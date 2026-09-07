/**
 * Atinov — Tests de tenencia entre cuentas (pentest 06-09-2026)
 *
 * Tres hallazgos MEDIOS que se cierran acá y no pueden volver:
 *  1. PUT /api/settings/account dejaba fijar CUALQUIER ig_user_id → una cuenta
 *     podía reclamar el ID de Instagram de otra y desviar el ruteo del webhook
 *     (que resuelve la cuenta por ig_user_id). Ahora: formato + unicidad.
 *  2. POST /api/user/change-password era anónima y distinguía "no existe" de
 *     "clave mala": enumeración de correos. Ahora exige sesión y responde igual.
 *  3. enforceMaxAgents/enforceMaxMagnets consultaban la cuenta del BODY antes
 *     del check de propiedad: sonda de cuántos agentes tiene otra cuenta.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-tenencia-test-')
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-test-largo-y-aburrido-1234567890';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('../db/database');
const settingsRouter = require('../routes/settings');
const userRouter = require('../routes/userAuth');
const { enforceMaxAgents } = require('../middleware/checkPlanLimits');

function handlerDe(router, path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack.map(s => s.handle);
}
/** Corre la cadena de handlers de una ruta (middlewares incluidos). */
function llamar(handlers, { body = {}, headers = {}, user } = {}) {
  return new Promise((resolve) => {
    const req = { body, headers, query: {}, ip: '127.0.0.1', get: h => headers[h.toLowerCase()] };
    if (user) req.user = user;
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { resolve({ status: this._status, data: d }); },
      sendStatus(s) { resolve({ status: s, data: null }); },
    };
    let i = 0;
    const next = (e) => {
      if (e) return resolve({ status: 500, data: null, error: e });
      const h = handlers[i++];
      if (!h) return resolve({ status: 200, data: 'fin sin respuesta' });
      Promise.resolve(h(req, res, next)).catch(err => resolve({ status: 500, data: null, error: err }));
    };
    next();
  });
}
async function cuenta(extra = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'negocio', ...extra });
  return accountId;
}

// ── #1 PUT /api/settings/account ─────────────────────────────────────────────

test('settings/account: no se puede reclamar el ig_user_id de OTRA cuenta (409), ni un ID que no sea de Meta', async () => {
  const victima = await cuenta({ ig_user_id: '17841400000000001', access_token: 'tok-victima-xxxxxxxxxxxx' });
  const atacante = await cuenta();
  const put = handlerDe(settingsRouter, '/account', 'put');
  const yo = { accountId: atacante };

  const robo = await llamar(put, { user: yo, body: { accountId: atacante, ig_user_id: '17841400000000001', access_token: 'EAAB' + 'x'.repeat(40) } });
  assert.strictEqual(robo.status, 409);
  const v = await db.findOne(db.accounts, { _id: victima });
  assert.strictEqual(v.ig_user_id, '17841400000000001', 'la víctima sigue dueña de su ID');
  const a = await db.findOne(db.accounts, { _id: atacante });
  assert.ok(!a.ig_user_id, 'el atacante no se quedó con nada');

  const noNumerico = await llamar(put, { user: yo, body: { accountId: atacante, ig_user_id: 'demo_ig_id', access_token: 'EAAB' + 'x'.repeat(40) } });
  assert.strictEqual(noNumerico.status, 400);

  const tokenBasura = await llamar(put, { user: yo, body: { accountId: atacante, ig_user_id: '17841400000000002', access_token: 'corto' } });
  assert.strictEqual(tokenBasura.status, 400);

  const ajeno = await llamar(put, { user: { accountId: 'otra' }, body: { accountId: atacante, ig_username: 'x' } });
  assert.strictEqual(ajeno.status, 403);
});

