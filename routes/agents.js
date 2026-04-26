const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { enforceMaxAgents, enforceFollowupFeature } = require('../middleware/checkPlanLimits');

// ── Tenant isolation helper ─────────────────────────────────────────────────
// Verifica que el accountId del request matchee con el del JWT del usuario.
// Sin esto, un usuario con un token válido podría leer/escribir datos de
// CUALQUIER otra cuenta solo cambiando el accountId en query/body.
function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

// ── Helper: cargar agente y validar que pertenece al accountId del JWT ─────
async function loadOwnedAgent(req, res) {
  const agent = await db.findOne(db.agents, { _id: req.params.id });
  if (!agent) { res.status(404).json({ error: 'Not found' }); return null; }
  if (agent.account_id !== req.user.accountId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return agent;
}

// GET all agents for account
router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const agents = await db.find(db.agents, { account_id: accountId },
      (a, b) => a.createdAt.localeCompare(b.createdAt));
    // Attach link objects
    const links = await db.find(db.links, { account_id: accountId });
    const result = agents.map(a => ({
      ...a,
      id: a._id,
      links: (a.link_ids || []).map(lid => links.find(l => l._id === lid)).filter(Boolean).map(l => ({...l, id: l._id}))
    }));
    res.json(result);
  } catch (e) { next(e); }
});

// GET single agent
router.get('/:id', async (req, res, next) => {
  try {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;
    const links = await db.find(db.links, { account_id: agent.account_id });
    const agentLinks = (agent.link_ids || []).map(lid => links.find(l => l._id === lid)).filter(Boolean).map(l => ({...l, id: l._id}));
    res.json({ ...agent, id: agent._id, links: agentLinks });
  } catch (e) { next(e); }
});

// POST create agent
router.post('/', enforceMaxAgents, async (req, res, next) => {
  try {
    const { accountId, name, avatar = '🤖', instructions = '' } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const agent = await db.insert(db.agents, { account_id: accountId, name, avatar, instructions, enabled: true, link_ids: [] });
    res.json({ ...agent, id: agent._id });
  } catch (e) { next(e); }
});

// PUT update agent
router.put('/:id', enforceFollowupFeature, async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    const {
      name, avatar, instructions, enabled, trigger_keywords, delay_min, delay_max,
      followup_enabled, followup_delay_hours,
    } = req.body;
    const upd = { name, avatar, instructions, enabled, trigger_keywords, delay_min, delay_max };
    if (typeof followup_enabled === 'boolean') upd.followup_enabled = followup_enabled;
    if (followup_delay_hours !== undefined) {
      const h = Math.max(1, Math.min(23, Number(followup_delay_hours) || 3));
      upd.followup_delay_hours = h;
    }
    await db.update(db.agents, { _id: req.params.id }, upd);
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    res.json({ ...agent, id: agent._id });
  } catch (e) { next(e); }
});

// PATCH agent followup settings (atajo solo para configuración follow-up)
router.patch('/:id/followup', async (req, res, next) => {
  // Si están tratando de activar, validar plan
  if (req.body?.enabled === true) {
    req.body.followup_enabled = true;
    return enforceFollowupFeature(req, res, next);
  }
  next();
}, async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    const { enabled, delay_hours } = req.body;
    const upd = {};
    if (typeof enabled === 'boolean') upd.followup_enabled = enabled;
    if (delay_hours !== undefined) {
      upd.followup_delay_hours = Math.max(1, Math.min(23, Number(delay_hours) || 3));
    }
    await db.update(db.agents, { _id: req.params.id }, upd);
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    res.json({
      followup_enabled:     agent.followup_enabled || false,
      followup_delay_hours: agent.followup_delay_hours || 3,
    });
  } catch (e) { next(e); }
});

// PATCH toggle
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;
    await db.update(db.agents, { _id: req.params.id }, { enabled: !agent.enabled });
    res.json({ enabled: !agent.enabled });
  } catch (e) { next(e); }
});

// DELETE agent
router.delete('/:id', async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    await db.remove(db.agents, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT update agent links
router.put('/:id/links', async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    const { linkIds = [] } = req.body;
    await db.update(db.agents, { _id: req.params.id }, { link_ids: linkIds });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST test agent
router.post('/:id/test', async (req, res, next) => {
  try {
    const { message, history = [], accountId } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;

    const knowledgeDocs = await db.find(db.knowledge, { account_id: accountId });
    const knowledge = knowledgeDocs.filter(k => k.is_main || (k.agent_ids || []).includes(req.params.id));
    const allLinks = await db.find(db.links, { account_id: accountId });
    const links = (owned.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);

    const { generateReply, classifyLead } = require('../services/openai');
    const reply = await generateReply({ agent: owned, knowledge, links, conversationHistory: history, newMessage: message, accountId });

    // Classify lead based on full conversation (including new exchange)
    const fullHistory = [...history, { role: 'user', content: message }, { role: 'agent', content: reply }];
    const classification = await classifyLead({ conversationHistory: fullHistory, accountId }).catch(() => null);

    res.json({ reply, classification });
  } catch (e) { next(e); }
});

module.exports = router;
