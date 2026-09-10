const axios = require('axios');
const db    = require('../db/database');

// WhatsApp Cloud API official endpoint (graph.facebook.com, no IG sub-app)
const WA_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Detecta error de token caducado/inválido en la WhatsApp Cloud API.
 * Mismo código 190 / OAuthException que Meta principal.
 */
function isTokenError(err) {
  const e = err?.response?.data?.error;
  return e?.code === 190 || e?.type === 'OAuthException';
}

/**
 * El token de WhatsApp murió: se marca la cuenta y se avisa al dueño UNA vez.
 *
 * No hay refresco posible (ver el comentario en sendMessage), así que lo único
 * honesto es dejar registro de que hay que reconectar y decírselo. El throttle
 * de 24 h evita que un worker con 50 mensajes en cola mande 50 correos.
 */
async function marcarWaParaReconectar(account, err) {
  const motivo = err?.response?.data?.error?.message || 'token de WhatsApp rechazado por Meta';
  const ultimo = account.wa_token_aviso_at ? new Date(account.wa_token_aviso_at).getTime() : 0;
  const yaAvisado = (Date.now() - ultimo) / 3_600_000 < 24;

  await db.update(db.accounts, { _id: account._id }, {
    wa_reconectar:        true,
    wa_reconectar_motivo: String(motivo).slice(0, 200),
    wa_reconectar_at:     account.wa_reconectar_at || new Date().toISOString(),
  }).catch(() => null);

  if (yaAvisado) return;
  try {
    const owner = await db.findOne(db.users, { account_id: account._id });
    if (!owner?.email) return;
    const { sendEmail } = require('./email');
    const { whatsappTokenPorVencerEmail } = require('./emailTemplates');
    const { subject, html } = whatsappTokenPorVencerEmail({
      name: owner.name, email: owner.email,
      dias: -1, numero: account.wa_display_number || null,
    });
    const r = await sendEmail({ to: owner.email, subject, html, tag: 'wa_token_vence', userId: owner._id });
    if (r?.ok) {
      await db.update(db.accounts, { _id: account._id },
        { wa_token_aviso_at: new Date().toISOString() }).catch(() => null);
      console.log(`📧 [whatsapp] avisado ${owner.email}: hay que reconectar WhatsApp (${motivo})`);
    }
  } catch (e) {
    console.error('[whatsapp] no se pudo avisar del token caído:', e.message);
  }
}

/**
 * Envía un mensaje de texto vía WhatsApp Cloud API.
 *
 * Endpoint: POST /{phone-number-id}/messages
 *
 * @param {Object} params
 * @param {string} params.phoneNumberId  — ID del número WSP del negocio (NO el número visible)
 * @param {string} params.recipient      — wa_id del destinatario (formato sin '+', ej "5491155...")
 * @param {string} params.text           — Cuerpo del mensaje
 * @param {string} params.accessToken    — Token con permisos whatsapp_business_messaging
 * @param {string} [params.accountId]    — Opcional, para auto-refresh del token si caduca
 */
async function sendMessage({ phoneNumberId, recipient, text, accessToken, accountId }) {
  if (!phoneNumberId) throw new Error('phoneNumberId requerido para WhatsApp');
  if (!recipient)     throw new Error('recipient (wa_id) requerido para WhatsApp');
  if (!text)          throw new Error('text requerido para WhatsApp');
  if (!accessToken)   throw new Error('accessToken requerido para WhatsApp');

  const url = `${WA_BASE}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { body: text, preview_url: false },
  };

  async function attempt(token) {
    return axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  try {
    const res = await attempt(accessToken);
    return res.data;
  } catch (err) {
    if (isTokenError(err) && accountId) {
      try {
        const account = await db.findOne(db.accounts, { _id: accountId });
        if (account) {
          // 🔴 EL TOKEN QUE FALLÓ DECIDE A QUIÉN LLAMAR. Antes se llamaba
          // siempre a tryRefreshOnOAuthError, que renueva el token de
          // INSTAGRAM (graph.instagram.com/refresh_access_token) y lo
          // devuelve — y el reintento mandaba el mensaje de WhatsApp con el
          // token de Instagram. Fallaba igual, pero parecía "ya lo intentamos".
          const esTokenWa = !!account.wa_access_token && accessToken === account.wa_access_token;
          if (esTokenWa) {
            // El token de WhatsApp no se refresca: si vino del botón, Meta no
            // publica endpoint de refresco; si vino del alta manual, es un
            // System User token que solo muere si lo revocan. En los dos casos
            // la salida es humana — se marca y se avisa, no se reintenta.
            await marcarWaParaReconectar(account, err);
          } else {
            const { tryRefreshOnOAuthError } = require('./metaRefresh');
            const newToken = await tryRefreshOnOAuthError(account);
            if (newToken) {
              const retryRes = await attempt(newToken);
              return retryRes.data;
            }
          }
        }
      } catch (refreshErr) {
        console.error('[whatsapp] refresh-retry failed:', refreshErr.message);
      }
    }
    console.error('[whatsapp] API error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Envía un template aprobado por Meta. Necesario para iniciar conversaciones
 * fuera de la ventana de 24h o para reabrir conversaciones inactivas.
 *
 * @param {Object} params
 * @param {string} params.phoneNumberId
 * @param {string} params.recipient
 * @param {string} params.templateName     — nombre exacto registrado en Meta Manager
 * @param {string} [params.languageCode]   — default 'es'
 * @param {Array}  [params.components]     — variables del template (opcional)
 * @param {string} params.accessToken
 */
async function sendTemplate({ phoneNumberId, recipient, templateName, languageCode = 'es', components = [], accessToken }) {
  const url = `${WA_BASE}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  };

  try {
    const res = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    console.error('[whatsapp] template error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Marca un mensaje como leído (envía "double check azul" al sender).
 * No bloqueante — si falla no debería romper el flujo.
 */
async function markAsRead({ phoneNumberId, messageId, accessToken }) {
  const url = `${WA_BASE}/${phoneNumberId}/messages`;
  try {
    await axios.post(url, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // No-op — best-effort
    console.warn('[whatsapp] markAsRead failed (non-fatal):', err.response?.data?.error?.message || err.message);
  }
}

/**
 * Resuelve la account interna a partir del phone_number_id que viene en el webhook.
 * El phone_number_id es único por número WSP por negocio.
 */
async function findAccountByPhoneNumberId(phoneNumberId) {
  return db.findOne(db.accounts, { wa_phone_number_id: phoneNumberId });
}

module.exports = {
  sendMessage,
  sendTemplate,
  markAsRead,
  findAccountByPhoneNumberId,
  isTokenError,
  marcarWaParaReconectar,
};
