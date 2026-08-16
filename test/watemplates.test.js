/**
 * Atinov — Suite de plantillas de WhatsApp
 *
 * El validador corre ANTES de gastar el POST a Meta: fija las reglas que
 * Meta aplica (nombre, categoría, variables secuenciales, largos) para que
 * el dueño reciba el motivo en castellano y no un "#100 Invalid parameter".
 * También la traducción de errores de Meta y el resumen para el panel.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const tpl = require('../services/waTemplates');

test('payload válido: nombre normalizado, componentes en orden, ejemplos por variable', () => {
  const p = tpl.construirPayload({
    name: 'Recordatorio_Cita', category: 'utility', language: 'es_CL',
    header: 'Recordatorio', body: 'Hola {{1}}, tu hora es el {{2}}.', footer: 'Responde para cambiarla',
    buttons: ['Confirmar', 'Cambiar hora'],
  });
  assert.strictEqual(p.name, 'recordatorio_cita', 'minúsculas');
  assert.strictEqual(p.category, 'UTILITY');
  assert.strictEqual(p.language, 'es_CL');
  assert.deepStrictEqual(p.components.map(c => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  const body = p.components.find(c => c.type === 'BODY');
  assert.deepStrictEqual(body.example.body_text, [['ejemplo 1', 'ejemplo 2']], 'Meta exige un ejemplo por variable');
  const btns = p.components.find(c => c.type === 'BUTTONS').buttons;
  assert.strictEqual(btns.length, 2);
  assert.strictEqual(btns[0].type, 'QUICK_REPLY');
});

test('rechaza lo que Meta rechazaría, con motivo en castellano', () => {
  const casos = [
    [{ name: 'Con Espacios', category: 'UTILITY', body: 'x' }, /minúsculas/],
    [{ name: 'ok_1', category: 'PROMO', body: 'x' }, /Categoría/],
    [{ name: 'ok_1', category: 'UTILITY', language: 'español', body: 'x' }, /Idioma/],
    [{ name: 'ok_1', category: 'UTILITY', body: '' }, /cuerpo/],
    [{ name: 'ok_1', category: 'UTILITY', body: 'Hola {{2}}' }, /orden/, 'salto de variable'],
    [{ name: 'ok_1', category: 'UTILITY', body: 'Hola {{1}} y {{3}}' }, /orden/],
    [{ name: 'ok_1', category: 'UTILITY', body: 'x', header: 'a'.repeat(61) }, /60/],
    [{ name: 'ok_1', category: 'UTILITY', body: 'x', header: 'Hola {{1}}' }, /encabezado/i],
    [{ name: 'ok_1', category: 'UTILITY', body: 'x', buttons: ['a'.repeat(26)] }, /25/],
    [{ name: 'ok_1', category: 'UTILITY', body: 'x'.repeat(1025) }, /1024/],
  ];
  for (const [borrador, re, nota] of casos) {
    assert.throws(() => tpl.construirPayload(borrador), (e) => e instanceof tpl.ErrorPlantilla && re.test(e.message), nota || JSON.stringify(borrador).slice(0, 60));
  }
});

test('máximo 3 botones y sin componentes vacíos', () => {
  const p = tpl.construirPayload({ name: 'b', category: 'UTILITY', body: 'x', buttons: ['1', '2', '3', '4', ''], header: '  ', footer: '' });
  assert.deepStrictEqual(p.components.map(c => c.type), ['BODY', 'BUTTONS'], 'header/footer vacíos no se mandan');
  assert.strictEqual(p.components[1].buttons.length, 3);
});

test('resumir: extrae cuerpo, botones, variables y motivo de rechazo real', () => {
  const r = tpl.resumir({
    id: '1', name: 'x', status: 'REJECTED', category: 'MARKETING', language: 'es',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, {{2}}' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí' }] },
    ],
    rejected_reason: 'PROMOTIONAL',
  });
  assert.strictEqual(r.variables, 2);
  assert.deepStrictEqual(r.buttons, ['Sí']);
  assert.strictEqual(r.rejected_reason, 'PROMOTIONAL');
  assert.strictEqual(tpl.resumir({ name: 'y', status: 'APPROVED', rejected_reason: 'NONE', components: [] }).rejected_reason, null, '"NONE" no es un motivo');
});

test('errores de Meta traducidos, sin filtrar internals', () => {
  const mk = (message) => ({ response: { data: { error: { message } } } });
  assert.match(tpl.explicarErrorMeta(mk('Message template name already exists')), /Ya existe/);
  assert.match(tpl.explicarErrorMeta(mk('(#100) Invalid parameter: example missing')), /ejemplo/);
  assert.match(tpl.explicarErrorMeta(mk('(#10) Application does not have permission')), /permiso/);
  const generico = tpl.explicarErrorMeta(mk('project id 12345 billing status suspended'));
  assert.ok(!/12345|billing/.test(generico), 'el detalle interno del proveedor no sale al cliente');
});
