/**
 * Atinov — Tests de la escalera de tres planes (Inicial / Crecimiento / Escala)
 *
 * Lo que se protege acá es la economía del negocio, no una función:
 *  1. que la llamada con IA sea de verdad el candado del tramo de entrada,
 *  2. que la cuota de WhatsApp exista y no se confunda con el total,
 *  3. que ningún plan se pueda vender por debajo de su costo.
 *
 * config/plans.js es puro (no importa db), así que esto corre sin NeDB.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  PLANS, getPlanFor, hasFeature, calculateOverage, cuotaWhatsApp, costoPlan,
  COSTO_CONV_WHATSAPP, COSTO_CONV_META, COSTO_MINUTO_LLAMADA, PRECIO_MINUTO_EXTRA,
} = require('../config/plans');

const VIGENTES = ['inicial', 'crecimiento', 'escala'];

test('los tres planes vigentes existen con su precio y su cuota', () => {
  const esperado = {
    inicial:     { price: 98,  maxDMs: 1800,  maxDMsWhatsApp: 90,  minutosLlamada: 0 },
    crecimiento: { price: 275, maxDMs: 7000,  maxDMsWhatsApp: 250, minutosLlamada: 200 },
    escala:      { price: 498, maxDMs: 20000, maxDMsWhatsApp: 460, minutosLlamada: 500 },
  };
  for (const [id, e] of Object.entries(esperado)) {
    const p = PLANS[id];
    assert.ok(p, `falta el plan ${id}`);
    for (const [campo, valor] of Object.entries(e)) {
      assert.strictEqual(p[campo], valor, `${id}.${campo}`);
    }
  }
});

test('la llamada con IA es el candado del plan de entrada', () => {
  // Es la razón de existir de la escalera: Inicial trae todo menos la llamada,
  // y eso es lo que hace que valga la pena subir a Crecimiento.
  assert.strictEqual(hasFeature({ membershipPlan: 'inicial' }, 'llamadas'), false);
  assert.strictEqual(hasFeature({ membershipPlan: 'crecimiento' }, 'llamadas'), true);
  assert.strictEqual(hasFeature({ membershipPlan: 'escala' }, 'llamadas'), true);
  assert.strictEqual(hasFeature({ membershipPlan: 'trial' }, 'llamadas'), false);
  assert.strictEqual(hasFeature(null, 'llamadas'), false, 'sin usuario nunca se llama');
});

test('Inicial trae el producto completo, no una versión mutilada', () => {
  // Si el plan de entrada se siente pobre, no entra nadie. Lo único que le
  // falta es la llamada.
  const u = { membershipPlan: 'inicial' };
  for (const f of ['followups', 'leadMagnets', 'qualification', 'inboxTakeControl']) {
    assert.strictEqual(hasFeature(u, f), true, `Inicial debe incluir ${f}`);
  }
  assert.strictEqual(hasFeature(u, 'llamadas'), false, 'menos la llamada');
});

test('la escalera sube de verdad en cada tramo', () => {
  const p = VIGENTES.map(id => PLANS[id]);
  for (let i = 1; i < p.length; i++) {
    assert.ok(p[i].price > p[i - 1].price, 'el precio sube');
    assert.ok(p[i].maxDMs > p[i - 1].maxDMs, 'las conversaciones suben');
    assert.ok(p[i].maxDMsWhatsApp > p[i - 1].maxDMsWhatsApp, 'la cuota de WhatsApp sube');
    assert.ok(p[i].minutosLlamada >= p[i - 1].minutosLlamada, 'los minutos no bajan');
    assert.ok(p[i].maxAgents >= p[i - 1].maxAgents, 'los agentes no bajan');
  }
});

test('la cuota de WhatsApp es siempre menor que el total', () => {
  // Son dos contadores distintos: WhatsApp cuesta ~9x lo que cuesta Instagram.
  // Si la cuota de canal igualara al total, no estaría protegiendo nada.
  for (const id of VIGENTES) {
    const p = PLANS[id];
    assert.ok(p.maxDMsWhatsApp < p.maxDMs, `${id}: la cuota de WhatsApp debe ser un subconjunto`);
  }
});

test('cuotaWhatsApp cuenta bien lo usado, lo que queda y el excedente', () => {
  const u = { membershipPlan: 'crecimiento' };
  const sinUsar = cuotaWhatsApp(u, 0);
  assert.strictEqual(sinUsar.tope, 250);
  assert.strictEqual(sinUsar.restantes, 250);
  assert.strictEqual(sinUsar.excedidas, 0);
  assert.strictEqual(sinUsar.costoExtraUSD, 0);

  const pasado = cuotaWhatsApp(u, 300);
  assert.strictEqual(pasado.excedidas, 50);
  assert.strictEqual(pasado.restantes, 0);
  assert.strictEqual(pasado.costoExtraUSD, 25, '50 conversaciones x US$0,50');

  assert.strictEqual(cuotaWhatsApp({ membershipPlan: 'founder' }, 99), null,
    'los planes heredados no tienen cuota separada de canal');
});

test('NINGÚN plan se vende por debajo de su costo', () => {
  // La guardia de fondo: si alguien toca una cuota o un precio y el plan queda
  // deficitario aun en el peor caso, este test lo frena antes del deploy.
  for (const id of VIGENTES) {
    const c = costoPlan(id);
    assert.ok(c, `costoPlan devolvió null para ${id}`);
    assert.ok(c.margen > 0, `${id} pierde plata con la cuota llena: US$${c.margen}`);
  }
});

test('el overage se vende por encima de lo que cuesta', () => {
  // El error que se cometió antes fue justamente éste: cobrar el excedente por
  // debajo del costo, o sea perder más mientras más se usa.
  for (const id of VIGENTES) {
    assert.ok(PLANS[id].overagePerDM > COSTO_CONV_WHATSAPP,
      `${id}: el overage (US$${PLANS[id].overagePerDM}) no puede ser menor al costo (US$${COSTO_CONV_WHATSAPP.toFixed(3)})`);
  }
  assert.ok(PRECIO_MINUTO_EXTRA > COSTO_MINUTO_LLAMADA,
    'el minuto extra debe venderse sobre su costo');
});

test('una conversación de WhatsApp cuesta mucho más que una de Instagram', () => {
  // Es la premisa entera de tener dos contadores. Si algún día dejan de
  // diferir, la cuota separada sobra y hay que simplificar.
  assert.ok(COSTO_CONV_WHATSAPP > COSTO_CONV_META * 5,
    'WhatsApp debe costar bastante más: Meta cobra ese canal y los otros no');
});

test('costoPlan desglosa el costo en sus partes reales', () => {
  const c = costoPlan('crecimiento');
  assert.strictEqual(c.precio, 275);
  assert.ok(c.whatsapp > 0, 'la cuota de WhatsApp cuesta');
  assert.ok(c.meta > 0, 'las conversaciones de IG/Messenger cuestan LLM');
  assert.ok(c.llamadas > 0, 'la bolsa de minutos cuesta');
  assert.strictEqual(c.numero, 7, 'el número de Twilio solo se arrienda si el plan llama');
  assert.strictEqual(costoPlan('inicial').numero, 0, 'Inicial no llama: no paga número');
  assert.ok(Math.abs(c.total - (c.whatsapp + c.meta + c.llamadas + c.numero)) < 0.02,
    'el total tiene que ser la suma de las partes');
});

test('un plan que no existe no rompe el cálculo', () => {
  assert.strictEqual(costoPlan('inventado'), null);
  assert.strictEqual(costoPlan(null), null);
  assert.strictEqual(costoPlan('trial'), null, 'trial es gratis: no tiene margen que calcular');
});

test('los planes heredados siguen resolviendo y no se rompen', () => {
  for (const id of ['founder', 'starter', 'pro', 'agency']) {
    assert.strictEqual(getPlanFor({ membershipPlan: id }).id, id,
      `${id} debe seguir resolviendo: hay cuentas que lo tienen`);
  }
  assert.strictEqual(calculateOverage({ membershipPlan: 'inicial' }, 2000).extraDMs, 200);
});
