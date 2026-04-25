const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

router.get('/', async (req, res) => {
  try {
    const { accountId } = req.query;
    const entries = await db.find(db.knowledge, { account_id: accountId },
      (a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
    const agents  = await db.find(db.agents, { account_id: accountId });
    const result  = entries.map(e => ({
      ...e, id: e._id,
      agents: (e.agent_ids || []).map(aid => agents.find(a => a._id === aid))
        .filter(Boolean).map(a => ({ id: a._id, name: a.name, avatar: a.avatar }))
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { accountId, title, content, is_main = false, agentIds = [] } = req.body;
    const entry = await db.insert(db.knowledge, { account_id: accountId, title, content, is_main, agent_ids: agentIds });
    res.json({ ...entry, id: entry._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, content, is_main, agentIds = [] } = req.body;
    await db.update(db.knowledge, { _id: req.params.id }, { title, content, is_main, agent_ids: agentIds });
    const entry = await db.findOne(db.knowledge, { _id: req.params.id });
    res.json({ ...entry, id: entry._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const entry = await db.findOne(db.knowledge, { _id: id });
    if (!entry) {
      console.warn(`[knowledge.delete] not found: ${id}`);
      return res.status(404).json({ error: 'Entrada no encontrada', id });
    }
    const removed = await db.remove(db.knowledge, { _id: id });
    console.log(`[knowledge.delete] removed ${removed} doc(s) for id=${id} (${entry.title})`);
    res.json({ ok: true, removed });
  } catch (e) {
    console.error('[knowledge.delete] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
