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

async function usuarioDelComentario(commentId, token) {
  try {
    const r = await axios.get(`${GRAPH_IG}/${encodeURIComponent(commentId)}`, {
      params: { fields: 'username,from', access_token: token }, timeout: 10000,
    });
    return r.data?.username || r.data?.from?.username || undefined;
  } catch {
    return undefined;
  }
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

    // Una regla creada sola al publicar arranca desde la hora de la publicación:
    // los comentarios del primer minuto, antes de que existiera, también cuentan.
    const desde = Math.max(Date.parse(regla.desde || regla.createdAt) || 0, ahora - VENTANA_MS);

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

      // Sin el usuario, el Inbox muestra "@1055249427039759" (visto el
      // 24-09-2026). Si la lista no lo trajo, se pide al comentario mismo.
      let usuario = c.from?.username || c.username;
      if (!usuario) usuario = await usuarioDelComentario(c.id, account.access_token);

      await handleComment(account.ig_user_id, {
        id: c.id,
        text: c.text || '',
        from: { id: c.from?.id, username: usuario },
        media: { id: String(regla.media_id) },
        created_time: c.timestamp,
        via: 'revision',
      }).catch(e => console.error('[comentarios] handleComment falló:', e.message));
      pasados++;
    }
  }
  return pasados;
}

// ── La regla sola al publicar ────────────────────────────────────────────────
// Brayan (02-10-2026): "quiero poder subir contenido desde mi celular, fácil".
// Publicar en Instagram ya es fácil; lo que obligaba a ir al computador era
// crear la regla en Atinov después. Si el texto de la publicación dice
// "Comenta INFO" (o "escribe PRECIO en los comentarios"), la regla se crea
// sola con esa palabra. Usa solo instagram_business_basic: no pide permiso
// nuevo a Meta.

const VENTANA_PUBLICACION_MS = 48 * 3600 * 1000;   // solo publicaciones recientes
const MAX_MEDIA_VISTOS = 60;

// Lo que viene después de "comenta" pero no es una palabra clave.
const NO_CLAVE = new Set([
  'abajo', 'aqui', 'aca', 'tu', 'tus', 'con', 'el', 'la', 'los', 'las', 'en', 'y', 'si', 'esto', 'este',
  'esta', 'para', 'que', 'por', 'un', 'una', 'me', 'te', 'lo', 'le', 'nos', 'cual', 'cuál', 'qué', 'que',
  'tambien', 'también', 'ahora', 'ya', 'hoy', 'mas', 'más',
]);

const PALABRA = '([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]{2,20})';
const COMILLA_A = '["“\'«]?';
const COMILLA_C = '["”\'»]?';
const PATRONES_CLAVE = [
  // "Comenta INFO", "comenta la palabra PRECIO", "coméntame QUIERO"
  new RegExp(`com[eé]nt(?:a|á|en|ame|anos|ános)\\s+(?:la\\s+palabra\\s+|con\\s+(?:la\\s+palabra\\s+)?)?${COMILLA_A}${PALABRA}${COMILLA_C}`, 'i'),
  // "escribe INFO en los comentarios", "deja PRECIO en comentarios"
  new RegExp(`(?:escrib(?:e|í|an)|dej(?:a|á|en))\\s+(?:un\\s+|la\\s+palabra\\s+)?${COMILLA_A}${PALABRA}${COMILLA_C}\\s+(?:en|abajo en)\\s+(?:los\\s+)?comentarios`, 'i'),
];

/** La palabra clave que pide la publicación, en minúsculas, o null. */
function palabraDeLaPublicacion(caption) {
  const t = String(caption || '');
  for (const p of PATRONES_CLAVE) {
    const m = t.match(p);
    if (!m) continue;
    const kw = m[1].toLowerCase();
    if (NO_CLAVE.has(kw)) continue;
    return kw;
  }
  return null;
}

async function publicacionesRecientes(account) {
  const igId = account.ig_platform_id || account.ig_user_id;
  const r = await axios.get(`${GRAPH_IG}/${encodeURIComponent(igId)}/media`, {
    params: { fields: 'id,caption,timestamp,permalink,media_type,media_url,thumbnail_url', limit: 5, access_token: account.access_token },
    timeout: 15000,
  });
  return Array.isArray(r.data?.data) ? r.data.data : [];
}

/**
 * Crea la regla de las publicaciones nuevas que piden "Comenta X".
 * Cada publicación se mira una sola vez: si el dueño borra la regla que se
 * creó sola, no vuelve a aparecer. Devuelve cuántas reglas creó.
 */
async function revisarPublicacionesNuevas({ ahora = Date.now() } = {}) {
  const cuentas = (await db.find(db.accounts, {})).filter(a => cuentaConsultable(a) && a.ig_auto_reglas !== false);
  let creadas = 0;
  for (const account of cuentas) {
    let lista;
    try {
      lista = await publicacionesRecientes(account);
    } catch (e) {
      console.warn(`[reglas-solas] no se pudieron leer las publicaciones de @${account.ig_username || account.ig_user_id}: ${e.response?.data?.error?.message || e.message}`);
      continue;
    }
    const vistas = Array.isArray(account.ig_media_auto_vistos) ? account.ig_media_auto_vistos : [];
    const nuevasVistas = [];
    for (const m of lista) {
      if (!m?.id || vistas.includes(m.id)) continue;
      const cuando = Date.parse(m.timestamp);
      if (!Number.isFinite(cuando) || ahora - cuando > VENTANA_PUBLICACION_MS) continue;
      nuevasVistas.push(m.id);
      const existe = await db.findOne(db.postRules, { account_id: account._id, media_id: String(m.id) });
      if (existe) continue;
      const kw = palabraDeLaPublicacion(m.caption);
      if (!kw) continue;
      await db.insert(db.postRules, {
        account_id:   account._id,
        media_id:     String(m.id),
        keywords:     kw,
        entregar:     '',
        public_reply: '',
        agent_id:     null,
        permalink:    String(m.permalink || '').slice(0, 300) || null,
        thumb:        String(m.thumbnail_url || m.media_url || '').slice(0, 500).replace(/['"\\]/g, '') || null,
        caption:      String(m.caption || '').slice(0, 90),
        enabled:      true,
        auto:         true,
        desde:        m.timestamp,
      });
      creadas++;
      console.log(`📌 [reglas-solas] regla "${kw}" creada sola para la publicación ${m.id} de @${account.ig_username || account.ig_user_id}`);
    }
    if (nuevasVistas.length) {
      await db.update(db.accounts, { _id: account._id }, {
        ig_media_auto_vistos: [...nuevasVistas, ...vistas].slice(0, MAX_MEDIA_VISTOS),
      });
    }
  }
  return creadas;
}

/** Arranca la revisión periódica. Devuelve el timer (unref: no retiene el proceso). */
function iniciar(handleComment) {
  let corriendo = false;   // si una vuelta tarda más de un minuto, no se encima la siguiente
  const t = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      // Primero las publicaciones nuevas, así su regla ya existe cuando se leen los comentarios.
      await revisarPublicacionesNuevas().catch(e => console.error('[reglas-solas] revisión falló:', e.message));
      await revisarComentarios({ handleComment }).catch(e => console.error('[comentarios] revisión falló:', e.message));
    } finally { corriendo = false; }
  }, INTERVALO_MS);
  t.unref?.();
  return t;
}

/** Solo para tests. */
function _vistos() { return vistos; }

module.exports = {
  revisarComentarios, revisarPublicacionesNuevas, palabraDeLaPublicacion,
  iniciar, cuentaConsultable, INTERVALO_MS, _vistos,
};
