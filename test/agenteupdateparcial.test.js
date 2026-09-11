/**
 * Atinov — El PUT parcial de un agente NO puede borrarle campos
 *
 * BUG REAL, visto en producción el 2026-09-10 en la cuenta del dueño:
 * marcar el checkbox del agente en Ajustes → "Agentes que pueden llamar"
 * manda `PUT /api/agents/:id` con el body {calls_enabled:true} y NADA más.
 * La ruta armaba el update así:
 *
 *   const upd = { name, avatar, instructions, enabled, trigger_keywords, ... };
 *
 * Con un body parcial esos siete llegan `undefined`. NeDB serializa con
 * JSON.stringify — que BORRA las claves undefined — así que el $set escribía
 * el documento SIN esos campos. Un clic dejó al agente sin nombre, sin avatar,
 * sin instrucciones y con `enabled` desaparecido: el panel lo mostró como
 * "undefined · ○ Inactivo" y `count({enabled:true})` pasó a 0.
 *
 * Este test corre la RUTA de verdad (no una copia de su lógica) contra una DB
 * temporal, porque el bug vivía justo en el borde entre la ruta y NeDB.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-agente-parcial-test-')
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-test-largo-y-aburrido-1234567890';

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../db/database');
const agentsRouter = require('../routes/agents');

function handlerDe(router, path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack.map(s => s.handle);
}

/** Corre la cadena de handlers de una ruta, con params. */
function llamar(handlers, { body = {}, params = {}, user } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, params, query: {}, headers: {}, ip: '127.0.0.1', get: () => undefined };
    if (user) req.user = user;
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { resolve({ status: this._status, data: d }); },
      sendStatus(s) { resolve({ status: s, data: null }); },
    };
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      const h = handlers[i++];
      if (!h) return resolve({ status: res._status, data: null });
      try { const r = h(req, res, next); if (r?.catch) r.catch(reject); }
      catch (e) { reject(e); }
    };
    next();
  });
}

const ACCOUNT = 'acc-parcial-1';
const USER    = { accountId: ACCOUNT, role: 'admin', userId: 'u1' };
const PUT     = handlerDe(agentsRouter, '/:id', 'put');

/** Agente nuevo y completo, como el que tenía Brayan. */
async function crearAgente(extra = {}) {
  return db.insert(db.agents, {
    account_id:       ACCOUNT,
    name:             'BRIAN',
    avatar:           '⚡',
    instructions:     'Vendes Atinov. No inventes precios.',
    enabled:          true,
    trigger_keywords: ['precio', 'info'],
    delay_min:        5,
    delay_max:        15,
    role:             'nurture',
    calls_enabled:    false,
    createdAt:        new Date().toISOString(),
    ...extra,
  });
}

// ── El caso exacto que rompió producción ─────────────────────────────────────
test('PUT {calls_enabled} NO borra nombre, avatar, instrucciones ni enabled', async () => {
  const a = await crearAgente();

  const r = await llamar(PUT, { body: { calls_enabled: true }, params: { id: a._id }, user: USER });
  assert.strictEqual(r.status, 200);

  const doc = await db.findOne(db.agents, { _id: a._id });
  assert.strictEqual(doc.calls_enabled, true, 'lo que SÍ se pidió debe cambiar');

  // Lo que nadie pidió cambiar tiene que seguir ahí, byte por byte.
  assert.strictEqual(doc.name, 'BRIAN');
  assert.strictEqual(doc.avatar, '⚡');
  assert.strictEqual(doc.instructions, 'Vendes Atinov. No inventes precios.');
  assert.strictEqual(doc.enabled, true);
  assert.deepStrictEqual(doc.trigger_keywords, ['precio', 'info']);
  assert.strictEqual(doc.delay_min, 5);
  assert.strictEqual(doc.delay_max, 15);
});

test('el síntoma que se vio en el panel: el agente sigue contando como ACTIVO', async () => {
  const a = await crearAgente();
  await llamar(PUT, { body: { calls_enabled: true }, params: { id: a._id }, user: USER });

  // Es la consulta literal del panel y de la llamada de prueba.
  const activos = await db.find(db.agents, { account_id: ACCOUNT, _id: a._id, enabled: true });
  assert.strictEqual(activos.length, 1, 'el agente desapareció de los activos');
});

// ── Que el arreglo no rompa lo que sí debe poder cambiar ─────────────────────
test('un PUT completo sigue actualizando todos los campos', async () => {
  const a = await crearAgente();

  await llamar(PUT, {
    body: {
      name: 'Atinov Ventas', avatar: '🤖', instructions: 'nuevo prompt',
      enabled: true, trigger_keywords: ['hola'], delay_min: 10, delay_max: 20,
    },
    params: { id: a._id }, user: USER,
  });

  const doc = await db.findOne(db.agents, { _id: a._id });
  assert.strictEqual(doc.name, 'Atinov Ventas');
  assert.strictEqual(doc.avatar, '🤖');
  assert.strictEqual(doc.instructions, 'nuevo prompt');
  assert.deepStrictEqual(doc.trigger_keywords, ['hola']);
  assert.strictEqual(doc.delay_min, 10);
  assert.strictEqual(doc.delay_max, 20);
});

test('enabled:false explícito SÍ apaga el agente (el guard es por tipo, no por verdad)', async () => {
  const a = await crearAgente();

  await llamar(PUT, { body: { enabled: false }, params: { id: a._id }, user: USER });

  const doc = await db.findOne(db.agents, { _id: a._id });
  assert.strictEqual(doc.enabled, false, 'apagar a propósito tiene que funcionar');
  assert.strictEqual(doc.name, 'BRIAN', 'y sin llevarse el resto por delante');
});

// ── La causa raíz, documentada para que nadie la repita ──────────────────────
test('la causa raíz: un $set con undefined deja el campo en nada', async () => {
  const a = await crearAgente();

  // Esto es lo que hacía la ruta vieja. Se deja como prueba viva de POR QUÉ el
  // update tiene que armarse condicionalmente en TODAS las rutas.
  await db.update(db.agents, { _id: a._id }, { name: undefined, enabled: undefined });

  const doc = await db.findOne(db.agents, { _id: a._id });
  assert.strictEqual(doc.name, undefined, 'el nombre se fue');
  assert.strictEqual(doc.enabled, undefined, 'y enabled también');

  // Este es el síntoma que se vio en el panel: deja de matchear la consulta de
  // agentes activos. (En disco es peor todavía: JSON.stringify no escribe las
  // claves undefined, así que al reiniciar el servicio ni siquiera existen.)
  const activos = await db.find(db.agents, { account_id: ACCOUNT, _id: a._id, enabled: true });
  assert.strictEqual(activos.length, 0, 'así fue como el panel mostró 0 agentes activos');
});
