/**
 * Atinov — Auditoría 12-09: contadores atómicos, fechas en Chile, dedupe,
 * planes reales y barrido de llamadas huérfanas.
 *
 * Lo que se fija: dos requests a la vez ya no pierden incrementos ni pasan
 * un tope; una conversación cuenta 1 aunque lleguen diez mensajes juntos; el
 * cupo diario se reserva antes de gastar y se libera si falla; el mes/día
 * se calculan en hora de Chile; el permiso de llamada no se reprocesa; el
 * mensaje de "sube de plan" nombra un plan que existe; una llamada colgada
 * en 'marcando' se cierra sola.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-concurrencia-test-')
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-test-largo-y-aburrido-1234567890';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const limits = require('../services/limits');
const { identityOf } = require('../services/channels/core');

async function usuarioConCuenta(plan = 'inicial') {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'negocio' });
  const user = await db.insert(db.users, { email: crypto.randomUUID() + '@x.cl', account_id: accountId, role: 'user', membershipPlan: plan, isActive: true });
  return { accountId, user };
}

// ── Fechas en Chile ──────────────────────────────────────────────────────────

test('currentMonth y hoyChile usan la hora de Chile, no la del servidor', () => {
  // 2026-03-01 02:30 UTC = 2026-02-28 23:30 en Chile (verano, UTC-3).
  const f = new Date('2026-03-01T02:30:00Z');
  assert.strictEqual(limits.hoyChile(f), '2026-02-28');
  assert.strictEqual(limits.currentMonth(f), '2026-02');
  assert.match(limits.currentMonth(), /^\d{4}-\d{2}$/);
});

// ── Contadores atómicos ──────────────────────────────────────────────────────

test('incrementDMCount: 25 incrementos simultáneos no pierden ninguno', async () => {
  const { accountId, user } = await usuarioConCuenta();
  await Promise.all(Array.from({ length: 25 }, () => limits.incrementDMCount(accountId, 1)));
  const u = await db.findOne(db.users, { _id: user._id });
  assert.strictEqual(u.monthly_dm_count, 25);
  assert.strictEqual(u.dm_count_month, limits.currentMonth());
});

test('registrarConversacion: 10 mensajes juntos del mismo lead cuentan UNA conversación', async () => {
  const { accountId, user } = await usuarioConCuenta();
  const lead = await db.insert(db.leads, { account_id: accountId, wa_id: '56911111111', channel: 'whatsapp' });
  const r = await Promise.all(Array.from({ length: 10 }, () => limits.registrarConversacion({ accountId, lead })));
  assert.strictEqual(r.filter(x => x.contada).length, 1, 'solo una gana el candado');
  const u = await db.findOne(db.users, { _id: user._id });
  assert.strictEqual(u.monthly_dm_count, 1);
  assert.strictEqual(u.monthly_wa_count, 1, 'WhatsApp lleva su propia cuota');
  const l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.contado_mes, limits.currentMonth());
  assert.strictEqual(l.contado_mes_wa, limits.currentMonth());
});

test('reservarCupoDiario: 30 reservas a la vez con tope 20 → exactamente 20 pasan; liberar devuelve una', async () => {
  const { accountId } = await usuarioConCuenta();
  const r = await Promise.all(Array.from({ length: 30 }, () => limits.reservarCupoDiario({ accountId, campo: 'voice_sessions', max: 20 })));
  assert.strictEqual(r.filter(x => x.ok).length, 20);
  let s = await db.findOne(db.settings, { account_id: accountId });
  assert.strictEqual(s.voice_sessions_count, 20);
  assert.strictEqual(s.voice_sessions_date, limits.hoyChile());
  await limits.liberarCupoDiario({ accountId, campo: 'voice_sessions' });
  s = await db.findOne(db.settings, { account_id: accountId });
  assert.strictEqual(s.voice_sessions_count, 19, 'un fallo de OpenAI devuelve la reserva');
  const otra = await limits.reservarCupoDiario({ accountId, campo: 'voice_sessions', max: 20 });
  assert.strictEqual(otra.ok, true);
});

test('ajustarSegundosVoz acepta delta negativo (duración oficial menor que la estimada)', async () => {
  const { accountId, user } = await usuarioConCuenta();
  await limits.registrarSegundosVoz(accountId, 180);
  await limits.ajustarSegundosVoz(accountId, -30);
  const u = await db.findOne(db.users, { _id: user._id });
  assert.strictEqual(u.monthly_voice_seconds, 150);
});

test('código de invitación: 5 reservas simultáneas con maxUses 1 → solo una pasa', async () => {
  const code = await db.insert(db.inviteCodes, { code: 'UNO-' + crypto.randomUUID().slice(0, 6), isActive: true, uses: 0, maxUses: 1, daysAccess: 14 });
  const r = await Promise.all(Array.from({ length: 5 }, () =>
    db.updateRaw(db.inviteCodes, { _id: code._id, uses: { $lt: 1 } }, { $inc: { uses: 1 } })));
  assert.strictEqual(r.filter(Boolean).length, 1);
  const c = await db.findOne(db.inviteCodes, { _id: code._id });
  assert.strictEqual(c.uses, 1);
});

test('reservarMarketing: dos workers a la vez → un solo marketing hoy', async () => {
  const { reservarMarketing } = require('../services/playbookPedido');
  const lead = await db.insert(db.leads, { account_id: 'acc', wa_id: '56922222222' });
  const cfg = { capMktMes: 3 };
  const r = await Promise.all([reservarMarketing(lead._id, lead, cfg), reservarMarketing(lead._id, lead, cfg)]);
  assert.strictEqual(r.filter(x => x.ok).length, 1);
  const l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.mkt_count_month, 1);
  assert.strictEqual(l.mkt_last_day, limits.hoyChile());
});

// ── Canales ──────────────────────────────────────────────────────────────────

test('identityOf reconoce messenger (antes caía a instagram)', () => {
  assert.strictEqual(identityOf({ channel: 'messenger', ig_user_id: 'psid-1' }).channel, 'messenger');
  assert.strictEqual(identityOf({ channel: 'whatsapp', wa_id: '569' }).channel, 'whatsapp');
  assert.strictEqual(identityOf({ ig_user_id: '178' }).channel, 'instagram');
});

// ── Permiso de llamada por WhatsApp: no se reprocesa ─────────────────────────

test('procesarWebhookCalls: el mismo permiso dos veces no reprograma dos veces', async () => {
  const { procesarWebhookCalls } = require('../services/whatsappCalling');
  const account = await db.insert(db.accounts, { wa_phone_number_id: 'pn-' + crypto.randomUUID().slice(0, 6) });
  const lead = await db.insert(db.leads, { account_id: account._id, wa_id: '56933333333' });
  const value = { user_call_permissions: [{ wa_id: '56933333333', status: 'granted', expiration_timestamp: 1800000000 }] };
  await procesarWebhookCalls({ phoneNumberId: account.wa_phone_number_id, value });
  await procesarWebhookCalls({ phoneNumberId: account.wa_phone_number_id, value });
  const sistema = await db.find(db.messages, { lead_id: lead._id, role: 'sistema' });
  assert.strictEqual(sistema.length, 1, 'un solo mensaje de sistema por permiso');
  const l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.wa_call_permission.status, 'accepted');
  assert.ok(l.wa_call_permission_firma);
});

// ── "Sube de plan" nombra un plan real ───────────────────────────────────────

test('enforceFeature: pide un plan de la escalera, nunca "Pro"/"Agency"', async () => {
  const { enforceFeature } = require('../middleware/checkPlanLimits');
  const { user } = await usuarioConCuenta('inicial');
  const req = { user: { userId: user._id, accountId: user.account_id }, body: {}, query: {} };
  let salida = null;
  const res = { status(s) { this._s = s; return this; }, json(d) { salida = { status: this._s, data: d }; } };
  await enforceFeature('whiteLabel', 'Marca blanca')(req, res, () => { salida = { status: 200 }; });
  assert.strictEqual(salida.status, 403);
  assert.strictEqual(salida.data.required, 'escala');
  assert.strictEqual(salida.data.required_name, 'Escala');
  assert.ok(!/Agency|Pro\b/.test(salida.data.error), salida.data.error);
  salida = null;
  await enforceFeature('webhook', 'Webhook')(req, res, () => { salida = { status: 200 }; });
  assert.strictEqual(salida.data.required, 'crecimiento');
});

// ── Llamadas huérfanas ───────────────────────────────────────────────────────

test('worker: una llamada colgada en "marcando" hace 20 min se cierra como fallida', async () => {
  const telefonia = require('../services/telefonia');
  const proveedores = require('../services/telefoniaProveedor');
  const original = proveedores.proveedorActivo;
  proveedores.proveedorActivo = () => ({ id: 'falso', etiqueta: 'Falso', configurado: () => true, faltantes: () => [], numeroPropio: () => '+56995684130', crearLlamada: async () => 'CA-x' });
  process.env.TWILIO_ACCOUNT_SID = 'AC-test'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_PHONE_NUMBER = '+56995684130';
  try {
    const vieja = await db.insert(db.llamadas, {
      account_id: 'acc-h', lead_id: 'lead-h', status: 'marcando', via: 'telefono', telefono: '+56911111111',
      dialing_started_at: new Date(Date.now() - 20 * 60_000).toISOString(), finalized_at: null, transcript: [],
    });
    const fresca = await db.insert(db.llamadas, {
      account_id: 'acc-h', lead_id: 'lead-h2', status: 'marcando', via: 'telefono', telefono: '+56922222222',
      dialing_started_at: new Date().toISOString(), finalized_at: null, transcript: [],
    });
    await telefonia.procesarLlamadasProgramadas();
    const v = await db.findOne(db.llamadas, { _id: vieja._id });
    const f = await db.findOne(db.llamadas, { _id: fresca._id });
    assert.strictEqual(v.status, 'fallida');
    assert.match(v.error || v.motivo || '', /huérfana/);
    assert.strictEqual(f.status, 'marcando', 'la reciente no se toca');
  } finally {
    proveedores.proveedorActivo = original;
  }
});
