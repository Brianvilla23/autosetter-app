/**
 * Atinov — Notas de voz (WhatsApp Cloud API)
 *
 * Entrada:  nota de voz del lead → descarga de media → Whisper → texto
 *           (la transcripción entra a runConversation como si fuera texto)
 * Salida:   respuesta del agente → TTS OpenAI → ffmpeg (OGG/OPUS mono) →
 *           upload a Meta → envío como mensaje de audio
 *
 * La conversión a voz ocurre AL MOMENTO DEL ENVÍO (worker de pendingSends),
 * no al encolar: la cola persistente sigue guardando texto como fuente de
 * verdad, y cualquier fallo del pipeline de voz degrada a texto sin perder
 * el mensaje.
 *
 * Requisito de Meta para que el audio se renderice como NOTA DE VOZ (ícono
 * de micrófono, no archivo adjunto): OGG contenedor + codec OPUS + mono.
 * Por eso el TTS se pide en mp3 y se transcodifica con ffmpeg — es el único
 * camino determinista. Funciona en Cloud API directa (nuestro caso), no vía
 * BSPs tipo Twilio.
 */

const axios = require('axios');
const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const db   = require('../db/database');

const WA_BASE     = 'https://graph.facebook.com/v21.0';
const OPENAI_BASE = 'https://api.openai.com/v1';

// Sobre este largo la nota de voz se hace eterna (~60s) y el mensaje sale
// como texto normal. El worker aplica este guard, no el webhook.
const MAX_VOICE_REPLY_CHARS = 550;

// ─────────────────────────────────────────────────────────────────────────────
// ENTRADA: descargar media de WhatsApp y transcribir
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descarga un media de la Cloud API en dos pasos: GET /{media-id} devuelve
 * una URL temporal (~5 min de validez) que requiere el mismo Bearer token.
 */
