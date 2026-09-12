const axios = require('axios');
const db    = require('../db/database');

// Messenger Platform (Facebook Pages) — mismo graph.facebook.com que WhatsApp Cloud API.
// A diferencia de Instagram/WhatsApp, Messenger opera sobre una PÁGINA de Facebook:
// el webhook llega con object='page' y se envía con el Page Access Token.
//
// ⚠️ LÍMITE DE PLATAFORMA (Marketplace): la Messenger Platform SOLO automatiza
// conversaciones de una PÁGINA de Facebook. Los mensajes de Marketplace de un
// PERFIL PERSONAL no son accesibles por API (Meta no lo permite). Para que Atinov
// responda inquietudes de Marketplace, la publicación debe estar bajo una Página.
const FB_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Detecta error de token de página caducado/inválido (mismo 190 / OAuthException
 * que el resto de Meta).
 */
function isTokenError(err) {
  const e = err?.response?.data?.error;
  return e?.code === 190 || e?.type === 'OAuthException';
}

/**
 * Envía un mensaje de texto vía Messenger Send API.
 *
 * Endpoint: POST /{page-id}/messages  (con el Page Access Token)
 *
 * @param {Object} params
 * @param {string} params.pageId       — ID de la Página de Facebook que envía
 * @param {string} params.recipient    — PSID (Page-Scoped ID) del destinatario, viene en el webhook
 * @param {string} params.text         — Cuerpo del mensaje
 * @param {string} params.accessToken  — Page Access Token (permiso pages_messaging)
 * @param {string} [params.accountId]  — Opcional, para auto-refresh del token si caduca
 */
async function sendMessage({ pageId, recipient, text, accessToken, accountId }) {
  if (!pageId)      throw new Error('pageId requerido para Messenger');
  if (!recipient)   throw new Error('recipient (PSID) requerido para Messenger');
  if (!text)        throw new Error('text requerido para Messenger');
  if (!accessToken) throw new Error('accessToken requerido para Messenger');

  const url = `${FB_BASE}/${pageId}/messages`;
  const payload = {
    recipient: { id: recipient },
    messaging_type: 'RESPONSE', // respuesta dentro de la ventana estándar de mensajería
    message: { text },
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
      // Antes se llamaba a tryRefreshOnOAuthError, que renueva el token de
      // INSTAGRAM y reintentaba Messenger con él: fallaba igual y en silencio.
      // El Page Access Token no se refresca solo: se marca y se avisa al dueño,
      // igual que WhatsApp e Instagram (auditoría 12-09).
      try {
        const account = await db.findOne(db.accounts, { _id: accountId });
        if (account) await marcarFbParaReconectar(account, err);
      } catch (e2) {
        console.error('[messenger] no se pudo marcar la reconexión:', e2.message);
      }
    }
    console.error('[messenger] API error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Meta rechazó el Page Access Token: se deja registro en la cuenta
 * (fb_reconectar) y se avisa al dueño por correo, con throttle de 24 h para
 * que un worker con mensajes en cola no mande cincuenta correos.
 */
async function marcarFbParaReconectar(account, err) {
  const motivo = err?.response?.data?.error?.message || 'token de la Página de Facebook rechazado por Meta';
  const ultimo = account.fb_token_aviso_at ? new Date(account.fb_token_aviso_at).getTime() : 0;
  const yaAvisado = (Date.now() - ultimo) / 3_600_000 < 24;

  await db.update(db.accounts, { _id: account._id }, {
    fb_reconectar:        true,
    fb_reconectar_motivo: String(motivo).slice(0, 200),
    fb_reconectar_at:     account.fb_reconectar_at || new Date().toISOString(),
  }).catch(() => null);

  if (yaAvisado) return;
  try {
    const owner = await db.findOne(db.users, { account_id: account._id });
    if (!owner?.email) return;
    const { sendEmail } = require('./email');
    const html = `<p>Hola ${owner.name || ''},</p>
<p>Meta rechazó el acceso de Atinov a tu Página de Facebook (${String(motivo).slice(0, 120)}). Los mensajes de Messenger dejaron de responderse.</p>
<p>Entra a <a href="https://atinov.com/app">atinov.com/app</a> → Ajustes → Messenger y vuelve a conectar la Página. Toma un minuto.</p>`;
    const r = await sendEmail({ to: owner.email, subject: 'Atinov: hay que reconectar Messenger', html, tag: 'fb_token_caido', userId: owner._id });
    if (r?.ok) {
      await db.update(db.accounts, { _id: account._id }, { fb_token_aviso_at: new Date().toISOString() }).catch(() => null);
      console.log(`📧 [messenger] avisado ${owner.email}: hay que reconectar Messenger (${motivo})`);
    }
  } catch (e) {
    console.error('[messenger] no se pudo avisar del token caído:', e.message);
  }
}

/**
 * Envía una "sender action" (marcar visto / typing) — best-effort, no bloqueante.
 * action: 'mark_seen' | 'typing_on' | 'typing_off'
 */
async function sendAction({ pageId, recipient, action = 'mark_seen', accessToken }) {
  const url = `${FB_BASE}/${pageId}/messages`;
  try {
    await axios.post(url, {
      recipient: { id: recipient },
      sender_action: action,
    }, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('[messenger] sendAction failed (non-fatal):', err.response?.data?.error?.message || err.message);
  }
}

/**
 * Obtiene el perfil público básico del sender (nombre) usando su PSID y el Page
 * Access Token. Best-effort — para mostrar un nombre real en el inbox en vez del
 * PSID. Meta permite first_name/last_name/profile_pic con pages_messaging.
 */
async function getUserProfile({ psid, accessToken }) {
  if (!psid || !accessToken) return null;
  try {
    const res = await axios.get(`${FB_BASE}/${psid}`, {
      params: { fields: 'first_name,last_name', access_token: accessToken },
    });
    return res.data;
  } catch (err) {
    console.warn('[messenger] getUserProfile failed (non-fatal):', err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * Resuelve la account interna a partir del page_id que viene en el webhook
 * (entry[].id en un evento object='page'). Único por Página por negocio.
 */
async function findAccountByPageId(pageId) {
  return db.findOne(db.accounts, { fb_page_id: String(pageId) });
}

module.exports = {
  marcarFbParaReconectar,
  sendMessage,
  sendAction,
  getUserProfile,
  findAccountByPageId,
  isTokenError,
};
