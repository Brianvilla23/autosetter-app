/**
 * Atinov — Suite de "Conectar Messenger con Facebook"
 *
 * El token de usuario llega desde el navegador del cliente, así que se trata
 * como falsificable: se confirma con Meta que sea de NUESTRA app y que traiga
 * los 3 permisos. Y los tokens de Página jamás salen del servidor: el
 * navegador solo manda el id de la Página que eligió, y solo sirve si esa
 * Página salió de la lista de ESA misma cuenta.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-msgr-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const db = require('../db/database');
const ml = require('../services/messengerLogin');

const APP = '907168025773391';

function conApp() {
  process.env.META_ES_APP_ID = APP;
  process.env.META_ES_APP_SECRET = 'secreto-principal';
  process.env.META_APP_ID = 'sub-app-instagram';
  process.env.META_APP_SECRET = 'secreto-ig';
  delete process.env.META_FB_APP_ID; delete process.env.META_FB_APP_SECRET;
}

/**
 * Finge a Meta. `debug` es lo que responde debug_token; `paginas` lo que
 * responde /me/accounts. Guarda cada llamada para revisarla después.
 */
function fingirMeta({ debug, paginas = [], suscribe = { success: true } } = {}) {
  const orig = { get: axios.get, post: axios.post, delete: axios.delete };
  const llamadas = [];
  axios.get = async (url, cfg) => {
    llamadas.push({ metodo: 'GET', url, cfg });
    if (url.endsWith('/debug_token')) return { data: { data: debug } };
    if (url.endsWith('/oauth/access_token')) return { data: { access_token: 'TOKEN_USUARIO_LARGO' } };
    if (url.endsWith('/me/accounts')) return { data: { data: paginas } };
    throw new Error('url no esperada ' + url);
  };
  axios.post = async (url, body, cfg) => {
    llamadas.push({ metodo: 'POST', url, cfg });
    if (suscribe instanceof Error) throw suscribe;
    return { data: suscribe };
  };
  axios.delete = async (url, cfg) => {
    llamadas.push({ metodo: 'DELETE', url, cfg });
    return { data: { success: true } };
  };
  return { llamadas, restaurar: () => Object.assign(axios, orig) };
}

