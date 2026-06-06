/**
 * Atinov — Tests del RAG (Tarea 2)
 *
 * Garantiza el FAIL-SAFE: sin credenciales Supabase, el RAG está desactivado
 * y NO rompe el flujo (el agente responde como hoy). Esta es la garantía de
 * "no romper producción" mientras el RAG no esté configurado.
 */

const { test } = require('node:test');
const assert = require('node:assert');

test('RAG desactivado sin SUPABASE_URL → isEnabled false, getClient null', () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  // require fresco (el módulo cachea, pero isEnabled lee env en vivo)
  const s = require('../services/rag/supabase');
  assert.strictEqual(s.isEnabled(), false);
  assert.strictEqual(s.getClient(), null);
});

test('retrieveContext devuelve null si el RAG no está configurado (no rompe)', async () => {
  delete process.env.SUPABASE_URL;
  const { retrieveContext } = require('../services/rag/retrieve');
  const r = await retrieveContext({ accountId: 'acc1', message: 'cuánto sale?' });
  assert.strictEqual(r, null);
});

test('isEnabled true solo con AMBAS env vars', () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  delete process.env.SUPABASE_SERVICE_KEY;
  const s = require('../services/rag/supabase');
  assert.strictEqual(s.isEnabled(), false, 'falta service key → desactivado');
  process.env.SUPABASE_SERVICE_KEY = 'svc_key';
  assert.strictEqual(s.isEnabled(), true, 'ambas presentes → activado');
  // cleanup
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
});

test('outcomeOf mapea pipeline_stage a outcome RAG', () => {
  const { outcomeOf } = require('../services/rag/ingest');
  assert.strictEqual(outcomeOf({ pipeline_stage: 'ganado' }), 'ganado');
  assert.strictEqual(outcomeOf({ is_converted: true }), 'ganado');
  assert.strictEqual(outcomeOf({ pipeline_stage: 'perdido' }), 'perdido');
  assert.strictEqual(outcomeOf({ pipeline_stage: 'nuevo' }), 'en_curso');
});
