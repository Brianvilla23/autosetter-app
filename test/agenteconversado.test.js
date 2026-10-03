/**
 * Atinov — Configurar el agente conversando
 *
 * El dueño cuenta su negocio y pide cambios en lenguaje natural; el
 * asistente los traduce a los campos del formulario. Lo que se fija acá: que
 * solo entren campos conocidos y acotados, que el agente nunca quede sin
 * nombre, que se pueda deshacer y que la respuesta del modelo se lea bien.
 */

// OpenAI falso: se instala antes de cargar el módulo.
const respuestasFalsas = [];
const OpenAIFalso = class { constructor() { this.chat = { completions: { create: async (args) => {
  OpenAIFalso.ultimo = args;
  return { choices: [{ message: { content: respuestasFalsas.shift() || '{}' } }] };
} } }; } };
require.cache[require.resolve('openai')] = { exports: OpenAIFalso, loaded: true, id: require.resolve('openai') };

const { test } = require('node:test');
const assert = require('node:assert');
const ac = require('../services/agenteConversado');

const AGENTE = {
  name: 'Ventas', cargo: '', objetivo: '', p_contexto: '', p_limites: 'Nunca des descuentos',
  p_objeciones: '', p_escalacion: '', instructions: '', p_ejemplos: [],
};

test('solo entran campos conocidos, acotados y que de verdad cambian', () => {
  const { upd, campos } = ac.sanearCambios({
    p_contexto: '  Vendes ropa de mujer por Instagram, despacho a todo Chile.  ',
    p_limites: 'Nunca des descuentos',            // igual que antes: no cuenta
    objetivo: 'vender',
    plan: 'escala',                                // campo desconocido: fuera
    account_id: 'otra-cuenta',                     // jamás
    name: '',                                      // el agente no se queda sin nombre
    p_ejemplos: [{ cliente: 'hola precio?', agente: 'hola, la polera sale 12 lucas' }, { cliente: '', agente: 'x' }],
  }, AGENTE);
  assert.deepStrictEqual(Object.keys(upd).sort(), ['objetivo', 'p_contexto', 'p_ejemplos']);
  assert.strictEqual(upd.p_contexto, 'Vendes ropa de mujer por Instagram, despacho a todo Chile.');
  assert.strictEqual(upd.p_ejemplos.length, 1, 'el ejemplo incompleto se descarta');
  assert.ok(campos.includes('Contexto del negocio') && campos.includes('Ejemplos'));
});

test('un objetivo inventado no se guarda', () => {
  const { upd } = ac.sanearCambios({ objetivo: 'dominar-el-mundo' }, AGENTE);
  assert.strictEqual(upd.objetivo, undefined);
});

test('cada cambio guarda la versión anterior y se puede deshacer de a uno', () => {
  let agente = { ...AGENTE };
  for (let i = 0; i < 12; i++) {
    const versiones = ac.apilarVersion(agente);
    agente = { ...agente, p_contexto: `versión ${i}`, versiones_conversadas: versiones };
  }
  assert.strictEqual(agente.versiones_conversadas.length, ac.MAX_VERSIONES, 'se guardan hasta 10');
  const atras = ac.versionAnterior(agente);
  assert.strictEqual(atras.upd.p_contexto, 'versión 10', 'vuelve al paso anterior');
  assert.strictEqual(atras.upd.versiones_conversadas.length, ac.MAX_VERSIONES - 1);
  assert.strictEqual(ac.versionAnterior({ ...AGENTE }), null, 'sin historial no hay deshacer');
});

test('conversar le pasa la configuración actual al modelo y lee su JSON', async () => {
  respuestasFalsas.push(JSON.stringify({
    respuesta: 'Listo, ya sabe que despachas a todo Chile. ¿Cuánto demora el envío?',
    cambios: { p_contexto: 'Vendes ropa de mujer. Despachas a todo Chile.' },
    listo: false,
  }));
  const r = await ac.conversar({
    agent: AGENTE, apiKey: 'sk-falsa',
    mensajes: [{ rol: 'asistente', texto: 'Cuéntame de tu negocio' }, { rol: 'dueno', texto: 'vendo ropa de mujer y despacho a todo chile' }],
  });
  assert.match(r.respuesta, /despachas a todo Chile/);
  assert.strictEqual(r.cambios.p_contexto, 'Vendes ropa de mujer. Despachas a todo Chile.');
  assert.strictEqual(r.listo, false);
  const sistema = OpenAIFalso.ultimo.messages[0].content;
  assert.match(sistema, /Nunca des descuentos/, 'el modelo ve cómo está configurado hoy');
  assert.deepStrictEqual(OpenAIFalso.ultimo.response_format, { type: 'json_object' });
  assert.strictEqual(OpenAIFalso.ultimo.messages.at(-1).role, 'user');
});

test('si el modelo responde algo que no es JSON, no revienta', async () => {
  respuestasFalsas.push('esto no es json');
  const r = await ac.conversar({ agent: AGENTE, apiKey: 'sk', mensajes: [{ rol: 'dueno', texto: 'hola' }] });
  assert.ok(r.respuesta.length > 0);
  assert.deepStrictEqual(r.cambios, {});
});

test('sin mensaje del dueño o sin clave, no llama al modelo', async () => {
  await assert.rejects(ac.conversar({ agent: AGENTE, apiKey: 'sk', mensajes: [{ rol: 'asistente', texto: 'hola' }] }));
  await assert.rejects(ac.conversar({ agent: AGENTE, apiKey: '', mensajes: [{ rol: 'dueno', texto: 'hola' }] }));
});
