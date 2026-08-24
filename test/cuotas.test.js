/**
 * Atinov — Tests de los contadores de cuota
 *
 * Estos contadores son lo que hace exigibles los planes: sin ellos la escalera
 * es un papel, porque nadie puede cobrar por algo que el sistema no mide.
 *
 * El bug que originó este archivo era invisible: findOwnerByAccount buscaba al
 * dueño por `accountId` cuando el campo real es `account_id`, así que devolvía
 * null SIEMPRE. checkDMAllowance dejaba pasar todo e incrementDMCount no
 * contaba nada — el sistema de cuotas llevaba meses apagado sin un solo error
 * en los logs. Por eso el primer test de acá es ese lookup.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-cuotas-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const limits = require('../services/limits');

/** Cuenta + usuario con el plan pedido. */
async function armarCuenta(plan = 'crecimiento', extra = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'negocio' });
  const user = await db.insert(db.users, {
    account_id: accountId,
    email: `${accountId}@atinov.com`,
    membershipPlan: plan,
    ...extra,
  });
  return { accountId, user };
}

async function armarLead(accountId, channel = 'instagram') {
  return db.insert(db.leads, { account_id: accountId, channel, ig_user_id: crypto.randomUUID() });
}

const leer = (id) => db.findOne(db.users, { _id: id });

test('REGRESIÓN: encuentra al dueño por account_id, no por accountId', async () => {
  // Este era el bug. Si vuelve, todos los tests de abajo pasan igual pero el
  // sistema queda apagado en producción, así que se fija explícitamente.
  const { accountId, user } = await armarCuenta();
  const encontrado = await limits.findOwnerByAccount(accountId);
  assert.ok(encontrado, 'tiene que encontrar al dueño');
  assert.strictEqual(encontrado._id, user._id);
  assert.strictEqual(await limits.findOwnerByAccount('no-existe'), null);
  assert.strictEqual(await limits.findOwnerByAccount(null), null);
});

test('una conversación cuenta 1, aunque el lead escriba veinte veces', async () => {
  const { accountId, user } = await armarCuenta();
  const lead = await armarLead(accountId, 'instagram');

  const primera = await limits.registrarConversacion({ accountId, lead });
  assert.strictEqual(primera.contada, true);
  assert.strictEqual(primera.total, 1);

  // El lead ya viene marcado de la DB en las siguientes vueltas.
  for (let i = 0; i < 5; i++) {
    const fresco = await db.findOne(db.leads, { _id: lead._id });
    const r = await limits.registrarConversacion({ accountId, lead: fresco });
    assert.strictEqual(r.contada, false, 'el mismo lead no puede sumar dos veces en el mes');
  }
  assert.strictEqual(Number((await leer(user._id)).monthly_dm_count), 1);
});

test('WhatsApp suma en los DOS contadores; Instagram solo en el total', async () => {
  const { accountId, user } = await armarCuenta();
  const wa = await armarLead(accountId, 'whatsapp');
  const ig = await armarLead(accountId, 'instagram');

  await limits.registrarConversacion({ accountId, lead: wa });
  await limits.registrarConversacion({ accountId, lead: ig });

  const u = await leer(user._id);
  assert.strictEqual(Number(u.monthly_dm_count), 2, 'las dos cuentan en el total');
  assert.strictEqual(Number(u.monthly_wa_count), 1, 'solo la de WhatsApp cuenta en su cuota');
});

test('un lead que pasa de Instagram a WhatsApp suma en la cuota de WhatsApp', async () => {
  // Es lo correcto contra el costo: esa conversación por WhatsApp le cuesta a
  // Meta igual que cualquier otra, aunque el lead ya estuviera contado.
  const { accountId, user } = await armarCuenta();
  const lead = await armarLead(accountId, 'instagram');
  await limits.registrarConversacion({ accountId, lead });

  const migrado = { ...(await db.findOne(db.leads, { _id: lead._id })), channel: 'whatsapp' };
  const r = await limits.registrarConversacion({ accountId, lead: migrado });
  assert.strictEqual(r.contada, true);

  const u = await leer(user._id);
  assert.strictEqual(Number(u.monthly_dm_count), 1, 'en el total sigue siendo un lead');
  assert.strictEqual(Number(u.monthly_wa_count), 1, 'pero ya usó cuota de WhatsApp');
});

test('la cuota de WhatsApp corta antes que la total', async () => {
  // Crecimiento: 3.000 conversaciones totales pero solo 150 de WhatsApp. Con
  // 150 de WhatsApp usadas queda muchísimo total libre, y aun así WhatsApp
  // tiene que frenar: es el canal que cuesta.
  const { accountId } = await armarCuenta('crecimiento', {
    monthly_dm_count: 200, monthly_wa_count: 150, dm_count_month: limits.currentMonth(),
  });
  const r = await limits.checkCuotaCanal(accountId, 'whatsapp');
  assert.strictEqual(r.motivo, 'whatsapp');
  assert.strictEqual(r.overage, true, 'Crecimiento permite overage: se cobra, no se corta');

  const ig = await limits.checkCuotaCanal(accountId, 'instagram');
  assert.ok(ig.allowed && !ig.overage, 'Instagram sigue holgado con 200 de 3.000');
});

