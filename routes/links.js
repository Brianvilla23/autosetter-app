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
    await db.remove(db.links, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
