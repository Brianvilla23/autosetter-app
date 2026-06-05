/**
 * Atinov — Tests de la separación en dos agentes (Tarea 1)
 *
 * Garantiza que:
 *  - El default es 'nurture' (compatibilidad: agentes viejos no cambian).
 *  - Un agente prospect NUNCA puede enviar automático.
 *  - La detección de señal de calor funciona para el handoff.
 *
 * Corre con `npm test` (node:test nativo).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { roleOf, canSendAuto, isValidRole, ROLE_IDS } = require('../config/agentRoles');
const { detectWarmthSignal } = require('../services/agents/prospectAgent');

// ── Roles ────────────────────────────────────────────────────────────────────
test('agente SIN role definido se trata como nurture (compatibilidad)', () => {
  assert.strictEqual(roleOf({ name: 'viejo' }), 'nurture');
  assert.strictEqual(roleOf({}), 'nurture');
  assert.strictEqual(roleOf(null), 'nurture');
});

test('roleOf respeta nurture/prospect explícitos', () => {
  assert.strictEqual(roleOf({ role: 'nurture' }), 'nurture');
  assert.strictEqual(roleOf({ role: 'prospect' }), 'prospect');
  // role basura → cae a nurture (no rompe)
  assert.strictEqual(roleOf({ role: 'hacker' }), 'nurture');
});

test('un agente NURTURE puede enviar automático; un PROSPECT NUNCA', () => {
  assert.strictEqual(canSendAuto({ role: 'nurture' }), true);
  assert.strictEqual(canSendAuto({}), true);              // default nurture
  assert.strictEqual(canSendAuto({ role: 'prospect' }), false);
});

test('isValidRole solo acepta los roles definidos', () => {
  assert.ok(isValidRole('nurture'));
  assert.ok(isValidRole('prospect'));
  assert.ok(!isValidRole('admin'));
  assert.ok(!isValidRole(''));
  assert.ok(!isValidRole(undefined));
  assert.deepStrictEqual(ROLE_IDS.sort(), ['nurture', 'prospect']);
});

// ── Señal de calor (handoff prospección → nutrición) ─────────────────────────
test('detectWarmthSignal detecta interés real del lead', () => {
  assert.ok(detectWarmthSignal('cuánto sale?'), 'pregunta de precio = calor');
  assert.ok(detectWarmthSignal('me interesa, cómo funciona'), 'interés explícito');
  assert.ok(detectWarmthSignal('quiero una demo'), 'pide demo');
  assert.ok(detectWarmthSignal('pasame el link'), 'pide link');
});

test('detectWarmthSignal NO se dispara con respuestas frías', () => {
  assert.ok(!detectWarmthSignal('hola'), 'saludo simple no es calor');
  assert.ok(!detectWarmthSignal('ok'), 'monosílabo no es calor');
  assert.ok(!detectWarmthSignal('gracias por escribir'), 'cortesía no es calor');
  assert.ok(!detectWarmthSignal(''), 'vacío no es calor');
});
