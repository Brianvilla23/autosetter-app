const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

router.get('/', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId || accountId === 'first' || accountId === 'temp') {
      const account = await db.findOne(db.accounts, {});
      if (!account) return res.status(404).json({ error: 'No account' });
      const settings = await db.findOne(db.settings, { account_id: account._id });
      const stats = await buildStats(account._id);
      return res.json({ account: { ...account, id: account._id }, settings, stats });
    }
    const account  = await db.findOne(db.accounts, { _id: accountId });
    const settings = await db.findOne(db.settings, { account_id: accountId });
    const stats    = await buildStats(accountId);
    res.json({ account: account ? { ...account, id: account._id } : null, settings, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function buildStats(accountId) {
  const [agents, leads, knowledge, links, converted] = await Promise.all([
    db.count(db.agents,    { account_id: accountId, enabled: true }),
    db.count(db.leads,     { account_id: accountId }),
    db.count(db.knowledge, { account_id: accountId }),
    db.count(db.links,     { account_id: accountId }),
    db.count(db.leads,     { account_id: accountId, is_converted: true }),
  ]);
  return { agents, leads, knowledge, links, converted };
}

router.put('/', async (req, res) => {
  try {
    const { accountId, openai_key } = req.body;
    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (exists) {
      await db.update(db.settings, { account_id: accountId }, { openai_key, updatedAt: new Date().toISOString() });
    } else {
      await db.insert(db.settings, { account_id: accountId, openai_key });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/account', async (req, res) => {
  try {
    const { accountId, ig_username, ig_user_id, access_token } = req.body;
    await db.update(db.accounts, { _id: accountId }, { ig_username, ig_user_id, access_token });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
