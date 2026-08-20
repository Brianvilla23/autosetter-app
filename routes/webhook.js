const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db/database');
const { generateReply, classifyLead } = require('../services/openai');
const { sendMessage, getIGUserInfo } = require('../services/meta');
const wa = require('../services/whatsapp');
const msgr = require('../services/messenger');
const PIPE = require('../config/pipeline');
const { selectAgent, servesChannel } = require('../services/agents');
const { canSendAuto } = require('../config/agentRoles');
const { knowledgeForAgent } = require('../services/agents/knowledge');
const { checkDMAllowance, incrementDMCount } = require('../services/limits');
// Pausa por canal: el dueño apagó ese canal desde Ajustes sin borrar credenciales.
const { estaPausado } = require('../services/channels/core');
const { v4: uuidv4 } = require('uuid');

// ── Bitácora en memoria de los últimos webhooks ─────────────────────────────
// Los logs del hosting se pueden ver con retraso o paginados, lo que hace muy
// lento diagnosticar "¿llegó o no llegó?". Esto guarda los últimos 40 eventos
// para consultarlos al instante desde /api/admin/webhook-log. Nunca guarda el
// contenido de los mensajes ni secretos: solo canal, resultado y hora.
const bitacora = [];
function anotar(evento) {
  bitacora.push({ ...evento, hora: new Date().toISOString() });
  if (bitacora.length > 40) bitacora.shift();
}
function leerBitacora() {
  return bitacora.slice().reverse();
}

// ── Verify Meta webhook signature (HMAC-SHA256) ─────────────────────────────
// Meta firma cada POST con header X-Hub-Signature-256 = "sha256=<hex>"
// usando el APP_SECRET sobre el raw body. Sin esta validación, cualquier
// atacante puede inyectar mensajes falsos y dispararle DMs reales a leads.
function verifyMetaSignature(req) {
  // Meta firma cada canal con el APP_SECRET del app que lo emite. En este
  // proyecto conviven DOS apps bajo el mismo webhook:
  //   • Instagram → SUB-APP de Instagram (Atinov-IG, ID 1666...) → META_APP_SECRET
  //   • WhatsApp  → Meta App principal   (Atinov,    ID 1313...) → META_APP_SECRET_WA
  // Por eso validamos contra AMBOS secrets y aceptamos si CUALQUIERA calza.
  // (Instagram: Meta Developers → API de Instagram → Configuración con inicio
  //  de sesión → "Clave secreta de la app de Instagram". WhatsApp: Configuración
  //  de la app → Básica → "Clave secreta de la app".)
  const secrets = [
    process.env.META_APP_SECRET,     // Instagram sub-app (1666)
    process.env.META_APP_SECRET_WA,  // Meta App principal (1313) — WhatsApp
  ].filter(Boolean);
  if (!secrets.length) {
    console.error('[webhook] ningún META_APP_SECRET configurado — rechazando');
    return false;
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') return false;

  // El raw body es preservado por el verify hook de express.json en server.js
  // (req.rawBody). Si no está, no podemos validar — fail closed.
  const raw = req.rawBody;
  if (!raw) return false;

  const sigBuf = Buffer.from(signature);
  return secrets.some((secret) => {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    try {
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  });
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
  // Token canónico (env, branded) + legacy de la suscripción Meta ya existente.
  // El legacy se acepta para NO romper el webhook vivo al rebrandinguear el
  // token; se puede quitar una vez que Meta apunte al token nuevo.
  const validTokens = [
    process.env.META_VERIFY_TOKEN || 'mi_token_secreto_webhook',
    'autosetter_webhook_2024', // legacy — suscripción Instagram ya verificada
  ];
  if (mode === 'subscribe' && validTokens.includes(token)) {
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
    // Diagnóstico: sin esto no se sabe QUÉ canal está siendo rechazado ni con
    // cuál de los secrets configurados habría validado. No imprime secretos:
    // solo el nombre de la variable que hubiera calzado.
    const cual = (() => {
      const raw = req.rawBody;
      const sig = req.headers['x-hub-signature-256'];
      if (!raw || !sig) return 'sin firma o sin body';
      for (const [nombre, secret] of [
        ['META_APP_SECRET', process.env.META_APP_SECRET],
        ['META_APP_SECRET_WA', process.env.META_APP_SECRET_WA],
      ]) {
        if (!secret) continue;
        const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
        if (esperado === sig) return `calzaba con ${nombre}`;
      }
      return 'NINGÚN secret configurado calza';
    })();
    console.error(`[webhook] firma inválida — canal=${req.body?.object || '?'} | ${cual}`);
    anotar({ canal: req.body?.object || '?', resultado: 'RECHAZADO', detalle: cual });
    return res.status(401).send('invalid signature');
  }
  // Se anota el entry.id (el ID con el que Meta identifica la cuenta en el
  // webhook). Instagram usa un ID distinto acá que en el login, y si no
  // coinciden el mensaje se descarta sin dejar rastro. Anotarlo permite
  // comparar contra el ig_user_id guardado.
  anotar({
    canal: req.body?.object || '?',
    resultado: 'ACEPTADO',
    entry_ids: (req.body?.entry || []).map(e => String(e.id)),
  });

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

    // ── BRANCH: WhatsApp Business Account ────────────────────────────────────
    // Meta envía webhooks de WhatsApp con object='whatsapp_business_account'.
    // Estructura: entry[].changes[].value.{metadata.phone_number_id, messages[], contacts[]}
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          // Campo `calls`: ciclo de vida de llamadas de WhatsApp. Lo que nos
          // importa acá es el PERMISO: si el lead llamó al negocio (con
          // callback_permission_status activo, Meta nos deja devolverle la
          // llamada) o concedió permiso permanente desde el perfil. Se guarda
          // en el lead para que el agente pueda llamar sin volver a pedir.
          if (change.field === 'calls') {
            const value = change.value || {};
            const phoneNumberId = value.metadata?.phone_number_id;
            if (phoneNumberId) {
              const { procesarWebhookCalls } = require('../services/whatsappCalling');
              await procesarWebhookCalls({ phoneNumberId, value })
                .catch(e => console.error('[wa] webhook calls error:', e.message));
            }
            continue;
          }
          if (change.field !== 'messages') continue;
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id;
          if (!phoneNumberId) continue;
          for (const msg of value.messages || []) {
            await handleWhatsAppMessage(phoneNumberId, msg, value)
              .catch(e => console.error('handleWhatsAppMessage error:', e));
          }
        }
      }
      return;
    }

    // ── BRANCH: Messenger (Página de Facebook / Marketplace) ─────────────────
    // Meta envía webhooks de Messenger con object='page'. Estructura idéntica a
    // Instagram: entry[].messaging[].{sender.id (PSID), message.text}. El account
    // se resuelve por entry.id (page_id). Sirve para consultas de Marketplace que
    // llegan a la Página → Atinov saluda, califica y deriva el prospecto a WhatsApp.
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        const pageId = entry.id;
        for (const event of entry.messaging || []) {
          await handleMessengerMessage(pageId, event).catch(e => console.error('handleMessengerMessage error:', e));
        }
      }
      return;
    }

    // ── BRANCH: Instagram ────────────────────────────────────────────────────
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
/**
 * ECHO: un mensaje que salió DESDE la cuenta del negocio — típicamente porque
 * el dueño lo escribió a mano desde su celular.
 *
 * Antes se descartaba en seco, y por eso la prospección en frío no funcionaba:
 * Brayan mandaba el primer DM desde Instagram, el sistema nunca se enteraba, y
 * cuando el prospecto respondía el agente veía una conversación VACÍA → creía
 * que era el primer contacto → volvía a saludar desde cero.
 *
 * Guardándolo como 'manual', el agente hereda la conversación que empezó un
 * humano y la continúa en vez de reiniciarla.
 */
