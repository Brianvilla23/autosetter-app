const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { v4: uuidv4 } = require('uuid');

// ── Tenant isolation helper ─────────────────────────────────────────────────
function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

// ── Helper: cargar lead y validar pertenencia al tenant ────────────────────
async function loadOwnedLead(req, res) {
  const lead = await db.findOne(db.leads, { _id: req.params.id });
  if (!lead) { res.status(404).json({ error: 'Not found' }); return null; }
  if (lead.account_id !== req.user.accountId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return lead;
}

// GET leads with filters
router.get('/', async (req, res, next) => {
  try {
    const { accountId, status, automation, qualification, search } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    let query = { account_id: accountId };
    if (status && status !== 'all') query.status = status;
    if (automation && automation !== 'all') query.automation = automation;
    if (qualification && qualification !== 'all') query.qualification = qualification;

    let leads = await db.find(db.leads, query,
      (a, b) => new Date(b.last_message_at || b.createdAt) - new Date(a.last_message_at || a.createdAt));

    if (search) leads = leads.filter(l => l.ig_username.includes(search.replace('@', '')));

    const agents = await db.find(db.agents, { account_id: accountId });
    const result = leads.map(l => {
      const agent = agents.find(a => a._id === l.agent_id);
      return { ...l, id: l._id, agent_name: agent?.name };
    });

    res.json({ leads: result.slice(0, 20), total: leads.length });
  } catch (e) { next(e); }
});

// GET bypassed list (must come before /:id route to avoid clash)
router.get('/bypassed/list', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const list = await db.find(db.bypassed, { account_id: accountId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list.map(u => ({ ...u, id: u._id })));
  } catch (e) { next(e); }
});

// GET single lead with messages
router.get('/:id', async (req, res, next) => {
  try {
    if (req.params.id === 'bypassed') return; // skip, handled below
    const lead = await loadOwnedLead(req, res);
    if (!lead) return;
    const messages = await db.find(db.messages, { lead_id: req.params.id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const agent = lead.agent_id ? await db.findOne(db.agents, { _id: lead.agent_id }) : null;
    res.json({ ...lead, id: lead._id, agent_name: agent?.name, agent_avatar: agent?.avatar, messages: messages.map(m => ({...m, id: m._id})) });
  } catch (e) { next(e); }
});

// PATCH update lead
router.patch('/:id', async (req, res, next) => {
  try {
    const owned = await loadOwnedLead(req, res);
    if (!owned) return;
    const { automation, agent_id, is_bypassed, is_converted, status, qualification } = req.body;
    const upd = {};
    if (automation     !== undefined) upd.automation     = automation;
    if (agent_id       !== undefined) upd.agent_id       = agent_id;
    if (is_bypassed    !== undefined) upd.is_bypassed    = is_bypassed;
    if (is_converted   !== undefined) upd.is_converted   = is_converted;
    if (status         !== undefined) upd.status         = status;
    if (qualification  !== undefined) upd.qualification  = qualification;
    await db.update(db.leads, { _id: req.params.id }, upd);
    const lead = await db.findOne(db.leads, { _id: req.params.id });
    res.json({ ...lead, id: lead._id });
  } catch (e) { next(e); }
});

// POST retrigger AI for last unanswered user message
router.post('/:id/retrigger', async (req, res, next) => {
  try {
    const lead = await loadOwnedLead(req, res);
    if (!lead) return;

    const account = await db.findOne(db.accounts, { _id: lead.account_id });
    const agent   = await db.findOne(db.agents,   { _id: lead.agent_id });
    if (!account || !agent) return res.status(400).json({ error: 'Account or agent not found' });

    const messages = await db.find(db.messages, { lead_id: req.params.id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Find last user message
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return res.status(400).json({ error: 'No user message found' });

    const { generateReply } = require('../services/openai');
    const { sendMessage }   = require('../services/meta');

    const allKnowledge = await db.find(db.knowledge, { account_id: account._id });
    const knowledge    = allKnowledge.filter(k => k.is_main || (k.agent_ids || []).includes(agent._id));
    const allLinks     = await db.find(db.links, { account_id: account._id });
    const links        = (agent.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);
    const settings     = await db.findOne(db.settings, { account_id: account._id });
    const apiKey       = process.env.OPENAI_API_KEY || settings?.openai_key;

    const history = messages.filter(m => m._id !== lastUser._id);

    const reply = await generateReply({
      agent, knowledge, links,
      conversationHistory: history,
      newMessage: lastUser.content,
      accountId: account._id,
      apiKey
    });

    await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: reply });
    await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() });

    const igUserId = account.ig_platform_id || account.ig_user_id;
    await sendMessage({ recipientId: lead.ig_user_id, text: reply, accessToken: account.access_token, igUserId, accountId: account._id });

    console.log(`🔁 Retrigger @${lead.ig_username}: ${reply.substring(0, 80)}`);
    res.json({ ok: true, reply });
  } catch (e) { next(e); }
});

