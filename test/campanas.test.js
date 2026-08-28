/**
 * Atinov — Tests de campañas segmentadas (broadcast)
 *
 * Lo que se protege:
 *  1. la base dura del segmento: demo, opt-out, manejo humano y leads sin
 *     WhatsApp JAMÁS entran a un broadcast, elija lo que elija el dueño,
 *  2. el broadcast comparte el MISMO cap de marketing por contacto que el
 *     playbook — quien ya recibió su promo del día/mes queda fuera y se
 *     REPORTA (no silencio),
 *  3. el pacing por lotes y la pausa visible cuando el plan se queda sin
 *     cuota — una campaña nunca muere en silencio a la mitad.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-campanas-test-')
);
delete process.env.OPENAI_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const camp = require('../services/campanas');

async function armarCuenta({ plan = 'crecimiento', userExtra = {} } = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, {
    _id: accountId, ig_username: 'tienda',
    wa_phone_number_id: 'ph-1', wa_access_token: 'tok-1',
  });
  await db.insert(db.users, {
    account_id: accountId, email: `${accountId}@t.com`, membershipPlan: plan, ...userExtra,
  });
  await db.insert(db.settings, { account_id: accountId });
  return accountId;
}

async function armarLead(accountId, extra = {}) {
  return db.insert(db.leads, {
    account_id: accountId,
    wa_id: '569' + Math.floor(Math.random() * 1e8),
    wa_name: 'Clienta Prueba',
    channel: 'whatsapp', automation: 'automated',
    last_message_at: new Date().toISOString(),
    ...extra,
  });
}

const fake = () => {
  const enviados = [];
  return { enviados, deps: { enviarPlantilla: async ({ lead }) => { enviados.push(lead._id); } } };
};

// ── Segmentos ───────────────────────────────────────────────────────────────

test('la base dura del segmento no es negociable: demo, opt-out, humano y sin-WhatsApp quedan fuera', () => {
  const seg = camp.normalizarSegmento({});
  const base = { wa_id: '56911111111', automation: 'automated' };
  assert.strictEqual(camp.cumpleSegmento(base, seg), true);
  assert.strictEqual(camp.cumpleSegmento({ ...base, demo: true }, seg), false);
  assert.strictEqual(camp.cumpleSegmento({ ...base, mkt_opt_out: true }, seg), false, 'pidió no recibir marketing');
  assert.strictEqual(camp.cumpleSegmento({ ...base, is_bypassed: true }, seg), false);
  assert.strictEqual(camp.cumpleSegmento({ ...base, automation: 'paused' }, seg), false);
  assert.strictEqual(camp.cumpleSegmento({ automation: 'automated' }, seg), false, 'sin wa_id no hay broadcast');
});

test('filtros del segmento: compraron, temperatura y actividad', () => {
  const base = { wa_id: '56911111111', automation: 'automated' };
  const hace = (dias) => new Date(Date.now() - dias * 864e5).toISOString();

  const soloClientes = camp.normalizarSegmento({ compraron: 'si' });
  assert.strictEqual(camp.cumpleSegmento({ ...base, is_converted: true }, soloClientes), true);
  assert.strictEqual(camp.cumpleSegmento({ ...base, pipeline_stage: 'ganado' }, soloClientes), true);
  assert.strictEqual(camp.cumpleSegmento(base, soloClientes), false);

  const noCompraron = camp.normalizarSegmento({ compraron: 'no' });
  assert.strictEqual(camp.cumpleSegmento({ ...base, is_converted: true }, noCompraron), false);

  const calientes = camp.normalizarSegmento({ calificacion: 'hot' });
  assert.strictEqual(camp.cumpleSegmento({ ...base, qualification: 'hot' }, calientes), true);
  assert.strictEqual(camp.cumpleSegmento({ ...base, qualification: 'cold' }, calientes), false);

  const dormidos = camp.normalizarSegmento({ actividad: 'dormidos_30' });
  assert.strictEqual(camp.cumpleSegmento({ ...base, last_message_at: hace(45) }, dormidos), true);
  assert.strictEqual(camp.cumpleSegmento({ ...base, last_message_at: hace(5) }, dormidos), false);
  const activos = camp.normalizarSegmento({ actividad: 'activos_30' });
  assert.strictEqual(camp.cumpleSegmento({ ...base, last_message_at: hace(5) }, activos), true);
  assert.strictEqual(camp.cumpleSegmento({ ...base, last_message_at: hace(45) }, activos), false);

  // Valores basura caen al default 'todos' en vez de romper.
  const raro = camp.normalizarSegmento({ compraron: 'quizas', actividad: 'x' });
  assert.deepStrictEqual(raro, { compraron: 'todos', calificacion: 'todos', actividad: 'todos' });
});

// ── Creación ────────────────────────────────────────────────────────────────

test('crearCampana valida lo mínimo y no permite más de 2 activas', async () => {
  const accountId = await armarCuenta();
  await armarLead(accountId);

  let r = await camp.crearCampana({ accountId, nombre: '', templateName: 'x', segmento: {} });
  assert.strictEqual(r.ok, false);
  r = await camp.crearCampana({ accountId, nombre: 'Promo', templateName: '', segmento: {} });
  assert.strictEqual(r.ok, false);

  // Segmento sin nadie → error claro, no una campaña muerta.
  r = await camp.crearCampana({ accountId, nombre: 'Promo', templateName: 'p1', segmento: { compraron: 'si' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ningún destinatario/);

  const manana = new Date(Date.now() + 864e5).toISOString();
  const c1 = await camp.crearCampana({ accountId, nombre: 'P1', templateName: 'p1', segmento: {}, scheduledFor: manana });
  const c2 = await camp.crearCampana({ accountId, nombre: 'P2', templateName: 'p2', segmento: {}, scheduledFor: manana });
  assert.ok(c1.ok && c2.ok);
  const c3 = await camp.crearCampana({ accountId, nombre: 'P3', templateName: 'p3', segmento: {}, scheduledFor: manana });
  assert.strictEqual(c3.ok, false, 'la tercera activa se rechaza — anti-metralleta');
});

// ── Worker ──────────────────────────────────────────────────────────────────

test('el ciclo completo: snapshot → envío con registro en el hilo → completada con stats', async () => {
  const accountId = await armarCuenta();
  const l1 = await armarLead(accountId);
  const l2 = await armarLead(accountId);
  const r = await camp.crearCampana({ accountId, nombre: 'Drop sept', templateName: 'promo_v1', segmento: {} });
  assert.ok(r.ok);

  const t = fake();
  await camp.procesarCampanas(t.deps);

  const c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'completada');
  assert.strictEqual(c.stats.enviados, 2);
  assert.deepStrictEqual([...t.enviados].sort(), [l1._id, l2._id].sort());
  // Queda en el hilo de cada lead (el agente lo ve si la persona responde).
  const msgs = await db.find(db.messages, { lead_id: l1._id, is_campana: true });
  assert.strictEqual(msgs.length, 1);
  // Y el contador de marketing del contacto avanzó (presupuesto compartido).
  const fresco = await db.findOne(db.leads, { _id: l1._id });
  assert.strictEqual(fresco.mkt_count_month, 1);
});

test('el cap por contacto manda: quien ya recibió su marketing de hoy queda fuera y se REPORTA', async () => {
  const accountId = await armarCuenta();
  await armarLead(accountId); // limpio
  await armarLead(accountId, {
    mkt_month: new Date().toISOString().slice(0, 7),
    mkt_count_month: 1,
    mkt_last_day: new Date().toISOString().slice(0, 10), // ya recibió hoy
  });
  const r = await camp.crearCampana({ accountId, nombre: 'P', templateName: 'p', segmento: {} });
  const t = fake();
  await camp.procesarCampanas(t.deps);
  const c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'completada');
  assert.strictEqual(c.stats.enviados, 1);
  assert.strictEqual(c.stats.bloqueados_cap, 1, 'el bloqueado por cap se cuenta, no se esconde');
});

test('opt-out DESPUÉS del snapshot igual protege: se relee al momento del envío', async () => {
  const accountId = await armarCuenta();
  const lead = await armarLead(accountId);
  const r = await camp.crearCampana({ accountId, nombre: 'P', templateName: 'p', segmento: {} });
  // Entre la programación y el envío, la persona pide no recibir más.
  await db.update(db.leads, { _id: lead._id }, { mkt_opt_out: true });
  const t = fake();
  await camp.procesarCampanas(t.deps);
  assert.strictEqual(t.enviados.length, 0);
  const c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'completada');
  assert.strictEqual(c.stats.enviados, 0);
});

test('131049 (casilla llena por otras marcas) se cuenta aparte y la campaña sigue', async () => {
  const accountId = await armarCuenta();
  await armarLead(accountId);
  await armarLead(accountId);
  const r = await camp.crearCampana({ accountId, nombre: 'P', templateName: 'p', segmento: {} });
  let n = 0;
  const deps = {
    enviarPlantilla: async () => {
      n++;
      if (n === 1) {
        throw Object.assign(new Error('limited'), { response: { data: { error: { code: 131049 } } } });
      }
    },
  };
  await camp.procesarCampanas(deps);
  const c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'completada');
  assert.strictEqual(c.stats.casilla_llena, 1);
  assert.strictEqual(c.stats.enviados, 1);
});

test('pacing por lotes: una campaña grande avanza de a LOTE_ENVIO por corrida', async () => {
  const accountId = await armarCuenta();
  for (let i = 0; i < camp.LOTE_ENVIO + 3; i++) await armarLead(accountId);
  const r = await camp.crearCampana({ accountId, nombre: 'Grande', templateName: 'p', segmento: {} });
  const t = fake();

  await camp.procesarCampanas(t.deps);
  let c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'enviando', 'no termina en una corrida');
  assert.strictEqual(c.stats.enviados, camp.LOTE_ENVIO);

  await camp.procesarCampanas(t.deps);
  c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'completada');
  assert.strictEqual(c.stats.enviados, camp.LOTE_ENVIO + 3);
});

test('sin cuota del plan la campaña se PAUSA visible, no muere en silencio', async () => {
  const mes = new Date().toISOString().slice(0, 7);
  // Plan inicial con la cuota de WhatsApp ya llena (90 de 90).
  const accountId = await armarCuenta({
    plan: 'inicial',
    userExtra: { monthly_dm_count: 1500, monthly_wa_count: 90, dm_count_month: mes },
  });
  await armarLead(accountId);
  const r = await camp.crearCampana({ accountId, nombre: 'P', templateName: 'p', segmento: {} });
  const t = fake();
  await camp.procesarCampanas(t.deps);
  const c = await db.findOne(db.campanas, { _id: r.campana._id });
  assert.strictEqual(c.estado, 'pausada_cuota');
  assert.match(c.nota, /límite/);
  assert.strictEqual(t.enviados.length, 0);
});

test('cancelar: solo campañas vivas, y lo enviado queda como historia', async () => {
  const accountId = await armarCuenta();
  await armarLead(accountId);
  const manana = new Date(Date.now() + 864e5).toISOString();
  const r = await camp.crearCampana({ accountId, nombre: 'P', templateName: 'p', segmento: {}, scheduledFor: manana });

  const ok = await camp.cancelarCampana(r.campana._id, accountId);
  assert.strictEqual(ok.ok, true);
  const otra = await camp.cancelarCampana(r.campana._id, accountId);
  assert.strictEqual(otra.ok, false, 'cancelar dos veces no corresponde');
  const ajena = await camp.cancelarCampana(r.campana._id, 'otra-cuenta');
  assert.strictEqual(ajena.ok, false, 'tenant isolation también acá');
});