async function handleEcho(pageId, event) {
  const text = event.message?.text;
  if (!text) return;                          // adjuntos sin texto: nada que heredar
  const destinatario = event.recipient?.id;   // en un echo, el lead es el RECEPTOR
  if (!destinatario) return;

  let account = await db.findOne(db.accounts, { ig_user_id: pageId });
  if (!account) account = await db.findOne(db.accounts, { ig_platform_id: pageId });
  if (!account) return;

  let lead = await db.findOne(db.leads, { account_id: account._id, ig_user_id: destinatario });

  // Dedup: los mensajes que manda el BOT también vuelven como echo, y ya
  // quedaron guardados como 'agent' antes de enviarse. Sin esto, cada
  // respuesta del agente quedaría duplicada en el historial.
  if (lead) {
    const desde = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recientes = await db.find(db.messages, { lead_id: lead._id, createdAt: { $gte: desde } });
    const yaEsta = recientes.some(m => (m.role === 'agent' || m.role === 'manual') && m.content === text);
    if (yaEsta) return;
  }

  // Sin lead = primer contacto saliente escrito a mano. Este es EL caso de la
  // prospección en frío: se crea el lead para que exista la conversación.
  if (!lead) {
    const info = await getIGUserInfo(destinatario, account.access_token);
    const sel = await selectAgent(account, null, 'instagram');
    lead = await db.insert(db.leads, {
      account_id: account._id,
      agent_id: sel.agent?._id || null,
      ig_user_id: destinatario,
      ig_username: info.username || destinatario,
      status: 'active',
      automation: 'automated',
      is_bypassed: false, is_converted: false,
      pipeline_stage: 'nuevo',
      triggered_by: 'outbound_manual',
      last_message_at: new Date().toISOString(),
    });
    console.log(`📤 Primer mensaje saliente manual a @${lead.ig_username} — lead creado`);
  }

  await db.insert(db.messages, { lead_id: lead._id, role: 'manual', content: text });
  await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() });
}

// ── HANDLER: DM DIRECTO ───────────────────────────────────────────────────────
async function handleDM(pageId, event) {
  const senderId = event.sender?.id;
  // Los echoes van por su propio camino: son mensajes NUESTROS, no del lead.
  if (event.message?.is_echo) return handleEcho(pageId, event);
  if (!senderId) return;

  // Instagram manda por el MISMO canal de DMs tres cosas distintas:
  //  · un mensaje normal (trae text)
  //  · una RESPUESTA a una historia tuya (trae text + reply_to.story)
  //  · una MENCIÓN en la historia de otra persona (SIN text, solo el adjunto
  //    story_mention) → antes se descartaba en seco y se perdía a alguien que
  //    te está mostrando a su audiencia gratis.
  const adjuntos   = event.message?.attachments || [];
  const tieneMencion = adjuntos.some(a => a.type === 'story_mention');
  const respuestaHistoria = !!event.message?.reply_to?.story;
  let text = event.message?.text;

  // Solo tratamos como "mención pura" la que NO trae texto. Si la persona
  // etiquetó Y escribió ("te etiqueté, ¿tienes el negro?"), lo que manda es su
  // pregunta — decirle al agente "no te escribió" lo haría ignorarla.
  const esMencion = tieneMencion && !text;
  if (esMencion) {
    // Sin texto no hay nada que "responder": el propio evento es el mensaje.
    text = '[TE MENCIONÓ EN SU HISTORIA]';
  }
  if (!text) return;

  // Find account.
  // Instagram identifica la misma cuenta con dos IDs distintos: el que llega en
  // el webhook (entry.id) y el que devuelve el login (ig_platform_id). Se busca
  // por ambos para que un mensaje no se pierda por esa diferencia.
  let account = await db.findOne(db.accounts, { ig_user_id: pageId });
  if (!account) account = await db.findOne(db.accounts, { ig_platform_id: pageId });
  if (!account) {
    console.log('No account for ig_user_id:', pageId);
    anotar({ canal: 'instagram', resultado: 'SIN CUENTA', detalle: `ningún registro con id ${pageId}` });
    return;
  }

  // Canal pausado desde Ajustes: el mensaje se recibe pero el agente no atiende.
  // Las credenciales siguen guardadas — reanudar es un clic.
  if (estaPausado(account, 'instagram')) {
    console.log(`⏸️ IG pausado por el dueño — no se responde a ${pageId}`);
    anotar({ canal: 'instagram', resultado: 'PAUSADO', detalle: 'el dueño pausó Instagram en Ajustes' });
    return;
  }

  // Si la cuenta necesita reconexión (token caducado e irrenovable), no generar
  // respuesta — al cliente ya le mandamos email needsReauth desde metaRefresh.
  // Generar reply quemaría OpenAI credits que no se pueden enviar.
  if (account.needs_reauth) {
    console.log(`🔌 DM ignorado (account needs_reauth) para @${account.ig_username || pageId}`);
    return;
  }

  // Check bypass
  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, ig_user_id: senderId });
  if (bypassed) return;

  // Buscar lead existente PRIMERO para que selectAgent respete handoff_state.
  let lead = await db.findOne(db.leads, { account_id: account._id, ig_user_id: senderId });

  // Seleccionar agente. nurture → responde auto; prospect / human_assisted → NO.
  const sel = await selectAgent(account, lead, 'instagram');
  const agent = sel.agent;
  if (!agent) return;
  if (!sel.canAuto) {
    console.log(`⏸️  DM no auto-respondido (${sel.reason}) — @${lead?.ig_username || senderId}. Lo maneja el humano.`);
    return;
  }

  // Una mención en historia no se filtra por keywords: nadie va a etiquetarte
  // escribiendo "precio". Que alguien te muestre a su audiencia YA es la señal.
  if (esMencion) {
    // Anti-spam: una historia suele tener varios frames y cada uno dispara su
    // propio webhook. Sin esto, 4 frames = 4 "gracias por mencionarme"
    // seguidos, 4 llamadas a OpenAI y 4 mensajes contra el plan.
    const desde = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    if (lead?.ultima_mencion_at && lead.ultima_mencion_at > desde) {
      console.log(`⏭️ Mención de @${lead.ig_username} ignorada — ya se agradeció hace menos de 6h`);
      return;
    }
  }

  if (!lead && !esMencion) {
    // ── KEYWORD GATE: Si es el primer mensaje, verificar keywords del agente ──
    if (!containsTrigger(text, agent)) {
      console.log(`🔒 DM ignorado (sin keyword) de ${senderId}: "${text}"`);
      return;
    }
  }

  if (!lead) {
    // Keyword detectada → crear lead y activar bot
    const userInfo = await getIGUserInfo(senderId, account.access_token);
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      ig_user_id: senderId, ig_username: userInfo.username || senderId,
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false, pipeline_stage: 'nuevo',
      triggered_by: esMencion ? 'story_mention' : 'dm_keyword',
      last_message_at: new Date().toISOString()
    });
    console.log(esMencion
      ? `📣 Lead creado por mención en historia de @${lead.ig_username}`
      : `🔑 Bot activado por keyword "info" en DM de @${lead.ig_username}`);
  }

  if (lead.automation !== 'automated' || lead.is_bypassed) return;

  if (esMencion) {
    await db.update(db.leads, { _id: lead._id }, { ultima_mencion_at: new Date().toISOString() }).catch(() => null);
  }

  await runConversation({ account, agent, lead, senderId, text, esMencion, respuestaHistoria });
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
  const commentId     = commentData?.id;

  // Find account + agent (una sola vez)
  let account = await db.findOne(db.accounts, { ig_user_id: pageId });
  if (!account) account = await db.findOne(db.accounts, { ig_platform_id: pageId });
  if (!account) return;
  if (account.needs_reauth) {
    console.log(`🔌 Comment ignorado (account needs_reauth) para @${account.ig_username || pageId}`);
    return;
  }
  if (estaPausado(account, 'instagram')) {
    console.log(`⏸️ Comment ignorado (IG pausado por el dueño) para @${account.ig_username || pageId}`);
    return;
  }

  // BUCLE: nuestra propia respuesta pública genera otro webhook de comentario.
  // Dos cortes independientes — si el id viene con otro scope, el parent_id
  // salva igual: nuestras respuestas SIEMPRE son respuestas a otro comentario,
  // y a una respuesta anidada nunca hay que contestarle.
  if (commentData?.parent_id) return;
  const propios = [account.ig_user_id, account.ig_platform_id, pageId].filter(Boolean);
  const mismoUsuario = account.ig_username && commenterName &&
    String(commenterName).toLowerCase() === String(account.ig_username).toLowerCase();
  if (propios.includes(commenterIgId) || mismoUsuario) return;

  // Meta rechaza la private reply pasados 7 días del comentario: no gastamos
  // una llamada a OpenAI en algo que no se va a poder enviar.
  if (commentData?.created_time) {
    const edadMs = Date.now() - new Date(
      typeof commentData.created_time === 'number'
        ? commentData.created_time * 1000
        : commentData.created_time
    ).getTime();
    if (Number.isFinite(edadMs) && edadMs > 7 * 24 * 3600 * 1000) {
      console.log(`⌛ Comentario de @${commenterName} tiene más de 7 días — Meta ya no permite responder por privado`);
      return;
    }
  }
  // ── Regla de ESTA publicación (lo de ManyChat) ────────────────────────────
  // Si el post tiene su propia palabra clave, manda esa. Si no tiene regla,
  // todo sigue como antes: las keywords del agente.
  let regla = mediaId
    ? await db.findOne(db.postRules, { account_id: account._id, media_id: String(mediaId), enabled: true })
    : null;
  // Una regla sin keywords haría que containsTrigger devuelva true para TODO
  // comentario de ese post. Ante la duda, se ignora la regla.
  if (regla && !String(regla.keywords || '').trim()) {
    console.warn(`[reglas] la regla del post ${mediaId} no tiene keywords — se ignora`);
    regla = null;
  }
  if (mediaId) console.log(`💬 Comentario en media ${mediaId} — ${regla ? `regla: "${regla.keywords}"` : 'sin regla, usa las keywords del agente'}`);

  // Cargar el lead ANTES de elegir agente: si el dueño tomó el control de esa
  // persona (handoff_state), selectAgent tiene que verlo — si no, un comentario
  // pisaría la conversación que el humano está trabajando.
  const leadPrevio = commenterIgId
    ? await db.findOne(db.leads, { account_id: account._id, ig_user_id: commenterIgId })
    : null;
  const sel = await selectAgent(account, leadPrevio, 'instagram');
  // La regla puede fijar qué agente atiende ese post; si el agente elegido no
  // existe o está apagado, se cae al que resolvió selectAgent.
  let agent = sel.agent;
  if (regla?.agent_id && typeof regla.agent_id === 'string') {
    const agenteRegla = await db.findOne(db.agents, {
      _id: regla.agent_id, account_id: account._id, enabled: true,
    });
    // El agente de la regla tiene que pasar los MISMOS filtros que el que
    // elige selectAgent: un agente 'prospect' auto-respondiendo un primer
    // contacto frío es exactamente lo que Meta castiga con baneo, y uno de
    // WhatsApp no debe contestar comentarios de Instagram.
    if (agenteRegla && canSendAuto(agenteRegla) && servesChannel(agenteRegla, 'instagram')) {
      agent = agenteRegla;
    } else if (agenteRegla) {
      console.warn(`[reglas] el agente fijado en la regla del post ${mediaId} no puede auto-responder por Instagram — se usa el agente por defecto`);
    }
  }

  // El disparo: la keyword de la regla si existe, si no la del agente.
  const disparo = regla
    ? containsTrigger(commentText, { trigger_keywords: regla.keywords })
    : containsTrigger(commentText, agent);

  if (!commenterIgId || !agent || !sel.canAuto || !disparo) {
    if (commenterIgId && agent && !sel.canAuto) console.log(`⏸️  Comentario no auto-respondido (${sel.reason}).`);
    else if (commenterIgId) console.log(`💬 Comentario ignorado (sin keyword): "${commentText}"`);
    return;
  }

  // Check bypass
  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, ig_user_id: commenterIgId });
  if (bypassed) return;

  // Dedup por COMENTARIO: Meta permite una sola private reply por comentario,
  // y el webhook puede reintentar. Se chequea antes que nada.
  if (commentId) {
    const yaRespondido = await db.findOne(db.leads, {
      account_id: account._id, triggered_comment_id: commentId,
    });
    if (yaRespondido) {
      console.log(`⏭️ Ya respondimos el comentario ${commentId} de @${commenterName}`);
      return;
    }
  }

  // Dedup por POST: no perseguir a la misma persona dos veces por la misma
  // publicación aunque comente varias veces.
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
  let lead = leadPrevio;
  if (!lead) {
    // El handle real viene en el webhook. getIGUserInfo NO sirve acá: para
    // alguien sin conversación previa sus dos intentos fallan y devuelve el ID
    // numérico como "username" — que terminaría publicado en el post.
    let username = commenterName;
    if (!username || username === commenterIgId) {
      const userInfo = await getIGUserInfo(commenterIgId, account.access_token);
      username = userInfo.username || commenterIgId;
    }
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      ig_user_id: commenterIgId, ig_username: username,
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false, pipeline_stage: 'nuevo',
      triggered_by: 'comment',
      triggered_media_id: mediaId,
      triggered_comment_id: commentId,   // sin esto el dedup por comentario es letra muerta
      last_message_at: new Date().toISOString()
    });
  } else {
    // Actualizar para marcar el nuevo trigger
    await db.update(db.leads, { _id: lead._id }, {
      triggered_by: 'comment',
      triggered_media_id: mediaId,
      triggered_comment_id: commentId,
      last_message_at: new Date().toISOString()
    });
  }

  console.log(`💬→📩 Comentario de @${lead.ig_username} ("${commentText.slice(0, 40)}") → private reply`);

  // Generar y encolar el DM. commentId hace que salga como private reply.
  const encolado = await runConversation({
    account, agent, lead,
    senderId: commenterIgId,
    text: commentText,           // el comentario es el "mensaje" inicial
    isCommentTrigger: true,
    commentId,
    entregar: regla?.entregar || null,   // qué debe entregar en ESTE post
  });

  // Respuesta PÚBLICA — SOLO si el DM quedó encolado. Publicar "te escribí al
  // privado" cuando el DM no va a salir (lead en manos de un humano, límite de
  // plan) deja al cliente quedando mal en su propio post, a la vista de todos.
  // Además exige keywords: sin ellas el agente responde a TODO comentario, y
  // no queremos comentar bajo un reclamo.
  // La regla puede traer su propia respuesta pública; si no, la del agente.
  const textoPublico = regla?.public_reply || agent.comment_public_reply;
  // Con regla, la keyword ya es específica de ese post: no hace falta exigir
  // keywords al agente (esa exigencia existe para no comentar bajo cualquier cosa).
  if (encolado && commentId && textoPublico && (regla || (agent.trigger_keywords || '').trim())) {
    try {
      const { replyToComment } = require('../services/meta');
      const handle = commenterName && commenterName !== commenterIgId ? commenterName : lead.ig_username;
      await replyToComment({
        commentId,
        text: textoPublico.replaceAll('{usuario}', `@${handle}`),
        accessToken: account.access_token,
      });
      console.log(`💬 Respuesta pública dejada en el comentario de @${handle}`);
    } catch (e) {
      console.warn('[comentarios] respuesta pública falló (no bloquea el DM):', e.response?.data?.error?.message || e.message);
    }
  }
}

