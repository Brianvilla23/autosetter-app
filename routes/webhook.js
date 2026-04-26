const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db/database');
const { generateReply, classifyLead } = require('../services/openai');
const { sendMessage, getIGUserInfo } = require('../services/meta');
const { checkDMAllowance, incrementDMCount } = require('../services/limits');
const { v4: uuidv4 } = require('uuid');

// ── Verify Meta webhook signature (HMAC-SHA256) ─────────────────────────────
// Meta firma cada POST con header X-Hub-Signature-256 = "sha256=<hex>"
// usando el APP_SECRET sobre el raw body. Sin esta validación, cualquier
// atacante puede inyectar mensajes falsos y dispararle DMs reales a leads.
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error('[webhook] META_APP_SECRET no configurado — rechazando');
    return false;
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') return false;

  // El raw body es preservado por el verify hook de express.json en server.js
  // (req.rawBody). Si no está, no podemos validar — fail closed.
  const raw = req.rawBody;
  if (!raw) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  try {
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// Verificar si el texto contiene alguno de los keywords del agente
// trigger_keywords: string con palabras separadas por comas, ej: "info,precio,hola"
// Si el agente no tiene keywords configuradas, responde a TODOS los mensajes
function containsTrigger(text, agent) {
  const raw = (agent.trigger_keywords || '').trim();
  if (!raw) return true; // Sin keywords → responde a todo
  const keywords = raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  const msgLower = (text || '').toLowerCase();
  return keywords.some(kw => msgLower.includes(kw));
}

// ── VERIFY (Meta GET) ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'mi_token_secreto_webhook')) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── WEBHOOK PRINCIPAL ─────────────────────────────────────────────────────────
// Nota: NO usamos express.json() acá porque el body parser global en server.js
// ya parsea el JSON Y guarda el raw body en req.rawBody (necesario para HMAC).
router.post('/', async (req, res) => {
  // 1. Validar firma ANTES de procesar nada — fail closed.
  if (!verifyMetaSignature(req)) {
    console.error('[webhook] firma inválida o ausente');
    return res.status(401).send('invalid signature');
  }

  // 2. Backpressure: si la queue está llena, rechazar antes de hacer trabajo.
  try {
    const queueCount = await db.count(db.pendingSends, {});
    if (queueCount > 10000) {
      console.error(`[QUEUE] pendingSends overflow (${queueCount}), rejecting webhook`);
      return res.status(429).json({ error: 'queue full' });
    }
  } catch (e) { /* si el count falla, seguimos — no queremos perder webhooks por un error transitorio */ }

  res.sendStatus(200); // Siempre 200 inmediato (después de validar)
  try {
    const body = req.body;
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {

      // ── 1. DMs directos ────────────────────────────────────────────────────
      for (const event of entry.messaging || []) {
        await handleDM(entry.id, event).catch(e => console.error('handleDM error:', e));
      }

      // ── 2. Comentarios en posts/carruseles (comment-to-DM) ─────────────────
      for (const change of entry.changes || []) {
        if (change.field === 'comments') {
          await handleComment(entry.id, change.value).catch(e => console.error('handleComment error:', e));
        }
      }
    }
  } catch (e) { console.error('Webhook error:', e); }
});

// ── HANDLER: DM DIRECTO ───────────────────────────────────────────────────────
async function handleDM(pageId, event) {
  const senderId = event.sender?.id;
  const text     = event.message?.text;
  if (!senderId || !text || event.message?.is_echo) return;

  // Find account
  const account = await db.findOne(db.accounts, { ig_user_id: pageId });
  if (!account) { console.log('No account for ig_user_id:', pageId); return; }

  // Check bypass
  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, ig_user_id: senderId });
  if (bypassed) return;

  // Find enabled agent
  const agents = await db.find(db.agents, { account_id: account._id, enabled: true },
    (a, b) => a.createdAt.localeCompare(b.createdAt));
  const agent = agents[0];
  if (!agent) return;

  // Get or create lead
  let lead = await db.findOne(db.leads, { account_id: account._id, ig_user_id: senderId });

  if (!lead) {
    // ── KEYWORD GATE: Si es el primer mensaje, verificar keywords del agente ──
    if (!containsTrigger(text, agent)) {
      console.log(`🔒 DM ignorado (sin keyword) de ${senderId}: "${text}"`);
      return;
    }
    // Keyword detectada → crear lead y activar bot
    const userInfo = await getIGUserInfo(senderId, account.access_token);
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      ig_user_id: senderId, ig_username: userInfo.username || senderId,
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false,
      triggered_by: 'dm_keyword',
      last_message_at: new Date().toISOString()
    });
    console.log(`🔑 Bot activado por keyword "info" en DM de @${lead.ig_username}`);
  }

  if (lead.automation !== 'automated' || lead.is_bypassed) return;

  await runConversation({ account, agent, lead, senderId, text });
}

