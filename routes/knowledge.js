const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// ── Tenant isolation helper ─────────────────────────────────────────────────
function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

async function loadOwnedKnowledge(req, res) {
  const entry = await db.findOne(db.knowledge, { _id: req.params.id });
  if (!entry) { res.status(404).json({ error: 'Entrada no encontrada', id: req.params.id }); return null; }
  if (entry.account_id !== req.user.accountId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return entry;
}

router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const entries = await db.find(db.knowledge, { account_id: accountId },
      (a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
    const agents  = await db.find(db.agents, { account_id: accountId });
    const result  = entries.map(e => ({
      ...e, id: e._id,
      agents: (e.agent_ids || []).map(aid => agents.find(a => a._id === aid))
        .filter(Boolean).map(a => ({ id: a._id, name: a.name, avatar: a.avatar }))
    }));
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { accountId, title, content, is_main = false, agentIds = [] } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const entry = await db.insert(db.knowledge, { account_id: accountId, title, content, is_main, agent_ids: agentIds });
    res.json({ ...entry, id: entry._id });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const owned = await loadOwnedKnowledge(req, res);
    if (!owned) return;
    const { title, content, is_main, agentIds } = req.body;
    // Cada campo se toca solo si viene: con un PUT parcial los `undefined`
    // borraban título/contenido en NeDB (misma familia que routes/agents.js).
    const upd = {};
    if (title !== undefined)     upd.title     = title;
    if (content !== undefined)   upd.content   = content;
    if (is_main !== undefined)   upd.is_main   = !!is_main;
    if (Array.isArray(agentIds)) upd.agent_ids = agentIds;
    await db.update(db.knowledge, { _id: req.params.id }, upd);
    const entry = await db.findOne(db.knowledge, { _id: req.params.id });
    res.json({ ...entry, id: entry._id });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const entry = await loadOwnedKnowledge(req, res);
    if (!entry) {
      console.warn(`[knowledge.delete] not found or forbidden: ${id}`);
      return;
    }
    const removed = await db.remove(db.knowledge, { _id: id });
    console.log(`[knowledge.delete] removed ${removed} doc(s) for id=${id} (${entry.title})`);
    res.json({ ok: true, removed });
  } catch (e) {
    console.error('[knowledge.delete] error:', e.message);
    next(e);
  }
});

module.exports = router;