async function downloadWhatsAppMedia({ mediaId, accessToken }) {
  const meta = await axios.get(`${WA_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  const url = meta.data?.url;
  if (!url) throw new Error('media sin url de descarga');

  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
    maxContentLength: 16 * 1024 * 1024, // WhatsApp capea audio a 16MB
    timeout: 30000,
  });
  // mimeType null si Meta no lo informa — cada call site aplica su default
  // (audio/ogg para notas de voz, image/jpeg para fotos).
  return {
    buffer:   Buffer.from(bin.data),
    mimeType: meta.data.mime_type || null,
  };
}

/**
 * Transcribe un audio con Whisper. Las notas de voz de WhatsApp llegan como
 * OGG/OPUS, que Whisper acepta directo — sin transcodificar en la entrada.
 */
async function transcribeAudio({ buffer, filename = 'nota.ogg', apiKey }) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  fd.append('model', 'whisper-1');
  fd.append('language', 'es');

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`whisper ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return String(data.text || '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SALIDA: TTS → OGG/OPUS → upload → send
// ─────────────────────────────────────────────────────────────────────────────

// Voces disponibles en la API de OpenAI. Están optimizadas para inglés, así
// que en español la diferencia entre ellas importa mucho: las brillantes
// ('nova', 'shimmer') suenan a locutor gringo leyendo. 'sage' y 'coral' son
// las más cálidas y conversacionales. Configurable por agente (agent.voice)
// y probable en caliente con POST /api/admin/probar-voces.
const VOCES_DISPONIBLES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const VOZ_POR_DEFECTO = 'sage';

// El parámetro `instructions` de gpt-4o-mini-tts es la palanca más fuerte
// contra el "suena a robot": dirige acento, ritmo y actitud. Vale más que
// cambiar de voz.
const INSTRUCCIONES_VOZ = [
  'Acento: español latinoamericano neutro-chileno. Tuteo siempre (tú, tienes, puedes). NUNCA voseo argentino ni acento español de España.',
  'Actitud: una persona real grabando una nota de voz rápida a un cliente entre dos cosas que está haciendo. Cercana y segura, nunca locutor de radio ni call center.',
  'Ritmo: conversacional y algo apurado, con micro-pausas naturales donde caería el aire al hablar. No pronuncies cada palabra con la misma fuerza: apura lo obvio y apóyate en lo importante.',
  'Tono: cálido, con una sonrisa leve en la voz. Baja el final de las frases como en el habla normal, no lo subas como si leyeras.',
  'Prohibido: sonar perfecto, monótono o leído.',
].join(' ');

/**
 * Genera el audio de la respuesta. gpt-4o-mini-tts acepta `instructions`
 * (tono/acento); si la cuenta no tiene acceso a ese modelo, cae a tts-1.
 */
async function synthesizeVoice({ text, apiKey, voice = VOZ_POR_DEFECTO }) {
  const vozFinal = VOCES_DISPONIBLES.includes(voice) ? voice : VOZ_POR_DEFECTO;
  async function call(model, withInstructions) {
    const body = { model, voice: vozFinal, input: text, response_format: 'mp3' };
    if (withInstructions) {
      body.instructions = INSTRUCCIONES_VOZ;
    }
    const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const err = new Error(`tts ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  }

  try {
    return await call('gpt-4o-mini-tts', true);
  } catch (e) {
    // Modelo no disponible para esta key → fallback al TTS clásico
    if (e.status === 400 || e.status === 403 || e.status === 404) {
      return await call('tts-1', false);
    }
    throw e;
  }
}

/**
 * Transcodifica cualquier audio de entrada a OGG/OPUS mono 48kHz — el formato
 * exacto que WhatsApp renderiza como nota de voz.
 */
function toVoiceNoteOgg(inputBuffer) {
  return new Promise((resolve, reject) => {
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atinov-voz-'));
    } catch (e) { return reject(e); }
    const inPath  = path.join(tmp, 'in.audio');
    const outPath = path.join(tmp, 'out.ogg');

    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ } };

    try {
      fs.writeFileSync(inPath, inputBuffer);
    } catch (e) { cleanup(); return reject(e); }

    execFile(
      ffmpegPath,
      ['-y', '-i', inPath, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-application', 'voip', outPath],
      { timeout: 30000 },
      (err) => {
        try {
          if (err) return reject(new Error(`ffmpeg: ${err.message}`));
          resolve(fs.readFileSync(outPath));
        } catch (e) {
          reject(e);
        } finally {
          cleanup();
        }
      }
    );
  });
}

/** Sube el OGG a Meta y devuelve el media id listo para enviar. */
async function uploadWhatsAppAudio({ phoneNumberId, oggBuffer, accessToken }) {
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'audio/ogg');
  fd.append('file', new Blob([oggBuffer], { type: 'audio/ogg' }), 'nota.ogg');

  const res = await fetch(`${WA_BASE}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: fd,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`upload media ${res.status}: ${detail}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error('upload media sin id en la respuesta');
  return data.id;
}

/**
 * Envía un mensaje de audio referenciando un media id ya subido.
 *
 * `voice: true` es lo que hace que WhatsApp lo renderice como NOTA DE VOZ
 * (ícono de micrófono + duración + descarga automática + transcripción del
 * lado del receptor) en vez de como archivo adjunto ("🎵 Audio"). Sin ese
 * flag, aunque el archivo sea OGG/OPUS mono correcto, llega como adjunto.
 * Doc: developers.facebook.com → WhatsApp → Messages → Audio messages.
 *
 * Es una feature marcada como beta por algunos BSPs: si la cuenta no la
 * tiene habilitada y Meta rechaza el payload, reintentamos sin el flag para
 * que el audio igual llegue (degradado a adjunto, pero no perdido).
 */
async function sendWhatsAppAudioMessage({ phoneNumberId, recipient, mediaId, accessToken }) {
  const url = `${WA_BASE}/${phoneNumberId}/messages`;
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'audio',
  };
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  try {
    await axios.post(url, { ...base, audio: { id: mediaId, voice: true } }, { headers, timeout: 15000 });
  } catch (err) {
    const code = err.response?.data?.error?.code;
    // 100 = parámetro inválido/no soportado para esta cuenta o versión
    if (code !== 100) throw err;
    console.warn('[voz] "voice:true" rechazado por Meta — reintentando como audio simple');
    await axios.post(url, { ...base, audio: { id: mediaId } }, { headers, timeout: 15000 });
  }
}

/**
 * Camino completo de salida, usado por el worker de pendingSends cuando el
 * item viene marcado replyAsVoice. Devuelve true si la nota de voz salió;
 * false en cualquier otro caso (el worker cae a texto — nunca se pierde el
 * mensaje por un fallo de voz).
 */
async function trySendVoiceReply(item) {
  try {
    if (!item?.text || item.text.length > MAX_VOICE_REPLY_CHARS) return false;
    // Un link no se puede "hablar" — ese mensaje sale como texto normal.
    if (/https?:\/\//i.test(item.text)) return false;
    if (!item.phoneNumberId || !item.recipientId || !item.accessToken) return false;

    const settings = item.accountId
      ? await db.findOne(db.settings, { account_id: item.accountId })
      : null;
    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) return false;

    const speech  = await synthesizeVoice({ text: item.text, apiKey, voice: item.voice });
    const ogg     = await toVoiceNoteOgg(speech);
    const mediaId = await uploadWhatsAppAudio({
      phoneNumberId: item.phoneNumberId,
      oggBuffer: ogg,
      accessToken: item.accessToken,
    });
    await sendWhatsAppAudioMessage({
      phoneNumberId: item.phoneNumberId,
      recipient: item.recipientId,
      mediaId,
      accessToken: item.accessToken,
    });
    console.log(`🎤 Nota de voz enviada a @${item.leadUsername || item.recipientId} (${item.text.length} chars)`);
    return true;
  } catch (e) {
    console.warn('[voz] fallo al enviar nota de voz, fallback a texto:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

module.exports = {
  downloadWhatsAppMedia,
  transcribeAudio,
  synthesizeVoice,
  toVoiceNoteOgg,
  uploadWhatsAppAudio,
  sendWhatsAppAudioMessage,
  trySendVoiceReply,
  MAX_VOICE_REPLY_CHARS,
  VOCES_DISPONIBLES,
  VOZ_POR_DEFECTO,
};
