/**
 * Atinov — Tests del riel de mejoras del agente (Panel Inteligencia)
 *
 * El primer test de este archivo existe por un bug invisible de la misma
 * familia que el de los contadores de cuota: routes/intelligence.js usaba `db`
 * sin importarlo, así que GET /improvements moría con ReferenceError → 500 —
 * la auto-mejora semanal llevaba semanas generando propuestas que el dueño
 * JAMÁS pudo ver. El sweep corría, guardaba, todo parecía vivo; solo el listar
 * estaba muerto, y como el frontend traga el error, nadie lo notó.
 *
 * Además se cubre el camino nuevo: "sube conversaciones reales y mejora tu
 * agente" — validaciones de entrada, candados de gasto y el riel de aprobación
 * compartido.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-intel-test-')
);
// Si la máquina tiene una key real en el entorno, estos tests NO deben poder
// gastarla: los caminos cubiertos cortan antes de tocar la red.
delete process.env.OPENAI_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const router = require('../routes/intelligence');
const {
  analyzeUploadedText, parsearPropuestas, guardarPropuestas, applyImprovement,
  MAX_PROPUESTAS_PENDIENTES, MIN_TEXTO_SUBIDO,
} = require('../services/promptImprover');

/** Saca el handler de negocio de una ruta del router (el último de la capa,
 *  saltando middlewares como el rate limiter). */
function handlerDe(path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}

/** req/res falsos con captura de status y json. */
function llamar(handler, { query = {}, body = {}, accountId } = {}) {
  return new Promise((resolve) => {
    const req = { query, body, user: { accountId } };
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { resolve({ status: this._status, data: d, error: null }); },
    };
    handler(req, res, (e) => resolve({ status: 500, data: null, error: e }));
  });
}

async function armarCuenta(extra = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'negocio' });
  const agent = await db.insert(db.agents, {
    account_id: accountId, name: 'Vendedora', enabled: true, instructions: 'Saluda con buena onda.',
    ...extra.agent,
  });
  return { accountId, agent };
}