// ── HANDLER: MENSAJE DE WHATSAPP ──────────────────────────────────────────────
// Recibe mensajes entrantes de la Cloud API de WhatsApp.
// El account se identifica por wa_phone_number_id (único por número WSP).
// El sender se identifica por wa_id (formato sin '+', ej "5491155...").
async function handleWhatsAppMessage(phoneNumberId, msg, value) {
  // Se procesan texto, audio (notas de voz → Whisper) e imagen (→ GPT-4o visión).
  // Video/documentos se ignoran por ahora.
  const isText  = msg.type === 'text'  && !!msg.text?.body;
  const isAudio = msg.type === 'audio' && !!msg.audio?.id;
  const isImage = msg.type === 'image' && !!msg.image?.id;

  // Respuesta al PERMISO DE LLAMADA por WhatsApp (botón oficial de Meta):
  // no es un mensaje para el agente, es el consentimiento que Meta exige
  // antes de que el negocio pueda llamar. Se registra y, si aceptó, la
  // llamada que estaba esperando se programa sola.
  if (msg.type === 'interactive' && msg.interactive?.type === 'call_permission_reply') {
    try {
      const account = await wa.findAccountByPhoneNumberId(phoneNumberId);
      if (!account) return;
      const lead = await db.findOne(db.leads, { account_id: account._id, wa_id: msg.from });
      if (!lead) return;
      const { procesarRespuestaPermiso } = require('../services/whatsappCalling');
      const r = await procesarRespuestaPermiso({ account, lead, interactive: msg.interactive });
      console.log(`📲 [wa] permiso de llamada ${r.acepto ? 'ACEPTADO' : 'rechazado'} por ${msg.from}`);
    } catch (e) { console.error('[wa] call_permission_reply error:', e.message); }
    return;
  }

  if (!isText && !isAudio && !isImage) {
    console.log(`[wa] tipo no soportado: ${msg.type} de ${msg.from}`);
    return;
  }

  const senderId = msg.from;
  const senderName = value.contacts?.[0]?.profile?.name || senderId;

  // Find account by phone_number_id
  const account = await wa.findAccountByPhoneNumberId(phoneNumberId);
  if (!account) {
    console.log(`[wa] no account para phone_number_id: ${phoneNumberId}`);
    return;
  }

  // WhatsApp usa su PROPIO token (wa_access_token), independiente del token de
  // Instagram. Por eso NO lo bloqueamos por needs_reauth (esa bandera es sobre
  // el token de IG expirado, que no afecta a WhatsApp). Solo saltamos si no hay
  // token de WhatsApp con el cual responder.
  if (!account.wa_access_token) {
    console.log(`🔌 WSP ignorado (sin wa_access_token) para phone ${phoneNumberId}`);
    return;
  }

  // Canal pausado desde Ajustes: se recibe, no se responde, no se pierde nada.
  if (estaPausado(account, 'whatsapp')) {
    console.log(`⏸️ WSP pausado por el dueño — no se responde a phone ${phoneNumberId}`);
    return;
  }

  // ── Media entrante → texto para el pipeline ──────────────────────────────
  // Audio: transcripción Whisper; el flag wasAudio hace que la respuesta
  // salga también como nota de voz (espejo del lead).
  // Imagen: descripción GPT-4o visión inyectada como texto entre corchetes.
  let text;
  let wasAudio = false;
  let wasImage = false;
  if (isText) {
    text = msg.text.body;
  } else {
    const settings = await db.findOne(db.settings, { account_id: account._id });
    const apiKey   = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) {
      console.log(`[wa] media ignorado (sin OpenAI key) de ${senderId}`);
      return;
    }
    const { downloadWhatsAppMedia } = require('../services/audio');
    try {
      if (isAudio) {
        const audioSvc = require('../services/audio');
        const media = await downloadWhatsAppMedia({
          mediaId: msg.audio.id,
          accessToken: account.wa_access_token,
        });
        text = await audioSvc.transcribeAudio({ buffer: media.buffer, apiKey });
        if (!text) {
          console.log(`[wa] audio de ${senderId} sin transcripción utilizable`);
          return;
        }
        wasAudio = true;
        console.log(`🎧 WSP audio transcrito de ${senderName}: "${text.slice(0, 80)}..."`);
      } else {
        const { describeImage } = require('../services/vision');
        const media = await downloadWhatsAppMedia({
          mediaId: msg.image.id,
          accessToken: account.wa_access_token,
        });
        const caption = msg.image.caption || null;
        const desc = await describeImage({
          buffer: media.buffer,
          mimeType: media.mimeType || 'image/jpeg',
          caption,
          apiKey,
        });
        text = `[El lead envió una FOTO${caption ? ` con el texto: "${caption}"` : ''}. Lo que se ve: ${desc}]`;
        wasImage = true;
        console.log(`🖼️ WSP imagen descrita de ${senderName}: "${desc.slice(0, 80)}..."`);
      }
    } catch (e) {
      console.error(`[wa] error procesando ${msg.type} de ${senderId}:`, e.message);
      return;
    }
  }

  // Marcar como leído (best-effort, no bloquea)
  if (msg.id && account.wa_access_token) {
    wa.markAsRead({
      phoneNumberId,
      messageId: msg.id,
      accessToken: account.wa_access_token,
    }).catch(() => null);
  }

  // Bypass check (por wa_id)
  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, wa_id: senderId });
  if (bypassed) return;

  // Buscar lead existente primero (mismo modelo que IG) para respetar handoff.
  let lead = await db.findOne(db.leads, { account_id: account._id, wa_id: senderId });

  // Seleccionar agente (nurture → auto; prospect / human_assisted → NO).
  const sel = await selectAgent(account, lead, 'whatsapp');
  const agent = sel.agent;
  if (!agent) return;
  if (!sel.canAuto) {
    console.log(`⏸️  WSP no auto-respondido (${sel.reason}) — ${lead?.wa_name || senderId}. Lo maneja el humano.`);
    return;
  }

  if (!lead) {
    if (!containsTrigger(text, agent)) {
      console.log(`🔒 WSP DM ignorado (sin keyword) de ${senderId}: "${text}"`);
      return;
    }
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      wa_id: senderId,
      wa_name: senderName,
      ig_user_id: senderId,        // Reutilizamos para compatibilidad con inbox actual
      ig_username: senderName,     // Mostrado en UI
      channel: 'whatsapp',
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false, pipeline_stage: 'nuevo',
      triggered_by: 'wa_dm',
      last_message_at: new Date().toISOString()
    });
    console.log(`🔑 WSP bot activado para ${senderName} (${senderId})`);
  }

  if (lead.automation !== 'automated' || lead.is_bypassed) return;

  await runConversation({ account, agent, lead, senderId, text, wasAudio, wasImage });
}

