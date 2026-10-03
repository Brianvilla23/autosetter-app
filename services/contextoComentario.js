/**
 * Atinov — Que la respuesta a un comentario tenga contexto y aprenda
 *
 * Prueba de Brayan del 01-10-2026: alguien comentó "info" en un post que
 * decía "Atinov responde tus DMs y WhatsApp al instante, califica al que va
 * en serio y agenda solo" y el privado fue "Activa tu prueba gratuita de 3
 * días aquí: <link>. ¿Te gustaría que te ayude con eso?". Correcto, pero sin
 * contexto: no mencionaba el post, no contaba nada y cerraba con una
 * pregunta de call center. Y el mismo mensaje le iba a llegar a todos.
 *
 * Dos causas, dos piezas:
 *  1. El agente no sabía en QUÉ publicación comentaron: solo recibía "info".
 *     textoDePublicacion() trae el texto del post (la regla guarda 90
 *     caracteres; se le pide el completo a Instagram y se recuerda una hora).
 *  2. El agente no sabía qué les había escrito a los anteriores ni qué
 *     funcionó. Cada primer mensaje queda registrado como "apertura"; si la
 *     persona contesta, la apertura queda marcada como exitosa. El prompt
 *     recibe las últimas (para no repetirlas) y las que consiguieron
 *     respuesta (para imitar su idea, no su texto). Así mejora solo con el uso.
 */

const axios = require('axios');
const db    = require('../db/database');

const IG_GRAPH = 'https://graph.instagram.com/v21.0';
const FB_GRAPH = 'https://graph.facebook.com/v21.0';
const CACHE_MS = 60 * 60 * 1000;
const MAX_TEXTO_POST = 600;
const RECIENTES = 4;
const EXITOSAS = 3;
const VENTANA_RESPUESTA_MS = 7 * 24 * 3600 * 1000;

const cachePosts = new Map();   // mediaId → { texto, hasta }

/** El texto completo de la publicación, o el que guardó la regla. Nunca lanza. */
async function textoDePublicacion(mediaId, account, regla = null) {
  if (!mediaId) return regla?.caption || null;
  const enCache = cachePosts.get(String(mediaId));
  if (enCache && enCache.hasta > Date.now()) return enCache.texto;

  let texto = null;
  const token = account?.access_token;
  if (token) {
    try {
      const base = /^IG/.test(token) ? IG_GRAPH : FB_GRAPH;
      const r = await axios.get(`${base}/${encodeURIComponent(mediaId)}`, {
        params: { fields: 'caption', access_token: token }, timeout: 10000,
      });
      texto = r.data?.caption ? String(r.data.caption).slice(0, MAX_TEXTO_POST) : null;
    } catch { /* se usa lo que guardó la regla */ }
  }
  texto = texto || regla?.caption || null;
  if (cachePosts.size > 500) cachePosts.clear();
  cachePosts.set(String(mediaId), { texto, hasta: Date.now() + CACHE_MS });
  return texto;
}

/** Guarda el primer mensaje que el agente le mandó a alguien que comentó. */
async function registrarApertura({ accountId, leadId, mediaId = null, texto }) {
  if (!accountId || !leadId || !String(texto || '').trim()) return null;
  return db.insert(db.aperturas, {
    account_id: accountId,
    lead_id:    leadId,
    media_id:   mediaId ? String(mediaId) : null,
    texto:      String(texto).slice(0, 500),
    respondio:  false,
  });
}

/** La persona contestó: su apertura (de los últimos 7 días) funcionó. */
async function marcarRespondida(leadId, ahora = Date.now()) {
  if (!leadId) return false;
  const pendientes = await db.find(db.aperturas, { lead_id: leadId, respondio: false },
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const ultima = pendientes.find(a => ahora - Date.parse(a.createdAt) < VENTANA_RESPUESTA_MS);
  if (!ultima) return false;
  await db.update(db.aperturas, { _id: ultima._id }, { respondio: true, respondio_at: new Date(ahora).toISOString() });
  return true;
}

/**
 * Bloque para el prompt: lo que ya se dijo (no repetir) y lo que funcionó
 * (imitar la idea). Sin historial devuelve null y el agente sigue igual.
 */
async function bloqueAperturas(accountId) {
  if (!accountId) return null;
  const todas = await db.find(db.aperturas, { account_id: accountId },
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!todas.length) return null;
  const recientes = todas.slice(0, RECIENTES);
  const exitosas = todas.filter(a => a.respondio && !recientes.includes(a)).slice(0, EXITOSAS);
  const exitosasRecientes = recientes.filter(a => a.respondio);
  const partes = [];
  partes.push('Así les escribiste hace poco a otras personas que comentaron. NO repitas estas frases ni su misma estructura: cada persona tiene que sentir que le escribiste a ella.');
  partes.push(...recientes.map(a => `  · "${a.texto.slice(0, 220)}"`));
  const buenas = [...exitosasRecientes, ...exitosas].slice(0, EXITOSAS);
  if (buenas.length) {
    partes.push('Estas aperturas tuyas SÍ consiguieron que la persona contestara. Toma de ellas el tono y la idea, nunca el texto:');
    partes.push(...buenas.map(a => `  · "${a.texto.slice(0, 220)}"`));
  }
  return partes.join('\n');
}

/** Para el panel: qué porcentaje de aperturas consigue respuesta. */
async function resumenAperturas(accountId) {
  const todas = await db.find(db.aperturas, { account_id: accountId });
  const respondidas = todas.filter(a => a.respondio).length;
  return { total: todas.length, respondidas, tasa: todas.length ? respondidas / todas.length : null };
}

/** Solo para tests. */
function _cache() { return cachePosts; }

module.exports = {
  textoDePublicacion, registrarApertura, marcarRespondida, bloqueAperturas, resumenAperturas, _cache,
};
