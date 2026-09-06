/**
 * Atinov — Tests del preset v2 del agente que vende Atinov
 *
 * Lo que se protege:
 *  1. Los PRECIOS salen de config/plans.js al instalar. El preset viejo siguió
 *     vendiendo "Founder US$148 / 20 cupos / 6.000 conversaciones" semanas
 *     después de cambiar la escalera: ningún número viejo puede volver a
 *     aparecer, y si mañana cambia un precio, el texto cambia solo.
 *  2. Autocontenido y seguro: se crea DESACTIVADO, knowledge sin is_main y
 *     ligada solo a él, no toca agentes previos.
 *  3. Estructurado: objetivo válido, ejemplos que el ensamblador acepta, y el
 *     prompt efectivo lleva los 3 momentos y la política de honestidad.
 *  4. Cero lead magnets con archivos inexistentes y cero links inventados.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-preset-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const { PLANS } = require('../config/plans');
const {
  applyAtinovPreset, textoPlanes, NOMBRE_AGENTE, EJEMPLOS, LINKS, KNOWLEDGE_BASE,
} = require('../services/atinovPreset');
const { instruccionesEfectivas, sanearEjemplos, esObjetivoValido } = require('../services/promptEstructurado');

async function cuentaNueva() {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'atinov' });
  return accountId;
}

test('textoPlanes se genera desde config/plans.js: precios, cuotas y el candado de llamadas', () => {
  const t = textoPlanes();
  for (const id of ['inicial', 'crecimiento', 'escala']) {
    const p = PLANS[id];
    assert.ok(t.includes(`US$${p.price}`), `falta el precio de ${id}`);
    assert.ok(t.includes(p.maxDMs.toLocaleString('es-CL')), `falta la cuota de ${id}`);
    assert.ok(t.includes(`${p.maxDMsWhatsApp} por WhatsApp`), `falta la cuota WA de ${id}`);
  }
  assert.ok(t.includes('sin llamadas con IA'), 'Inicial declara que no trae llamadas');
  assert.ok(t.includes(`${PLANS.crecimiento.minutosLlamada} minutos de llamadas`));
  assert.ok(t.includes('3 días de prueba GRATIS sin tarjeta'));
  assert.ok(t.includes('CERO costo de implementación'));

  // Si cambia la escalera, cambia el texto (no hay números pegados a mano).
  const otros = JSON.parse(JSON.stringify(PLANS));
  otros.inicial.price = 123; otros.inicial.priceCLP = 111000;
  const t2 = textoPlanes(otros);
  assert.ok(t2.includes('US$123') && t2.includes('$111.000'));
  assert.ok(!t2.includes(`US$${PLANS.inicial.price} al mes`));
});

test('applyAtinovPreset: agente desactivado, estructurado, autocontenido; no toca lo previo', async () => {
  const accountId = await cuentaNueva();
  const previo = await db.insert(db.agents, { account_id: accountId, name: 'Atinov Sales', enabled: true, instructions: 'viejo' });
  const kbPrevia = await db.insert(db.knowledge, { account_id: accountId, title: 'Vieja', content: 'x', is_main: true, agent_ids: [previo._id] });

  const r = await applyAtinovPreset(db, accountId);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created.magnets, 0, 'sin lead magnets con archivos que no existen');

  const agente = await db.findOne(db.agents, { _id: r.agentId });
  assert.strictEqual(agente.name, NOMBRE_AGENTE);
  assert.strictEqual(agente.enabled, false, 'se crea apagado: el dueño lo enciende y apaga el viejo');
  assert.ok(esObjetivoValido(agente.objetivo));
  assert.strictEqual(agente.ignore_main_knowledge, true);
  assert.strictEqual(sanearEjemplos(agente.p_ejemplos).length, EJEMPLOS.length);
  assert.ok(agente.p_contexto && agente.p_limites && agente.p_objeciones && agente.p_escalacion);
  assert.deepStrictEqual([agente.delay_min, agente.delay_max], [5, 15]);

  // Knowledge: ligada SOLO al agente nuevo y nunca is_main.
  const kb = await db.find(db.knowledge, { account_id: accountId, agent_ids: r.agentId });
  assert.strictEqual(kb.length, KNOWLEDGE_BASE.length);
  assert.ok(kb.every(k => k.is_main === false), 'is_main contaminaría a todos los agentes vivos');
  const planes = kb.find(k => k.title.startsWith('Planes y precios'));
  assert.ok(planes.content.includes(`US$${PLANS.inicial.price}`), 'los precios vienen de plans.js');

  // Lo previo sigue intacto.
  const viejo = await db.findOne(db.agents, { _id: previo._id });
  assert.strictEqual(viejo.enabled, true);
  assert.strictEqual(viejo.instructions, 'viejo');
  assert.strictEqual((await db.findOne(db.knowledge, { _id: kbPrevia._id })).is_main, true);

  // Links: solo dominios propios y reales, ninguno "[EDITAR]" ni calendly.
  const links = await db.find(db.links, { account_id: accountId });
  assert.strictEqual(links.length, LINKS.length);
  assert.ok(links.every(l => l.url.startsWith('https://atinov.com/')), 'links solo a atinov.com');
  assert.ok(links.every(l => !/EDITAR|calendly/i.test(l.url + l.name)));
});

test('REGRESIÓN: ningún número de la escalera vieja sobrevive en el prompt ni en la knowledge', async () => {
  const accountId = await cuentaNueva();
  const r = await applyAtinovPreset(db, accountId);
  const agente = await db.findOne(db.agents, { _id: r.agentId });
  const kb = await db.find(db.knowledge, { account_id: accountId });
  const todo = [instruccionesEfectivas(agente), ...kb.map(k => k.content)].join('\n');

  for (const viejo of ['148', 'Founder', 'fundadores', 'cohorte', '6.000 conversaciones', '20 cupos', 'GPT-4', 'Brian', 'de 10 a 80', 'calendly']) {
    assert.ok(!todo.includes(viejo), `sobrevive texto viejo: "${viejo}"`);
  }
});

test('el prompt efectivo lleva los 3 momentos, la honestidad y los ejemplos al final', async () => {
  const accountId = await cuentaNueva();
  const r = await applyAtinovPreset(db, accountId);
  const agente = await db.findOne(db.agents, { _id: r.agentId });
  const prompt = instruccionesEfectivas(agente);

  assert.ok(prompt.includes('Tu rol: Brayan, fundador de Atinov.'));
  assert.ok(prompt.includes('CERRAR LA VENTA'), 'objetivo vender');
  for (const momento of ['1. DOLOR', '2. CAMBIO', '3. PRÓXIMO PASO']) assert.ok(prompt.includes(momento), `falta ${momento}`);
  assert.ok(prompt.includes('Nunca inventes testimonios'));
  assert.ok(prompt.includes('Derivas a Brayan'));
  assert.ok(prompt.includes('Nunca digas que eres IA'));
  const idxEjemplos = prompt.indexOf('ASÍ RESPONDES TÚ');
  assert.ok(idxEjemplos > prompt.indexOf('INSTRUCCIONES ADICIONALES'), 'los ejemplos van al final');
  assert.ok(prompt.includes('Cliente: hola, info'));
});

test('el preset se puede aplicar dos veces solo si la ruta lo permite: el servicio no deduplica solo', async () => {
  // El anti-duplicado vive en la ruta (busca por NOMBRE_AGENTE). Acá se fija
  // el nombre para que la ruta y el servicio no se desincronicen.
  assert.strictEqual(NOMBRE_AGENTE, 'Atinov Ventas');
});