// ── HANDLER: MENSAJE DE MESSENGER (Página de Facebook / Marketplace) ─────────
// El account se identifica por fb_page_id (único por Página). El sender es el
// PSID (Page-Scoped ID). Mismo modelo que WhatsApp: un canal más que alimenta
// el mismo CRM. La derivación a WhatsApp la maneja el prompt (ver runConversation).
async function handleMessengerMessage(pageId, event) {
  const senderId = event.sender?.id;
  const text     = event.message?.text;
  // Ignorar echos (mensajes que envía la propia Página) y eventos sin texto
  // (delivery/read/reactions).
  if (!senderId || !text || event.message?.is_echo) return;

  const account = await msgr.findAccountByPageId(pageId);
  if (!account) { console.log(`[fb] no account para page_id: ${pageId}`); return; }

  // Messenger usa el Page Access Token (fb_page_token), independiente de IG/WSP.
  if (!account.fb_page_token) {
    console.log(`🔌 FB ignorado (sin fb_page_token) para page ${pageId}`);
    return;
  }

  // Canal pausado desde Ajustes.
  if (estaPausado(account, 'messenger')) {
    console.log(`⏸️ FB pausado por el dueño — no se responde a page ${pageId}`);
    return;
  }

  // Marcar visto (best-effort, no bloquea)
  msgr.sendAction({ pageId, recipient: senderId, action: 'mark_seen', accessToken: account.fb_page_token })
    .catch(() => null);

  const bypassed = await db.findOne(db.bypassed, { account_id: account._id, fb_psid: senderId });
  if (bypassed) return;

  let lead = await db.findOne(db.leads, { account_id: account._id, fb_psid: senderId });

  const sel = await selectAgent(account, lead, 'messenger');
  const agent = sel.agent;
  if (!agent) return;
  if (!sel.canAuto) {
    console.log(`⏸️  FB no auto-respondido (${sel.reason}) — PSID ${senderId}. Lo maneja el humano.`);
    return;
  }

  if (!lead) {
    if (!containsTrigger(text, agent)) {
      console.log(`🔒 FB DM ignorado (sin keyword) de ${senderId}: "${text}"`);
      return;
    }
    // Nombre real del sender (best-effort; si falla, mostramos el PSID)
    let name = senderId;
    try {
      const prof = await msgr.getUserProfile({ psid: senderId, accessToken: account.fb_page_token });
      if (prof?.first_name) name = [prof.first_name, prof.last_name].filter(Boolean).join(' ');
    } catch { /* best-effort */ }
    lead = await db.insert(db.leads, {
      account_id: account._id, agent_id: agent._id,
      fb_psid: senderId,
      fb_page_id: String(pageId),
      ig_user_id: senderId,        // compat con inbox actual
      ig_username: name,           // mostrado en UI
      channel: 'messenger',
      status: 'active', automation: 'automated',
      is_bypassed: false, is_converted: false, pipeline_stage: 'nuevo',
      triggered_by: 'fb_dm',
      last_message_at: new Date().toISOString()
    });
    console.log(`🔑 FB bot activado para ${name} (PSID ${senderId})`);
  }

  if (lead.automation !== 'automated' || lead.is_bypassed) return;

  await runConversation({ account, agent, lead, senderId, text });
}

