/**
 * Atinov — Tests del monitor de margen y la medición del costo LLM
 *
 * Lo que se protege acá:
 *  1. que el rate card cubra los modelos que la app usa por defecto — si
 *     mañana se cambia OPENAI_FAST_MODEL sin actualizar la tabla, el costo se
 *     sobreestima en silencio (lado seguro, pero hay que verlo),
 *  2. que la medición de llmPorConv salga de tokens reales y excluya la demo,
 *  3. que el margen por cuenta use los costos unitarios de la escalera y que
 *     la alerta dispare bajo el umbral — este monitor es lo que hace exigible
 *     el objetivo de margen, igual que los contadores hacen exigibles los
 *     planes.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-margen-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const { currentMonth } = require('../services/limits');
const {
  medirLlmPorConv, margenPorCuenta, costoLlamadaLlm,
  PRECIOS_MODELO, PRECIO_DESCONOCIDO, FACTOR_AUXILIAR, UMBRAL_ALERTA_MARGEN,
} = require('../services/margenCuentas');
const {
  COSTOS, COSTO_CONV_WHATSAPP, COSTO_CONV_META, COSTO_MINUTO_LLAMADA,
} = require('../config/plans');

async function armarCuenta(plan, extra = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'negocio-' + plan });
  const user = await db.insert(db.users, {
    account_id: accountId,
    email: `${accountId}@cliente.com`,
    membershipPlan: plan,
    ...extra,
  });
  return { accountId, user };
}

test('el rate card cubre los modelos que la app usa por defecto', () => {
  // openai.js: OPENAI_FAST_MODEL default gpt-4o-mini (chat + clasificación),
  // OPENAI_REASONING_MODEL default o4-mini. Si alguno sale de esta lista, el
  // costo se cobra como gpt-4o y el panel lo marca — pero mejor no llegar ahí.
  for (const modelo of ['gpt-4o-mini', 'o4-mini']) {
    assert.ok(PRECIOS_MODELO[modelo], `falta el rate card de ${modelo}`);
  }
  // El fallback sobreestima: debe ser al menos tan caro como el modelo barato.
  assert.ok(PRECIO_DESCONOCIDO.entrada > PRECIOS_MODELO['gpt-4o-mini'].entrada);
  assert.ok(PRECIO_DESCONOCIDO.salida  > PRECIOS_MODELO['gpt-4o-mini'].salida);
});

test('costoLlamadaLlm calcula por tokens y cobra lo desconocido como gpt-4o', () => {
  // 1M de entrada + 1M de salida en gpt-4o-mini = 0,15 + 0,60.
  const conocido = costoLlamadaLlm({ model: 'gpt-4o-mini', promptTokens: 1e6, completionTokens: 1e6 });
  assert.ok(Math.abs(conocido - 0.75) < 1e-9, `gpt-4o-mini dio ${conocido}`);

  const raro = costoLlamadaLlm({ model: 'modelo-que-no-existe', promptTokens: 1e6, completionTokens: 1e6 });
  const gpt4o = PRECIOS_MODELO['gpt-4o'];
  assert.ok(Math.abs(raro - (gpt4o.entrada + gpt4o.salida)) < 1e-9, 'desconocido = tarifa gpt-4o');

  // Sin tokens no hay costo, y los campos ausentes no revientan.
  assert.strictEqual(costoLlamadaLlm({ model: 'gpt-4o-mini' }), 0);
});

test('medirLlmPorConv: tokens reales / conversaciones reales, sin la demo', async () => {
  const mes = currentMonth();
  const { accountId } = await armarCuenta('crecimiento');

  // Dos leads atendidos este mes + un lead demo que NO debe contar.
  const lead1 = await db.insert(db.leads, { account_id: accountId, channel: 'instagram' });
  const lead2 = await db.insert(db.leads, { account_id: accountId, channel: 'whatsapp' });
  const leadDemo = await db.insert(db.leads, { account_id: accountId, demo: true });
  await db.insert(db.messages, { lead_id: lead1._id, role: 'agent', content: 'hola' });
  await db.insert(db.messages, { lead_id: lead1._id, role: 'agent', content: 'sigo acá' });
  await db.insert(db.messages, { lead_id: lead2._id, role: 'agent', content: 'hola' });
  await db.insert(db.messages, { lead_id: leadDemo._id, role: 'agent', content: 'demo' });

  // Dos llamadas LLM de 1M/1M en gpt-4o-mini (US$0,75 c/u) este mes, y una
  // vieja de un mes cerrado que debe quedar fuera del corte.
  await db.insert(db.aiUsage, { accountId, model: 'gpt-4o-mini', promptTokens: 1e6, completionTokens: 1e6 });
  await db.insert(db.aiUsage, { accountId, model: 'gpt-4o-mini', promptTokens: 1e6, completionTokens: 1e6 });
  await db.insert(db.aiUsage, {
    accountId, model: 'gpt-4o-mini', promptTokens: 9e6, completionTokens: 9e6,
    createdAt: '2020-01-15T00:00:00.000Z',
  });

  const r = await medirLlmPorConv(mes);
  assert.strictEqual(r.conversaciones, 2, 'la demo no es una conversación');
  assert.strictEqual(r.llamadas_llm, 2, 'la llamada del mes viejo queda fuera');
  assert.ok(Math.abs(r.costo_chat_usd - 1.5) < 1e-6);
  assert.ok(Math.abs(r.llm_por_conv_chat_usd - 0.75) < 1e-6);
  assert.ok(Math.abs(r.llm_por_conv_total_usd - 0.75 * FACTOR_AUXILIAR) < 1e-6);
  assert.strictEqual(r.constante_config_usd, COSTOS.llmPorConv);
  assert.ok(r.desviacion_pct > 0, 'con este costo sintético la constante queda corta');
  assert.strictEqual(r.por_modelo['gpt-4o-mini'].llamadas, 2);
  assert.deepStrictEqual(r.modelos_sin_precio, []);
});

test('medirLlmPorConv en un mes sin datos no divide por cero', async () => {
  const r = await medirLlmPorConv('2019-03');
  assert.strictEqual(r.conversaciones, 0);
  assert.strictEqual(r.llm_por_conv_chat_usd, null);
  assert.strictEqual(r.llm_por_conv_total_usd, null);
  assert.strictEqual(r.desviacion_pct, null);
});

test('margenPorCuenta: uso real × costos de la escalera, con LLM medido de contraste', async () => {
  const mes = currentMonth();
  const { accountId, user } = await armarCuenta('crecimiento', {
    monthly_dm_count: 100, monthly_wa_count: 40, dm_count_month: mes,
    monthly_voice_seconds: 600, voice_count_month: mes,
  });
  // REGRESIÓN convención: aiUsage usa accountId (camel). Si alguien lo "unifica"
  // a account_id, esta columna queda en cero sin ningún error.
  await db.insert(db.aiUsage, { accountId, model: 'gpt-4o-mini', promptTokens: 1e6, completionTokens: 1e6 });

  const r = await margenPorCuenta();
  const fila = r.cuentas.find(c => c.email === user.email);
  assert.ok(fila, 'la cuenta pagada aparece en el monitor');

  const esperado = 40 * COSTO_CONV_WHATSAPP + 60 * COSTO_CONV_META
                 + 10 * COSTO_MINUTO_LLAMADA + COSTOS.numeroMes; // crecimiento SÍ llama
  assert.strictEqual(fila.precio_usd, 275);
  assert.strictEqual(fila.conversaciones, 100);
  assert.strictEqual(fila.conversaciones_wa, 40);
  assert.strictEqual(fila.minutos_voz, 10);
  assert.strictEqual(fila.costo_usd, +esperado.toFixed(2));
  assert.strictEqual(fila.margen_usd, +(275 - esperado).toFixed(2));
  assert.strictEqual(fila.alerta, false, 'con este uso el margen es sano');
  assert.ok(Math.abs(fila.llm_medido_usd - 0.75) < 1e-6, 'el LLM medido agrupa por accountId camel');
});

test('la alerta dispara cuando una cuenta pagada cruza el umbral', async () => {
  const mes = currentMonth();
  // Inicial (US$98, sin llamadas): 320 conversaciones de WhatsApp en overage
  // cuestan ~US$81 → margen ~17% < 20. Es el caso real que el monitor caza:
  // un cliente chico reventando el canal caro.
  const { user } = await armarCuenta('inicial', {
    monthly_dm_count: 320, monthly_wa_count: 320, dm_count_month: mes,
  });

  const r = await margenPorCuenta();
  const fila = r.cuentas.find(c => c.email === user.email);
  assert.ok(fila.margen_pct < UMBRAL_ALERTA_MARGEN, `margen ${fila.margen_pct}% debía quedar bajo el umbral`);
  assert.strictEqual(fila.alerta, true);
  assert.ok(r.alertas >= 1);
  assert.strictEqual(r.cuentas[0].alerta, true, 'las alertas se ordenan primero');
  assert.strictEqual(fila.costo_desglose.numero, 0, 'Inicial no arrienda número: no puede llamar');
});

test('trial sin margen pero visible; demo y admin fuera del monitor', async () => {
  const mes = currentMonth();
  const { user: trial } = await armarCuenta('trial', {
    monthly_dm_count: 50, monthly_wa_count: 10, dm_count_month: mes,
  });
  await db.insert(db.users, { email: 'demo@atinov.com', membershipPlan: 'crecimiento', account_id: 'acc-demo' });
  await db.insert(db.users, { email: 'admin@atinov.com', role: 'admin', account_id: 'acc-admin' });

  const r = await margenPorCuenta();
  const filaTrial = r.cuentas.find(c => c.email === trial.email);
  assert.ok(filaTrial, 'el trial se ve: cuesta plata aunque no pague');
  assert.strictEqual(filaTrial.margen_pct, null);
  assert.strictEqual(filaTrial.alerta, false, 'sin precio no hay margen que alertar');
  assert.ok(filaTrial.costo_usd > 0);
  assert.ok(!r.cuentas.some(c => c.email === 'demo@atinov.com'), 'la demo no es un cliente');
  assert.ok(!r.cuentas.some(c => c.email === 'admin@atinov.com'), 'el admin tampoco');
});

test('los contadores de un mes viejo no cuentan como uso de este mes', async () => {
  const { user } = await armarCuenta('escala', {
    monthly_dm_count: 900, monthly_wa_count: 200, dm_count_month: '2020-01',
    monthly_voice_seconds: 6000, voice_count_month: '2020-01',
  });
  const r = await margenPorCuenta();
  const fila = r.cuentas.find(c => c.email === user.email);
  assert.strictEqual(fila.conversaciones, 0);
  assert.strictEqual(fila.conversaciones_wa, 0);
  assert.strictEqual(fila.minutos_voz, 0);
  // Solo queda el costo fijo del número (Escala puede llamar).
  assert.strictEqual(fila.costo_usd, COSTOS.numeroMes);
});

test('el umbral de alerta es el 20% acordado', () => {
  assert.strictEqual(UMBRAL_ALERTA_MARGEN, 20);
});
