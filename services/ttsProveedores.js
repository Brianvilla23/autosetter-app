/**
 * Atinov — Síntesis de voz con varios proveedores (piloto de escucha)
 *
 * Brayan quiere comparar cómo suena la misma frase con OpenAI, ElevenLabs y
 * Fish Audio S2.1 Pro ANTES de decidir si cambia el motor de las llamadas
 * (2026-09-12). El botón "Enviarme las voces" del admin ya sintetiza, sube y
 * manda notas de voz por WhatsApp con entrega verificada: acá solo se le
 * cambia el motor.
 *
 * Solo TTS (texto → audio). Para una CONVERSACIÓN con otro motor hace falta
 * un pipeline STT→LLM→TTS o la plataforma de agentes del proveedor; eso no
 * vive acá. Las claves van en Railway: ELEVENLABS_API_KEY, FISH_AUDIO_API_KEY.
 *
 * `fetchFn` se inyecta para poder testear sin red.
 */

const PROVEEDORES = ['openai', 'elevenlabs', 'fish'];

const VARIABLE = {
  openai:     'OPENAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  fish:       'FISH_AUDIO_API_KEY',
};

function configurado(proveedor) {
  if (proveedor === 'openai') return true;       // la key de OpenAI se resuelve aparte (cuenta o entorno)
  return !!process.env[VARIABLE[proveedor]];
}

async function leerError(r, etiqueta) {
  const detalle = (await r.text().catch(() => '')).slice(0, 200);
  const e = new Error(`${etiqueta} ${r.status}: ${detalle}`);
  e.status = r.status;
  return e;
}

/**
 * Devuelve un Buffer MP3 con la frase dicha por `voz` en el `proveedor`.
 *  - openai:     voz = nombre (marin, cedar, sage…)
 *  - elevenlabs: voz = voice_id de su biblioteca
 *  - fish:       voz = reference_id de fish.audio (opcional: sin él usa la voz por defecto del modelo)
 */
async function sintetizar({ proveedor = 'openai', texto, voz, apiKey, fetchFn = fetch } = {}) {
  if (!PROVEEDORES.includes(proveedor)) throw new Error(`proveedor desconocido: ${proveedor}`);
  if (!texto) throw new Error('texto requerido');

  if (proveedor === 'openai') {
    return require('./audio').synthesizeVoice({ text: texto, apiKey, voice: voz });
  }

  if (proveedor === 'elevenlabs') {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('Falta ELEVENLABS_API_KEY en Railway');
    if (!voz) throw new Error('ElevenLabs necesita el voice_id de la voz (Voices → copiar ID)');
    const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voz)}?output_format=mp3_44100_128`;
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: texto, model_id: model }),
    });
    if (!r.ok) throw await leerError(r, 'elevenlabs');
    return Buffer.from(await r.arrayBuffer());
  }

  // fish
  const key = process.env.FISH_AUDIO_API_KEY;
  if (!key) throw new Error('Falta FISH_AUDIO_API_KEY en Railway');
  const model = process.env.FISH_AUDIO_MODEL || 's2.1-pro';
  const body = { text: texto, format: 'mp3', latency: 'normal', normalize: true };
  if (voz) body.reference_id = voz;
  const r = await fetchFn('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await leerError(r, 'fish');
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { PROVEEDORES, VARIABLE, configurado, sintetizar };