// ── MOTOR PRINCIPAL: genera respuesta IA y envía DM ──────────────────────────
// Devuelve true si dejó una respuesta encolada. El comment-to-DM lo necesita:
// la respuesta PÚBLICA promete un DM, así que no puede publicarse si el DM no
// va a salir (lead en manos de un humano, límite de plan alcanzado…).
async function runConversation({ account, agent, lead, senderId, text, isCommentTrigger = false, commentId = null, entregar = null, esMencion = false, respuestaHistoria = false, wasAudio = false, wasImage = false }) {
  if (lead.automation !== 'automated' || lead.is_bypassed) return false;

  // Guardar mensaje entrante (no cuenta al límite: son los DMs recibidos)
  // media marca el origen: 'audio' = nota de voz (content es su transcripción),
  // 'image' = foto (content es su descripción).
  const mediaTag = wasAudio ? 'audio' : wasImage ? 'image' : null;
  // via:'comment' importa: un comentario NO abre la ventana de 24h, así que el
  // follow-up no puede tratarlo como si el lead nos hubiera escrito.
  await db.insert(db.messages, {
    lead_id: lead._id, role: 'user', content: text,
    ...(mediaTag ? { media: mediaTag } : {}),
    ...(isCommentTrigger ? { via: 'comment' } : {}),
    // Una mención tampoco es un mensaje que la persona escribió: marcarla
    // evita que el follow-up la persiga como si hubiera iniciado conversación.
    ...(esMencion ? { via: 'story_mention' } : {}),
  });
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
    return false;
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
  const knowledge    = knowledgeForAgent(allKnowledge, agent);
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
      magnetContext = `MAGNET ENTREGADO: Acabas de enviarle al lead "${delivery.magnet.title}" a su email (${delivery.email}). Confirma brevemente en tu respuesta ("listo, te lo mandé al mail, revísalo cuando puedas") y sigue la conversación natural. NO pidas el email de nuevo.`;
    } else if (delivery.alreadyDelivered) {
      magnetContext = `NOTA: Al lead ya le entregaste "${delivery.magnet.title}" antes. No vuelvas a ofrecerlo ni a pedirle email.`;
    }
  } catch (e) { console.warn('magnetDelivery skip:', e.message); }

  // Contexto extra si fue disparado por comentario.
  // OJO: es la ÚNICA private reply que Meta permite por comentario, así que
  // este mensaje tiene que valer por sí solo — no puede ser un "hola, ¿en qué
  // te ayudo?" que desperdicie el tiro.
  const contextoHistoria = esMencion
    ? `NOTA: Esta persona te MENCIONÓ EN SU HISTORIA — te está mostrando a su audiencia, gratis. No te escribió un mensaje: la mención ES el evento.
Tu respuesta: agradécele de verdad, corto y humano (una o dos líneas), sin sonar a plantilla y sin venderle nada en este mensaje. Si su historia da pie a algo concreto (mostró tu producto, fue a tu local), menciónalo. Termina con una pregunta simple y abierta solo si fluye; si no, deja el agradecimiento solo.`
    : respuestaHistoria
    ? `NOTA: Esta persona está RESPONDIENDO A UNA HISTORIA TUYA (no escribió de la nada). Responde en ese contexto, natural, como sigue una conversación que ya empezó — no la saludes como si fuera un primer contacto.`
    : null;

  const baseContext = isCommentTrigger
    ? `NOTA: Esta persona comentó "${String(text).slice(0, 80)}" en una publicación tuya y este es el PRIMER mensaje que recibe de ti, por privado.
Reglas para este mensaje:
- Es el único mensaje que puedes enviar hasta que la persona responda: tiene que entregar valor por sí solo, no puede ser solo un saludo.
${entregar
  ? `- ESTO ES LO QUE TIENES QUE ENTREGARLE (es lo prometido en esa publicación, va sí o sí en el mensaje): ${entregar}`
  : '- Preséntate en una línea y entrega LO QUE VINO A BUSCAR según su comentario (la info, el precio, el link, lo que corresponda de tu base de conocimiento).'}
- Cierra con UNA sola pregunta que invite a responder.
- Natural y corto, como un DM real. Nada de "gracias por comentar en nuestra publicación".`
    : null;

  // ── RAG: few-shot dinámico (memoria de conversaciones anteriores) ────────
  // Inyecta ejemplos/insights relevantes del mismo cliente. Si el RAG no está
  // configurado (sin SUPABASE_URL), retrieveContext devuelve null → el agente
  // responde exactamente como hoy. Best-effort, nunca bloquea la respuesta.
  let ragContext = null;
  try {
    const { retrieveContext } = require('../services/rag/retrieve');
    ragContext = await retrieveContext({ accountId: account._id, message: text, apiKey });
  } catch (e) { /* RAG opcional — si falla, seguimos sin él */ }

  // ── Messenger (Marketplace): calificar y derivar a WhatsApp ──────────────
  // En este canal el objetivo NO es cerrar, es filtrar: saludar, calificar el
  // interés y, si el lead es un prospecto real, invitarlo a seguir por WhatsApp
  // (donde vive el hub de venta). Los curiosos sin intención se atienden con
  // calidez pero sin insistir.
  let messengerHandoff = null;
  if (lead.channel === 'messenger') {
    // Con link clickeable la derivación convierte más que dictar el número:
    // en Messenger un wa.me se abre con un toque.
    let waHint = '';
    if (account.wa_display_number) {
      const { digitosWhatsapp } = require('../services/accessLinks');
      const digitos = digitosWhatsapp(account.wa_display_number);
      waHint = digitos
        ? ` (pásale este link para seguir por WhatsApp: https://wa.me/${digitos})`
        : ` (escríbeme al ${account.wa_display_number})`;
    }
    messengerHandoff = `CANAL MESSENGER / MARKETPLACE. Tu trabajo acá es SALUDAR y CALIFICAR, no cerrar la venta. Descubre si hay intención real (pregunta precio, disponibilidad para ver el producto, forma de pago, o señales claras de compra). Si el lead es un prospecto real, invítalo a seguir la conversación por WhatsApp${waHint} para coordinar los detalles/la visita — ahí se cierra. Si solo está curioseando, responde cálido y breve, sin empujar. Nunca copies datos sensibles ni cierres el trato en este canal.`;
  }

  // Si el lead habló por nota de voz, el agente debe saberlo: responde más
  // conversacional y la respuesta saldrá también como audio (espejo).
  const audioContext = wasAudio
    ? 'NOTA: el lead te envió una NOTA DE VOZ — lo que lees es su transcripción. Tu respuesta se le enviará como nota de voz hablada: redacta como se habla (frases cortas, sin listas, sin emojis). Si necesitas compartir un link, inclúyelo normal y el mensaje saldrá como texto en vez de audio.'
    : null;

  // ── Memoria por lead: hechos de conversaciones anteriores (cualquier canal)
  let memoryContext = null;
  try {
    const { buildMemoryContext } = require('../services/leadMemory');
    memoryContext = buildMemoryContext(lead);
  } catch (e) { /* memoria opcional */ }

  // ── Cobro in-chat: capacidad solo si la cuenta tiene Mercado Pago ─────────
  let paymentContext = null;
  try {
    const { buildPaymentContext } = require('../services/payments');
    paymentContext = buildPaymentContext(settings);
  } catch (e) { /* pagos opcional */ }

  // ── Agenda in-chat: capacidad solo si la cuenta conectó Google Calendar ───
  // (con la disponibilidad real de los próximos 7 días; fail-closed si falla)
  let calendarContext = null;
  try {
    const { buildCalendarContext } = require('../services/calendar');
    calendarContext = await buildCalendarContext(settings, account._id);
  } catch (e) { /* agenda opcional */ }

  // ── ¿Te sigue? Cambia el guion: a quien ya te sigue no le explicas quién
  // eres ni le pides que te siga. Meta solo entrega el dato de quien TE
  // ESCRIBIÓ (un comentario no basta), así que no se consulta en ese caso.
  let followerContext = null;
  if (!isCommentTrigger) {
    try {
      const fs = require('../services/followerStatus');
      if (fs.necesitaChequeo(lead)) lead = await fs.refrescarEstado(lead, account);
      followerContext = fs.buildFollowerContext(lead, { esMencion });
    } catch (e) { /* dato opcional, nunca bloquea */ }
  }

  // ── Pedido de Shopify pendiente: el agente confirma el despacho ───────────
  let orderContext = null;
  try {
    const { buildOrderContext } = require('../services/shopify');
    orderContext = buildOrderContext(lead);
  } catch (e) { /* pedidos opcional */ }

  // ── Llamada telefónica: capacidad solo si TODO está dado ──────────────────
  // (Twilio configurado + interruptores cuenta/agente + horario + topes +
  //  lead CALIENTE o que pidió la llamada). Fail-closed en cada condición.
  let llamadaContext = null;
  try {
    const { buildLlamadaContext } = require('../services/telefonia');
    llamadaContext = await buildLlamadaContext({ settings, agent, lead, incomingText: text, account });
  } catch (e) { /* telefonía opcional */ }

  const extraContext = [baseContext, contextoHistoria, messengerHandoff, magnetContext, audioContext, memoryContext, followerContext, paymentContext, calendarContext, orderContext, llamadaContext, ragContext].filter(Boolean).join('\n\n') || null;

  let reply = await generateReply({
    agent, knowledge, links,
    conversationHistory: history.slice(0, -1),
    newMessage: text,
    accountId: account._id,
    apiKey,
    extraContext,
    qualification: lead.qualification || null,
    leadPhone:     lead.wa_id || null,
    leadChannel:   lead.channel || (lead.wa_id ? 'whatsapp' : 'instagram'),
  });

  // ── Resolver marcadores [PAGO: ...] → link real de Mercado Pago ──────────
  // Antes de guardar/encolar, para que DB y cola tengan el texto final.
  // Fail-closed: sin token o con error, el marcador se elimina y el mensaje
  // sale igual.
  try {
    const { resolvePaymentMarkers } = require('../services/payments');
    const resolved = await resolvePaymentMarkers(reply, {
      settings, accountId: account._id, leadId: lead._id,
    });
    reply = resolved.text;
    if (resolved.links.length) {
      console.log(`💳 [${agent.name}] Link de pago generado para @${lead.ig_username}: $${resolved.links[0].amount} CLP`);
    }
  } catch (e) { console.warn('[pago] resolución de marcadores falló (no bloquea):', e.message); }

  // ── Resolver marcadores [AGENDAR: ...] → cita real en Google Calendar ─────
  // Mismo contrato que el pago: fail-closed, el marcador nunca rompe el mensaje.
  try {
    const { resolveCalendarMarkers } = require('../services/calendar');
    const agendado = await resolveCalendarMarkers(reply, {
      settings, accountId: account._id, leadId: lead._id,
      leadName: lead.wa_name || lead.ig_username,
    });
    reply = agendado.text;
    if (agendado.events.length) {
      console.log(`📅 [${agent.name}] Cita agendada para @${lead.ig_username}: ${agendado.events[0].when}`);
    }
  } catch (e) { console.warn('[agenda] resolución de marcadores falló (no bloquea):', e.message); }

  // ── Resolver marcadores [PEDIDO: ...] → estado del pedido de Shopify ──────
  try {
    const { resolveOrderMarkers } = require('../services/shopify');
    const pedido = await resolveOrderMarkers(reply, { lead, accountId: account._id });
    reply = pedido.text;
  } catch (e) { console.warn('[shopify] resolución de marcadores falló (no bloquea):', e.message); }

  // Calcular delay humanizador (5-15s default, configurable por agente)
  // Bajamos default de 30-90s a 5-15s tras feedback: setters/closers necesitan
  // respuesta rápida para no perder leads HOT. 5-15s sigue siendo "humano-like"
  // (un humano tipea en ~10s) sin parecer bot instantáneo.
  // Se calcula ACÁ (antes de resolver [LLAMAR]) porque la llamada se ancla al
  // momento real en que este mensaje sale: el aviso siempre llega primero.
  const delayMin = agent.delay_min ?? 5;
  const delayMax = agent.delay_max ?? 15;
  const stepSize = (delayMax - delayMin) >= 30 ? 10 : 5; // pasos de 10s para ranges grandes, 5s para chicos
  const steps = Math.floor((delayMax - delayMin) / stepSize) + 1;
  const delaySeconds = delayMin + Math.floor(Math.random() * steps) * stepSize;
  const sendAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  // ── Resolver marcadores [LLAMAR: ...] → llamada telefónica programada ─────
  // El modelo propone, el servidor decide: acá se re-validan TODOS los
  // candados (consentimiento, horario, topes, teléfono dicho por el lead).
  // La llamada se marca 20 s DESPUÉS de que este aviso sale (sendAt + tick
  // del worker), para que llegue antes que el timbre. Fail-closed: el
  // marcador jamás rompe el mensaje.
  try {
    const { resolveLlamadaMarkers } = require('../services/telefonia');
    // +10 s: el worker de envíos corre cada 10 s; el mensaje sale en el primer
    // tick posterior a sendAt. Anclar al peor caso evita que suene antes.
    const avisoSaleAt = new Date(new Date(sendAt).getTime() + 10_000).toISOString();
    const llamado = await resolveLlamadaMarkers(reply, { settings, account, agent, lead, avisoSaleAt });
    reply = llamado.text;
    if (llamado.llamadas.length) {
      console.log(`📞 [${agent.name}] Llamada programada para @${lead.ig_username || lead.wa_name}: ${llamado.llamadas[0].telefono}`);
    }
  } catch (e) { console.warn('[llamada] resolución de marcadores falló (no bloquea):', e.message); }

  // Red de seguridad: si el LLM respondió SOLO con un marcador, el scrub deja
  // el texto vacío y el envío moriría en failedSends tras 5 reintentos — la
  // clienta confirma su pedido y no recibe nada. Acuse mínimo en su lugar.
  if (!reply || !reply.trim()) {
    console.warn(`[${agent.name}] reply vacío tras resolver marcadores — se envía acuse mínimo`);
    reply = 'Listo, quedó registrado 👌';
  }

  // Guardar respuesta del agente
  await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: reply });

  // ── RAG: actualizar score de cierre del lead (async, best-effort) ─────────
  // No bloquea la respuesta; si el RAG está apagado, scoreLead devuelve null.
  try {
    const { scoreLead } = require('../services/rag/score');
    scoreLead(lead, apiKey).catch(() => {});
  } catch (e) { /* RAG opcional */ }

  // ── Memoria por lead: extraer/actualizar hechos (async, best-effort) ──────
  try {
    const { updateLeadMemory } = require('../services/leadMemory');
    updateLeadMemory({ leadId: lead._id, apiKey }).catch(() => {});
  } catch (e) { /* memoria opcional */ }

  // (delaySeconds / sendAt ya calculados arriba, antes de resolver [LLAMAR])

  // Guardar en queue persistente — sobrevive reinicios de Railway
  // Channel-aware: el worker dispatchea a Instagram, WhatsApp o Messenger según `channel`.
  const ch = lead.channel === 'whatsapp' ? 'whatsapp'
           : lead.channel === 'messenger' ? 'messenger'
           : 'instagram';
  const pendingItem = {
    channel:      ch,
    recipientId:  senderId,
    text:         reply,
    accessToken:  ch === 'whatsapp'  ? (account.wa_access_token || account.access_token)
                : ch === 'messenger' ? account.fb_page_token
                : account.access_token,
    accountId:    account._id,     // Para incrementar contador de DMs al enviar
    lead_id:      lead._id,        // Supresión 21.719: la cola (y failedSends, que la hereda) debe poder borrarse por lead
    sendAt,
    leadUsername: lead.ig_username || lead.wa_name || senderId,
    agentName:    agent.name,
  };
  if (ch === 'whatsapp') {
    pendingItem.phoneNumberId = account.wa_phone_number_id;
    // Espejo de voz: si el lead habló, el agente responde hablando (el worker
    // degrada a texto si el reply es muy largo, trae link o el TTS falla).
    // Se puede apagar por agente con voice_replies: false.
    if (wasAudio && agent.voice_replies !== false) {
      pendingItem.replyAsVoice = true;
      // Voz configurable por agente (probar con POST /api/admin/probar-voces).
      if (agent.voice) pendingItem.voice = agent.voice;
    }
  } else if (ch === 'messenger') {
    pendingItem.pageId = account.fb_page_id;
  } else {
    pendingItem.igUserId = account.ig_platform_id || account.ig_user_id;
    // Disparado por comentario: quien comentó NUNCA nos escribió, así que no
    // hay ventana de 24h y un DM normal se rechaza. El worker tiene que usar
    // la private reply contra el ID del comentario.
    if (commentId) pendingItem.commentId = commentId;
  }
  await db.insert(db.pendingSends, pendingItem);
  const channelLabel = ch === 'whatsapp' ? '📱WSP' : ch === 'messenger' ? '📨FB' : '📷IG';
  console.log(`⏱ ${channelLabel} [${agent.name}] Reply a @${pendingItem.leadUsername} programado en ${delaySeconds}s (${sendAt})`);

  console.log(`💬 [${agent.name}] → @${lead.ig_username}: ${reply.substring(0, 80)}...`);

  // ── Clasificar lead (async, sin bloquear) ──────────────────────────────────
  const fullHistory = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const prevQualification = lead.qualification || null;
  classifyLead({ conversationHistory: fullHistory, accountId: account._id, apiKey }).then(async result => {
    if (!result?.qualification) return;

    // Auto-progresión de etapa CRM según qualification (no degrada etapas
    // manuales avanzadas como demo/propuesta/ganado/perdido).
    const newStage = PIPE.autoStageFromQualification(
      lead.pipeline_stage, result.qualification, lead.is_converted
    );
    const stageUpd = {};
    if (newStage && newStage !== lead.pipeline_stage) {
      stageUpd.pipeline_stage = newStage;
      stageUpd.stage_changed_at = new Date().toISOString();
    }

    await db.update(db.leads, { _id: lead._id }, {
      qualification: result.qualification,
      qualification_reason: result.reason,
      qualification_updated_at: new Date().toISOString(),
      ...stageUpd,
    }).catch(e => console.error('classifyLead update error:', e));
    const stageLog = stageUpd.pipeline_stage ? ` · etapa→${stageUpd.pipeline_stage}` : '';
    console.log(`🎯 [@${lead.ig_username}] → ${result.qualification.toUpperCase()}: ${result.reason}${stageLog}`);

    // ── Evento facturable: lead calificado HOT (transición, con dedup) ──────
    // Base del pricing por resultado (Tier 3): registro objetivo y auditable
    // de cada outcome que el agente produce. Hoy solo se CUENTA — el cobro
    // por outcome se activa cuando el plan lo incluya.
    if (result.qualification === 'hot' && prevQualification !== 'hot') {
      try {
        const yaExiste = await db.findOne(db.billableEvents, { lead_id: lead._id, type: 'lead_calificado' });
        if (!yaExiste) {
          await db.insert(db.billableEvents, {
            account_id: account._id,
            lead_id: lead._id,
            type: 'lead_calificado',
            detalle: result.reason || null,
          });
        }
      } catch (e) { /* contador best-effort */ }
    }

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

    // ── Resumen automático si transicionó a TIBIO (warm) ─────────────────────
    if (result.qualification === 'warm' && prevQualification !== 'warm') {
      try {
        const { notifyLeadEvent } = require('../services/notifications');
        const owner = await db.findOne(db.users, { account_id: account._id });
        if (owner) {
          const r = await notifyLeadEvent({ userId: owner._id, leadId: lead._id, event: 'tibio' });
          const channels = (r.sent || []).filter(s => s.ok).map(s => s.channel).join(', ');
          if (channels) console.log(`🌤️ Resumen TIBIO enviado a ${owner.email} (${channels}) para @${lead.ig_username}`);
        }
      } catch (e) { console.error('notifyLeadEvent(tibio) error:', e.message); }
    }
  }).catch(e => console.error('classifyLead error:', e));

  return true; // respuesta encolada
}

