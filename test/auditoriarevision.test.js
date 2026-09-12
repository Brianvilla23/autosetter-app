/**
 * Atinov — Revisión de las reparaciones (12-09): lo que quedó a medias.
 *
 * Lo que se fija: una reserva de marketing que no termina en envío se
 * libera (el lead no queda bloqueado el día por un fallo); Polar recibe el
 * plan comprado en metadata; el cupo diario de "analizar texto" se reserva y
 * se libera si el modelo falla; el buscador del Inbox encuentra leads de
 * WhatsApp por nombre y número.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-revision-test-')
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-test-largo-y-aburrido-1234567890';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const limits = require('../services/limits');
const { reservarMarketing, liberarMarketing } = require('../services/playbookPedido');

function handlerDe(router, path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;   // el de negocio (salta rate limiters)
}
function llamar(handler, { body = {}, query = {}, params = {}, user } = {}) {
  return new Promise((resolve) => {
    const req = { body, query, params, headers: {}, ip: '127.0.0.1', user };
    const res = { _status: 200, status(s) { this._status = s; return this; }, json(d) { resolve({ status: this._status, data: d }); } };
    Promise.resolve(handler(req, res, (e) => resolve({ status: 500, data: { error: e && e.message } })))
      .catch(e => resolve({ status: 500, data: { error: e.message } }));
  });
}

// ── 1. Reserva de marketing que no termina en envío se libera ───────────────

test('liberarMarketing: tras un envío fallido el lead puede recibir marketing hoy', async () => {
  const lead = await db.insert(db.leads, { account_id: 'acc', wa_id: '56911111111' });
  const cfg = { capMktMes: 3 };
  assert.strictEqual((await reservarMarketing(lead._id, lead, cfg)).ok, true);
  let l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.mkt_last_day, limits.hoyChile());
  // el envío falló → se devuelve la reserva
  await liberarMarketing(lead._id);
  l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.mkt_count_month, 0);
  assert.strictEqual(l.mkt_last_day, null);
  // y hoy se puede intentar de nuevo
  assert.strictEqual((await reservarMarketing(lead._id, l, cfg)).ok, true);
  // liberar dos veces no deja el contador negativo
  await liberarMarketing(lead._id); await liberarMarketing(lead._id);
  l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.mkt_count_month, 0);
});

// ── 2. Polar recibe el plan comprado ────────────────────────────────────────

test('polar.createCheckout manda el plan pedido en metadata (no siempre founder)', async () => {
  process.env.POLAR_API_KEY = 'polar-test';
  process.env.POLAR_PRODUCT_PRICE_ID = 'price-default';
  const axios = require('axios');
  const original = axios.post;
  const llamadas = [];
  axios.post = async (url, body) => { llamadas.push({ url, body }); return { data: { url: 'https://polar/x', id: 'chk_1' } }; };
  try {
    const polar = require('../services/polar');
    await polar.createCheckout({ userId: 'u1', email: 'a@b.cl', name: 'A', appUrl: 'https://atinov.com', priceId: 'price-escala', plan: 'escala' });
    assert.strictEqual(llamadas[0].body.metadata.plan, 'escala');
    assert.strictEqual(llamadas[0].body.product_price_id, 'price-escala');
    await polar.createCheckout({ userId: 'u1', email: 'a@b.cl', name: 'A', appUrl: 'https://atinov.com' });
    assert.strictEqual(llamadas[1].body.metadata.plan, 'founder', 'sin plan sigue siendo founder (compatibilidad)');
    assert.strictEqual(llamadas[1].body.product_price_id, 'price-default');
  } finally { axios.post = original; }
});

// ── 3. Cupo de "analizar texto": reserva atómica y liberación si falla ──────

test('analizar-texto: un fallo del modelo devuelve el cupo; el éxito lo consume', async () => {
  const accountId = 'acc-' + crypto.randomUUID();
  const intelligenceRouter = require('../routes/intelligence');
  const post = handlerDe(intelligenceRouter, '/improvements/analizar-texto', 'post');
  const pi = require('../services/promptImprover');
  const original = pi.analyzeUploadedText;
  try {
    pi.analyzeUploadedText = async () => ({ ok: false, error: 'texto muy corto' });
    let r = await llamar(post, { body: { accountId, texto: 'x' }, user: { accountId, userId: 'u1' } });
    assert.strictEqual(r.status, 400);
    let s = await db.findOne(db.settings, { account_id: accountId });
    assert.strictEqual(Number(s.upload_analysis_count || 0), 0, 'el fallo no quema cupo');

    pi.analyzeUploadedText = async () => ({ ok: true, propuestas: [] });
    r = await llamar(post, { body: { accountId, texto: 'hola '.repeat(50) }, user: { accountId, userId: 'u1' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    s = await db.findOne(db.settings, { account_id: accountId });
    assert.strictEqual(s.upload_analysis_count, 1);
    assert.strictEqual(s.upload_analysis_date, limits.hoyChile(), 'fecha en hora de Chile');
  } finally { pi.analyzeUploadedText = original; }
});

// ── 4. Buscador del Inbox ───────────────────────────────────────────────────

test('inbox: busca leads de WhatsApp por nombre de perfil, contacto y número', async () => {
  const accountId = 'acc-' + crypto.randomUUID();
  const inboxRouter = require('../routes/inbox');
  const get = handlerDe(inboxRouter, '/', 'get');
  await db.insert(db.leads, { account_id: accountId, channel: 'whatsapp', wa_id: '56987654321', wa_name: 'Camila Torres', status: 'active' });
  await db.insert(db.leads, { account_id: accountId, channel: 'instagram', ig_user_id: '178', ig_username: 'pedro.gym', status: 'active' });
  const user = { accountId, userId: 'u1' };
  const porNombre = await llamar(get, { query: { accountId, search: 'camila' }, user });
  assert.strictEqual(porNombre.status, 200, JSON.stringify(porNombre.data));
  assert.strictEqual(porNombre.data.items.length, 1);
  const porNumero = await llamar(get, { query: { accountId, search: '8765' }, user });
  assert.strictEqual(porNumero.data.items.length, 1);
  const porIg = await llamar(get, { query: { accountId, search: '@pedro' }, user });
  assert.strictEqual(porIg.data.items.length, 1);
});