test('REGRESIÓN: GET /improvements lista las propuestas (db estaba sin importar → 500 eterno)', async () => {
  const { accountId, agent } = await armarCuenta();
  await db.insert(db.improvements, {
    account_id: accountId, agent_id: agent._id, status: 'pending',
    causa: 'Responde tarde a la objeción de precio',
    evidencia: '3 de 5 conversaciones', propuesta: 'Cuando digan que está caro, valida primero y da el porqué del precio.',
    origen: 'semanal', muestra: 5,
  });

  const r = await llamar(handlerDe('/improvements', 'get'), { query: { accountId }, accountId });
  assert.strictEqual(r.error, null, `el handler no puede reventar: ${r.error}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.improvements.length, 1);
  assert.strictEqual(r.data.improvements[0].causa, 'Responde tarde a la objeción de precio');
  assert.strictEqual(r.data.improvements[0].origen, 'semanal');
});

test('GET /improvements: propuestas viejas sin origen se reportan como del semanal', async () => {
  const { accountId, agent } = await armarCuenta();
  await db.insert(db.improvements, {
    account_id: accountId, agent_id: agent._id, status: 'pending',
    causa: 'Propuesta pre-existente', propuesta: 'Haz X.',
  });
  const r = await llamar(handlerDe('/improvements', 'get'), { query: { accountId }, accountId });
  assert.strictEqual(r.data.improvements[0].origen, 'semanal');
});

test('parsearPropuestas rescata el array aunque el modelo lo envuelva en texto', () => {
  const item = { causa: 'c', evidencia: 'e', propuesta: 'p' };
  assert.deepStrictEqual(parsearPropuestas(JSON.stringify([item])), [item]);
  assert.deepStrictEqual(parsearPropuestas('Claro, aquí va:\n```json\n[' + JSON.stringify(item) + ']\n```'), [item]);
  assert.deepStrictEqual(parsearPropuestas('no hay json'), []);
  assert.deepStrictEqual(parsearPropuestas('{"no":"array"}'), []);
  assert.deepStrictEqual(parsearPropuestas('[{roto'), []);
  assert.deepStrictEqual(parsearPropuestas(null), []);
});

test('guardarPropuestas respeta el cupo y no duplica causas pendientes', async () => {
  const { accountId, agent } = await armarCuenta();
  const pendientes = [{ causa: 'ya existe' }];
  const creadas = await guardarPropuestas({
    accountId, agentId: agent._id, pendientes, origen: 'subidas',
    items: [
      { causa: 'ya existe', propuesta: 'duplicada, no va' },
      { causa: 'nueva 1', evidencia: 'e', propuesta: 'p1' },
      { causa: 'nueva 2', propuesta: 'p2' },
      { causa: 'nueva 3', propuesta: 'no cabe: cupo 3 − 1 pendiente = 2' },
      { causa: 'sin propuesta' },
    ],
  });
  // Cupo: MAX(3) − 1 pendiente = 2 slots, y el primer item del slice es el
  // duplicado (se salta pero consumió su lugar en el slice). Quedan 'nueva 1'.
  const guardadas = await db.find(db.improvements, { account_id: accountId, status: 'pending' });
  assert.strictEqual(creadas, guardadas.length);
  assert.ok(guardadas.every(g => g.causa !== 'ya existe'), 'la causa duplicada no se re-inserta');
  assert.ok(guardadas.every(g => g.origen === 'subidas'));
  assert.ok(creadas <= MAX_PROPUESTAS_PENDIENTES - pendientes.length, 'nunca sobre el cupo');
});

test('analyzeUploadedText corta ANTES de tocar la red: sin key, texto corto, cupo lleno, sin agente', async () => {
  const { accountId } = await armarCuenta();
  const textoLargo = 'Cliente: hola quiero info\nYo: hola! te cuento...\n'.repeat(10);

  // Sin API key (el candado que protege la plata).
  let r = await analyzeUploadedText({ accountId, texto: textoLargo, apiKey: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /API key/i);

  // Texto sin señal suficiente.
  r = await analyzeUploadedText({ accountId, texto: 'hola', apiKey: 'sk-falsa' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, new RegExp(String(MIN_TEXTO_SUBIDO)));

  // Cupo de propuestas lleno: no se analiza más hasta revisar.
  for (let i = 0; i < MAX_PROPUESTAS_PENDIENTES; i++) {
    await db.insert(db.improvements, { account_id: accountId, status: 'pending', causa: 'c' + i, propuesta: 'p' });
  }
  r = await analyzeUploadedText({ accountId, texto: textoLargo, apiKey: 'sk-falsa' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /esperando revisión/);

  // Cuenta sin agente activo: no hay a quién proponerle.
  const sinAgente = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: sinAgente });
  r = await analyzeUploadedText({ accountId: sinAgente, texto: textoLargo, apiKey: 'sk-falsa' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /agente activo/);
});

test('POST /analizar-texto: dueño ajeno → 403; el accountId del body no manda', async () => {
  const { accountId } = await armarCuenta();
  const h = handlerDe('/improvements/analizar-texto', 'post');
  const r = await llamar(h, { body: { accountId, texto: 'x'.repeat(300) }, accountId: 'otra-cuenta' });
  assert.strictEqual(r.status, 403);
});

test('POST /analizar-texto: el tope diario por cuenta devuelve 429 sin llamar al modelo', async () => {
  const { accountId } = await armarCuenta();
  const hoy = new Date().toISOString().slice(0, 10);
  await db.insert(db.settings, {
    account_id: accountId, upload_analysis_date: hoy, upload_analysis_count: 10,
    openai_key: 'sk-falsa',
  });
  const h = handlerDe('/improvements/analizar-texto', 'post');
  const r = await llamar(h, { body: { accountId, texto: 'x'.repeat(300) }, accountId });
  assert.strictEqual(r.status, 429);
  assert.match(r.data.error, /máximo de 10/);
});

test('POST /analizar-texto: texto corto → 400 con el motivo, y NO quema cupo diario', async () => {
  const { accountId } = await armarCuenta();
  await db.insert(db.settings, { account_id: accountId, openai_key: 'sk-falsa' });
  const h = handlerDe('/improvements/analizar-texto', 'post');
  const r = await llamar(h, { body: { accountId, texto: 'muy corto' }, accountId });
  assert.strictEqual(r.status, 400);
  const s = await db.findOne(db.settings, { account_id: accountId });
  assert.ok(!s.upload_analysis_count, 'un análisis fallido no debe contar contra el tope del día');
});

test('applyImprovement anexa bajo UNA sección, sin duplicar el encabezado viejo', async () => {
  // Agente que YA tiene el encabezado del texto anterior ("del análisis
  // semanal...") — aprobar una propuesta nueva no debe crear una segunda sección.
  const { accountId, agent } = await armarCuenta({
    agent: { instructions: 'Base.\n\n═══ MEJORAS APROBADAS (del análisis semanal de conversaciones perdidas) ═══\n• [2026-08-01] Regla vieja.' },
  });
  const imp = await db.insert(db.improvements, {
    account_id: accountId, agent_id: agent._id, status: 'pending',
    causa: 'c', propuesta: 'Imita el cierre con pregunta del dueño.', origen: 'subidas',
  });
  const r = await applyImprovement(imp._id, accountId);
  assert.strictEqual(r.ok, true);
  const actualizado = await db.findOne(db.agents, { _id: agent._id });
  const secciones = (actualizado.instructions.match(/═══ MEJORAS APROBADAS/g) || []).length;
  assert.strictEqual(secciones, 1, 'una sola sección de mejoras, venga de donde venga la propuesta');
  assert.ok(actualizado.instructions.includes('Imita el cierre con pregunta del dueño.'));

  // Y en un agente limpio, el encabezado nuevo (neutro) se crea una vez.
  const { accountId: acc2, agent: agente2 } = await armarCuenta();
  const imp2 = await db.insert(db.improvements, {
    account_id: acc2, agent_id: agente2._id, status: 'pending', causa: 'c2', propuesta: 'Regla nueva.',
  });
  await applyImprovement(imp2._id, acc2);
  const limpio = await db.findOne(db.agents, { _id: agente2._id });
  assert.ok(limpio.instructions.includes('═══ MEJORAS APROBADAS (aprendidas de conversaciones reales) ═══'));
});