// ── WEBHOOK DE MERCADO PAGO ──────────────────────────────────────────────────
// POST /webhook/mercadopago?acc=<accountId>&lead=<leadId>
// MP notifica; NO confiamos en el body: se consulta el pago a la API de MP
// con el token de la cuenta y solo se actúa si está aprobado y el
// external_reference calza. Siempre 200 (MP reintenta ante otros códigos).
router.post('/mercadopago', async (req, res) => {
  res.sendStatus(200);
  try {
    const accountId = String(req.query.acc || '');
    const leadId    = String(req.query.lead || '');
    const paymentId = req.body?.data?.id || req.query['data.id'] || req.query.id;
    const type      = req.body?.type || req.query.type || req.query.topic;
    if (!accountId || !leadId || !paymentId) return;
    if (type && !String(type).includes('payment')) return;

    const { handleMpNotification } = require('../services/payments');
    const r = await handleMpNotification({ accountId, leadId, paymentId });
    if (!r.ok) console.log(`[MP] notificación ignorada (${r.reason}) — payment ${paymentId}`);
  } catch (e) {
    console.error('[MP] webhook error:', e.response?.data || e.message);
  }
});

// ── WEBHOOK DE SHOPIFY ───────────────────────────────────────────────────────
// POST /webhook/shopify?acc=<accountId>  ·  topic orders/create (y orders/paid)
//
// Entra un pedido → se crea/actualiza el lead con el pedido en su ficha → sale
// el mensaje de confirmación por WhatsApp (template aprobado). Cuando la
// clienta responde, el flujo normal de WhatsApp la encuentra por wa_id y el
// agente ya tiene el pedido en contexto.
//
// Seguridad: HMAC-SHA256 del cuerpo CRUDO con el secret de LA CUENTA
// (fail-closed: sin secret configurado se rechaza todo). 401 ante firma
// inválida — Shopify no debe reintentar un payload que no es nuestro.
router.post('/shopify', async (req, res) => {
  try {
    const accountId = String(req.query.acc || '');
    if (!accountId) return res.status(400).json({ error: 'falta acc' });

    const settings = await db.findOne(db.settings, { account_id: accountId });
    const secret = settings?.shopify_webhook_secret;
    // 200 (no 403) a propósito: Shopify reintenta ~19 veces en 48h ante
    // cualquier no-2xx y termina BORRANDO la suscripción. Si el dueño
    // desconectó la tienda, queremos que deje de mandar, no que se autodestruya
    // el webhook. La firma inválida sí responde 401 (señal real de problema).
    if (!secret) return res.status(200).json({ ignored: 'cuenta sin Shopify configurado' });

    const shopify = require('../services/shopify');
    const firmaOk = shopify.verifyWebhook(
      req.rawBody, req.get('X-Shopify-Hmac-Sha256'), secret
    );
    if (!firmaOk) {
      console.warn(`[shopify] firma inválida para cuenta ${accountId}`);
      return res.status(401).json({ error: 'firma inválida' });
    }

    // ACK inmediato: Shopify corta a los 5s y reintenta. El trabajo sigue abajo.
    res.sendStatus(200);

    // UN solo topic por cuenta (default orders/create). Aceptar create Y paid
    // provocaba una carrera real: Shopify dispara ambos con milisegundos de
    // diferencia en pedidos pagados online, las dos requests leen el dedup en
    // null y la clienta recibe DOS mensajes (y quedan dos leads con el mismo
    // wa_id). El dueño elige uno en la configuración.
    const topicEsperado = settings.shopify_topic || 'orders/create';
    const topic = req.get('X-Shopify-Topic') || 'orders/create';
    if (topic !== topicEsperado) {
      console.log(`[shopify] topic ${topic} ignorado (la cuenta escucha ${topicEsperado})`);
      return;
    }

    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account) return;

    const orden = shopify.parseOrder(req.body, {
      etaDias: Number(settings.shopify_eta_dias) > 0 ? Number(settings.shopify_eta_dias) : 3,
    });

    // Dedup: orders/create y orders/paid pueden llegar por el mismo pedido, y
    // Shopify reintenta ante cualquier hipo de red.
    const yaProcesado = await db.findOne(db.leads, {
      account_id: accountId, 'shopify_order.orderId': orden.orderId,
    });
    if (yaProcesado) {
      console.log(`[shopify] pedido ${orden.numero} ya procesado — ignorado`);
      return;
    }

    if (!orden.telefono) {
      console.warn(`[shopify] pedido ${orden.numero} sin teléfono utilizable — no se puede contactar`);
      return;
    }

    const agente = await db.findOne(db.agents, { account_id: accountId, enabled: true });
    const pedidoFicha = {
      orderId: orden.orderId, numero: orden.numero, productos: orden.productos,
      direccion: orden.direccion, total: orden.total, moneda: orden.moneda,
      etaLegible: orden.etaLegible, etaIso: orden.etaIso,
      estado: 'pendiente', creado_at: new Date().toISOString(),
    };

    let lead = await db.findOne(db.leads, { account_id: accountId, wa_id: orden.telefono });
    if (lead) {
      // NO se pisa pipeline_stage: un cliente recurrente que ya estaba en
      // "ganado" volvería a "nuevo" quedando contado como convertido en la
      // columna equivocada.
      await db.update(db.leads, { _id: lead._id }, {
        shopify_order: pedidoFicha,
        last_message_at: new Date().toISOString(),
      });
      lead = { ...lead, shopify_order: pedidoFicha };
    } else {
      lead = await db.insert(db.leads, {
        account_id: accountId,
        agent_id: agente?._id || null,
        wa_id: orden.telefono,
        wa_name: orden.nombre,
        ig_user_id: orden.telefono,      // compatibilidad con el inbox actual
        ig_username: orden.nombre,
        channel: 'whatsapp',
        status: 'active', automation: 'automated',
        is_bypassed: false, is_converted: false,
        pipeline_stage: 'nuevo',
        triggered_by: 'shopify_order',
        shopify_order: pedidoFicha,
        last_message_at: new Date().toISOString(),
      });
    }

    // Envío del template. Sin WhatsApp conectado o sin template configurado el
    // pedido queda igual registrado en el lead (el dueño lo ve en el inbox).
    const templateName = settings.shopify_template_name;
    if (!account.wa_phone_number_id || !account.wa_access_token) {
      console.warn(`[shopify] pedido ${orden.numero} registrado pero la cuenta no tiene WhatsApp conectado`);
      return;
    }
    if (!templateName) {
      console.warn(`[shopify] pedido ${orden.numero} registrado pero falta shopify_template_name`);
      return;
    }

    // No abrir una conversación que el agente no va a poder continuar: si el
    // lead está en manos de un humano (bypass/handoff/automatización off), la
    // clienta respondería "sí, confirmo" y nadie le contestaría.
    const enBypass = await db.findOne(db.bypassed, { account_id: accountId, wa_id: orden.telefono });
    if (enBypass || lead.is_bypassed || (lead.automation && lead.automation !== 'automated')) {
      console.warn(`[shopify] pedido ${orden.numero} registrado pero el lead está en manejo humano — no se envía automático`);
      await db.insert(db.messages, {
        lead_id: lead._id, role: 'sistema',
        content: `🛒 Pedido nuevo ${orden.numero} (${orden.productos}) — este lead está en manejo humano, confírmalo tú.`,
      }).catch(() => null);
      return;
    }

    // El template consume cuota del plan igual que cualquier DM saliente.
    const { checkDMAllowance, incrementDMCount } = require('../services/limits');
    const permiso = await checkDMAllowance(accountId).catch(() => ({ allowed: true }));
    if (permiso && permiso.allowed === false) {
      console.warn(`[shopify] pedido ${orden.numero} registrado pero la cuenta alcanzó el límite de mensajes del plan`);
      await db.insert(db.messages, {
        lead_id: lead._id, role: 'sistema',
        content: `⚠️ Pedido ${orden.numero} sin confirmar: la cuenta alcanzó el límite de mensajes de su plan.`,
      }).catch(() => null);
      return;
    }

    const wa = require('../services/whatsapp');
    const params = [
      orden.primerNombre,
      orden.productos,
      orden.direccion || 'no registrada',
      orden.etaLegible,
    ].map(t => ({ type: 'text', text: String(t).slice(0, 250) }));

    try {
      await wa.sendTemplate({
        phoneNumberId: account.wa_phone_number_id,
        recipient: orden.telefono,
        templateName,
        languageCode: settings.shopify_template_lang || 'es',
        components: [{ type: 'body', parameters: params }],
        accessToken: account.wa_access_token,
      });
      // Guardar lo enviado como mensaje del agente: la clienta responde a ESTO
      // y el historial del LLM tiene que reflejarlo.
      await db.insert(db.messages, {
        lead_id: lead._id, role: 'agent',
        content: `Hola ${orden.primerNombre}! Tenemos tu pedido de ${orden.productos} listo para despacho. Dirección registrada: ${orden.direccion || 'no registrada'}. ¿Nos confirmas que está correcta para enviarlo? Llegada estimada: ${orden.etaLegible}.`,
        is_template: true,
      });
      await incrementDMCount(accountId, 1).catch(() => null);
      console.log(`🛒 [shopify] Confirmación enviada — ${orden.numero} a ${orden.telefono}`);
    } catch (e) {
      console.error(`[shopify] no se pudo enviar la confirmación de ${orden.numero}:`,
        e.response?.data?.error?.message || e.message);
      await db.insert(db.messages, {
        lead_id: lead._id, role: 'sistema',
        content: `⚠️ No se pudo enviar la confirmación automática del pedido ${orden.numero}. Contáctala manualmente.`,
      }).catch(() => null);
    }
  } catch (e) {
    console.error('[shopify] webhook error:', e.response?.data || e.message);
  }
});

