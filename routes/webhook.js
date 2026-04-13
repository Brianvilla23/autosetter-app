const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { generateReply, classifyLead } = require('../services/openai');
const { sendMessage, getIGUserInfo } = require('../services/meta');
const { v4: uuidv4 } = require('uuid');

// ── VERIFY (Meta GET) ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'mi_token_secreto_webhook')) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── RECEIVE DMs ───────────────────────────────────────────────────────────────
router.post('/', express.json(), async (req, res) => {
  res.sendStatus(200); // Always 200 immediately
  try {
    const body = req.body;
    if (body.object !== 'instagram') return;
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        await handleMessage(entry.id, event).catch(e => console.error('handleMessage error:', e));
      }
    }
  } catch (e) { console.error('Webhook error:', e); }
});

async function handleMessage(pageId, event) {
  const senderId  = event.sender?.id;
  const text      = event.message?.text;
  if (!senderId || !text || event.message?.is_echo) return;

  // Find account
  const account = await db.findOne(db.accounts, { ig_user_id: pageId });
  if (!account) { console.log('No account for ig_user_id:', pageId); return; }

  // Check bypass
  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, ig_username: senderId });
  if (bypassed) return;

  // Find enabled agent
  const agents = await db.find(db.agents, { account_id: account._id, enabled: true },
    (a, b) => a.createdAt.localeCompare(b.createdAt));
  const agent = agents[0];
  if (!agent) return;

  // Get or create lead
  let lead = await db.findOne(db.leads, { account_id: account._id, ig_user_id: senderId });
  if (!lead) {
    const userInfo = await getIGUserInfo(senderId, account.access_token);
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      ig_user_id: senderId, ig_username: userInfo.username || senderId,
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false,
      last_message_at: new Date().toISOString()
    });
  }

  if (lead.automation !== 'automated' || lead.is_bypassed) return;

  // Save incoming message
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: text });
  await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() });

  // Build context
  const history = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const allKnowledge = await db.find(db.knowledge, { account_id: account._id });
  const knowledge    = allKnowledge.filter(k => k.is_main || (k.agent_ids || []).includes(agent._id));
  const allLinks     = await db.find(db.links, { account_id: account._id });
  const links        = (agent.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);

  // Generate reply
  const settings = await db.findOne(db.settings, { account_id: account._id });
  const apiKey   = process.env.OPENAI_API_KEY || settings?.openai_key;

  const reply = await generateReply({
    agent, knowledge, links,
    conversationHistory: history.slice(0, -1),
    newMessage: text,
    accountId: account._id,
    apiKey
  });

  // Save agent reply
  await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: reply });

  // Send via Meta
  await sendMessage({ recipientId: senderId, text: reply, accessToken: account.access_token });

  console.log(`💬 [${agent.name}] → @${lead.ig_username}: ${reply.substring(0, 80)}...`);

  // ── Classify lead (async, non-blocking) ──────────────────────────────────
  const fullHistory = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  classifyLead({ conversationHistory: fullHistory, accountId: account._id, apiKey }).then(result => {
    if (result?.qualification) {
      db.update(db.leads, { _id: lead._id }, {
        qualification: result.qualification,
        qualification_reason: result.reason,
        qualification_updated_at: new Date().toISOString()
      }).catch(e => console.error('classifyLead update error:', e));
      console.log(`🎯 [${lead.ig_username}] clasificado como ${result.qualification.toUpperCase()}: ${result.reason}`);
    }
  }).catch(e => console.error('classifyLead error:', e));
}

module.exports = router;
