/**
 * Atinov — Conectar Messenger con Facebook (sin copiar tokens)
 *
 * Antes el cliente tenía que sacar el ID de su Página y un Page Access Token
 * del panel de desarrolladores de Meta, y además suscribir la Página al
 * webhook a mano. Nadie que no sea desarrollador llega al final de eso, y el
 * App Review lo nota: los permisos de Páginas se piden para que el NEGOCIO
 * elija su Página y la app la deje lista, no para pegar tokens.
 *
 * El flujo ahora:
 *   1. El cliente aprieta "Conectar con Facebook" → popup de Meta (FB.login)
 *      donde acepta pages_show_list, pages_manage_metadata y pages_messaging.
 *   2. El navegador nos manda el token de usuario. Se verifica con Meta que
 *      sea de NUESTRA app y que traiga los permisos, se cambia por uno de
 *      larga duración y se leen sus Páginas (pages_show_list).
 *   3. El cliente elige una Página → se suscribe a los mensajes
 *      (pages_manage_metadata) y se guarda su token, que desde ahí contesta
 *      (pages_messaging).
 *
 * Los tokens de Página NUNCA viajan al navegador: quedan en memoria del
 * servidor 10 minutos, atados a la cuenta que los pidió, hasta que elige.
 *
 * Un token de Página sacado de un token de usuario de larga duración no
 * caduca (salvo que el dueño cambie la clave o quite la app). Por eso el
 * canje a larga duración es obligatorio: con el token corto la Página
 * quedaría muda en una hora.
 */

const axios = require('axios');
const db    = require('../db/database');

const GRAPH = 'https://graph.facebook.com/v21.0';

// Lo que el popup pide y lo que se exige que el cliente haya aceptado.
const SCOPES = ['pages_show_list', 'pages_manage_metadata', 'pages_messaging'];

// Qué recibe la Página suscrita. El webhook atiende `messages`; los
// postbacks (botones) se suscriben para no perderlos cuando se usen.
const CAMPOS_WEBHOOK = ['messages', 'messaging_postbacks'];

const NOMBRE_PERMISO = {
  pages_show_list:       'ver la lista de tus Páginas',
  pages_manage_metadata: 'suscribir la Página a los mensajes',
  pages_messaging:       'responder los mensajes de la Página',
};

// La app de Meta dueña del caso de uso Messenger es la PRINCIPAL (la misma
// del Embedded Signup de WhatsApp), no la sub-app de Instagram que vive en
// META_APP_ID. El webhook de Páginas llega firmado por esa app, y el token de
// Página tiene que ser de ella para que la suscripción le entregue los
// mensajes a Atinov. META_FB_APP_ID existe por si algún día se separan.
const appId = () =>
  process.env.META_FB_APP_ID || process.env.META_ES_APP_ID || process.env.META_APP_ID || '';
const appSecret = () =>
  process.env.META_FB_APP_SECRET || process.env.META_ES_APP_SECRET || process.env.META_APP_SECRET || '';

function estaHabilitado() {
  return !!(appId() && appSecret());
}

/**
 * Lo que el frontend necesita para abrir el popup. Nada es secreto.
 * `configId` es opcional: si Meta exige una Configuración de "Facebook Login
 * for Business" para pedir estos permisos, se crea en el panel con token de
 * USUARIO y se pone en META_FB_LOGIN_CONFIG_ID. Sin ella se piden por scope.
 */
function configPublica() {
  return {
    enabled:      estaHabilitado(),
    appId:        appId() || null,
    configId:     process.env.META_FB_LOGIN_CONFIG_ID || null,
    scopes:       SCOPES,
    graphVersion: 'v21.0',
  };
}

/** Error que se le muestra al cliente tal cual (no filtra nada interno). */
class ConexionInvalida extends Error {}

// ── Páginas en espera de que el cliente elija ────────────────────────────────
const pendientes = new Map();           // accountId → { paginas, expira }
const TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of pendientes.entries()) if (v.expira < ahora) pendientes.delete(k);
}, 10 * 60 * 1000).unref?.();

/**
 * Confirma con Meta que el token es válido, de NUESTRA app, y trae los tres
 * permisos. Sin el chequeo de app, alguien podría mandar un token sacado de
 * otra app y conectar una Página cuyos mensajes jamás nos llegarían.
 */
async function verificarToken(tokenUsuario) {
  let d;
  try {
    const r = await axios.get(`${GRAPH}/debug_token`, {
      params: { input_token: tokenUsuario, access_token: `${appId()}|${appSecret()}` },
      timeout: 15000,
    });
    d = r.data?.data || {};
  } catch {
    throw new ConexionInvalida('Meta no aceptó la autorización. Vuelve a apretar "Conectar con Facebook"');
  }
  if (!d.is_valid) throw new ConexionInvalida('la autorización de Facebook venció. Vuelve a apretar "Conectar con Facebook"');
  if (String(d.app_id) !== String(appId())) {
    throw new ConexionInvalida('esa autorización no es de Atinov');
  }
  const concedidos = Array.isArray(d.scopes) ? d.scopes : [];
  const faltan = SCOPES.filter(s => !concedidos.includes(s));
  if (faltan.length) {
    const que = faltan.map(s => NOMBRE_PERMISO[s]).join(', ');
    throw new ConexionInvalida(`en la ventana de Facebook quedó sin marcar el permiso para ${que}. Vuelve a conectar y deja los permisos activados`);
  }
  return d;
}