// ── WEBHOOKS DE TWILIO (llamadas telefónicas salientes) ──────────────────────
// Dos endpoints públicos, los dos con DOBLE candado: el token HMAC por
// llamada (?ll & ?t, acuñado con JWT_SECRET) y la firma X-Twilio-Signature.
// Fail-closed: sin credenciales de Twilio en el entorno responden 403 seco.
// Twilio manda form-urlencoded — el parser global ya lo cubre.

// POST /webhook/twilio/twiml?ll=<llamadaId>&t=<token>
// Twilio lo llama cuando el lead CONTESTA: devolvemos el TwiML que conecta
// el audio de la llamada al WebSocket del puente.
router.post('/twilio/twiml', async (req, res) => {
  try {
    const telefonia = require('../services/telefonia');
    if (!telefonia.telefoniaHabilitada()) return res.status(403).send('Forbidden');

    const llamadaId = String(req.query.ll || '');
    if (!llamadaId || !telefonia.tokenValido(llamadaId, req.query.t)) {
      return res.status(403).send('Forbidden');
    }
    if (!telefonia.firmaTwilioValida(req)) {
      console.warn(`[twilio] twiml con firma inválida para ${llamadaId}`);
      return res.status(403).send('Forbidden');
    }

    const ll = await db.findOne(db.llamadas, { _id: llamadaId });
    // 'en_curso' también vale: el status callback "in-progress" puede llegar
    // ANTES que este fetch de TwiML (carrera real de Twilio).
    if (!ll || !['marcando', 'sonando', 'en_curso'].includes(ll.status)) {
      // Llamada finalizada, cancelada o inexistente: TwiML de colgado.
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }
    if (ll.ws_lock) {
      // Ya hay un stream conectado para esta llamada: un segundo TwiML es
      // un replay — colgado seco.
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }

    res.type('text/xml').send(telefonia.twimlParaLlamada(llamadaId));
  } catch (e) {
    console.error('[twilio] twiml error:', e.message);
    res.status(500).send('Error');
  }
});

