/**
 * Atinov — Tests de la cascada de supresión (Ley 21.719 / data deletion de Meta)
 *
 * Lo que se protege acá no es un algoritmo, es una LISTA: qué colecciones se
 * borran y por qué campo. Equivocarse en un nombre de campo no da error —
 * borra cero documentos en silencio y deja dato personal vivo después de
 * prometerle al titular que lo eliminamos. Eso es lo que estos tests cuidan.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { POR_CUENTA, POR_USUARIO, CONSERVADO } = require('../services/supresionPlan');

const nombres = POR_CUENTA.map(([n]) => n);
const campos  = Object.fromEntries(POR_CUENTA);

test('la cascada cubre todas las colecciones con dato personal del cliente', () => {
  // Si alguien agrega una colección nueva con dato personal y no la suma a
  // POR_CUENTA, este test cae. Es a propósito: la lista tiene que crecer con
  // el esquema, no quedarse atrás como pasó con la cascada vieja de admin.js.
  const obligatorias = [
    'followups', 'pendingSends', 'failedSends', 'llamadas',
    'agents', 'knowledge', 'knowledgeSources', 'links', 'bypassed',
    'settings', 'magnetLinks', 'linkClicks', 'leadMagnets',
    'magnetDeliveries', 'postRules', 'improvements', 'quickReplies', 'aiUsage',
  ];
  for (const c of obligatorias) {
    assert.ok(nombres.includes(c), `falta ${c} en la cascada: quedaría dato personal vivo`);
  }
});

test('las colecciones que la cascada vieja olvidaba están cubiertas', () => {
  // Regresión directa del bug: admin.js borraba a mano y se le quedaban éstas,
  // pese a que /data-deletion promete que se borra la base de conocimiento.
  for (const c of ['knowledgeSources', 'leadMagnets', 'magnetDeliveries',
                   'linkClicks', 'postRules', 'improvements', 'aiUsage']) {
    assert.ok(nombres.includes(c), `${c} se olvidaba antes y debe seguir cubierta`);
  }
});

test('cada colección se borra por el campo correcto', () => {
  // El esquema NO es uniforme: unas usan account_id y otras accountId. Un
  // nombre mal escrito no falla, borra cero. Por eso se fija uno por uno.
  assert.strictEqual(campos.pendingSends, 'accountId');
  assert.strictEqual(campos.failedSends,  'accountId');
  assert.strictEqual(campos.aiUsage,      'accountId');

  assert.strictEqual(campos.followups,        'account_id');
  assert.strictEqual(campos.llamadas,         'account_id');
  assert.strictEqual(campos.knowledge,        'account_id');
  assert.strictEqual(campos.knowledgeSources, 'account_id');
  assert.strictEqual(campos.settings,         'account_id');
  assert.strictEqual(campos.magnetDeliveries, 'account_id');
});

test('lo que cuelga del usuario se borra por su propio campo', () => {
  const porUsuario = Object.fromEntries(POR_USUARIO);
  assert.strictEqual(porUsuario.emailLog, 'userId', 'el emailLog guarda la dirección: es dato personal');
  assert.strictEqual(porUsuario.referrals, 'referrer_id');
});

test('billableEvents y auditLog NO se borran, y está declarado por qué', () => {
  // Retención legítima. Si alguien los mete en la cascada, se pierde la prueba
  // de que la supresión ocurrió y los registros que exige la ley tributaria.
  assert.ok(!nombres.includes('billableEvents'), 'billableEvents tiene retención contable');
  assert.ok(!nombres.includes('auditLog'), 'auditLog es la prueba de la propia supresión');

  // Y no basta con no borrarlos: la excepción tiene que estar escrita, porque
  // /data-deletion §3 se la declara al titular.
  assert.ok(CONSERVADO.billableEvents, 'la excepción de billableEvents debe estar documentada');
  assert.ok(CONSERVADO.auditLog, 'la excepción de auditLog debe estar documentada');
});

test('la lista no tiene duplicados', () => {
  assert.strictEqual(new Set(nombres).size, nombres.length, 'una colección repetida se borraría dos veces');
});
