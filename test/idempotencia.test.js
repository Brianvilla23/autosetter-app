/**
 * Atinov — Idempotencia de mensajes entrantes (pentest 06-09-2026)
 *
 * Meta reintenta la entrega de un evento cuando no recibe 200 a tiempo. Sin
 * un candado por id de mensaje (mid en Instagram/Messenger, wamid en
 * WhatsApp) el mismo DM se respondía dos veces y se pagaban dos llamadas a
 * OpenAI — reproducido por el pentest reenviando el mismo mid tres veces.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-idem-test-')
);
delete process.env.OPENAI_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const { mensajeYaProcesado } = require('../routes/webhook');

test('mensajeYaProcesado: false sin id o sin registro; true cuando el mid ya se guardó con el mensaje', async () => {
  assert.strictEqual(await mensajeYaProcesado(null), false);
  assert.strictEqual(await mensajeYaProcesado(''), false);
  const mid = 'm_' + crypto.randomUUID();
  assert.strictEqual(await mensajeYaProcesado(mid), false, 'primera vez: se procesa');
  await db.insert(db.messages, { lead_id: 'lead-x', role: 'user', content: 'hola', mid });
  assert.strictEqual(await mensajeYaProcesado(mid), true, 'reintento de Meta: se descarta');
  assert.strictEqual(await mensajeYaProcesado(mid + '-otro'), false, 'otro id no se confunde');
});
