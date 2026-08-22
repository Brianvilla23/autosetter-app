/**
 * Atinov — Tests del plan Founder
 *
 * Founder es el único plan que se vende. Faltaba en config/plans.js, y como
 * getPlanFor() hace `PLANS[key] || PLANS.trial`, toda cuenta con
 * membershipPlan='founder' caía silenciosamente a TRIAL: 200 DMs, sin
 * calificación, sin follow-ups, sin lead magnets. Cobrar $148 y entregar el
 * plan gratis, sin un solo error en los logs.
 *
 * No era hipotético: la migración post-Lemon-Squeezy de db/database.js dejó
 * cuentas reales en 'founder' desde el 2026-05-03.
 *
 * config/plans.js es puro (no importa db), así que esto corre sin NeDB.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { PLANS, getPlanFor, hasFeature, calculateOverage } = require('../config/plans');

test('el plan founder existe', () => {
  assert.ok(PLANS.founder, 'sin esto, todo el que paga cae a trial');
  assert.strictEqual(PLANS.founder.id, 'founder');
});

test('REGRESIÓN: una cuenta founder NO cae a trial', () => {
  const plan = getPlanFor({ membershipPlan: 'founder' });
  assert.strictEqual(plan.id, 'founder', 'este es el bug que se está arreglando');
  assert.notStrictEqual(plan.id, 'trial');
  assert.strictEqual(plan.maxDMs, 6000, 'no los 200 de trial');
});

test('founder entrega lo que promete la landing', () => {
  const plan = getPlanFor({ membershipPlan: 'founder' });
  assert.strictEqual(plan.maxDMs, 6000, '"6.000 conversaciones/mes"');
  assert.strictEqual(plan.maxAgents, 5, '"5 agentes"');
  assert.strictEqual(plan.price, 148, 'US$148/mes');
  assert.strictEqual(plan.priceCLP, 135000, 'debe calzar con MP_PRICE_FOUNDER_CLP');
});

test('founder trae encendido todo lo que se vende', () => {
  const u = { membershipPlan: 'founder' };
  for (const f of ['followups', 'leadMagnets', 'qualification', 'webhook',
                   'inboxTakeControl', 'multiAccount', 'multiUser',
                   'apiAccess', 'prioritySupport']) {
    assert.strictEqual(hasFeature(u, f), true, `founder debe incluir ${f}`);
  }
  // El white-label es del plan de agencias, no de Founder.
  assert.strictEqual(hasFeature(u, 'whiteLabel'), false);
});

test('el mayúsculas/minúsculas no rompe el plan', () => {
  // getPlanFor normaliza a minúsculas; si alguien guarda 'Founder' desde un
  // panel o un import, tiene que resolver igual y no caer a trial.
  assert.strictEqual(getPlanFor({ membershipPlan: 'Founder' }).id, 'founder');
  assert.strictEqual(getPlanFor({ membershipPlan: 'FOUNDER' }).id, 'founder');
});

test('founder cobra overage en vez de cortar la atención', () => {
  const u = { membershipPlan: 'founder' };
  const o = calculateOverage(u, 6500);
  assert.ok(o, 'founder permite overage: pasarse no puede dejar al negocio mudo');
  assert.strictEqual(o.extraDMs, 500);
  // 0,50 y no 0,025: desde el 1-oct-2026 una conversación de WhatsApp cuesta
  // ~US$0,27, así que el overage viejo se vendía por debajo del costo.
  assert.strictEqual(o.perDM, 0.50);
});

test('lo que ya funcionaba sigue funcionando', () => {
  // Agregar founder no puede cambiar el resto del comportamiento.
  assert.strictEqual(getPlanFor(null).id, 'trial', 'sin usuario → trial');
  assert.strictEqual(getPlanFor({}).id, 'trial', 'sin plan → trial');
  assert.strictEqual(getPlanFor({ membershipPlan: 'inventado' }).id, 'trial', 'plan desconocido → trial');
  assert.strictEqual(getPlanFor({ role: 'admin' }).id, 'admin', 'el admin manda sobre el plan');
  assert.strictEqual(getPlanFor({ membershipPlan: 'pro' }).id, 'pro', 'los legacy siguen resolviendo');
  assert.strictEqual(calculateOverage({ membershipPlan: 'trial' }, 500), null, 'trial no tiene overage');
});
