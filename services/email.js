/**
 * Atinov — Servicio de Emails Transaccionales (Resend)
 *
 * Usa la REST API de Resend (sin dependencia extra, solo axios).
 * Si no hay RESEND_API_KEY configurada NO se envía nada y se registra como
 * FALLIDO (antes se registraba como ok, y el panel mostraba "enviado" un
 * correo que nunca salió — eso fue lo que ocultó que el link de restablecer
 * contraseña jamás se mandaba). Nunca lanza: quien lo llama sigue su flujo.
 *
 * Todos los envíos —de este módulo y de services/notifications.js— se
 * loguean en db.emailLog y se ven en GET /api/admin/emails.
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
 *   sendEmail({ to, subject, html, text?, replyTo?, userId?, tag?, from? })
 *
 * Devuelve { ok, id?, error?, mode: 'resend'|'log' }.
 * Nunca lanza — los fallos se loguean y devuelven ok:false para no bloquear
 * el flujo que lo llamó (un registro NO debe fallar porque no llegó el mail).
 *
 * `from` permite que services/notifications.js conserve su propio remitente
 * (RESEND_FROM) sin dejar de registrarse acá. Queda guardado en el log: si un
 * remitente no está verificado en Resend, se ve cuál falla.
 */
async function sendEmail({ to, subject, html, text, replyTo, userId, tag, from }) {
  const apiKey = process.env.RESEND_API_KEY;
  const mode   = apiKey ? 'resend' : 'log';
  const remitente = from || FROM_DEFAULT;

  // Sin API key NO se envió nada. Registrarlo como ok:true decía "enviado" en
  // el panel de un correo que nunca salió — justo el engaño que hace perder
  // horas cuando alguien no recibe su link de contraseña.
  if (!apiKey) {
    console.warn(`📧 [SIN ENVIAR — falta RESEND_API_KEY] to=${to} subject="${subject}" tag=${tag || '-'}`);
    await logEmail({
      to, subject, mode, tag, userId, from: remitente,
      ok: false, error: 'RESEND_API_KEY no configurada — el correo NO se envió',
    });
    return { ok: false, mode, id: null, error: 'RESEND_API_KEY no configurada' };
  }

  try {
    const { data } = await axios.post(RESEND_API, {
      from:     remitente,
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
    await logEmail({ to, subject, mode, tag, userId, from: remitente, ok: true, providerId: data.id });
    return { ok: true, mode, id: data.id };
  } catch (e) {
    const err = e.response?.data?.message || e.message;
    console.error(`❌ Email fallido a ${to} — "${subject}": ${err}`);
    await logEmail({ to, subject, mode, tag, userId, from: remitente, ok: false, error: String(err).slice(0, 300) });
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
