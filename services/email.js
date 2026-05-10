/**
 * Atinov — Servicio de Emails Transaccionales (Resend)
 *
 * Usa la REST API de Resend (sin dependencia extra, solo axios).
 * Si no hay RESEND_API_KEY configurada, corre en modo log-only:
 * imprime el email por consola pero no manda nada. Útil para dev
 * y para no romper producción si alguien olvida setear la key.
 *
 * Todos los envíos se loguean en db.emailLog para auditoría.
 *
 * Referencia API: https://resend.com/docs/api-reference/emails/send-email
 */

const axios = require('axios');
const db    = require('../db/database');

const RESEND_API   = 'https://api.resend.com/emails';
const FROM_DEFAULT = process.env.EMAIL_FROM || 'Atinov <soporte@atinov.com>';
const REPLY_TO     = process.env.EMAIL_REPLY_TO || 'soporte@atinov.com';

/**
 * Envía un email. Firma:
 *   sendEmail({ to, subject, html, text?, replyTo?, userId?, tag? })
 *
 * Devuelve { ok, id?, error?, mode: 'resend'|'log' }.
 * Nunca lanza — los fallos se loguean y devuelven ok:false para no bloquear
 * el flujo que lo llamó (un registro NO debe fallar porque no llegó el mail).
 */
async function sendEmail({ to, subject, html, text, replyTo, userId, tag }) {
  const apiKey = process.env.RESEND_API_KEY;
  const mode   = apiKey ? 'resend' : 'log';

  // Log-only mode: útil en dev y si Resend está caído
  if (!apiKey) {
    console.log(`📧 [LOG-ONLY] to=${to} subject="${subject}" tag=${tag || '-'}`);
    await logEmail({ to, subject, mode, tag, userId, ok: true, note: 'sin RESEND_API_KEY' });
    return { ok: true, mode, id: null };
  }

  try {
    const { data } = await axios.post(RESEND_API, {
      from:     FROM_DEFAULT,
      to:       Array.isArray(to) ? to : [to],
      subject,
      html,
      text:     text || stripHtml(html),
      reply_to: replyTo || REPLY_TO,
      tags:     tag ? [{ name: 'type', value: tag }] : undefined,
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    console.log(`📧 Email enviado a ${to} — "${subject}" (id ${data.id})`);
    await logEmail({ to, subject, mode, tag, userId, ok: true, providerId: data.id });
    return { ok: true, mode, id: data.id };
  } catch (e) {
    const err = e.response?.data?.message || e.message;
    console.error(`❌ Email fallido a ${to} — "${subject}": ${err}`);
    await logEmail({ to, subject, mode, tag, userId, ok: false, error: String(err).slice(0, 300) });
    return { ok: false, mode, error: err };
  }
}

async function logEmail(entry) {
  try {
    await db.insert(db.emailLog, entry);
  } catch {
    // no bloquear por fallo de logging
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { sendEmail };
