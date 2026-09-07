/**
 * Atinov — Tests de la llamada de prueba del panel admin
 *
 * POR QUÉ EXISTE ESTE CAMINO: la primera llamada de la plataforma no puede ser
 * la de un lead real. Si el bridge, el códec o la voz están mal, enterarse
 * cuesta una venta. El botón marca al teléfono del dueño por el MISMO camino
 * de producción, con un lead sintético.
 *
 * Lo que se fija acá es que "prueba" NO signifique "sin candados":
 *  1. Sin credenciales del proveedor no marca (fail-closed, igual que el resto).
 *  2. El interruptor de la cuenta y el horario se respetan — una prueba que se
 *     salta los candados no prueba el camino real, prueba otro.
 *  3. Tope diario: un botón que gasta plata no puede ser un bucle.
 *  4. Cada prueba usa un lead NUEVO: el candado "un lead, una llamada por día"
 *     es real, y reusar el lead haría que la segunda prueba muriera sola.
 *  5. Una llamada de prueba jamás le escribe a nadie por el chat.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-llprueba-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');

const db        = require('../db/database');
const telefonia = require('../services/telefonia');
const router    = require('../routes/admin');

const ACCOUNT = 'acc-prueba';

/** Saca el handler de negocio de una ruta del router (salta middlewares). */
function handlerDe(path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, 'no existe la ruta ' + metodo.toUpperCase() + ' ' + path);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}

function llamar(handler, { body = {}, params = {}, accountId = ACCOUNT } = {}) {
  return new Promise((resolve) => {
    const req = { body, params, query: {}, user: { accountId, userId: 'u1', role: 'admin' } };
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { resolve({ status: this._status, data: d }); },
    };
    Promise.resolve(handler(req, res, (e) => resolve({ status: 500, data: { error: e && e.message } })))
      .catch(e => resolve({ status: 500, data: { error: e.message } }));
  });
}

const post = handlerDe('/llamada-prueba', 'post');

/** Hora Chile actual, para armar ventanas que no dependan del reloj de la máquina. */
function horaChileAhora() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', hour: 'numeric', hour12: false,
  }).formatToParts(new Date()).find(p => p.type === 'hour').value);
}

function conProveedor() {
  process.env.TWILIO_ACCOUNT_SID  = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN   = 'tok-test';
  process.env.TWILIO_PHONE_NUMBER = '+56995684130';
}
function sinProveedor() {
  for (const v of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
    'TELNYX_API_KEY', 'TELNYX_ACCOUNT_SID', 'TELNYX_APP_SID', 'TELNYX_PHONE_NUMBER']) {
    delete process.env[v];
  }
}

/** Deja la cuenta lista: agente activo + llamadas prendidas + dentro de horario. */
async function prepararCuenta({ enabled = true, enHorario = true } = {}) {
  await db.remove(db.settings, { account_id: ACCOUNT }, { multi: true });
  await db.remove(db.agents,   { account_id: ACCOUNT }, { multi: true });
  await db.remove(db.llamadas, { account_id: ACCOUNT }, { multi: true });
  await db.remove(db.leads,    { account_id: ACCOUNT }, { multi: true });

  const h = horaChileAhora();
  await db.insert(db.settings, {
    account_id: ACCOUNT,
    llamadas_enabled: enabled,
    llamadas_hora_inicio: enHorario ? h : (h + 1) % 24,
    llamadas_hora_fin:    enHorario ? (h + 1) % 24 : (h + 2) % 24,
  });
  await db.insert(db.agents, {
    account_id: ACCOUNT, name: 'Agente de prueba', enabled: true,
    calls_enabled: true, voice: 'sage',
  });
}

// ── Fail-closed ─────────────────────────────────────────────────────────────

