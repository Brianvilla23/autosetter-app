const axios = require('axios');
const db    = require('../db/database');

// Instagram Business Login tokens work with graph.instagram.com (not graph.facebook.com)
const IG_BASE = 'https://graph.instagram.com/v21.0';
const FB_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Detecta si un error de la API de Meta es por token inválido/caducado.
 * code 190 = OAuthException (token expired, invalid, or revoked)
 */
function isTokenError(err) {
  const e = err?.response?.data?.error;
  return e?.code === 190 || e?.type === 'OAuthException';
}

/**
 * Send a text message via Instagram DM
 * Uses Instagram Platform API (required for Instagram Business Login tokens)
 * Endpoint: POST /{ig-user-id}/messages on graph.instagram.com
 *
 * Si el token está caducado, intenta refresh automático y reintenta una vez.
 * Para eso necesita accountId (opcional) — si no se pasa, falla al primer intento.
 */
async function sendMessage({ recipientId, text, accessToken, igUserId, accountId }) {
  const url = igUserId
    ? `${IG_BASE}/${igUserId}/messages`
    : `${FB_BASE}/me/messages`;

  async function attempt(token) {
    return axios.post(
      url,
      { recipient: { id: recipientId }, message: { text } },
      { params: { access_token: token } }
    );
  }

  try {
    const res = await attempt(accessToken);
    return res.data;
  } catch (err) {
    // Si es error de token y tenemos accountId, probar refresh + retry
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
        console.error('Refresh-retry failed:', refreshErr.message);
      }
    }
    console.error('Meta API error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get user info (username/name) from a sender's IG scoped ID.
 * Tries multiple endpoints since the sender ID from webhooks may differ.
 */
async function getIGUserInfo(igUserId, accessToken) {
  // Try 1: Instagram Platform API direct user lookup
  try {
    const res = await axios.get(`${IG_BASE}/${igUserId}`, {
      params: { fields: 'id,name,username', access_token: accessToken }
    });
    if (res.data.username) return res.data;
  } catch (e) {
    // silent
  }

  // Try 2: Look up via conversation participants
  try {
    const res = await axios.get(`${IG_BASE}/me/conversations`, {
      params: {
        user_id: igUserId,
        platform: 'instagram',
        fields: 'participants',
        access_token: accessToken
      }
    });
    const data = res.data?.data?.[0];
    const participant = data?.participants?.data?.find(p => p.id === igUserId || p.username);
    if (participant?.username) return participant;
  } catch (e) {
    // silent
  }

  // Fallback: return numeric ID as username
  return { username: igUserId, name: igUserId };
}

/**
 * PRIVATE REPLY — DM a alguien que comentó un post/reel.
 *
 * Es la diferencia entre que el comment-to-DM funcione o no: a quien nunca te
 * escribió NO se le puede mandar un DM normal (`recipient: {id}`) porque no
 * hay ventana de mensajería abierta — Meta lo rechaza. La única vía es la
 * private reply, que usa el ID DEL COMENTARIO como destinatario.
 *
 * Reglas de Meta que hay que respetar (las impone del lado de ellos):
 *  - UNA sola private reply por comentario. La primera tiene que valer.
 *  - Hasta 7 días después del comentario (en Live, solo durante la transmisión).
 *  - Si el comentario se borró o el usuario bloquea solicitudes, falla.
 * Cuando la persona responde, se abre la ventana de 24h normal y a partir de
 * ahí se conversa libre con sendMessage().
 */
async function sendPrivateReply({ commentId, text, accessToken, igUserId, accountId }) {
  const url = igUserId
    ? `${IG_BASE}/${igUserId}/messages`
    : `${FB_BASE}/me/messages`;

  async function attempt(token) {
    return axios.post(
      url,
      { recipient: { comment_id: commentId }, message: { text } },
      { params: { access_token: token } }
    );
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
          if (newToken) return (await attempt(newToken)).data;
        }
      } catch (refreshErr) {
        console.error('Refresh-retry failed (private reply):', refreshErr.message);
      }
    }
    console.error('Meta API error (private reply):', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Respuesta PÚBLICA a un comentario ("te escribí al DM 📩").
 * Es lo que hace que el resto de la gente vea que la cuenta responde — y lo
 * que empuja a más gente a comentar la keyword. Nunca debe bloquear el DM:
 * el caller la llama best-effort.
 */
async function replyToComment({ commentId, text, accessToken }) {
  const res = await axios.post(
    `${IG_BASE}/${commentId}/replies`,
    { message: text },
    { params: { access_token: accessToken } }
  );
  return res.data;
}

module.exports = { sendMessage, sendPrivateReply, replyToComment, getIGUserInfo, isTokenError };