const DEBUG_OK = {
  is_valid: true, app_id: APP,
  scopes: ['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'public_profile'],
};
const PAGINAS = [
  { id: '1111111111', name: 'Barbería Don Pepe', category: 'Barbería', access_token: 'TOKEN_PAGINA_1', tasks: ['MANAGE', 'MODERATE', 'MESSAGING'] },
  { id: '2222222222', name: 'Página de un amigo', category: 'Blog', access_token: 'TOKEN_PAGINA_2', tasks: ['ANALYZE'] },
];

async function cuentaNueva() {
  const a = await db.insert(db.accounts, { name: 'prueba' });
  return a._id;
}

// ─────────────────────────────────────────────────────────────────────────────

test('sin app ni secreto la función está apagada; la config pública no lleva el secreto', () => {
  const prev = { ...process.env };
  for (const k of ['META_FB_APP_ID', 'META_FB_APP_SECRET', 'META_ES_APP_ID', 'META_ES_APP_SECRET', 'META_APP_ID', 'META_APP_SECRET']) delete process.env[k];
  assert.strictEqual(ml.estaHabilitado(), false);

  conApp();
  assert.strictEqual(ml.estaHabilitado(), true);
  const cfg = ml.configPublica();
  assert.ok(!JSON.stringify(cfg).includes('secreto'), 'el app secret jamás viaja al navegador');
  assert.deepStrictEqual(cfg.scopes, ['pages_show_list', 'pages_manage_metadata', 'pages_messaging']);
  assert.strictEqual(cfg.configId, null, 'sin configuración: se piden por scope');
  process.env = prev;
});

test('usa la app PRINCIPAL (la del caso Messenger), no la sub-app de Instagram', () => {
  const prev = { ...process.env };
  conApp();
  assert.strictEqual(ml.configPublica().appId, APP);
  process.env = prev;
});

test('un token de OTRA app se rechaza antes de leer Páginas', async () => {
  const prev = { ...process.env }; conApp();
  const meta = fingirMeta({ debug: { ...DEBUG_OK, app_id: '999' }, paginas: PAGINAS });
  try {
    const acc = await cuentaNueva();
    await assert.rejects(ml.listarPaginas({ accountId: acc, tokenUsuario: 'tok' }), ml.ConexionInvalida);
    assert.ok(!meta.llamadas.some(l => l.url.endsWith('/me/accounts')), 'no se consultan Páginas con un token ajeno');
  } finally { meta.restaurar(); process.env = prev; }
});

test('si el cliente desmarcó un permiso, se le dice cuál en palabras simples', async () => {
  const prev = { ...process.env }; conApp();
  const meta = fingirMeta({ debug: { ...DEBUG_OK, scopes: ['pages_show_list', 'pages_messaging'] } });
  try {
    const acc = await cuentaNueva();
    await assert.rejects(
      ml.listarPaginas({ accountId: acc, tokenUsuario: 'tok' }),
      (e) => e instanceof ml.ConexionInvalida && /suscribir la Página a los mensajes/.test(e.message)
    );
  } finally { meta.restaurar(); process.env = prev; }
});

test('la lista que ve el navegador NO trae tokens de Página', async () => {
  const prev = { ...process.env }; conApp();
  const meta = fingirMeta({ debug: DEBUG_OK, paginas: PAGINAS });
  try {
    const acc = await cuentaNueva();
    const lista = await ml.listarPaginas({ accountId: acc, tokenUsuario: 'tok' });
    assert.strictEqual(lista.length, 2);
    assert.ok(!JSON.stringify(lista).includes('TOKEN_PAGINA'), 'ningún token sale al navegador');
    assert.deepStrictEqual(lista.map(p => p.puede), [true, false], 'quien solo ve estadísticas no puede conectar');
    // Las Páginas se leen con el token LARGO, no con el corto del popup.
    const cuentas = meta.llamadas.find(l => l.url.endsWith('/me/accounts'));
    assert.strictEqual(cuentas.cfg.headers.Authorization, 'Bearer TOKEN_USUARIO_LARGO');
  } finally { meta.restaurar(); process.env = prev; }
});

test('conectar suscribe la Página con SU token y la guarda en la cuenta', async () => {
  const prev = { ...process.env }; conApp();
  const meta = fingirMeta({ debug: DEBUG_OK, paginas: PAGINAS });
  try {
    const acc = await cuentaNueva();
    await ml.listarPaginas({ accountId: acc, tokenUsuario: 'tok' });
    const r = await ml.conectarPagina({ accountId: acc, pageId: '1111111111', waDisplayNumber: '+56 9 1234 5678' });
    assert.deepStrictEqual(r, { pageId: '1111111111', nombre: 'Barbería Don Pepe' });

    const sus = meta.llamadas.find(l => l.metodo === 'POST');
    assert.ok(sus.url.endsWith('/1111111111/subscribed_apps'));
    assert.strictEqual(sus.cfg.params.access_token, 'TOKEN_PAGINA_1');
    assert.strictEqual(sus.cfg.params.subscribed_fields, 'messages,messaging_postbacks');

    const cuenta = await db.findOne(db.accounts, { _id: acc });
    assert.strictEqual(cuenta.fb_page_id, '1111111111');
    assert.strictEqual(cuenta.fb_page_token, 'TOKEN_PAGINA_1');
    assert.strictEqual(cuenta.fb_page_name, 'Barbería Don Pepe');
    assert.strictEqual(cuenta.fb_conectado_via, 'facebook_login');
    assert.strictEqual(cuenta.wa_display_number, '+56 9 1234 5678');
    assert.strictEqual(ml._pendientes().has(acc), false, 'los demás tokens se descartan');
  } finally { meta.restaurar(); process.env = prev; }
});

test('otra cuenta no puede conectar una Página que listó alguien más', async () => {
  const prev = { ...process.env }; conApp();
  const meta = fingirMeta({ debug: DEBUG_OK, paginas: PAGINAS });
  try {
    const duena = await cuentaNueva();
    const intrusa = await cuentaNueva();
    await ml.listarPaginas({ accountId: duena, tokenUsuario: 'tok' });
    await assert.rejects(ml.conectarPagina({ accountId: intrusa, pageId: '1111111111' }), ml.ConexionInvalida);
    await assert.rejects(ml.conectarPagina({ accountId: duena, pageId: '3333333333' }), ml.ConexionInvalida,
      'una Página que no vino en la lista tampoco');
    assert.ok(!meta.llamadas.some(l => l.metodo === 'POST'), 'no se suscribió nada');
  } finally { meta.restaurar(); process.env = prev; }
});

test('si Meta no deja suscribir, no se guarda nada', async () => {
  const prev = { ...process.env }; conApp();
  const meta = fingirMeta({ debug: DEBUG_OK, paginas: PAGINAS, suscribe: new Error('(#200) permisos') });
  try {
    const acc = await cuentaNueva();
    await ml.listarPaginas({ accountId: acc, tokenUsuario: 'tok' });
    await assert.rejects(ml.conectarPagina({ accountId: acc, pageId: '1111111111' }), ml.ConexionInvalida);
    const cuenta = await db.findOne(db.accounts, { _id: acc });
    assert.ok(!cuenta.fb_page_token, 'una Página sin suscripción quedaría conectada y muda');
  } finally { meta.restaurar(); process.env = prev; }
});

test('quién puede conectar según sus tareas en la Página', () => {
  assert.strictEqual(ml.puedeConectar(['ANALYZE', 'ADVERTISE']), false);
  assert.strictEqual(ml.puedeConectar(['MANAGE']), true);
  assert.strictEqual(ml.puedeConectar(['MODERATE', 'MESSAGING']), true);
  assert.strictEqual(ml.puedeConectar(undefined), true, 'sin tareas no se bloquea: decide la suscripción');
});

test('olvidar credenciales desuscribe la Página y nunca revienta', async () => {
  const meta = fingirMeta({});
  try {
    assert.strictEqual(await ml.desuscribirPagina({ pageId: '1111111111', pageToken: 'T' }), true);
    assert.ok(meta.llamadas.some(l => l.metodo === 'DELETE' && l.url.endsWith('/1111111111/subscribed_apps')));
    assert.strictEqual(await ml.desuscribirPagina({ pageId: null, pageToken: null }), false);
  } finally { meta.restaurar(); }

  const orig = axios.delete;
  axios.delete = async () => { throw new Error('token revocado'); };
  try {
    assert.strictEqual(await ml.desuscribirPagina({ pageId: '1', pageToken: 'T' }), false);
  } finally { axios.delete = orig; }
});
