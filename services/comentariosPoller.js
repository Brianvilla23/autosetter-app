/**
 * Atinov — Revisar comentarios de Instagram sin esperar el webhook
 *
 * Meta solo entrega el webhook de `comments` cuando la app tiene ACCESO
 * AVANZADO a instagram_business_manage_comments, o sea, después del App
 * Review. Hasta entonces el comentario "info" en una publicación con regla
 * nunca llega y el cliente no recibe nada (visto el 24-09-2026 grabando el
 * video del App Review: comentó y no pasó nada). Y el App Review pide
 * justamente un video donde eso funcione.
 *
 * Este revisor le pregunta a Instagram, cada minuto, por los comentarios
 * nuevos de las publicaciones que tienen una regla activa, y se los pasa al
 * MISMO manejador del webhook (handleComment). Así no hay dos lógicas: las
 * palabras clave, el filtro de los propios comentarios, el tope de 7 días y
 * el "una sola respuesta por comentario" son los mismos.
 *
 * Cuando el webhook empiece a llegar, los dos caminos conviven sin duplicar:
 * handleComment no responde dos veces el mismo comentario (queda guardado en
 * el lead como triggered_comment_id).
 *
 * Solo mira comentarios posteriores a la creación de la regla: crear una
 * regla sobre un post viejo no debe mandarle mensajes a todos los que
 * comentaron hace semanas.
 */

const axios = require('axios');
const db    = require('../db/database');

const GRAPH_IG     = 'https://graph.instagram.com/v21.0';
const INTERVALO_MS = 60 * 1000;
const VENTANA_MS   = 7 * 24 * 3600 * 1000;   // Meta no deja responder por privado después
const MAX_VISTOS   = 5000;

// Comentarios ya pasados al manejador en este proceso: evita llamar a
// handleComment (y loguear "sin keyword") cada minuto por el mismo comentario.
const vistos = new Set();

function marcarVisto(id) {
  if (vistos.size >= MAX_VISTOS) vistos.clear();
  vistos.add(id);
}

/** Solo las cuentas conectadas con Instagram Login (token IG…) se consultan acá. */
function cuentaConsultable(account) {
  return !!(account && account.ig_user_id && account.access_token &&
    /^IG/.test(account.access_token) && !account.needs_reauth);
}

async function comentariosDe(mediaId, token) {
  const r = await axios.get(`${GRAPH_IG}/${encodeURIComponent(mediaId)}/comments`, {
    params: { fields: 'id,text,timestamp,username,from', limit: 50, access_token: token },
    timeout: 15000,
  });
  return Array.isArray(r.data?.data) ? r.data.data : [];
}

/**
 * Una pasada. `handleComment(igUserId, commentData)` es el del webhook.
 * Devuelve cuántos comentarios nuevos se pasaron al manejador.
 */
async function revisarComentarios({ handleComment, ahora = Date.now() } = {}) {
  if (typeof handleComment !== 'function') return 0;
  const reglas = await db.find(db.postRules, { enabled: true });
  if (!reglas.length) return 0;

  const cuentas = new Map();
  let pasados = 0;

  for (const regla of reglas) {
    if (!regla.media_id || !regla.account_id) continue;
    if (!cuentas.has(regla.account_id)) {
      cuentas.set(regla.account_id, await db.findOne(db.accounts, { _id: regla.account_id }));
    }
    const account = cuentas.get(regla.account_id);
    if (!cuentaConsultable(account)) continue;

    const desde = Math.max(Date.parse(regla.createdAt) || 0, ahora - VENTANA_MS);

    let lista;
    try {
      lista = await comentariosDe(regla.media_id, account.access_token);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.warn(`[comentarios] no se pudo leer la publicación ${regla.media_id} de @${account.ig_username || account.ig_user_id}: ${msg}`);
      continue;
    }

    for (const c of lista) {
      if (!c?.id || vistos.has(c.id)) continue;
      marcarVisto(c.id);
      const cuando = Date.parse(c.timestamp);
      if (!Number.isFinite(cuando) || cuando < desde) continue;

      await handleComment(account.ig_user_id, {
        id: c.id,
        text: c.text || '',
        from: { id: c.from?.id, username: c.from?.username || c.username },
        media: { id: String(regla.media_id) },
        created_time: c.timestamp,
        via: 'revision',
      }).catch(e => console.error('[comentarios] handleComment falló:', e.message));
      pasados++;
    }
  }
  return pasados;
}

/** Arranca la revisión periódica. Devuelve el timer (unref: no retiene el proceso). */
function iniciar(handleComment) {
  const t = setInterval(() => {
    revisarComentarios({ handleComment }).catch(e => console.error('[comentarios] revisión falló:', e.message));
  }, INTERVALO_MS);
  t.unref?.();
  return t;
}

/** Solo para tests. */
function _vistos() { return vistos; }

module.exports = { revisarComentarios, iniciar, cuentaConsultable, INTERVALO_MS, _vistos };
