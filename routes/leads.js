const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { v4: uuidv4 } = require('uuid');

// GET leads with filters
router.get('/', async (req, res) => {
  try {
    const { accountId, status, automation, qualification, search } = req.query;
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET single lead with messages
router.get('/:id', async (req, res) => {
  try {
    if (req.params.id === 'bypassed') return; // skip, handled below
    const lead = await db.findOne(db.leads, { _id: req.params.id });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const messages = await db.find(db.messages, { lead_id: req.params.id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const agent = lead.agent_id ? await db.findOne(db.agents, { _id: lead.agent_id }) : null;
    res.json({ ...lead, id: lead._id, agent_name: agent?.name, agent_avatar: agent?.avatar, messages: messages.map(m => ({...m, id: m._id})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH update lead
router.patch('/:id', async (req, res) => {
  try {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST retrigger AI for last unanswered user message
router.post('/:id/retrigger', async (req, res) => {
  try {
    const lead = await db.findOne(db.leads, { _id: req.params.id });
    if (!lead) return res.status(404).json({ error: 'Not found' });

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
    await sendMessage({ recipientId: lead.ig_user_id, text: reply, accessToken: account.access_token, igUserId });

    console.log(`🔁 Retrigger @${lead.ig_username}: ${reply.substring(0, 80)}`);
    res.json({ ok: true, reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST manual message
router.post('/:id/message', async (req, res) => {
  try {
    const { text, accountId } = req.body;
    const lead = await db.findOne(db.leads, { _id: req.params.id });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    await db.insert(db.messages, { lead_id: req.params.id, role: 'manual', content: text });
    // Send via Meta if real token
    const account = await db.findOne(db.accounts, { _id: accountId });
    if (account?.access_token && account.access_token !== 'demo_token') {
      const { sendMessage } = require('../services/meta');
      await sendMessage({ recipientId: lead.ig_user_id, text, accessToken: account.access_token });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET bypassed list
router.get('/bypassed/list', async (req, res) => {
  try {
    const { accountId } = req.query;
    const list = await db.find(db.bypassed, { account_id: accountId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list.map(u => ({ ...u, id: u._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST add bypass
router.post('/bypassed/add', async (req, res) => {
  try {
    const { accountId, igUsername } = req.body;
    const username = igUsername.replace('@', '');
    const exists = await db.findOne(db.bypassed, { account_id: accountId, ig_username: username });
    if (exists) return res.status(400).json({ error: 'Already bypassed' });
    await db.insert(db.bypassed, { account_id: accountId, ig_username: username });
    await db.update(db.leads, { account_id: accountId, ig_username: username }, { is_bypassed: true, automation: 'paused' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE bypass
router.delete('/bypassed/:id', async (req, res) => {
  try {
    await db.remove(db.bypassed, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