/** Token corto (1-2 h) → token de larga duración (~60 días). */
async function tokenLargo(tokenUsuario) {
  try {
    const r = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        grant_type:        'fb_exchange_token',
        client_id:         appId(),
        client_secret:     appSecret(),
        fb_exchange_token: tokenUsuario,
      },
      timeout: 15000,
    });
    if (!r.data?.access_token) throw new Error('sin access_token');
    return r.data.access_token;
  } catch {
    throw new ConexionInvalida('Meta no entregó un acceso duradero. Vuelve a apretar "Conectar con Facebook"');
  }
}

// Quien solo ve estadísticas o publica anuncios no puede contestar mensajes
// ni suscribir la Página. Si Meta no manda las tareas (pasa con algunas
// Páginas de la experiencia nueva) no se bloquea: la suscripción decide.
function puedeConectar(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return true;
  return ['MANAGE', 'MODERATE', 'MESSAGING'].some(t => tasks.includes(t));
}

/**
 * Paso 2: lee las Páginas del cliente y las deja en espera.
 * Devuelve la lista SIN tokens, que es lo único que ve el navegador.
 */
async function listarPaginas({ accountId, tokenUsuario }) {
  if (!tokenUsuario || typeof tokenUsuario !== 'string' || tokenUsuario.length > 1000) {
    throw new ConexionInvalida('Facebook no devolvió la autorización. Vuelve a intentarlo');
  }
  await verificarToken(tokenUsuario);
  const largo = await tokenLargo(tokenUsuario);

  let crudas = [];
  try {
    const r = await axios.get(`${GRAPH}/me/accounts`, {
      params: { fields: 'id,name,access_token,tasks,category', limit: 100 },
      headers: { Authorization: `Bearer ${largo}` },
      timeout: 15000,
    });
    crudas = r.data?.data || [];
  } catch {
    throw new ConexionInvalida('no se pudo leer la lista de tus Páginas de Facebook');
  }

  const paginas = crudas
    .filter(p => p?.id && p?.access_token)
    .map(p => ({
      id:        String(p.id),
      nombre:    String(p.name || 'Página sin nombre').slice(0, 120),
      categoria: String(p.category || '').slice(0, 80),
      puede:     puedeConectar(p.tasks),
      token:     p.access_token,
    }));

  pendientes.set(accountId, { paginas, expira: Date.now() + TTL_MS });

  return paginas.map(({ token, ...visible }) => visible);
}

/** Suscribe NUESTRA app a los mensajes de la Página (pages_manage_metadata). */
async function suscribirPagina({ pageId, pageToken }) {
  const r = await axios.post(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, null, {
    params: { subscribed_fields: CAMPOS_WEBHOOK.join(','), access_token: pageToken },
    timeout: 15000,
  });
  if (r.data?.success !== true) throw new Error('Meta no confirmó la suscripción');
}

/**
 * Paso 3: conecta la Página elegida. Solo acepta Páginas que salieron de
 * `listarPaginas` para ESTA cuenta en los últimos 10 minutos: el navegador
 * manda un id, nunca un token.
 */
async function conectarPagina({ accountId, pageId, waDisplayNumber }) {
  const espera = pendientes.get(accountId);
  if (!espera || espera.expira < Date.now()) {
    pendientes.delete(accountId);
    throw new ConexionInvalida('pasaron más de 10 minutos desde que entraste con Facebook. Vuelve a apretar "Conectar con Facebook"');
  }
  const pagina = espera.paginas.find(p => p.id === String(pageId));
  if (!pagina) throw new ConexionInvalida('esa Página no está entre las que autorizaste en Facebook');
  if (!pagina.puede) {
    throw new ConexionInvalida(`tu usuario no administra los mensajes de "${pagina.nombre}". Pide a quien administra la Página que te dé control total o que la conecte`);
  }

  try {
    await suscribirPagina({ pageId: pagina.id, pageToken: pagina.token });
  } catch (e) {
    console.error('[messenger-login] suscripción falló:', e.response?.data?.error?.message || e.message);
    throw new ConexionInvalida(`Meta no dejó suscribir "${pagina.nombre}" a los mensajes. Revisa que sigas administrando la Página y reintenta`);
  }

  const upd = {
    fb_page_id:           pagina.id,
    fb_page_token:        pagina.token,
    fb_page_name:         pagina.nombre,
    fb_conectado_via:     'facebook_login',
    fb_suscrito_at:       new Date().toISOString(),
    fb_pausado:           false,
    fb_reconectar:        false,
    fb_reconectar_motivo: null,
    fb_reconectar_at:     null,
    fb_token_aviso_at:    null,
  };
  if (waDisplayNumber !== undefined) upd.wa_display_number = String(waDisplayNumber || '').trim().slice(0, 30);
  await db.update(db.accounts, { _id: accountId }, upd);

  pendientes.delete(accountId);   // los demás tokens de Página no se guardan
  return { pageId: pagina.id, nombre: pagina.nombre };
}

/**
 * Al olvidar las credenciales, se saca a Atinov de la Página. Si falla (token
 * ya revocado, Página borrada) no importa: igual se borran los datos locales.
 */
async function desuscribirPagina({ pageId, pageToken }) {
  if (!pageId || !pageToken) return false;
  try {
    await axios.delete(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, {
      params: { access_token: pageToken },
      timeout: 15000,
    });
    return true;
  } catch (e) {
    console.warn('[messenger-login] desuscripción falló (se sigue igual):', e.response?.data?.error?.message || e.message);
    return false;
  }
}

/** Solo para tests: ver/limpiar lo que está en espera. */
function _pendientes() { return pendientes; }

module.exports = {
  SCOPES,
  CAMPOS_WEBHOOK,
  estaHabilitado,
  configPublica,
  listarPaginas,
  conectarPagina,
  desuscribirPagina,
  puedeConectar,
  ConexionInvalida,
  _pendientes,
};
