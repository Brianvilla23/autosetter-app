const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// ── Tenant isolation helper ─────────────────────────────────────────────────
function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

async function loadOwnedLink(req, res) {
  const link = await db.findOne(db.links, { _id: req.params.id });
  if (!link) { res.status(404).json({ error: 'Link no encontrado', id: req.params.id }); return null; }
  if (link.account_id !== req.user.accountId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return link;
}

router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const links = await db.find(db.links, { account_id: accountId },
      (a, b) => a.createdAt.localeCompare(b.createdAt));
    res.json(links.map(l => ({ ...l, id: l._id })));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { accountId, name, url, description = '' } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const link = await db.insert(db.links, { account_id: accountId, name, url, description });
    res.json({ ...link, id: link._id });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const owned = await loadOwnedLink(req, res);
    if (!owned) return;
    const { name, url, description } = req.body;
    await db.update(db.links, { _id: req.params.id }, { name, url, description });
    const link = await db.findOne(db.links, { _id: req.params.id });
    res.json({ ...link, id: link._id });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const link = await loadOwnedLink(req, res);
    if (!link) return;
    const removed = await db.remove(db.links, { _id: id });
    console.log(`[links.delete] removed ${removed} doc(s) for id=${id} (${link.name})`);

    // Quitar referencia SOLO de agentes del mismo tenant que apunten a este link
    const agents = await db.find(db.agents, { account_id: req.user.accountId });
    for (const a of agents) {
      if (Array.isArray(a.link_ids) && a.link_ids.includes(id)) {
        const newIds = a.link_ids.filter(lid => lid !== id);
        await db.update(db.agents, { _id: a._id }, { link_ids: newIds }).catch(() => null);
      }
    }

    res.json({ ok: true, removed });
  } catch (e) {
    console.error('[links.delete] error:', e.message);
    next(e);
  }
});

module.exports = router;
