/**
 * Atinov — Suite de llamadas DENTRO de WhatsApp (Meta Calling API vía SIP)
 *
 * Fija las reglas que hacen que esta vía sea segura y legal:
 *  1. Fail-closed: sin SIP activado en la cuenta (credenciales de Meta), la
 *     vía WhatsApp NO existe — se cae a llamada telefónica.
 *  2. Permiso de Meta: 1 solicitud/24h y 2 por semana por lead; el permiso
 *     aceptado tiene vencimiento; rechazado no vale.
 *  3. Países bloqueados por Meta (USA/Canadá, Egipto, Vietnam, Nigeria).
 *  4. Twilio marca al SIP de Meta con las credenciales digest del número.
 *  5. La respuesta al permiso pasa la llamada de 'esperando_permiso' a
 *     'programada' (aceptó) o 'cancelada' (rechazó).
 *  6. Las credenciales SIP NUNCA salen al frontend (sanitize).
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-wacalling-test-')
);
process.env.JWT_SECRET = 'secreto-de-test';
process.env.APP_URL = 'https://test.atinov.local';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';

const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../db/database');
const wa = require('../services/whatsappCalling');
const { sanitizeSettings } = require('../services/sanitize');

const settingsOk = {
  llamadas_enabled: true, wa_calling_enabled: true,
  wa_sip_username: 'user123', wa_sip_password: 'pass456', wa_sip_hostname: 'atinov.sip.twilio.com',
};
const accountOk = { wa_phone_number_id: '1251424908052492', wa_access_token: 'EAAx' };

test('fail-closed: sin credenciales SIP la vía WhatsApp no está habilitada', () => {
  assert.strictEqual(wa.llamadasWaHabilitadas(accountOk, { ...settingsOk, wa_sip_password: null }), false);
  assert.strictEqual(wa.llamadasWaHabilitadas(accountOk, { ...settingsOk, wa_calling_enabled: false }), false);
  assert.strictEqual(wa.llamadasWaHabilitadas(accountOk, { ...settingsOk, llamadas_enabled: false }), false, 'el interruptor general manda');
  assert.strictEqual(wa.llamadasWaHabilitadas({ wa_phone_number_id: null }, settingsOk), false, 'sin WhatsApp conectado no hay vía');
  assert.strictEqual(wa.llamadasWaHabilitadas(accountOk, settingsOk), true);
});

test('países bloqueados por Meta: USA/Canadá, Egipto, Vietnam, Nigeria; Chile OK', () => {
  assert.strictEqual(wa.destinoBloqueado('14155550134'), true, 'USA');
  assert.strictEqual(wa.destinoBloqueado('201001234567'), true, 'Egipto');
  assert.strictEqual(wa.destinoBloqueado('84901234567'), true, 'Vietnam');
  assert.strictEqual(wa.destinoBloqueado('2348012345678'), true, 'Nigeria');
  assert.strictEqual(wa.destinoBloqueado('56985666043'), false, 'Chile');
  assert.strictEqual(wa.destinoBloqueado('5491155551234'), false, 'Argentina');
});

test('permiso: solo cuenta si está aceptado y vigente', () => {
  const futuro = new Date(Date.now() + 3 * 86400e3).toISOString();
  const pasado = new Date(Date.now() - 1 * 86400e3).toISOString();
  assert.ok(wa.permisoVigente({ wa_call_permission: { status: 'accepted', expires_at: futuro } }));
  assert.strictEqual(wa.permisoVigente({ wa_call_permission: { status: 'accepted', expires_at: pasado } }), null, 'vencido');
  assert.strictEqual(wa.permisoVigente({ wa_call_permission: { status: 'rejected' } }), null, 'rechazado');
  assert.strictEqual(wa.permisoVigente({ wa_call_permission: { status: 'pending' } }), null, 'pendiente');
  assert.strictEqual(wa.permisoVigente({}), null);
});

test('límites de Meta al pedir permiso: 1 por 24h, 2 por semana', () => {
  const ahora = Date.now();
  const hace = (h) => new Date(ahora - h * 3600e3).toISOString();
  assert.strictEqual(wa.puedePedirPermiso({}).ok, true, 'sin historial se puede');
  assert.strictEqual(wa.puedePedirPermiso({ wa_call_permission_requests: [hace(2)] }).ok, false, 'ya pidió hoy');
  assert.strictEqual(wa.puedePedirPermiso({ wa_call_permission_requests: [hace(30)] }).ok, true, 'ayer sí, hoy libre');
  assert.strictEqual(wa.puedePedirPermiso({ wa_call_permission_requests: [hace(30), hace(100)] }).ok, false, '2 en la semana = tope');
  assert.strictEqual(wa.puedePedirPermiso({ wa_call_permission_requests: [hace(30), hace(200)] }).ok, true, 'la de hace 8 días ya no cuenta');
});

test('Twilio marca al SIP de Meta con digest del número (no al celular)', () => {
  const p = wa.paramsTwilioParaWhatsapp({ telefonoE164: '+56985666043', settings: settingsOk });
  assert.strictEqual(p.To, 'sip:+56985666043@wa.meta.vc;transport=tls');
  assert.strictEqual(p.SipAuthUsername, 'user123');
  assert.strictEqual(p.SipAuthPassword, 'pass456');
  assert.ok(p.From.startsWith('sip:user123@atinov.sip.twilio.com'));
});

test('respuesta al permiso: aceptó → la llamada en espera queda programada; rechazó → cancelada', async () => {
  const account = { _id: 'acc-wa', ...accountOk };
  const lead = await db.insert(db.leads, { account_id: 'acc-wa', wa_id: '56985666043', channel: 'whatsapp' });
  await db.insert(db.llamadas, { account_id: 'acc-wa', lead_id: lead._id, status: 'esperando_permiso', via: 'whatsapp' });

  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const r = await wa.procesarRespuestaPermiso({
    account, lead,
    interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', expiration_timestamp: String(exp) } },
  });
  assert.strictEqual(r.acepto, true);
  const ll = await db.findOne(db.llamadas, { lead_id: lead._id });
  assert.strictEqual(ll.status, 'programada', 'la llamada se destraba sola al aceptar');
  assert.ok(ll.dial_at, 'con hora de marcado');
  const leadUpd = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(leadUpd.wa_call_permission.status, 'accepted');
  assert.ok(new Date(leadUpd.wa_call_permission.expires_at) > new Date());

  // Rechazo en otro lead
  const lead2 = await db.insert(db.leads, { account_id: 'acc-wa', wa_id: '56911111111', channel: 'whatsapp' });
  await db.insert(db.llamadas, { account_id: 'acc-wa', lead_id: lead2._id, status: 'esperando_permiso', via: 'whatsapp' });
  const r2 = await wa.procesarRespuestaPermiso({
    account, lead: lead2, interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'reject' } },
  });
  assert.strictEqual(r2.acepto, false);
  const ll2 = await db.findOne(db.llamadas, { lead_id: lead2._id });
  assert.strictEqual(ll2.status, 'cancelada', 'rechazo = se cancela, sin insistir');
});

test('permiso SIN botón: el lead llamó al negocio (callback) → queda autorizado y la llamada en espera se destraba', async () => {
  // Cuenta con WhatsApp para que findAccountByPhoneNumberId la resuelva
  await db.insert(db.accounts, { _id: 'acc-cb', wa_phone_number_id: 'PN-CB', wa_access_token: 'tok' });
  const lead = await db.insert(db.leads, { account_id: 'acc-cb', wa_id: '56922223333', channel: 'whatsapp' });
  await db.insert(db.llamadas, { account_id: 'acc-cb', lead_id: lead._id, status: 'esperando_permiso', via: 'whatsapp' });

  await wa.procesarWebhookCalls({
    phoneNumberId: 'PN-CB',
    value: {
      metadata: { phone_number_id: 'PN-CB' },
      user_call_permissions: [{ wa_id: '56922223333', status: 'temporary', expiration_timestamp: String(Math.floor(Date.now() / 1000) + 7 * 86400) }],
    },
  });
  const l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.wa_call_permission.status, 'accepted');
  assert.strictEqual(l.wa_call_permission.source, 'callback', 'origen: el lead llamó, no el botón');
  assert.ok(wa.permisoVigente(l), 'vigente → el agente puede llamar sin pedir');
  const ll = await db.findOne(db.llamadas, { lead_id: lead._id });
  assert.strictEqual(ll.status, 'programada', 'la llamada que esperaba el botón se destraba sola');
});

test('permiso PERMANENTE desde el perfil: sin vencimiento', async () => {
  await db.insert(db.accounts, { _id: 'acc-perm', wa_phone_number_id: 'PN-PERM', wa_access_token: 'tok' });
  const lead = await db.insert(db.leads, { account_id: 'acc-perm', wa_id: '56933334444', channel: 'whatsapp' });
  await wa.procesarWebhookCalls({
    phoneNumberId: 'PN-PERM',
    value: { metadata: { phone_number_id: 'PN-PERM' }, user_call_permissions: [{ wa_id: '56933334444', status: 'granted', type: 'permanent' }] },
  });
  const l = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(l.wa_call_permission.status, 'accepted');
  assert.strictEqual(l.wa_call_permission.expires_at, null, 'permanente = no vence');
  assert.ok(wa.permisoVigente(l));
});

test('las credenciales SIP de Meta NUNCA salen al frontend', () => {
  const safe = sanitizeSettings({ account_id: 'a', openai_key: '', ...settingsOk });
  const s = JSON.stringify(safe);
  assert.ok(!('wa_sip_password' in safe));
  assert.ok(!('wa_sip_username' in safe));
  assert.ok(!s.includes('pass456') && !s.includes('user123'));
  assert.strictEqual(safe.wa_calling_enabled, true, 'el flag sí sale (la UI lo necesita)');
});
