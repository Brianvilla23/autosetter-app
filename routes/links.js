const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

router.get('/', async (req, res) => {
  try {
    const links = await db.find(db.links, { account_id: req.query.accountId },
      (a, b) => a.createdAt.localeCompare(b.createdAt));
    res.json(links.map(l => ({ ...l, id: l._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { accountId, name, url, description = '' } = req.body;
    const link = await db.insert(db.links, { account_id: accountId, name, url, description });
    res.json({ ...link, id: link._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, url, description } = req.body;
    await db.update(db.links, { _id: req.params.id }, { name, url, description });
    const link = await db.findOne(db.links, { _id: req.params.id });
    res.json({ ...link, id: link._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Verificar que el link existe ANTES de remover (mejor diagnóstico)
    const link = await db.findOne(db.links, { _id: id });
    if (!link) {
      console.warn(`[links.delete] not found: ${id}`);
      return res.status(404).json({ error: 'Link no encontrado', id });
    }
    const removed = await db.remove(db.links, { _id: id });
    console.log(`[links.delete] removed ${removed} doc(s) for id=${id} (${link.name})`);

    // Quitar referencia de cualquier agente que apunte a este link
    const agents = await db.find(db.agents, {});
    for (const a of agents) {
      if (Array.isArray(a.link_ids) && a.link_ids.includes(id)) {
        const newIds = a.link_ids.filter(lid => lid !== id);
        await db.update(db.agents, { _id: a._id }, { link_ids: newIds }).catch(() => null);
      }
    }

    res.json({ ok: true, removed });
  } catch (e) {
    console.error('[links.delete] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
