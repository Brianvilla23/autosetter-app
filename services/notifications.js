/**
 * Atinov — Servicio de notificaciones multi-canal
 *
 * Avisa al dueño/closer CUANDO un lead se pone 🔥 HOT — email + WhatsApp
 * + webhook. El objetivo: que el humano pueda saltar a la conversación
 * en vivo antes de que el lead se enfríe.
 *
 * Canales:
 *  • Telegram   → Bot API oficial (gratis, setup 2 min con @BotFather) ← RECOMENDADO
 *  • Email      → Resend (https://resend.com, 3000/mes free, API simple)
 *  • WhatsApp   → CallMeBot (free, el user se auto-registra en minutos)
 *  • Webhook    → POST JSON a URL del user (Zapier/Make/n8n/Discord/Slack)
 *
 * Throttle: nunca más de una notificación por lead cada 30 minutos.
 */

const axios = require('axios');
const db    = require('../db/database');

const THROTTLE_MINUTES = 30;
const APP_URL = () => process.env.APP_URL || 'https://atinov.com';

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL (Resend)
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, from }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  RESEND_API_KEY no configurado — email skip');
    return { ok: false, reason: 'no_api_key' };
  }
  try {
    const res = await axios.post(
      'https://api.resend.com/emails',
      {
        from:    from || process.env.RESEND_FROM || 'Atinov <notificaciones@atinov.com>',
        to:      [to],
        subject, html,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        timeout: 8000,
      }
    );
    return { ok: true, id: res.data?.id };
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error('Resend email error:', msg);
    return { ok: false, reason: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM (Bot API oficial, gratis)
// Setup del user (una vez):
//   1. Abrir Telegram → buscar @BotFather → /newbot → seguir instrucciones
//   2. Copiar el token (ej: 1234567890:AAHqXxx...) → pegar en Atinov
//   3. Abrir el bot creado y enviarle /start
//   4. En Atinov clickear "Detectar chat" → queda listo
// ─────────────────────────────────────────────────────────────────────────────
async function sendTelegram({ botToken, chatId, text }) {
  if (!botToken || !chatId) return { ok: false, reason: 'missing_config' };
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 8000 });
    return { ok: !!res.data?.ok, id: res.data?.result?.message_id };
  } catch (e) {
    const msg = e.response?.data?.description || e.message;
    console.error('Telegram error:', msg);
    return { ok: false, reason: msg };
  }
}

/**
 * Llama getUpdates de un bot recién creado y extrae el chat_id del último
 * mensaje recibido (normalmente /start enviado por el usuario).
 * Se usa desde la UI para auto-detectar el chat_id sin que el usuario
 * tenga que buscarlo manualmente.
 */