test('un plan sin overage sí corta, y explica por qué', async () => {
  const { accountId } = await armarCuenta('trial', {
    monthly_dm_count: 200, monthly_wa_count: 0, dm_count_month: limits.currentMonth(),
  });
  const r = await limits.checkCuotaCanal(accountId, 'instagram');
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /conversaciones/);
});

test('el admin y las cuentas huérfanas nunca se bloquean', async () => {
  const { accountId } = await armarCuenta('trial', {
    role: 'admin', monthly_dm_count: 99999, dm_count_month: limits.currentMonth(),
  });
  assert.strictEqual((await limits.checkCuotaCanal(accountId, 'whatsapp')).allowed, true);
  assert.strictEqual((await limits.checkCuotaCanal('cuenta-sin-dueño')).allowed, true);
});

test('al cambiar de mes los contadores parten de cero', async () => {
  const { accountId, user } = await armarCuenta('crecimiento', {
    monthly_dm_count: 2999, monthly_wa_count: 150, dm_count_month: '2020-01',
  });
  const r = await limits.checkCuotaCanal(accountId, 'whatsapp');
  assert.ok(r.allowed && !r.overage, 'el mes viejo no puede seguir pesando');
  assert.strictEqual(r.whatsapp, 0);

  const lead = await armarLead(accountId, 'whatsapp');
  await limits.registrarConversacion({ accountId, lead });
  const u = await leer(user._id);
  assert.strictEqual(Number(u.monthly_dm_count), 1, 'arranca en 1, no en 3.000');
  assert.strictEqual(u.dm_count_month, limits.currentMonth());
});

// ── VOZ ──────────────────────────────────────────────────────────────────────

test('el plan Inicial no tiene bolsa de minutos', async () => {
  const { accountId } = await armarCuenta('inicial');
  const r = await limits.checkMinutosVoz(accountId);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /no incluye llamadas/);
});

test('dentro de la bolsa se llama; pasada la bolsa se cobra; al doble se corta', async () => {
  const mes = limits.currentMonth();
  const dentro = await armarCuenta('crecimiento', { monthly_voice_seconds: 60 * 100, voice_count_month: mes });
  const r1 = await limits.checkMinutosVoz(dentro.accountId);
  assert.ok(r1.allowed && !r1.overage, '100 de 150 minutos: holgado');
  assert.strictEqual(Math.round(r1.restantes), 50);

  const pasado = await armarCuenta('crecimiento', { monthly_voice_seconds: 60 * 180, voice_count_month: mes });
  const r2 = await limits.checkMinutosVoz(pasado.accountId);
  assert.ok(r2.allowed, 'no se corta al negocio que está vendiendo');
  assert.strictEqual(r2.overage, true, 'pero queda marcado para cobrarlo');

  const fuga = await armarCuenta('crecimiento', { monthly_voice_seconds: 60 * 300, voice_count_month: mes });
  const r3 = await limits.checkMinutosVoz(fuga.accountId);
  assert.strictEqual(r3.allowed, false, 'al doble de la bolsa hay corte duro');
  assert.match(r3.reason, /doble/);
});

test('los segundos de cada llamada se acumulan y resetean por mes', async () => {
  const { accountId, user } = await armarCuenta('escala', {
    monthly_voice_seconds: 999, voice_count_month: '2020-01',
  });
  await limits.registrarSegundosVoz(accountId, 90);
  let u = await leer(user._id);
  assert.strictEqual(Number(u.monthly_voice_seconds), 90, 'el mes viejo no se arrastra');

  await limits.registrarSegundosVoz(accountId, 30);
  u = await leer(user._id);
  assert.strictEqual(Number(u.monthly_voice_seconds), 120, 'se suman');

  await limits.registrarSegundosVoz(accountId, 0);
  await limits.registrarSegundosVoz(accountId, -50);
  u = await leer(user._id);
  assert.strictEqual(Number(u.monthly_voice_seconds), 120, 'cero y negativos se ignoran');
});

// ── REPORTE ──────────────────────────────────────────────────────────────────

test('getUsage reporta los tres contadores sin romperse con topes vacíos', async () => {
  const mes = limits.currentMonth();
  const { user } = await armarCuenta('crecimiento', {
    monthly_dm_count: 300, monthly_wa_count: 75, dm_count_month: mes,
    monthly_voice_seconds: 60 * 75, voice_count_month: mes,
  });
  const r = await limits.getUsage(user._id);
  assert.strictEqual(r.usage.whatsapp, 75);
  assert.strictEqual(r.usage.minutosVoz, 75);
  assert.strictEqual(r.percent.whatsapp, 50, '75 de 150');
  assert.strictEqual(r.percent.minutosVoz, 50, '75 de 150');
  assert.strictEqual(r.plan.maxDMsWhatsApp, 150);

  // Inicial no tiene voz (0) y los heredados no tienen cuota de WhatsApp
  // (null). Ninguno de los dos puede dar 100% ni marcar "pasado de límite":
  // en JavaScript `0 >= null` es true, y ese era el riesgo.
  const ini = await armarCuenta('inicial');
  const ri = await limits.getUsage(ini.user._id);
  assert.strictEqual(ri.percent.minutosVoz, 0);
  assert.strictEqual(ri.overLimit.minutosVoz, false);

  const leg = await armarCuenta('founder');
  const rl = await limits.getUsage(leg.user._id);
  assert.strictEqual(rl.percent.whatsapp, 0);
  assert.strictEqual(rl.overLimit.whatsapp, false, 'sin cuota de canal no puede estar "pasado"');
});