// ── HANDLER: COMENTARIO EN POST/CARRUSEL → DM ─────────────────────────────────
async function handleComment(pageId, commentData) {
  /*
    commentData tiene: id, text, from.id, from.username, media.id, created_time
  */
  const commentText   = commentData?.text || '';
  const commenterIgId = commentData?.from?.id;
  const commenterName = commentData?.from?.username || commenterIgId;
  const mediaId       = commentData?.media?.id;

  // Find account + agent (una sola vez)
  const account = await db.findOne(db.accounts, { ig_user_id: pageId });
  if (!account) return;
  const agents = await db.find(db.agents, { account_id: account._id, enabled: true },
    (a, b) => a.createdAt.localeCompare(b.createdAt));
  const agent = agents[0];

  if (!commenterIgId || !agent || !containsTrigger(commentText, agent)) {
    if (commenterIgId) console.log(`💬 Comentario ignorado (sin keyword): "${commentText}"`);
    return;
  }

  // Check bypass
  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, ig_user_id: commenterIgId });
  if (bypassed) return;

  // Evitar duplicados: verificar si ya enviamos DM por este comentario en las últimas 2 horas
  const recentTrigger = await db.findOne(db.leads, {
    account_id: account._id,
    ig_user_id: commenterIgId,
    triggered_by: 'comment',
    triggered_media_id: mediaId
  });
  if (recentTrigger) {
    console.log(`⏭️ DM ya enviado a @${commenterName} por este post`);
    return;
  }

  // Get or create lead
  let lead = await db.findOne(db.leads, { account_id: account._id, ig_user_id: commenterIgId });
  if (!lead) {
    const userInfo = await getIGUserInfo(commenterIgId, account.access_token);
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      ig_user_id: commenterIgId, ig_username: userInfo.username || commenterName,
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false,
      triggered_by: 'comment',
      triggered_media_id: mediaId,
      last_message_at: new Date().toISOString()
    });
  } else {
    // Actualizar para marcar el nuevo trigger
    await db.update(db.leads, { _id: lead._id }, {
      triggered_by: 'comment',
      triggered_media_id: mediaId,
      last_message_at: new Date().toISOString()
    });
  }

  console.log(`💬→📩 Comentario "info" de @${lead.ig_username} → enviando DM automático`);

  // Generar y enviar DM al comentador
  await runConversation({
    account, agent, lead,
    senderId: commenterIgId,
    text: commentText,           // Usamos el texto del comentario como mensaje inicial
    isCommentTrigger: true       // Flag para contexto opcional
  });
}

