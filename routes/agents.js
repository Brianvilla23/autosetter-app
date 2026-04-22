const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { enforceMaxAgents, enforceFollowupFeature } = require('../middleware/checkPlanLimits');

// GET all agents for account
router.get('/', async (req, res) => {
  try {
    const { accountId } = req.query;
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET single agent
router.get('/:id', async (req, res) => {
  try {
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    if (!agent) return res.status(404).json({ error: 'Not found' });
    const links = await db.find(db.links, { account_id: agent.account_id });
    const agentLinks = (agent.link_ids || []).map(lid => links.find(l => l._id === lid)).filter(Boolean).map(l => ({...l, id: l._id}));
    res.json({ ...agent, id: agent._id, links: agentLinks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create agent
router.post('/', enforceMaxAgents, async (req, res) => {
  try {
    const { accountId, name, avatar = '🤖', instructions = '' } = req.body;
    const agent = await db.insert(db.agents, { account_id: accountId, name, avatar, instructions, enabled: true, link_ids: [] });
    res.json({ ...agent, id: agent._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update agent
router.put('/:id', enforceFollowupFeature, async (req, res) => {
  try {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH agent followup settings (atajo solo para configuración follow-up)
router.patch('/:id/followup', async (req, res, next) => {
  // Si están tratando de activar, validar plan
  if (req.body?.enabled === true) {
    req.body.followup_enabled = true;
    return enforceFollowupFeature(req, res, next);
  }
  next();
}, async (req, res) => {
  try {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH toggle
router.patch('/:id/toggle', async (req, res) => {
  try {
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    if (!agent) return res.status(404).json({ error: 'Not found' });
    await db.update(db.agents, { _id: req.params.id }, { enabled: !agent.enabled });
    res.json({ enabled: !agent.enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE agent
router.delete('/:id', async (req, res) => {
  try {
    await db.remove(db.agents, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update agent links
router.put('/:id/links', async (req, res) => {
  try {
    const { linkIds = [] } = req.body;
    await db.update(db.agents, { _id: req.params.id }, { link_ids: linkIds });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST test agent
router.post('/:id/test', async (req, res) => {
  try {
    const { message, history = [], accountId } = req.body;
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const knowledgeDocs = await db.find(db.knowledge, { account_id: accountId });
    const knowledge = knowledgeDocs.filter(k => k.is_main || (k.agent_ids || []).includes(req.params.id));
    const allLinks = await db.find(db.links, { account_id: accountId });
    const links = (agent.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);

    const { generateReply, classifyLead } = require('../services/openai');
    const reply = await generateReply({ agent, knowledge, links, conversationHistory: history, newMessage: message, accountId });

    // Classify lead based on full conversation (including new exchange)
    const fullHistory = [...history, { role: 'user', content: message }, { role: 'agent', content: reply }];
    const classification = await classifyLead({ conversationHistory: fullHistory, accountId }).catch(() => null);

    res.json({ reply, classification });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
