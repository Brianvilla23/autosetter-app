/**
 * Atinov — Abstracción de canal: envío (Tarea 3)
 *
 * Un mismo agente, múltiples canales. Este módulo unifica el ENVÍO: el caller
 * dice "mandá este texto a este lead" y el dispatcher resuelve el transporte
 * (Instagram Graph API o WhatsApp Cloud API) según el canal.
 *
 * La taxonomía pura de canales vive en core.js (sin db/red). Acá se agrega
 * send(), que sí carga los transportes meta/whatsapp.
 */

const core = require('./core');
const meta = require('../meta');
const wa   = require('../whatsapp');

/**
 * Envía un mensaje por el canal correcto.
 * @param {Object} p
 * @param {string} p.channel       — 'instagram' | 'whatsapp'
 * @param {Object} p.account       — para tokens/ids
 * @param {string} p.recipientId   — ig_user_id o wa_id
 * @param {string} p.text
 */
async function send({ channel, account, recipientId, text }) {
  const ch = core.channelOf(channel);
  if (ch === 'whatsapp') {
    return wa.sendMessage({
      phoneNumberId: account.wa_phone_number_id,
      recipient:     recipientId,
      text,
      accessToken:   account.wa_access_token,
      accountId:     account._id,
    });
  }
  // default: instagram
  return meta.sendMessage({
    recipientId,
    text,
    accessToken: account.access_token,
    igUserId:    account.ig_platform_id || account.ig_user_id,
    accountId:   account._id,
  });
}

module.exports = { ...core, send };