// POST manual message
// Body: { text, accountId, takeControl? } — takeControl=true marca al lead como bypassed
//                                            (el bot deja de responder esa conversación)
router.post('/:id/message', async (req, res, next) => {
  try {
    const { text, accountId, takeControl } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requerido' });

    const lead = await loadOwnedLead(req, res);
    if (!lead) return;

    const cleanText = String(text).slice(0, 1000);
    const message = await db.insert(db.messages, {
      lead_id: req.params.id,
      account_id: lead.account_id,
      role: 'manual',
      content: cleanText,
    });

    // Update last_message_at + opcionalmente take-control + read_at (si lo respondés ya lo leíste)
    const upd = { last_message_at: new Date().toISOString(), read_at: new Date().toISOString() };
    if (takeControl) {
      upd.is_bypassed = true;
      upd.automation  = 'paused';
    }
    await db.update(db.leads, { _id: req.params.id }, upd);

    // Send via Meta if real token
    const account = await db.findOne(db.accounts, { _id: accountId });
    let metaSent = false;
    if (account?.access_token && account.access_token !== 'demo_token') {
      try {
        const { sendMessage } = require('../services/meta');
        const igUserId = account.ig_platform_id || account.ig_user_id;
        await sendMessage({ recipientId: lead.ig_user_id, text: cleanText, accessToken: account.access_token, igUserId, accountId: account._id });
        metaSent = true;
      } catch (e) {
        console.warn(`manual send → @${lead.ig_username} failed:`, e.response?.data || e.message);
      }
    }

    res.json({ ok: true, message: { ...message, id: message._id }, metaSent });
  } catch (e) { next(e); }
});

// POST add bypass
router.post('/bypassed/add', async (req, res, next) => {
  try {
    const { accountId, igUsername } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const username = igUsername.replace('@', '');
    const exists = await db.findOne(db.bypassed, { account_id: accountId, ig_username: username });
    if (exists) return res.status(400).json({ error: 'Already bypassed' });
    await db.insert(db.bypassed, { account_id: accountId, ig_username: username });
    await db.update(db.leads, { account_id: accountId, ig_username: username }, { is_bypassed: true, automation: 'paused' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE bypass
router.delete('/bypassed/:id', async (req, res, next) => {
  try {
    const entry = await db.findOne(db.bypassed, { _id: req.params.id });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (entry.account_id !== req.user.accountId) return res.status(403).json({ error: 'forbidden' });
    await db.remove(db.bypassed, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── DELETE lead (borra lead + mensajes + pendingSends asociados) ──────────────
// Útil para limpiar testing antes de un demo en vivo.
router.delete('/:id', async (req, res, next) => {
  try {
    const lead = await loadOwnedLead(req, res);
    if (!lead) return;
    await db.remove(db.messages,     { lead_id: lead._id }, { multi: true });
    await db.remove(db.pendingSends, { lead_id: lead._id }, { multi: true });
    await db.remove(db.leads,        { _id: lead._id });
    console.log(`🗑️ Lead borrado: @${lead.ig_username} (${lead._id})`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── POST clear messages (limpia conversación pero mantiene el lead) ──────────
// Útil cuando querés "resetear" la conversación con un lead conocido sin
// perderlo de la lista. El bot va a tratar el próximo DM como primer mensaje.
router.post('/:id/clear-messages', async (req, res, next) => {
  try {
    const lead = await loadOwnedLead(req, res);
    if (!lead) return;
    await db.remove(db.messages,     { lead_id: lead._id }, { multi: true });
    await db.remove(db.pendingSends, { lead_id: lead._id }, { multi: true });
    // Resetear estado del lead para que el flujo arranque limpio
    await db.update(db.leads, { _id: lead._id }, {
      qualification: null,
      last_message_at: null,
      limit_reached: false,
    });
    console.log(`🧹 Mensajes limpiados para lead @${lead.ig_username} (${lead._id})`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── POST clear all (borra TODOS los leads del account — para reset completo) ─
// Pide confirm explícito en body para evitar accidentes.
router.post('/clear-all', async (req, res, next) => {
  try {
    const { accountId, confirm } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    if (confirm !== 'YES_DELETE_ALL_LEADS') {
      return res.status(400).json({ error: 'confirm required: send {"confirm":"YES_DELETE_ALL_LEADS"}' });
    }
    const leads = await db.find(db.leads, { account_id: accountId });
    const leadIds = leads.map(l => l._id);
    await db.remove(db.messages,     { lead_id: { $in: leadIds } }, { multi: true });
    await db.remove(db.pendingSends, { lead_id: { $in: leadIds } }, { multi: true });
    await db.remove(db.leads,        { account_id: accountId }, { multi: true });
    console.warn(`🗑️🗑️ CLEAR-ALL: ${leads.length} leads borrados para account ${accountId}`);
    res.json({ ok: true, deleted: leads.length });
  } catch (e) { next(e); }
});

module.exports = router;