// POST /webhook/twilio/status?ll=<llamadaId>&t=<token>
// Ciclo de vida de la llamada. En `completed` Twilio manda CallDuration —
// la duración OFICIAL que manda sobre el cronómetro del puente.
router.post('/twilio/status', async (req, res) => {
  // Twilio reintenta ante non-2xx: se responde 200 salvo fallo de auth.
  try {
    const telefonia = require('../services/telefonia');
    if (!telefonia.telefoniaHabilitada()) return res.status(403).send('Forbidden');

    const llamadaId = String(req.query.ll || '');
    if (!llamadaId || !telefonia.tokenValido(llamadaId, req.query.t)) {
      return res.status(403).send('Forbidden');
    }
    if (!telefonia.firmaTwilioValida(req)) {
      console.warn(`[twilio] status con firma inválida para ${llamadaId}`);
      return res.status(403).send('Forbidden');
    }
    res.sendStatus(200);

    const ll = await db.findOne(db.llamadas, { _id: llamadaId });
    if (!ll) return;

    const st  = String(req.body?.CallStatus || '');
    const dur = Number(req.body?.CallDuration || 0);

    if (st === 'ringing' && ll.status === 'marcando') {
      await db.update(db.llamadas, { _id: llamadaId }, { status: 'sonando' }).catch(() => null);
    } else if (st === 'in-progress' && ['marcando', 'sonando'].includes(ll.status)) {
      await db.update(db.llamadas, { _id: llamadaId }, {
        status: 'en_curso', answered_at: ll.answered_at || new Date().toISOString(),
      }).catch(() => null);
    } else if (st === 'completed') {
      // Si el puente ya finalizó, esto solo corrige la duración con la oficial.
      const conecto = !!ll.answered_at || dur > 0;
      const finalizo = await telefonia.finalizarLlamada(llamadaId, {
        resultado: conecto ? 'terminada' : 'no_contesto',
        duracionSeg: dur,
      });
      if (!finalizo && dur > 0) {
        await db.update(db.llamadas, { _id: llamadaId }, { duracion_seg: dur }).catch(() => null);
        const costo = telefonia.costoEstimadoUSD(dur);
        await db.update(db.llamadas, { _id: llamadaId }, { costo_usd: costo }).catch(() => null);
      }
    } else if (['busy', 'no-answer', 'failed', 'canceled'].includes(st)) {
      const resultado = st === 'busy' || st === 'no-answer' ? 'no_contesto' : 'fallida';
      const finalizo = await telefonia.finalizarLlamada(llamadaId, {
        resultado, duracionSeg: 0, motivo: st,
      });
      // Volver al chat con un mensaje natural, sin insistir (decisión del batch).
      if (finalizo && resultado === 'no_contesto') {
        await telefonia.encolarMensajeNoContesto(ll);
      }
    }
  } catch (e) {
    console.error('[twilio] status error:', e.message);
    if (!res.headersSent) res.sendStatus(200);
  }
});

module.exports = router;
module.exports.leerBitacora = leerBitacora;