test('sin credenciales del proveedor NO marca, y dice dónde faltan', async () => {
  sinProveedor();
  await prepararCuenta();
  const r = await llamar(post, { body: { telefono: '+56 9 9568 4130' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /credenciales|Railway/i);
  assert.strictEqual((await db.find(db.llamadas, { account_id: ACCOUNT })).length, 0);
});

test('teléfono inválido se rechaza antes de gastar nada', async () => {
  conProveedor();
  await prepararCuenta();
  for (const malo of ['', 'hola', '123']) {
    const r = await llamar(post, { body: { telefono: malo } });
    assert.strictEqual(r.status, 400, 'debió rechazar ' + JSON.stringify(malo));
  }
  assert.strictEqual((await db.find(db.llamadas, { account_id: ACCOUNT })).length, 0);
});

// ── Los candados de la cuenta NO se saltan por ser una prueba ────────────────

test('con las llamadas apagadas en la cuenta, la prueba no marca', async () => {
  conProveedor();
  await prepararCuenta({ enabled: false });
  const r = await llamar(post, { body: { telefono: '+56995684130' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /apagad/i);
  assert.strictEqual((await db.find(db.llamadas, { account_id: ACCOUNT })).length, 0);
});

test('fuera del horario de la cuenta, la prueba no marca', async () => {
  conProveedor();
  await prepararCuenta({ enHorario: false });
  const r = await llamar(post, { body: { telefono: '+56995684130' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /horario/i);
});

test('sin agente activo no hay quién hable', async () => {
  conProveedor();
  await prepararCuenta();
  await db.remove(db.agents, { account_id: ACCOUNT }, { multi: true });
  const r = await llamar(post, { body: { telefono: '+56995684130' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /agente/i);
});

// ── Camino feliz ────────────────────────────────────────────────────────────

test('deja la llamada programada AHORA, corta y marcada como prueba', async () => {
  conProveedor();
  await prepararCuenta();
  const r = await llamar(post, { body: { telefono: '+56 9 9568 4130' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.telefono, '+56995684130', 'normaliza a E.164');

  const ll = await db.findOne(db.llamadas, { _id: r.data.llamadaId });
  assert.strictEqual(ll.status, 'programada');
  assert.strictEqual(ll.es_prueba, true);
  assert.strictEqual(ll.via, 'telefono');
  assert.strictEqual(ll.max_min, 3, 'una prueba no puede costar 10 minutos');
  assert.ok(ll.dial_at <= new Date().toISOString(), 'sin espera: no hay aviso de chat que esperar');
  assert.strictEqual(ll.fecha_chile, telefonia.fechaChile(), 'cuenta contra los topes del día');
  assert.ok(ll.consent_texto, 'queda registrado quién la pidió');
});

test('cada prueba crea un lead NUEVO: la segunda del día no muere por el tope por lead', async () => {
  conProveedor();
  await prepararCuenta();
  const a = await llamar(post, { body: { telefono: '+56995684130' } });
  const b = await llamar(post, { body: { telefono: '+56995684130' } });
  assert.strictEqual(b.status, 200, 'la segunda prueba del día debe poder hacerse');

  const lla = await db.findOne(db.llamadas, { _id: a.data.llamadaId });
  const llb = await db.findOne(db.llamadas, { _id: b.data.llamadaId });
  assert.notStrictEqual(lla.lead_id, llb.lead_id);

  const leads = await db.find(db.leads, { account_id: ACCOUNT });
  assert.ok(leads.length >= 2);
  assert.ok(leads.every(l => l.es_prueba === true), 'los leads de prueba quedan marcados como tales');
});

test('tope de 3 pruebas por día: la cuarta se rechaza', async () => {
  conProveedor();
  await prepararCuenta();
  const hechas = [];
  for (let i = 0; i < 3; i++) hechas.push(await llamar(post, { body: { telefono: '+56995684130' } }));
  assert.ok(hechas.every(r => r.status === 200), 'las 3 primeras pasan');
  assert.strictEqual(hechas[2].data.restantes, 0);

  const cuarta = await llamar(post, { body: { telefono: '+56995684130' } });
  assert.strictEqual(cuarta.status, 429);
  assert.match(cuarta.data.error, /tope/i);
});

test('una prueba cancelada por un candado no consume el cupo del día', async () => {
  conProveedor();
  await prepararCuenta();
  const r = await llamar(post, { body: { telefono: '+56995684130' } });
  await db.update(db.llamadas, { _id: r.data.llamadaId }, { status: 'cancelada' });
  const otra = await llamar(post, { body: { telefono: '+56995684130' } });
  assert.strictEqual(otra.data.restantes, 2, 'la cancelada no cuenta');
});

// ── Una prueba no le escribe a nadie ────────────────────────────────────────

test('la llamada de prueba que no contesta NO encola ningún mensaje al chat', async () => {
  const antes = (await db.find(db.pendingSends, {})).length;
  await telefonia.encolarMensajeNoContesto({
    _id: 'll-x', account_id: ACCOUNT, lead_id: 'lead-x', es_prueba: true,
  });
  assert.strictEqual((await db.find(db.pendingSends, {})).length, antes);
});

// ── Estado de la prueba ─────────────────────────────────────────────────────

test('el estado NO se puede leer desde otra cuenta', async () => {
  conProveedor();
  await prepararCuenta();
  const r = await llamar(post, { body: { telefono: '+56995684130' } });
  const get = handlerDe('/llamada-prueba/:id', 'get');

  const propia = await llamar(get, { params: { id: r.data.llamadaId } });
  assert.strictEqual(propia.status, 200);
  assert.strictEqual(propia.data.status, 'programada');

  const ajena = await llamar(get, { params: { id: r.data.llamadaId }, accountId: 'otra-cuenta' });
  assert.strictEqual(ajena.status, 404);
});
