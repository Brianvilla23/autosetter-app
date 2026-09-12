/**
 * Atinov — Perfil de voz por país (prefijo del teléfono)
 *
 * Lo que se fija: el país sale del número (prefijo más largo primero), un
 * dato explícito del lead manda sobre el número, el país del negocio es el
 * respaldo, y sin nada se habla chileno. Chile prohíbe el voseo; Argentina
 * lo exige pleno. Un lead que habla inglés se atiende en inglés.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const lv = require('../services/localeVoz');

test('prefijo: el mas largo gana (593 antes que 59, 598 antes que 5)', () => {
  assert.strictEqual(lv.paisDesdeTelefono('+56 9 9568 4130'), 'CL');
  assert.strictEqual(lv.paisDesdeTelefono('5491155551234'), 'AR');
  assert.strictEqual(lv.paisDesdeTelefono('+593991234567'), 'EC');
  assert.strictEqual(lv.paisDesdeTelefono('+59899123456'), 'UY');
  assert.strictEqual(lv.paisDesdeTelefono('+5215512345678'), 'MX');
  assert.strictEqual(lv.paisDesdeTelefono('+1 305 555 0100'), 'US');
  assert.strictEqual(lv.paisDesdeTelefono(''), null);
  assert.strictEqual(lv.paisDesdeTelefono('+99912345'), null, 'prefijo desconocido');
});

test('precedencia: lead.pais > telefono > account.pais > CL', () => {
  assert.strictEqual(lv.perfilPara({}).pais, 'CL');
  assert.strictEqual(lv.perfilPara({}).origen, 'default');
  assert.strictEqual(lv.perfilPara({ account: { pais: 'mx' } }).pais, 'MX');
  assert.strictEqual(lv.perfilPara({ telefono: '+5491155551234', account: { pais: 'MX' } }).pais, 'AR');
  const p = lv.perfilPara({ telefono: '+5491155551234', lead: { pais: 'CO' } });
  assert.strictEqual(p.pais, 'CO');
  assert.strictEqual(p.origen, 'lead');
  assert.strictEqual(lv.perfilPara({ lead: { wa_id: '56912345678' } }).pais, 'CL', 'sin telefono explicito usa el wa_id del lead');
  assert.strictEqual(lv.perfilPara({ lead: { pais: 'ZZ' }, telefono: '+34600000000' }).pais, 'ES', 'pais invalido se ignora');
});

test('Chile prohibe el voseo, Argentina lo exige pleno, Colombia trata de usted', () => {
  assert.match(lv.PERFILES.CL.bloque, /Nunca voseo argentino/);
  assert.match(lv.PERFILES.AR.bloque, /vos tenés/);
  assert.match(lv.PERFILES.AR.bloque, /Nunca mezclar con "tú tienes"/);
  assert.match(lv.PERFILES.CO.bloque, /"Usted" por defecto/);
  assert.match(lv.PERFILES.MX.bloque, /Nunca uses "al tiro"/);
});

test('idioma de transcripcion: es por defecto; lead.idioma=en fuerza ingles', () => {
  assert.strictEqual(lv.perfilPara({ telefono: '+13055550100' }).idioma, 'es', 'EE.UU. = mercado hispano por defecto');
  const en = lv.perfilPara({ telefono: '+13055550100', lead: { idioma: 'en' } });
  assert.strictEqual(en.pais, 'EN');
  assert.strictEqual(en.idioma, 'en');
  assert.match(en.bloque, /US ENGLISH/);
});

test('todo perfil tiene lo que el puente necesita', () => {
  for (const [codigo, p] of Object.entries(lv.PERFILES)) {
    assert.strictEqual(p.pais, codigo);
    assert.ok(['es', 'en'].includes(p.idioma), codigo + ' idioma');
    assert.ok(p.vozSugerida, codigo + ' voz');
    assert.ok(p.bloque.includes('---'), codigo + ' bloque');
    assert.ok(p.promptTranscripcion, codigo + ' prompt transcripcion');
  }
  for (const pais of Object.values(lv.PREFIJOS)) assert.ok(lv.PERFILES[pais], 'prefijo apunta a perfil inexistente: ' + pais);
});
