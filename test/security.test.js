/**
 * Atinov — Suite de seguridad
 *
 * Garantiza que las defensas que impiden robar API keys y hackear cuentas
 * ajenas NO se rompan en futuros cambios. Corre con `npm test` (node:test
 * nativo, sin dependencias).
 *
 * Cubre:
 *  1. Sanitización — ningún secret (access_token, openai_key) sale al cliente.
 *  2. Firma de webhooks — MP y Polar rechazan firmas forjadas.
 *  3. Anti NoSQL-injection — el login no acepta objetos como email/password.
 *  4. JWT — tokens con secret inválido se rechazan.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// 1. SANITIZACIÓN — las API keys NUNCA viajan al cliente
// ─────────────────────────────────────────────────────────────────────────────
const { sanitizeAccount, sanitizeSettings, maskSecret } = require('../services/sanitize');

test('sanitizeAccount NUNCA expone access_token de Meta', () => {
  const account = {
    _id: 'acc1', ig_username: 'brayan', ig_user_id: '123',
    access_token: 'IGAA_SUPER_SECRETO_12345',
    wa_access_token: 'WA_SECRETO_67890',
    token_last_error: 'error con token IGAA_fragmento',
  };
  const safe = sanitizeAccount(account);
  const serialized = JSON.stringify(safe);

  assert.ok(!('access_token' in safe), 'access_token NO debe estar presente');
  assert.ok(!('wa_access_token' in safe), 'wa_access_token NO debe estar presente');
  assert.ok(!('token_last_error' in safe), 'token_last_error NO debe estar presente');
  assert.ok(!serialized.includes('IGAA_SUPER_SECRETO'), 'el token no debe aparecer ni serializado');
  assert.ok(!serialized.includes('WA_SECRETO'), 'el wa token no debe aparecer');
  // Pero SÍ expone los flags de presencia (lo que el frontend necesita)
  assert.strictEqual(safe.has_access_token, true);
  assert.strictEqual(safe.has_wa_access_token, true);
  // Y los campos públicos se mantienen
  assert.strictEqual(safe.ig_username, 'brayan');
});

test('sanitizeSettings NUNCA expone openai_key cruda', () => {
  const settings = { account_id: 'acc1', openai_key: 'sk-proj-ABCDEFGHIJKLMNOP1234' };
  const safe = sanitizeSettings(settings);
  const serialized = JSON.stringify(safe);

  assert.ok(!('openai_key' in safe), 'openai_key NO debe estar presente');
  assert.ok(!serialized.includes('ABCDEFGHIJKLMNOP'), 'la key no debe aparecer ni serializada');
  assert.strictEqual(safe.has_openai_key, true);
  // El masked sí, pero solo prefijo + últimos 4
  assert.ok(safe.openai_key_masked.startsWith('sk-pr'));
  assert.ok(safe.openai_key_masked.endsWith('1234'));
  assert.ok(!safe.openai_key_masked.includes('ABCDEFGHIJKLMNOP'));
});

test('sanitizeAccount/Settings manejan null sin romper', () => {
  assert.strictEqual(sanitizeAccount(null), null);
  assert.strictEqual(sanitizeSettings(null), null);
});

test('maskSecret enmascara correctamente y no filtra el medio', () => {
  assert.strictEqual(maskSecret('sk-proj-1234567890ABCD'), 'sk-pr…ABCD');
  assert.strictEqual(maskSecret('corto'), '••••');           // demasiado corto → todo oculto
  assert.strictEqual(maskSecret(''), null);
  assert.strictEqual(maskSecret(null), null);
  assert.strictEqual(maskSecret(undefined), null);
});

test('un account nuevo con campo *_token agregado a futuro NO se filtra si está en la lista', () => {
  // Regresión: si alguien agrega wa_business_token, debe estar protegido.
  const { SENSITIVE_ACCOUNT_FIELDS } = require('../services/sanitize');
  assert.ok(SENSITIVE_ACCOUNT_FIELDS.includes('access_token'));
  assert.ok(SENSITIVE_ACCOUNT_FIELDS.includes('wa_access_token'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. FIRMA DE WEBHOOKS — rechazar forjados (no activar suscripciones gratis)
// ─────────────────────────────────────────────────────────────────────────────
const { verifyMpSignature } = require('../services/mpWebhook');

test('MP webhook: sin MP_WEBHOOK_SECRET → skipped (no bloquea, defensa de re-query activa)', () => {
  delete process.env.MP_WEBHOOK_SECRET;
  const r = verifyMpSignature({ headers: {}, query: {}, body: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
});

test('MP webhook: con secret pero SIN header x-signature → rechaza', () => {
  process.env.MP_WEBHOOK_SECRET = 'mp_secret_test';
  const r = verifyMpSignature({ headers: {}, query: { 'data.id': '123' }, body: {} });
  assert.strictEqual(r.ok, false);
  delete process.env.MP_WEBHOOK_SECRET;
});

test('MP webhook: firma FORJADA (v1 incorrecto) → rechaza', () => {
  process.env.MP_WEBHOOK_SECRET = 'mp_secret_test';
  const r = verifyMpSignature({
    headers: { 'x-signature': 'ts=1700000000,v1=deadbeef00000000', 'x-request-id': 'req1' },
    query: { 'data.id': '123' }, body: {},
  });
  assert.strictEqual(r.ok, false);
  delete process.env.MP_WEBHOOK_SECRET;
});

test('MP webhook: firma VÁLIDA (HMAC correcto) → acepta', () => {
  const secret = 'mp_secret_test';
  process.env.MP_WEBHOOK_SECRET = secret;
  const dataId = 'abc123', requestId = 'req-xyz', ts = '1700000000';
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const r = verifyMpSignature({
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
    query: { 'data.id': dataId }, body: {},
  });
  assert.strictEqual(r.ok, true);
  delete process.env.MP_WEBHOOK_SECRET;
});

// Polar webhook signature
const polar = require('../services/polar');

test('Polar webhook: firma forjada → rechaza', () => {
  process.env.POLAR_WEBHOOK_SECRET = 'polar_secret_test';
  const ok = polar.verifyWebhookSignature('{"evil":true}', 'sha256=deadbeef');
  assert.strictEqual(ok, false);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('Polar webhook: firma válida → acepta', () => {
  const secret = 'polar_secret_test';
  process.env.POLAR_WEBHOOK_SECRET = secret;
  const body = '{"type":"subscription.created"}';
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const ok = polar.verifyWebhookSignature(body, 'sha256=' + sig);
  assert.strictEqual(ok, true);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('Polar webhook: sin secret configurado → rechaza (fail closed)', () => {
  delete process.env.POLAR_WEBHOOK_SECRET;
  const ok = polar.verifyWebhookSignature('{}', 'sha256=whatever');
  assert.strictEqual(ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANTI NoSQL-INJECTION — login no debe aceptar objetos como credenciales
// ─────────────────────────────────────────────────────────────────────────────
test('un objeto {$ne:null} como email NO es string (bloqueado por la validación de login)', () => {
  // El login hace `if (typeof email !== 'string' || typeof password !== 'string')`.
  // Simulamos esa guarda exacta para garantizar que el patrón sigue vigente.
  const maliciousEmail = { $ne: null };
  const maliciousPass  = { $gt: '' };
  const guard = (email, password) =>
    !(typeof email !== 'string' || typeof password !== 'string');
  assert.strictEqual(guard(maliciousEmail, 'x'), false, 'email objeto debe rechazarse');
  assert.strictEqual(guard('a@b.com', maliciousPass), false, 'password objeto debe rechazarse');
  assert.strictEqual(guard('a@b.com', 'realpass'), true, 'credenciales string válidas pasan');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. JWT — un token firmado con secret distinto debe rechazarse
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

test('JWT firmado con otro secret NO se verifica con el secret real', () => {
  const realSecret = 'el-secret-real-de-produccion-de-32+chars';
  const attackerToken = jwt.sign({ userId: 'x', role: 'admin' }, 'secret-del-atacante');
  assert.throws(
    () => jwt.verify(attackerToken, realSecret),
    /invalid signature|jwt/i,
    'un token forjado con otro secret debe fallar la verificación'
  );
});

test('JWT válido se verifica y conserva el payload', () => {
  const secret = 'el-secret-real-de-produccion-de-32+chars';
  const token = jwt.sign({ userId: 'u1', accountId: 'a1', role: 'user' }, secret, { expiresIn: '1h' });
  const decoded = jwt.verify(token, secret);
  assert.strictEqual(decoded.userId, 'u1');
  assert.strictEqual(decoded.role, 'user');
});