async function detectTelegramChatId(botToken) {
  if (!botToken) return { ok: false, reason: 'no_token' };
  try {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
    const res = await axios.get(url, { timeout: 8000 });
    if (!res.data?.ok) return { ok: false, reason: res.data?.description || 'invalid_token' };
    const updates = res.data.result || [];
    if (!updates.length) {
      return { ok: false, reason: 'no_messages', hint: 'Envía /start al bot primero' };
    }
    // Tomar el chat.id del update más reciente con mensaje
    const last = updates
      .slice()
      .reverse()
      .find(u => u.message?.chat?.id || u.edited_message?.chat?.id);
    const chatId = last?.message?.chat?.id || last?.edited_message?.chat?.id;
    const name = last?.message?.chat?.first_name || last?.message?.chat?.username || 'usuario';
    if (!chatId) return { ok: false, reason: 'no_chat_id' };
    return { ok: true, chat_id: String(chatId), name };
  } catch (e) {
    const msg = e.response?.data?.description || e.message;
    return { ok: false, reason: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP (CallMeBot)
// Setup del user (una vez):
//   1. Agrega a contactos +34 644 60 39 49
//   2. Envíale: "I allow callmebot to send me messages"
//   3. Recibe apikey numérica → la pega en Atinov
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsApp({ phone, apikey, text }) {
  if (!phone || !apikey) return { ok: false, reason: 'Falta el número o la API key' };
  // Apikey debe ser numérica (CallMeBot la entrega así)
  const cleanApikey = String(apikey).replace(/[^0-9]/g, '');
  if (!cleanApikey) return { ok: false, reason: 'API key inválida — debe ser sólo números' };
  try {
    // Phone DEBE estar en E.164 sin el "+" (ej: 56912345678)
    const cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 8) return { ok: false, reason: 'Número inválido — usá E.164 sin "+" (ej: 56912345678)' };

    const url = 'https://api.callmebot.com/whatsapp.php';
    const res = await axios.get(url, {
      params: { phone: cleanPhone, apikey: cleanApikey, text },
      timeout: 10000,
    });
    // CallMeBot devuelve 200 + HTML; success si contiene "Message queued"
    const body = String(res.data || '');
    const ok = /Message queued|Message sent/i.test(body);

    // Si falló, intentamos extraer mensaje legible del HTML que devuelve
    let reason = null;
    if (!ok) {
      // Pistas comunes de CallMeBot:
      if (/APIKey is invalid/i.test(body))               reason = 'API key inválida. Repetí el setup en CallMeBot (mensaje "I allow callmebot to send me messages") y usá la API key REAL que te enviaron, no el placeholder.';
      else if (/You need to ask for the APIKey/i.test(body)) reason = 'Todavía no completaste el setup. Mandale "I allow callmebot to send me messages" al +34 644 60 39 49 desde tu WhatsApp y esperá la respuesta con tu API key.';
      else if (/Phone Number is not Valid/i.test(body))  reason = 'Número inválido. Usá formato E.164 sin "+" (ej: 56912345678).';
      else if (/User is not registered/i.test(body))     reason = 'Tu número no está registrado en CallMeBot. Hacé el setup primero (paso 2 de las instrucciones).';
      else                                                reason = 'CallMeBot rechazó el envío: ' + body.replace(/<[^>]+>/g, '').slice(0, 160).trim();
    }
    return { ok, response: body.slice(0, 200), reason };
  } catch (e) {
    console.error('CallMeBot error:', e.message);
    return { ok: false, reason: 'Error de red llamando a CallMeBot: ' + e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK genérico (Zapier, Make, n8n, Discord, Slack, etc.)
// ─────────────────────────────────────────────────────────────────────────────
async function sendWebhook({ url, payload }) {
  if (!url) return { ok: false, reason: 'no_url' };
  try {
    await axios.post(url, payload, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json' },
    });
    return { ok: true };
  } catch (e) {
    console.error('Webhook error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICACIÓN DE LEAD HOT — orquesta los 3 canales
// ─────────────────────────────────────────────────────────────────────────────
async function notifyHotLead({ userId, leadId }) {
  const user = await db.findOne(db.users, { _id: userId });
  if (!user) return { sent: [] };

  // Si el user nunca configuró notifications, asumimos defaults con email ON
  // para que reciba alertas al email de su cuenta sin tener que setear nada.
  const n = {
    email_enabled:    true,
    telegram_enabled: false,
    whatsapp_enabled: false,
    webhook_enabled:  false,
    ...(user.notifications || {}),
  };

  // Throttle: ¿ya notificamos este lead hace poco?
  const lead = await db.findOne(db.leads, { _id: leadId });
  if (!lead) return { sent: [] };

  if (lead.last_notified_at) {
    const diffMin = (Date.now() - new Date(lead.last_notified_at)) / 60000;
    if (diffMin < THROTTLE_MINUTES) {
      return { sent: [], throttled: true };
    }
  }

  // Construir payload común
  const account = await db.findOne(db.accounts, { _id: lead.account_id });
  const messages = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const lastMessages = messages.slice(-4); // últimas 4 líneas

  const igUsername = lead.ig_username;
  const conversationPreview = lastMessages.map(m =>
    `${m.role === 'user' ? `@${igUsername}` : 'BOT'}: ${String(m.content).slice(0, 140)}`
  ).join('\n');

  const dmLink = `https://www.instagram.com/direct/t/${lead.ig_user_id}/`;
  const appLink = `${APP_URL()}/?section=leads&lead=${lead._id}`;

  const sent = [];

  // ── TELEGRAM ──
  if (n.telegram_enabled && n.telegram_bot_token && n.telegram_chat_id) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = [
      `🔥 <b>LEAD HOT DETECTADO</b>`,
      ``,
      `<b>Prospecto:</b> @${esc(igUsername)}`,
      `<b>Razón:</b> ${esc(lead.qualification_reason || 'alta probabilidad de cierre')}`,
      ``,
      `<b>Últimos mensajes:</b>`,
      `<code>${esc(conversationPreview)}</code>`,
      ``,
      `📲 <a href="${dmLink}">Abrir DM en Instagram</a>`,
      `📊 <a href="${appLink}">Ver en Atinov</a>`,
      ``,
      `<i>Toma el control antes que se enfríe.</i>`,
    ].join('\n');
    const r = await sendTelegram({
      botToken: n.telegram_bot_token,
      chatId:   n.telegram_chat_id,
      text,
    });
    sent.push({ channel: 'telegram', ...r });
  }

  // ── EMAIL ──
  if (n.email_enabled && (n.email_address || user.email)) {
    const to = n.email_address || user.email;
    const subject = `🔥 Lead HOT: @${igUsername} — listo para cerrar`;
    const html = `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:auto;padding:24px;background:#f8f9fb;border-radius:12px">
        <div style="background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
          <h1 style="margin:0 0 8px;color:#ef4444;font-size:22px">🔥 Lead HOT detectado</h1>
          <p style="margin:0 0 16px;color:#666;font-size:14px">El asistente identificó a <strong>@${igUsername}</strong> como cliente prioritario. Es un buen momento para que tomes el control y cierres.</p>

          <div style="background:#fef2f2;border-left:3px solid #ef4444;padding:12px 16px;border-radius:6px;margin-bottom:16px">
            <div style="font-size:13px;color:#888;margin-bottom:6px">Razón:</div>
            <div style="font-size:14px;color:#333">${escapeHtml(lead.qualification_reason || 'alta probabilidad de cierre')}</div>
          </div>

          <h3 style="font-size:13px;color:#888;margin:20px 0 8px;text-transform:uppercase;letter-spacing:0.5px">Últimos mensajes</h3>
          <pre style="background:#0f172a;color:#e0e0e0;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-family:'SF Mono',Consolas,monospace;margin:0">${escapeHtml(conversationPreview)}</pre>

          <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">
            <a href="${dmLink}" style="background:#ef4444;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;font-size:14px">💬 Abrir DM en Instagram</a>
            <a href="${appLink}" style="background:#f3f4f6;color:#111;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;font-size:14px">Ver en Atinov</a>
          </div>

          <p style="margin-top:22px;font-size:12px;color:#999">Puedes desactivar estas notificaciones desde Settings en Atinov.</p>
        </div>
      </div>`;
    const r = await sendEmail({ to, subject, html });
    sent.push({ channel: 'email', ...r });
  }

  // ── WHATSAPP ──
  if (n.whatsapp_enabled && n.whatsapp_number && n.whatsapp_apikey) {
    const text = [
      `🔥 *LEAD HOT DETECTADO*`,
      ``,
      `*Prospecto:* @${igUsername}`,
      `*Razón:* ${lead.qualification_reason || 'alta probabilidad de cierre'}`,
      ``,
      `*Últimos mensajes:*`,
      conversationPreview,
      ``,
      `📲 Abrir en IG:`,
      dmLink,
      ``,
      `Toma el control antes que se enfríe.`,
    ].join('\n');
    const r = await sendWhatsApp({
      phone:  n.whatsapp_number,
      apikey: n.whatsapp_apikey,
      text,
    });
    sent.push({ channel: 'whatsapp', ...r });
  }

  // ── WEBHOOK ──
  if (n.webhook_enabled && n.webhook_url) {
    const r = await sendWebhook({
      url: n.webhook_url,
      payload: {
        event:         'lead.hot',
        timestamp:     new Date().toISOString(),
        lead: {
          id:          lead._id,
          ig_username: lead.ig_username,
          ig_user_id:  lead.ig_user_id,
          qualification: lead.qualification,
          reason:      lead.qualification_reason,
        },
        account: {
          id:          account?._id,
          ig_username: account?.ig_username,
        },
        last_messages: lastMessages.map(m => ({ role: m.role, content: m.content, at: m.createdAt })),
        links: {
          instagram_dm: dmLink,
          dashboard:    appLink,
        },
      },
    });
    sent.push({ channel: 'webhook', ...r });
  }

  // Registrar que notificamos (para throttle)
  if (sent.some(s => s.ok)) {
    await db.update(db.leads, { _id: lead._id }, {
      last_notified_at: new Date().toISOString(),
    });
  }

  return { sent };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST — permite al usuario probar sus notificaciones con un payload dummy
// ─────────────────────────────────────────────────────────────────────────────
async function sendTestNotification({ userId, channel }) {
  const user = await db.findOne(db.users, { _id: userId });
  if (!user || !user.notifications) return { ok: false, reason: 'no config' };
  const n = user.notifications;

  const fakePreview = '@juan_perez: Quiero más info del programa\nBOT: ¡Hola Juan! Cuéntame, ¿qué te trae hoy?\n@juan_perez: Tengo un negocio de coaching y quiero automatizar mis DMs';

  if (channel === 'telegram') {
    if (!n.telegram_enabled || !n.telegram_bot_token || !n.telegram_chat_id) {
      return { ok: false, reason: 'Telegram desactivado o sin config' };
    }
    const text = [
      `✅ <b>Test Atinov</b>`,
      ``,
      `Tu Telegram está configurado correctamente.`,
      `Cuando un lead se ponga 🔥 HOT, recibirás una alerta como esta con los detalles y links directos al DM.`,
      ``,
      `<code>${fakePreview}</code>`,
    ].join('\n');
    return await sendTelegram({
      botToken: n.telegram_bot_token,
      chatId:   n.telegram_chat_id,
      text,
    });
  }

  if (channel === 'email') {
    if (!n.email_enabled) return { ok: false, reason: 'email desactivado' };
    const to = n.email_address || user.email;
    return await sendEmail({
      to,
      subject: '✅ Test — Atinov puede enviarte emails',
      html: `<div style="font-family:system-ui;padding:20px"><h2>✅ Funciona</h2><p>Esta es una prueba. Cuando un lead se ponga 🔥 HOT, recibirás un email como este con los detalles y un botón para abrir el DM al instante.</p><pre style="background:#0f172a;color:#e0e0e0;padding:12px;border-radius:6px;font-size:12px">${escapeHtml(fakePreview)}</pre></div>`,
    });
  }

  if (channel === 'whatsapp') {
    if (!n.whatsapp_enabled || !n.whatsapp_number || !n.whatsapp_apikey) {
      return { ok: false, reason: 'WhatsApp desactivado o sin config' };
    }
    return await sendWhatsApp({
      phone:  n.whatsapp_number,
      apikey: n.whatsapp_apikey,
      text:   '✅ *Test Atinov*\n\nTu WhatsApp está configurado. Cuando un lead se ponga 🔥 HOT, recibirás una alerta como esta con los detalles.',
    });
  }

  if (channel === 'webhook') {
    if (!n.webhook_enabled || !n.webhook_url) return { ok: false, reason: 'Webhook desactivado' };
    return await sendWebhook({
      url: n.webhook_url,
      payload: {
        event:     'test',
        timestamp: new Date().toISOString(),
        message:   'Test de Atinov — si ves esto, tu webhook funciona.',
      },
    });
  }

  return { ok: false, reason: 'canal inválido' };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  sendWebhook,
  sendTelegram,
  detectTelegramChatId,
  notifyHotLead,
  sendTestNotification,
};