// ── MOTOR PRINCIPAL: genera respuesta IA y envía DM ──────────────────────────
async function runConversation({ account, agent, lead, senderId, text, isCommentTrigger = false }) {
  if (lead.automation !== 'automated' || lead.is_bypassed) return;

  // Guardar mensaje entrante (no cuenta al límite: son los DMs recibidos)
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: text });
  await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() });

  // ── CHECK LÍMITE DE PLAN ─────────────────────────────────────────────────
  // El bot solo responde si el dueño de la cuenta no superó su límite mensual.
  const allowance = await checkDMAllowance(account._id);
  if (!allowance.allowed) {
    console.warn(`🚫 [${agent.name}] Límite mensual alcanzado para @${lead.ig_username}: ${allowance.reason}`);
    // Marcamos el lead para que el humano sepa que quedó sin respuesta automática
    await db.update(db.leads, { _id: lead._id }, {
      limit_reached: true,
      limit_reason:  allowance.reason,
    }).catch(() => null);
    return;
  }

  // Cancelar follow-ups pendientes — el lead acaba de responder (best-effort)
  try {
    const { cancelPendingForLead } = require('../services/followup');
    await cancelPendingForLead(lead._id, 'lead respondió');
  } catch (e) { /* silencioso */ }

  // Construir contexto
  const history    = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const allKnowledge = await db.find(db.knowledge, { account_id: account._id });
  const knowledge    = allKnowledge.filter(k => k.is_main || (k.agent_ids || []).includes(agent._id));
  const allLinks     = await db.find(db.links, { account_id: account._id });
  const links        = (agent.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);

  // API Key
  const settings = await db.findOne(db.settings, { account_id: account._id });
  const apiKey   = process.env.OPENAI_API_KEY || settings?.openai_key;

  // ── LEAD MAGNET: detección + entrega automática ─────────────────────────
  // Si el lead respondió con email y el bot había ofrecido un magnet, lo entregamos
  // antes de generar la respuesta, para que el bot pueda confirmar la entrega en su reply.
  let magnetContext = null;
  try {
    const { tryDeliverMagnet } = require('../services/magnetDelivery');
    const delivery = await tryDeliverMagnet({
      lead, account,
      incomingText: text,
      recentHistory: history,
    });
    if (delivery.delivered) {
      magnetContext = `MAGNET ENTREGADO: Acabás de enviarle al lead "${delivery.magnet.title}" a su email (${delivery.email}). Confirmá brevemente en tu respuesta ("listo, te lo mandé al mail, revisalo cuando puedas") y seguí la conversación natural. NO pidas el email de nuevo.`;
    } else if (delivery.alreadyDelivered) {
      magnetContext = `NOTA: Al lead ya le entregaste "${delivery.magnet.title}" antes. No vuelvas a ofrecerlo ni a pedirle email.`;
    }
  } catch (e) { console.warn('magnetDelivery skip:', e.message); }

  // Contexto extra si fue disparado por comentario
  const baseContext = isCommentTrigger
    ? `NOTA: Este usuario comentó "info" en uno de tus posts. Inicia la conversación presentándote y preguntando cómo puedes ayudarle.`
    : null;
  const extraContext = [baseContext, magnetContext].filter(Boolean).join('\n\n') || null;

  const reply = await generateReply({
    agent, knowledge, links,
    conversationHistory: history.slice(0, -1),
    newMessage: text,
    accountId: account._id,
    apiKey,
    extraContext
  });

  // Guardar respuesta del agente
  await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: reply });

  // Calcular delay humanizador (30-90s en pasos de 10s)
  const delayMin = agent.delay_min ?? 30;
  const delayMax = agent.delay_max ?? 90;
  const steps = Math.floor((delayMax - delayMin) / 10) + 1;
  const delaySeconds = delayMin + Math.floor(Math.random() * steps) * 10;
  const sendAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  // Guardar en queue persistente — sobrevive reinicios de Railway
  const igUserId = account.ig_platform_id || account.ig_user_id;
  await db.insert(db.pendingSends, {
    recipientId:  senderId,
    text:         reply,
    accessToken:  account.access_token,
    igUserId,
    accountId:    account._id,     // Para incrementar contador de DMs al enviar
    sendAt,
    leadUsername: lead.ig_username,
    agentName:    agent.name,
  });
  console.log(`⏱ [${agent.name}] Reply a @${lead.ig_username} programado en ${delaySeconds}s (${sendAt})`);

  console.log(`💬 [${agent.name}] → @${lead.ig_username}: ${reply.substring(0, 80)}...`);

  // ── Clasificar lead (async, sin bloquear) ──────────────────────────────────
  const fullHistory = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const prevQualification = lead.qualification || null;
  classifyLead({ conversationHistory: fullHistory, accountId: account._id, apiKey }).then(async result => {
    if (!result?.qualification) return;

    await db.update(db.leads, { _id: lead._id }, {
      qualification: result.qualification,
      qualification_reason: result.reason,
      qualification_updated_at: new Date().toISOString()
    }).catch(e => console.error('classifyLead update error:', e));
    console.log(`🎯 [@${lead.ig_username}] → ${result.qualification.toUpperCase()}: ${result.reason}`);

    // ── Disparar notificación si transicionó a HOT ───────────────────────────
    if (result.qualification === 'hot' && prevQualification !== 'hot') {
      try {
        const { notifyHotLead } = require('../services/notifications');
        // Bug fix: el campo en la tabla users es account_id (snake_case), no accountId.
        // Con el bug viejo el lookup devolvía null y la notificación nunca salía.
        const owner = await db.findOne(db.users, { account_id: account._id });
        if (owner) {
          const r = await notifyHotLead({ userId: owner._id, leadId: lead._id });
          const channels = (r.sent || []).filter(s => s.ok).map(s => s.channel).join(', ');
          if (channels) console.log(`🔔 Notificación HOT enviada a ${owner.email} (${channels}) para @${lead.ig_username}`);
          else if (r.throttled) console.log(`🔕 Notificación HOT throttled para @${lead.ig_username}`);
          else console.log(`⚠️  Notificación HOT no enviada (sin canales activos) para @${lead.ig_username}`);
        } else {
          console.warn(`⚠️  HOT detectado pero no se encontró owner para account ${account._id}`);
        }
      } catch (e) { console.error('notifyHotLead error:', e.message); }
    }
  }).catch(e => console.error('classifyLead error:', e));
}

module.exports = router;
