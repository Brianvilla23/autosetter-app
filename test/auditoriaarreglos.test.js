/**
 * Atinov — Arreglos de la auditoría de código (2026-09-12)
 *
 * Tres familias que ya nos habían mordido:
 *  1. PUT parcial que BORRA campos: `{ a, b }` con undefined en un $set de
 *     NeDB deja el documento sin esos campos (links, knowledge).
 *  2. Tenencia: un número de WhatsApp o una Página de Facebook en dos
 *     cuentas hace que el webhook conteste los mensajes de un negocio con
 *     el agente de otro (mismo candado que ya tenía ig_user_id).
 *  3. Cascada de borrado (Ley 21.719): errorLog guarda email e IP del
 *     titular y no se borraba.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-auditoria-test-')
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-test-largo-y-aburrido-1234567890';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const linksRouter     = require('../routes/links');
const knowledgeRouter = require('../routes/knowledge');
const settingsRouter  = require('../routes/settings');
const { POR_CUENTA, POR_USUARIO } = require('../services/supresionPlan');

function handlerDe(router, path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack.map(s => s.handle);
}
function llamar(handlers, { body = {}, params = {}, user } = {}) {
  return new Promise((resolve) => {
    const req = { body, params, query: {}, headers: {}, ip: '127.0.0.1', get: () => undefined, user };
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { resolve({ status: this._status, data: d }); },
      sendStatus(s) { resolve({ status: s, data: null }); },
    };
    let i = 0;
    const next = (e) => {
      if (e) return resolve({ status: 500, data: { error: e.message } });
      const h = handlers[i++];
      if (!h) return resolve({ status: res._status, data: null });
      Promise.resolve(h(req, res, next)).catch(err => resolve({ status: 500, data: { error: err.message } }));
    };
    next();
  });
}
async function cuenta(extra = {}) {
  const id = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: id, ig_username: 'negocio', ...extra });
  return id;
}

// ── 1. PUT parcial no borra ──────────────────────────────────────────────────

test('links: PUT parcial conserva los campos que no vinieron', async () => {
  const acc = await cuenta();
  const link = await db.insert(db.links, { account_id: acc, name: 'Catálogo', url: 'https://x.cl/c', description: 'PDF con precios' });
  const r = await llamar(handlerDe(linksRouter, '/:id', 'put'), { params: { id: link._id }, user: { accountId: acc }, body: { name: 'Catálogo 2026' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const doc = await db.findOne(db.links, { _id: link._id });
  assert.strictEqual(doc.name, 'Catálogo 2026');
  assert.strictEqual(doc.url, 'https://x.cl/c', 'la url no vino: no se borra');
  assert.strictEqual(doc.description, 'PDF con precios');
});

test('knowledge: PUT parcial conserva título/contenido y no vacía agent_ids si no viene', async () => {
  const acc = await cuenta();
  const k = await db.insert(db.knowledge, { account_id: acc, title: 'Horarios', content: 'Lunes a viernes 9 a 18', is_main: true, agent_ids: ['ag-1'] });
  const r = await llamar(handlerDe(knowledgeRouter, '/:id', 'put'), { params: { id: k._id }, user: { accountId: acc }, body: { content: 'Lunes a sábado 9 a 20' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const doc = await db.findOne(db.knowledge, { _id: k._id });
  assert.strictEqual(doc.title, 'Horarios');
  assert.strictEqual(doc.content, 'Lunes a sábado 9 a 20');
  assert.strictEqual(doc.is_main, true);
  assert.deepStrictEqual(doc.agent_ids, ['ag-1'], 'antes un PUT sin agentIds los vaciaba');
});

// ── 2. Un número / una Página = UNA cuenta ───────────────────────────────────

test('settings/whatsapp: no se puede conectar el número de OTRA cuenta (409); el propio sí', async () => {
  const victima  = await cuenta({ wa_phone_number_id: '111222333', wa_access_token: 'tok-victima' });
  const atacante = await cuenta();
  const put = handlerDe(settingsRouter, '/whatsapp', 'put');

  const robo = await llamar(put, { user: { accountId: atacante }, body: { accountId: atacante, wa_phone_number_id: '111222333', wa_business_account_id: '999', wa_access_token: 'EAAB' + 'x'.repeat(40) } });
  assert.strictEqual(robo.status, 409);
  assert.match(robo.data.error, /otra cuenta/);
  const a = await db.findOne(db.accounts, { _id: atacante });
  assert.ok(!a.wa_phone_number_id, 'el atacante no se quedó con el número');
  const v = await db.findOne(db.accounts, { _id: victima });
  assert.strictEqual(v.wa_phone_number_id, '111222333');

  // La víctima re-guarda su MISMO número: no es colisión.
  const propio = await llamar(put, { user: { accountId: victima }, body: { accountId: victima, wa_phone_number_id: '111222333' } });
  assert.strictEqual(propio.status, 200);
  // Y un número libre entra normal.
  const libre = await llamar(put, { user: { accountId: atacante }, body: { accountId: atacante, wa_phone_number_id: '444555666' } });
  assert.strictEqual(libre.status, 200);
});

test('settings/messenger: no se puede conectar la Página de OTRA cuenta (409)', async () => {
  const victima  = await cuenta({ fb_page_id: 'page-77', fb_page_token: 'tok' });
  const atacante = await cuenta();
  const put = handlerDe(settingsRouter, '/messenger', 'put');
  const robo = await llamar(put, { user: { accountId: atacante }, body: { accountId: atacante, fb_page_id: 'page-77', fb_page_token: 'EAAB' + 'x'.repeat(40) } });
  assert.strictEqual(robo.status, 409);
  const a = await db.findOne(db.accounts, { _id: atacante });
  assert.ok(!a.fb_page_id);
  const v = await db.findOne(db.accounts, { _id: victima });
  assert.strictEqual(v.fb_page_id, 'page-77');
});

// ── 3. errorLog se borra con la cuenta y con el usuario ──────────────────────

test('errorLog está en la cascada de supresión por cuenta Y por usuario', () => {
  const porCuenta  = POR_CUENTA.find(([c]) => c === 'errorLog');
  const porUsuario = POR_USUARIO.find(([c]) => c === 'errorLog');
  assert.ok(porCuenta, 'falta errorLog por cuenta');
  assert.strictEqual(porCuenta[1], 'accountId', 'errorTracker guarda accountId (camelCase)');
  assert.ok(porUsuario, 'falta errorLog por usuario');
  assert.strictEqual(porUsuario[1], 'userId');
});
