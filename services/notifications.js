/**
 * Atinov — Servicio de notificaciones multi-canal
 *
 * Avisa al dueño/closer CUANDO un lead se pone 🔥 HOT — email + Telegram
 * + webhook. El objetivo: que el humano pueda saltar a la conversación
 * en vivo antes de que el lead se enfríe.
 *
 * Canales:
 *  • Telegram   → Bot API oficial (gratis, setup 2 min con @BotFather) ← RECOMENDADO
 *  • Email      → Resend (https://resend.com, 3000/mes free, API simple)
 *  • Webhook    → POST JSON a URL del user (Zapier/Make/n8n/Discord/Slack)
 *
 * Throttle: nunca más de una notificación por lead cada 30 minutos.
 */

const axios = require('axios');
const db    = require('../db/database');

const THROTTLE_MINUTES = 30;
const APP_URL = () => process.env.APP_URL || 'https://atinov.com';

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL (Resend) — delega en services/email.js para que TODO envío quede
// registrado en db.emailLog y sea visible en /api/admin/emails.
//
// Antes este módulo hablaba con Resend por su cuenta y sus fallos solo salían
// por consola. El correo de "olvidé mi contraseña" usa esta función: cuando no
// llegaba, no quedaba rastro en ninguna parte y era imposible saber si faltaba
// la API key, si el remitente no estaba verificado o si el correo no tenía
// cuenta. Ese agujero es lo que se cierra acá.
//
// El remitente por defecto se mantiene tal cual (RESEND_FROM) a propósito: si
// en Resend está verificado ese y no el de los transaccionales, cambiarlo
// rompería las notificaciones que hoy SÍ llegan. La diferencia entre ambos
// remitentes se expone en GET /api/admin/emails para poder revisarla.
// ─────────────────────────────────────────────────────────────────────────────
const FROM_NOTIFICACIONES = () =>
  process.env.RESEND_FROM || 'Atinov <notificaciones@atinov.com>';

