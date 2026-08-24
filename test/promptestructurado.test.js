/**
 * Atinov — Tests del constructor de prompt estructurado
 *
 * Lo crítico acá es la RETROCOMPATIBILIDAD: hay agentes en producción que solo
 * tienen `instructions` (texto libre), y el botón de mejora semanal
 * (promptImprover) anexa a ese campo. Si el ensamblador altera en una letra lo
 * que esos agentes mandan al modelo, cambia el comportamiento de agentes que
 * hoy funcionan — y eso es una regresión silenciosa en producción.
 *
 * Módulo puro: corre sin NeDB.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  OBJETIVOS, esObjetivoValido, sanearEjemplos, tieneEstructura, instruccionesEfectivas,
} = require('../services/promptEstructurado');

test('RETRO: un agente clásico sale IDÉNTICO, byte a byte', () => {
  const texto = 'Eres Mariela, vendes poleras.\n\nMEJORAS APROBADAS\n- Saluda con el nombre.';
  assert.strictEqual(instruccionesEfectivas({ instructions: texto }), texto,
    'sin campos estructurados no se toca ni un espacio');
  assert.strictEqual(instruccionesEfectivas({ instructions: '' }), '');
  assert.strictEqual(instruccionesEfectivas(null), '');
  assert.strictEqual(instruccionesEfectivas({}), '');
});

test('tieneEstructura distingue clásico de estructurado', () => {
  assert.strictEqual(tieneEstructura({ instructions: 'hola' }), false);
  assert.strictEqual(tieneEstructura({ p_contexto: 'vendemos autos' }), true);
  assert.strictEqual(tieneEstructura({ objetivo: 'vender' }), true);
  assert.strictEqual(tieneEstructura({ objetivo: 'inventado' }), false, 'objetivo inválido no cuenta');
  assert.strictEqual(tieneEstructura({ p_ejemplos: [{ cliente: 'hola', agente: 'buenas!' }] }), true);
  assert.strictEqual(tieneEstructura({ p_ejemplos: [{ cliente: 'hola' }] }), false, 'ejemplo incompleto no cuenta');
  assert.strictEqual(tieneEstructura(null), false);
});

test('el prompt ensamblado lleva cada sección con su encabezado', () => {
  const out = instruccionesEfectivas({
    cargo: 'Asistente de ventas',
    objetivo: 'vender',
    p_contexto: 'Vendemos poleras de algodón.',
    p_limites: 'Nunca prometer envío gratis.',
    p_objeciones: 'Si dicen caro, mostrar el pack.',
    p_escalacion: 'Reclamos van al dueño.',
    instructions: 'Habla chileno.',
    p_ejemplos: [{ cliente: '¿Tienen tallas?', agente: 'Sí, de la XS a la XXL 🙌' }],
  });
  assert.match(out, /Tu rol: Asistente de ventas\./);
  assert.match(out, /CERRAR LA VENTA/);
  assert.match(out, /SOBRE EL NEGOCIO\nVendemos poleras/);
  assert.match(out, /LÍMITES — LO QUE NUNCA HACES\nNunca prometer/);
  assert.match(out, /CÓMO RESPONDES A OBJECIONES\nSi dicen caro/);
  assert.match(out, /CUÁNDO DERIVAR A UN HUMANO\nReclamos/);
  assert.match(out, /INSTRUCCIONES ADICIONALES\nHabla chileno\./);
  assert.match(out, /Ejemplo 1:\nCliente: ¿Tienen tallas\?\nTú: Sí, de la XS/);
});

test('el orden es el diseñado: límites antes que objeciones, ejemplos al final', () => {
  const out = instruccionesEfectivas({
    p_limites: 'L', p_objeciones: 'O', p_contexto: 'C', p_escalacion: 'E',
    instructions: 'X', p_ejemplos: [{ cliente: 'a', agente: 'b' }],
  });
  const pos = (t) => out.indexOf(t);
  assert.ok(pos('SOBRE EL NEGOCIO') < pos('LÍMITES'), 'contexto → límites');
  assert.ok(pos('LÍMITES') < pos('OBJECIONES'), 'los límites definen la cancha primero');
  assert.ok(pos('OBJECIONES') < pos('DERIVAR'), 'objeciones → escalación');
  assert.ok(pos('ADICIONALES') < pos('ASÍ RESPONDES TÚ'), 'los ejemplos son lo último que el modelo lee');
});

test('el texto libre viejo SOBREVIVE dentro del prompt estructurado', () => {
  // El promptImprover anexa mejoras a `instructions`. Si el ensamblador lo
  // dejara fuera, activar el constructor borraría meses de mejoras aprobadas.
  const out = instruccionesEfectivas({
    p_contexto: 'Vendemos autos.',
    instructions: 'MEJORAS APROBADAS\n- No usar emojis en la primera respuesta.',
  });
  assert.match(out, /MEJORAS APROBADAS\n- No usar emojis/);
});

test('sanearEjemplos: descarta incompletos, corta a 5, recorta a 500', () => {
  const cinco = Array.from({ length: 8 }, (_, i) => ({ cliente: `c${i}`, agente: `a${i}` }));
  assert.strictEqual(sanearEjemplos(cinco).length, 5);
  assert.deepStrictEqual(sanearEjemplos([
    { cliente: 'hola', agente: '' },
    { cliente: '', agente: 'chao' },
    { cliente: '  ', agente: 'x' },
    null,
    { cliente: 'ok', agente: 'ya' },
  ]), [{ cliente: 'ok', agente: 'ya' }]);
  assert.strictEqual(sanearEjemplos('no-array').length, 0);
  const largo = sanearEjemplos([{ cliente: 'x'.repeat(900), agente: 'y' }])[0];
  assert.strictEqual(largo.cliente.length, 500, 'un ejemplo kilométrico se recorta');
});

test('los seis objetivos existen y uno inválido no mete texto raro', () => {
  for (const k of ['calificar', 'agendar', 'vender', 'informar', 'soporte', 'recolectar']) {
    assert.ok(esObjetivoValido(k), `falta el objetivo ${k}`);
    assert.ok(OBJETIVOS[k].prompt.length > 40, `${k} necesita un prompt real`);
    assert.ok(OBJETIVOS[k].label, `${k} necesita label para el panel`);
  }
  assert.strictEqual(esObjetivoValido('__proto__'), false, 'no se cuela por el prototipo');
  assert.strictEqual(esObjetivoValido(''), false);
  const out = instruccionesEfectivas({ objetivo: 'inventado', p_contexto: 'X' });
  assert.ok(!out.includes('inventado'), 'un objetivo inválido simplemente se omite');
});

test('campos con solo espacios no generan secciones vacías', () => {
  const out = instruccionesEfectivas({ p_contexto: 'Real.', p_limites: '   ', p_objeciones: '\n\n' });
  assert.ok(!out.includes('LÍMITES'), 'espacios no son contenido');
  assert.ok(!out.includes('OBJECIONES'));
  assert.match(out, /SOBRE EL NEGOCIO\nReal\./);
});
