/**
 * Atinov — Síntesis multi-proveedor (piloto de escucha ElevenLabs / Fish)
 *
 * Sin red: se inyecta un fetch falso que anota la petición. Lo que se fija es
 * que cada proveedor reciba la clave en el header correcto, el modelo, la voz
 * y el formato, y que sin clave en el entorno se corte con un mensaje que
 * diga qué variable falta en Railway.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const tts = require('../services/ttsProveedores');

function fetchFalso(bytes = 'mp3') {
  const llamadas = [];
  const fn = async (url, init) => {
    llamadas.push({ url, init });
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(bytes), text: async () => '' };
  };
  return { fn, llamadas };
}

test('elevenlabs: voice_id en la URL, key en xi-api-key, modelo en el body', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-test';
  delete process.env.ELEVENLABS_MODEL;
  const { fn, llamadas } = fetchFalso();
  const buf = await tts.sintetizar({ proveedor: 'elevenlabs', texto: 'hola', voz: 'VOZ123', fetchFn: fn });
  assert.strictEqual(buf.toString(), 'mp3');
  const { url, init } = llamadas[0];
  assert.match(url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/VOZ123\?output_format=mp3_44100_128$/);
  assert.strictEqual(init.headers['xi-api-key'], 'el-test');
  const body = JSON.parse(init.body);
  assert.strictEqual(body.text, 'hola');
  assert.strictEqual(body.model_id, 'eleven_multilingual_v2');
});

test('fish: bearer, header model, reference_id opcional y mp3', async () => {
  process.env.FISH_AUDIO_API_KEY = 'fish-test';
  delete process.env.FISH_AUDIO_MODEL;
  const { fn, llamadas } = fetchFalso();
  await tts.sintetizar({ proveedor: 'fish', texto: 'hola', voz: 'REF9', fetchFn: fn });
  const { url, init } = llamadas[0];
  assert.strictEqual(url, 'https://api.fish.audio/v1/tts');
  assert.strictEqual(init.headers.Authorization, 'Bearer fish-test');
  assert.strictEqual(init.headers.model, 's2.1-pro');
  const body = JSON.parse(init.body);
  assert.strictEqual(body.reference_id, 'REF9');
  assert.strictEqual(body.format, 'mp3');

  await tts.sintetizar({ proveedor: 'fish', texto: 'hola', fetchFn: fn });
  assert.ok(!('reference_id' in JSON.parse(llamadas[1].init.body)), 'sin voz no manda reference_id');
});

test('sin clave en el entorno: corta ANTES de la red y dice que variable falta', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.FISH_AUDIO_API_KEY;
  const { fn, llamadas } = fetchFalso();
  await assert.rejects(() => tts.sintetizar({ proveedor: 'elevenlabs', texto: 'x', voz: 'v', fetchFn: fn }), /ELEVENLABS_API_KEY/);
  await assert.rejects(() => tts.sintetizar({ proveedor: 'fish', texto: 'x', fetchFn: fn }), /FISH_AUDIO_API_KEY/);
  assert.strictEqual(llamadas.length, 0);
  assert.strictEqual(tts.configurado('elevenlabs'), false);
  assert.strictEqual(tts.configurado('openai'), true);
});

test('elevenlabs sin voice_id y proveedor desconocido se rechazan claro', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-test';
  await assert.rejects(() => tts.sintetizar({ proveedor: 'elevenlabs', texto: 'x' }), /voice_id/);
  await assert.rejects(() => tts.sintetizar({ proveedor: 'nube-x', texto: 'x' }), /desconocido/);
});

test('error HTTP del proveedor llega con status y detalle', async () => {
  process.env.FISH_AUDIO_API_KEY = 'fish-test';
  const fn = async () => ({ ok: false, status: 402, text: async () => 'insufficient credits', arrayBuffer: async () => Buffer.alloc(0) });
  await assert.rejects(() => tts.sintetizar({ proveedor: 'fish', texto: 'x', fetchFn: fn }), /fish 402: insufficient credits/);
});