test('settings/account: la conexión manual legítima sigue funcionando (ID propio libre, username con @)', async () => {
  const mia = await cuenta();
  const put = handlerDe(settingsRouter, '/account', 'put');
  const r = await llamar(put, { user: { accountId: mia }, body: { accountId: mia, ig_username: '@mi.negocio', ig_user_id: '17841400000000009', access_token: 'IGQVJ' + 'y'.repeat(60) } });
  assert.strictEqual(r.status, 200);
  const a = await db.findOne(db.accounts, { _id: mia });
  assert.strictEqual(a.ig_username, 'mi.negocio');
  assert.strictEqual(a.ig_user_id, '17841400000000009');
  // Re-guardar el MISMO ID en la misma cuenta no es colisión.
  const r2 = await llamar(put, { user: { accountId: mia }, body: { accountId: mia, ig_user_id: '17841400000000009', access_token: 'IGQVJ' + 'z'.repeat(60) } });
  assert.strictEqual(r2.status, 200);
  // Solo el nombre, sin tocar credenciales.
  const r3 = await llamar(put, { user: { accountId: mia }, body: { accountId: mia, ig_username: 'otro.nombre' } });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual((await db.findOne(db.accounts, { _id: mia })).access_token, 'IGQVJ' + 'z'.repeat(60));
});

// ── #2 POST /api/user/change-password ────────────────────────────────────────

test('change-password: sin sesión no entra (401), y con sesión no enumera: clave mala y usuario borrado responden igual', async () => {
  const cadena = handlerDe(userRouter, '/change-password', 'post');
  assert.ok(cadena.length >= 2, 'lleva requireAuth delante del handler');

  const sinToken = await llamar(cadena, { body: { email: 'alguien@x.cl', currentPassword: 'a', newPassword: 'NuevaClave123!' } });
  assert.strictEqual(sinToken.status, 401);

  const userId = 'u-' + crypto.randomUUID();
  await db.insert(db.users, { _id: userId, email: 'dueno@x.cl', password_hash: await bcrypt.hash('Correcta123!', 4), account_id: 'acc-x' });
  const handler = cadena[cadena.length - 1];

  const mala = await llamar([handler], { user: { userId }, body: { currentPassword: 'Incorrecta', newPassword: 'NuevaClave123!' } });
  const fantasma = await llamar([handler], { user: { userId: 'u-no-existe' }, body: { currentPassword: 'Incorrecta', newPassword: 'NuevaClave123!' } });
  assert.strictEqual(mala.status, 401);
  assert.strictEqual(fantasma.status, 401);
  assert.deepStrictEqual(mala.data, fantasma.data, 'misma respuesta: no se distingue usuario inexistente');

  // El email del body se ignora: no se puede cambiar la clave de otro.
  const ok = await llamar([handler], { user: { userId }, body: { email: 'otro@x.cl', currentPassword: 'Correcta123!', newPassword: 'NuevaClave123!' } });
  assert.strictEqual(ok.status, 200);
  const u = await db.findOne(db.users, { _id: userId });
  assert.ok(await bcrypt.compare('NuevaClave123!', u.password_hash));
});

// ── #3 enforceMaxAgents ──────────────────────────────────────────────────────

test('enforceMaxAgents mira SOLO la cuenta del usuario autenticado, no la del body', async () => {
  const victima = await cuenta();
  await db.insert(db.agents, { account_id: victima, name: 'A', enabled: true });
  const mia = await cuenta();
  const userId = 'u-' + crypto.randomUUID();
  // Trial: 1 agente máximo. La víctima ya tiene 1; yo tengo 0.
  await db.insert(db.users, { _id: userId, email: 'yo@x.cl', account_id: mia, membershipPlan: 'trial', role: 'user' });

  const req = { body: { accountId: victima }, headers: { authorization: 'Bearer x' }, user: { userId, accountId: mia } };
  const res = { _status: 200, status(s) { this._status = s; return this; }, json(d) { this._data = d; } };
  let paso = false;
  await enforceMaxAgents(req, res, () => { paso = true; });
  assert.ok(paso, 'con 0 agentes propios el middleware deja pasar aunque el body apunte a una cuenta llena');
  assert.strictEqual(res._data, undefined, 'no filtra el límite de la otra cuenta');
});
