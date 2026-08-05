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

/**
 * PERFIL COMPLETO del usuario que escribió — incluye si te sigue.
 *
 * Meta solo entrega estos datos si la persona TE ESCRIBIÓ (eso cuenta como
 * consentimiento). Si solo comentó un post y nunca mandó un DM, la API
 * devuelve error — por eso esto se consulta al recibir un mensaje, no al
 * recibir un comentario.
 *
 * Devuelve null ante cualquier problema: es información que MEJORA la
 * respuesta, nunca un requisito para responder.
 */
const CAMPOS_PERFIL = 'name,username,follower_count,is_user_follow_business,is_business_follow_user,is_verified_user';

async function getUserProfileFull({ igsid, accessToken, igUserId, pageToken }) {
  const intentos = [{ base: IG_BASE, token: accessToken, via: 'instagram' }];
  // Meta documenta estos campos sobre graph.facebook.com con token de Página.
  // Si la cuenta tiene Messenger conectado, ese token es un segundo intento
  // gratis en vez de quedarnos sin el dato.
  if (pageToken) intentos.push({ base: FB_BASE, token: pageToken, via: 'facebook' });

  let ultimoError = null;
  for (const intento of intentos) {
    try {
      const res = await axios.get(`${intento.base}/${igsid}`, {
        params: { fields: CAMPOS_PERFIL, access_token: intento.token },
        timeout: 10000,
      });
      const d = res.data || {};
      return {
        username:      d.username || null,
        name:          d.name || null,
        followerCount: Number.isFinite(d.follower_count) ? d.follower_count : null,
        teSigue:       typeof d.is_user_follow_business === 'boolean' ? d.is_user_follow_business : null,
        loSigues:      typeof d.is_business_follow_user === 'boolean' ? d.is_business_follow_user : null,
        verificado:    !!d.is_verified_user,
        via:           intento.via,
      };
    } catch (err) {
      ultimoError = err.response?.data?.error?.message || err.message;
    }
  }
  // Causas normales: la persona solo comentó (sin consentimiento), bloqueó a
  // la cuenta, o el host/permiso no aplica a este tipo de login. El prefijo
  // [perfil] permite filtrarlo en los logs para diagnosticar de una.
  console.warn(`[perfil] sin datos de ${igsid} (${intentos.map(i => i.via).join(' → ')}): ${ultimoError}`);
  return null;
}

module.exports = { sendMessage, sendPrivateReply, replyToComment, getIGUserInfo, getUserProfileFull, isTokenError };
