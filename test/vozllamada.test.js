/**
 * Atinov — Una llamada tiene que sonar a llamada
 *
 * Primera llamada real con Twilio, 2026-09-10. La transcripción mostró tres
 * fallas que no eran de audio sino de lo que le decíamos al agente:
 *   1. Abrió con "Hola, soy Brayan, te escribí por el chat que te llamaba":
 *      no dijo de qué negocio llamaba y el chat nunca existió (las reglas del
 *      closer asumían uno).
 *   2. Pidió "di cualquier frase cortita para confirmar que tu audio entra
 *      limpio": el tema de la prueba era una prueba técnica, no una llamada.
 *   3. Transcribió a una persona que hablaba español como "Thank you.",
 *      "Bye-bye." y una frase en italiano (whisper-1 sin idioma).
 * Además, la configuración de audio va a OpenAI tal cual: un valor fuera de su
 * enum hace que rechace la sesión y la llamada muera antes del "aló". Por eso
 * se fija acá contra los valores del SDK oficial.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const voz = require('../services/voiceCommon');

const agente = {
  name: 'Atinov Ventas', cargo: 'asistente de Brayan en Atinov',
  objetivo: 'vender', p_contexto: 'Atinov es un asistente con IA para el inbox de un negocio.',
};
const leadPrueba = { name: 'Prueba de llamada', channel: 'test', es_prueba: true };
const mensajesPrueba = [{ role: 'user', content: 'Llamada de prueba de la plataforma pedida por el dueño desde el panel admin.' }];
const unir = (bloques) => bloques.filter(Boolean).join('\n');

// ── Demostración vs llamada a un lead real ──────────────────────────────────

test('demo: no inventa un chat previo ni usa las reglas del closer', () => {
  const txt = unir(voz.construirBloquesLead({
    agent: agente, kbTexto: '', lead: leadPrueba, messages: mensajesPrueba, demo: true,
  }));
  assert.ok(txt.includes('LLAMADA DE DEMOSTRACIÓN'));
  assert.ok(txt.includes('NO hubo ningún chat antes'));
  assert.ok(!txt.includes('ESTA CONVERSACIÓN YA EMPEZÓ'), 'las reglas del closer asumen un chat');
  assert.ok(!txt.includes('Prueba de llamada'), 'el nombre del lead sintético no llega al agente');
  assert.ok(!txt.includes('LO QUE YA CONVERSARON'), 'sin historial: no hubo chat');
  assert.ok(txt.includes('asistente de Brayan en Atinov'), 'la identidad del agente sí llega');
});

test('lead real: siguen las reglas del closer, su nombre y el historial', () => {
  const txt = unir(voz.construirBloquesLead({
    agent: agente, kbTexto: '', lead: { name: 'Camila', channel: 'whatsapp' },
    messages: [{ role: 'user', content: 'me interesa, ¿me llamas?' }],
  }));
  assert.ok(txt.includes('ESTA CONVERSACIÓN YA EMPEZÓ'));
  assert.ok(txt.includes('Se llama Camila'));
  assert.ok(txt.includes('LO QUE YA CONVERSARON'));
  assert.ok(!txt.includes('LLAMADA DE DEMOSTRACIÓN'));
});

// ── Lo que dice al contestar y cuánto habla ─────────────────────────────────

test('al contestar se presenta: quién es, de qué negocio y para qué', () => {
  for (const reglas of [voz.REGLAS_LLAMADA_SALIENTE, voz.REGLAS_DEMO_LLAMADA]) {
    assert.match(reglas, /quién eres, de qué negocio llamas y para qué/);
  }
  assert.ok(!voz.REGLAS_LLAMADA_SALIENTE.includes('te dije por el chat que te llamaba'),
    'la apertura vieja no decía de dónde llamaba');
});

test('demo: nada de pruebas técnicas de audio', () => {
  assert.match(voz.REGLAS_DEMO_LLAMADA, /No hagas pruebas técnicas de audio/);
});

test('turnos cortos: la regla de voz pone un techo concreto', () => {
  assert.match(voz.REGLAS_VOZ, /máximo 2 frases y unas 25 palabras por turno/);
});

// ── Audio del teléfono contra el enum oficial de OpenAI ─────────────────────
// Valores copiados de openai-node (src/resources/realtime/realtime.ts),
// verificados el 2026-09-10.
const ENUM = {
  ruido: ['near_field', 'far_field'],
  eagerness: ['low', 'medium', 'high', 'auto'],
  transcripcion: ['whisper-1', 'gpt-transcribe', 'gpt-live-transcribe', 'gpt-4o-mini-transcribe',
    'gpt-4o-mini-transcribe-2025-12-15', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'gpt-realtime-whisper'],
  voces: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
};

test('audio del teléfono: ningún valor fuera del enum de OpenAI', () => {
  const a = voz.configAudioTelefono('marin');
  assert.strictEqual(a.input.format.type, 'audio/pcmu', 'μ-law: el formato nativo del teléfono');
  assert.strictEqual(a.output.format.type, 'audio/pcmu');
  assert.strictEqual(a.input.turn_detection.type, 'semantic_vad');
  assert.ok(ENUM.eagerness.includes(a.input.turn_detection.eagerness));
  assert.ok(ENUM.ruido.includes(a.input.noise_reduction.type));
  assert.ok(ENUM.transcripcion.includes(a.input.transcription.model),
    'modelo de transcripción inválido: ' + a.input.transcription.model);
  assert.ok(ENUM.voces.includes(a.output.voice));
});

test('la transcripción es en español en las tres vías', () => {
  assert.strictEqual(voz.TRANSCRIPCION.language, 'es');
  assert.notStrictEqual(voz.TRANSCRIPCION.model, 'whisper-1',
    'whisper-1 fue el que transcribió "Thank you" a quien hablaba español');
});
