/**
 * Atinov — Cliente Supabase + embeddings (capa RAG)
 *
 * ACTIVACIÓN CONDICIONAL: si SUPABASE_URL / SUPABASE_SERVICE_KEY no están
 * configurados, el RAG queda DESACTIVADO y `isEnabled()` devuelve false. El
 * resto del sistema sigue funcionando idéntico (igual que WhatsApp/Polar
 * dormantes). Cero riesgo para producción mientras no se configure.
 *
 * Embeddings: OpenAI text-embedding-3-small (1536 dims) — decisión cerrada.
 */

const OpenAI = require('openai');

let _client = null;
let _initTried = false;

/** ¿Está configurado el RAG? */
function isEnabled() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/** Devuelve el cliente Supabase (lazy). null si no está configurado. */
function getClient() {
  if (!isEnabled()) return null;
  if (_client) return _client;
  if (_initTried) return _client;
  _initTried = true;
  try {
    const { createClient } = require('@supabase/supabase-js');
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    return _client;
  } catch (e) {
    console.error('[rag] No se pudo inicializar Supabase:', e.message);
    return null;
  }
}

/**
 * Genera un embedding con OpenAI. Devuelve array de 1536 floats, o null si falla.
 * @param {string} text
 * @param {string} [apiKey]
 */
async function embed(text, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key || !text || !String(text).trim()) return null;
  try {
    const client = new OpenAI({ apiKey: key });
    const res = await client.embeddings.create({
      model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
      input: String(text).slice(0, 8000), // límite defensivo de tokens
    });
    return res.data[0].embedding;
  } catch (e) {
    console.error('[rag] embed error:', e.message);
    return null;
  }
}

/**
 * Embeddings en batch (más barato que 1 por llamada). Devuelve array de arrays.
 */
async function embedBatch(texts, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  const clean = (texts || []).map(t => String(t || '').slice(0, 8000)).filter(Boolean);
  if (!key || !clean.length) return [];
  try {
    const client = new OpenAI({ apiKey: key });
    const res = await client.embeddings.create({
      model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
      input: clean,
    });
    return res.data.map(d => d.embedding);
  } catch (e) {
    console.error('[rag] embedBatch error:', e.message);
    return [];
  }
}

module.exports = { isEnabled, getClient, embed, embedBatch };
