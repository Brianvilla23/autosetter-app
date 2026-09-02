/**
 * Atinov — Tests de la cuenta demo (la que ve el revisor de Meta)
 *
 * Esta cuenta no es una cuenta más: es lo ÚNICO que el revisor de Meta puede
 * abrir y tocar. El motivo de rechazo #1 del App Review es "el revisor no
 * puede entrar", y el #2 es "parece un producto a medio instalar".
 *
 * Lo que se fija acá salió de recorrer el panel demo como lo hará el revisor
 * (2026-09-02) y encontrar tres cosas que restaban credibilidad:
 *   1. la cuenta caía en plan trial → "Plan Trial" + alerta de límite + botón
 *      de upgrade en la primera pantalla,
 *   2. la tarjeta "Termina tu setup 3/6 · Conecta tu Instagram" siempre
 *      visible, porque la demo nunca podrá conectar un Instagram real,
 *   3. el agente demo sin los campos del constructor → formularios en blanco
 *      justo donde el revisor va a mirar cómo se configura el asistente.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-demoseed-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../db/database');
const { seedDemo } = require('../services/demoSeed');
const { getPlanFor } = require('../config/plans');
const { esObjetivoValido, tieneEstructura, instruccionesEfectivas } = require('../services/promptEstructurado');

const DEMO_EMAIL = 'demo@atinov.com';
const leerDemo = () => db.findOne(db.users, { email: DEMO_EMAIL });

test('la cuenta demo NO queda en trial: el revisor no debe ver límites ni upgrade', async () => {
  await seedDemo({ password: 'clave-de-prueba-1234' });
  const user = await leerDemo();
  assert.ok(user, 'la demo se crea');

  const plan = getPlanFor(user);
  assert.notStrictEqual(plan.id, 'trial', 'en trial el panel muestra la alerta de límite y el botón de upgrade');
  assert.ok(plan.price > 0, 'un plan de verdad, no el gratuito');
  // Con este plan la primera pantalla no puede quedarse sin margen: el uso
  // sembrado es mínimo comparado con la cuota.
  assert.ok(plan.maxDMs >= 3000, 'cuota holgada para que no aparezcan avisos de tope');
});

test('el agente demo trae los campos del constructor llenos, no cajas vacías', async () => {
  await seedDemo({ password: 'clave-de-prueba-1234' });
  const user = await leerDemo();
  const agente = await db.findOne(db.agents, { account_id: user.account_id, enabled: true });
  assert.ok(agente, 'la demo tiene un agente activo');

  assert.ok(esObjetivoValido(agente.objetivo), `objetivo inválido: ${agente.objetivo}`);
  assert.ok(agente.cargo && agente.cargo.length > 3, 'el cargo se muestra en el editor');
  for (const campo of ['p_contexto', 'p_limites', 'p_objeciones', 'p_escalacion']) {
    assert.ok(agente[campo] && agente[campo].length > 40, `${campo} vacío: el revisor ve un formulario en blanco`);
  }
  assert.ok(Array.isArray(agente.p_ejemplos) && agente.p_ejemplos.length >= 2,
    'los ejemplos enseñan más que las reglas — y son lo que se ve al abrir el agente');
  for (const e of agente.p_ejemplos) {
    assert.ok(e.cliente && e.agente, 'cada ejemplo necesita las dos partes o se descarta al guardar');
  }
  assert.strictEqual(tieneEstructura(agente), true);

  // Y lo estructurado tiene que llegar de verdad al prompt del modelo.
  const efectivas = instruccionesEfectivas(agente);
  assert.match(efectivas, /Recepcionista/i);
  assert.ok(efectivas.length > 400, 'el prompt efectivo se arma con los campos nuevos');
});

test('re-sembrar la demo (resetear) deja el mismo estado, no uno degradado', async () => {
  // El botón de admin resetea. Si el reset olvidara el plan, la cuenta volvería
  // a trial justo antes de que entre el revisor — el peor momento posible.
  await seedDemo({ password: 'primera-clave-1234' });
  const antes = await leerDemo();
  await seedDemo({ password: 'segunda-clave-5678' });
  const despues = await leerDemo();

  assert.strictEqual(antes._id, despues._id, 'es la misma cuenta, no una nueva');
  assert.strictEqual(getPlanFor(despues).id, getPlanFor(antes).id, 'el plan sobrevive al reset');
  assert.notStrictEqual(getPlanFor(despues).id, 'trial');

  const agente = await db.findOne(db.agents, { account_id: despues.account_id, enabled: true });
  assert.strictEqual(tieneEstructura(agente), true, 'el agente re-sembrado tampoco queda en blanco');
});

test('la demo sigue marcada como demo: es lo que dispara la franja de datos ficticios', async () => {
  // Esa franja es la razón por la que los videos NO se graban con esta cuenta
  // (Meta la lee como mockup). Si se perdiera el flag, se perdería el aviso.
  await seedDemo({ password: 'clave-de-prueba-1234' });
  const user = await leerDemo();
  assert.strictEqual(user.demo, true);
  const cuenta = await db.findOne(db.accounts, { _id: user.account_id });
  assert.strictEqual(cuenta.demo, true);
});

test('la demo tiene conversaciones reales que mostrar en el Inbox', async () => {
  await seedDemo({ password: 'clave-de-prueba-1234' });
  const user = await leerDemo();
  const leads = await db.find(db.leads, { account_id: user.account_id });
  assert.ok(leads.length >= 8, `el Inbox del revisor necesita volumen creíble (hay ${leads.length})`);
  // Con calificaciones repartidas: es lo que demuestra el producto de un vistazo.
  const quals = new Set(leads.map(l => l.qualification).filter(Boolean));
  assert.ok(quals.has('hot'), 'tiene que haber leads calientes');
  assert.ok(quals.size >= 2, 'y más de una temperatura, o el filtro no dice nada');

  const conMensajes = await db.find(db.messages, { lead_id: leads[0]._id });
  assert.ok(conMensajes.length > 0, 'las conversaciones tienen hilo, no están vacías');
});
