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
        const { tryRefreshOnOAuthError } = require('./metaRefresh');
        const account = await db.findOne(db.accounts, { _id: accountId });
        if (account) {
          const newToken = await tryRefreshOnOAuthError(account);
          if (newToken) {
            const retryRes = await attempt(newToken);
            return retryRes.data;
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
};