async function sendEmail({ to, subject, html, from, userId, tag }) {
  const { sendEmail: enviar } = require('./email');
  const r = await enviar({
    to, subject, html,
    from: from || FROM_NOTIFICACIONES(),
    userId,
    tag: tag || 'notificacion',
  });
  // Compatibilidad: los llamadores de este módulo leen `reason`, los de
  // services/email.js leen `error`. Se devuelven los dos.
  return { ...r, reason: r.ok ? undefined : (r.error || 'no_api_key') };
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
    `${m.role === 'user' ? `@${igUsername}` : 'ATINOV'}: ${String(m.content).slice(0, 140)}`
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
// RESUMEN AUTOMÁTICO DE RESULTADO — ganado / perdido / tibio
// Mismo mecanismo multi-canal que notifyHotLead, pero para el cierre del ciclo
// del lead (o cuando entra en calor medio). ganado/perdido son transiciones
// terminales (no se throttlean); tibio sí, porque el lead puede re-evaluarse
// varias veces mientras sigue conversando.
// ─────────────────────────────────────────────────────────────────────────────
const OUTCOME_COPY = {
  ganado:  { emoji: '🎉', label: 'LEAD GANADO',  color: '#22c55e', throttleField: 'last_notified_ganado_at' },
  perdido: { emoji: '❌', label: 'LEAD PERDIDO', color: '#ef4444', throttleField: 'last_notified_perdido_at' },
  tibio:   { emoji: '🌤️', label: 'LEAD TIBIO',   color: '#f59e0b', throttleField: 'last_notified_tibio_at' },
};

async function notifyLeadEvent({ userId, leadId, event }) {
  const copy = OUTCOME_COPY[event];
  if (!copy) return { sent: [] };

  const user = await db.findOne(db.users, { _id: userId });
  if (!user) return { sent: [] };

  const n = {
    email_enabled:    true,
    telegram_enabled: false,
    webhook_enabled:  false,
    ...(user.notifications || {}),
  };

  const lead = await db.findOne(db.leads, { _id: leadId });
  if (!lead) return { sent: [] };

  if (event === 'tibio' && lead[copy.throttleField]) {
    const diffMin = (Date.now() - new Date(lead[copy.throttleField])) / 60000;
    if (diffMin < THROTTLE_MINUTES) return { sent: [], throttled: true };
  }

  const account  = await db.findOne(db.accounts, { _id: lead.account_id });
  const messages = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const lastMessages = messages.slice(-6);

  const igUsername = lead.ig_username || lead.wa_name || 'lead';
  const conversationPreview = lastMessages.map(m =>
    `${m.role === 'user' ? `@${igUsername}` : 'ATINOV'}: ${String(m.content).slice(0, 140)}`
  ).join('\n');

  const durationDays = lead.createdAt
    ? Math.max(0, Math.round((Date.now() - new Date(lead.createdAt)) / 86400000))
    : null;

  const detailLines = [];
  if (event === 'ganado' && lead.deal_value) {
    detailLines.push(`Valor del deal: ${lead.deal_currency || 'USD'} ${lead.deal_value}`);
  }
  if ((event === 'perdido' || event === 'tibio') && lead.qualification_reason) {
    detailLines.push(`Motivo: ${lead.qualification_reason}`);
  }
  if (durationDays !== null) detailLines.push(`Ciclo: ${durationDays} día(s) desde el primer contacto`);
  detailLines.push(`Mensajes intercambiados: ${messages.length}`);

  const dmLink  = lead.channel === 'whatsapp' ? null : `https://www.instagram.com/direct/t/${lead.ig_user_id}/`;
  const appLink = `${APP_URL()}/?section=leads&lead=${lead._id}`;

  const sent = [];

  if (n.telegram_enabled && n.telegram_bot_token && n.telegram_chat_id) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = [
      `${copy.emoji} <b>${copy.label}</b>`,
      ``,
      `<b>Prospecto:</b> @${esc(igUsername)}`,
      ...detailLines.map(esc),
      ``,
      `<b>Últimos mensajes:</b>`,
      `<code>${esc(conversationPreview)}</code>`,
      ``,
      dmLink ? `📲 <a href="${dmLink}">Abrir DM en Instagram</a>` : '',
      `📊 <a href="${appLink}">Ver en Atinov</a>`,
    ].filter(Boolean).join('\n');
    sent.push({ channel: 'telegram', ...(await sendTelegram({ botToken: n.telegram_bot_token, chatId: n.telegram_chat_id, text })) });
  }

  if (n.email_enabled && (n.email_address || user.email)) {
    const to = n.email_address || user.email;
    const subject = `${copy.emoji} ${copy.label}: @${igUsername}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:auto;padding:24px;background:#f8f9fb;border-radius:12px">
        <div style="background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
          <h1 style="margin:0 0 8px;color:${copy.color};font-size:22px">${copy.emoji} ${copy.label}</h1>
          <p style="margin:0 0 16px;color:#666;font-size:14px"><strong>@${igUsername}</strong></p>
          <div style="background:#f8f9fb;border-left:3px solid ${copy.color};padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:14px;color:#333">
            ${detailLines.map(escapeHtml).join('<br>')}
          </div>
          <h3 style="font-size:13px;color:#888;margin:20px 0 8px;text-transform:uppercase;letter-spacing:0.5px">Últimos mensajes</h3>
          <pre style="background:#0f172a;color:#e0e0e0;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-family:'SF Mono',Consolas,monospace;margin:0">${escapeHtml(conversationPreview)}</pre>
          <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">
            ${dmLink ? `<a href="${dmLink}" style="background:${copy.color};color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;font-size:14px">💬 Abrir DM</a>` : ''}
            <a href="${appLink}" style="background:#f3f4f6;color:#111;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;font-size:14px">Ver en Atinov</a>
          </div>
        </div>
      </div>`;
    sent.push({ channel: 'email', ...(await sendEmail({ to, subject, html })) });
  }

  if (n.webhook_enabled && n.webhook_url) {
    sent.push({ channel: 'webhook', ...(await sendWebhook({
      url: n.webhook_url,
      payload: {
        event:     `lead.${event}`,
        timestamp: new Date().toISOString(),
        lead: {
          id: lead._id, ig_username: igUsername, channel: lead.channel,
          qualification: lead.qualification, pipeline_stage: lead.pipeline_stage,
          deal_value: lead.deal_value, deal_currency: lead.deal_currency,
        },
        account: { id: account?._id, ig_username: account?.ig_username },
        last_messages: lastMessages.map(m => ({ role: m.role, content: m.content, at: m.createdAt })),
        links: { instagram_dm: dmLink, dashboard: appLink },
      },
    })) });
  }

  if (event === 'tibio' && sent.some(s => s.ok)) {
    await db.update(db.leads, { _id: lead._id }, { [copy.throttleField]: new Date().toISOString() });
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

  const fakePreview = '@juan_perez: Quiero más info del programa\nATINOV: ¡Hola Juan! Cuéntame, ¿qué te trae hoy?\n@juan_perez: Tengo un negocio de coaching y se me escapan DMs todos los días';

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
  sendWebhook,
  sendTelegram,
  detectTelegramChatId,
  notifyHotLead,
  notifyLeadEvent,
  sendTestNotification,
};
