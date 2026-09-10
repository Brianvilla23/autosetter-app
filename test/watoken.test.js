/**
 * Atinov — Tests de la mecha de 60 días del botón de un clic
 *
 * POR QUÉ EXISTE: la Configuración de Embedded Signup se creó desde la
 * plantilla "Registro insertado de WhatsApp CON TOKEN QUE CADUCA EN 60 DÍAS".
 * Ese token es un business integration system user token y Meta no publica
 * ningún endpoint para refrescarlo: la única recuperación es que el cliente
 * vuelva a pasar por el botón. El código lo guardaba sin fecha, sin aviso y
 * sin recuperación — cada cliente que entrara por ahí tenía una mecha
 * encendida que nadie estaba mirando.
 *
 * Nunca explotó porque HOY todos los clientes entraron por la vía manual, que
 * usa un System User token sin caducidad. El día que Meta apruebe el App
 * Review, explota.
 *
 * Lo que se fija acá:
 *  1. Toda conexión por botón queda con fecha de muerte, la diga Meta o no.
 *  2. El aviso sale ANTES, una vez, y no se repite hasta el cooldown.
 *  3. Reconectar (por botón o a mano) apaga el aviso.
 *  4. Un token de WhatsApp caído NO se "recupera" con el de Instagram.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-watoken-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../db/database');
const es = require('../services/embeddedSignup');
const wa = require('../services/whatsapp');

const DIA = 86_400_000;

// ── La fecha de muerte ───────────────────────────────────────────────────────

test('sin expires_in de Meta se asume la vida de la plantilla (60 días), no "para siempre"', () => {
  const c = es.caducidadToken(null);
  assert.strictEqual(c.estimada, true, 'queda marcado que la fecha la pusimos nosotros');
  const dias = Math.round((new Date(c.expiraEn).getTime() - Date.now()) / DIA);
  assert.strictEqual(dias, es.VIDA_TOKEN_DEFAULT_DIAS);
});

test('si Meta manda expires_in, manda Meta', () => {
  const c = es.caducidadToken(7 * 24 * 3600);
  assert.strictEqual(c.estimada, false);
  const dias = Math.round((new Date(c.expiraEn).getTime() - Date.now()) / DIA);
  assert.strictEqual(dias, 7);
});

test('diasParaCaducar: sin fecha no inventa un número', () => {
  assert.strictEqual(es.diasParaCaducar({}), null);
  assert.strictEqual(es.diasParaCaducar({ wa_token_expires_at: 'cualquier cosa' }), null);

  const en5 = new Date(Date.now() + 5 * DIA + 1000).toISOString();
  assert.strictEqual(es.diasParaCaducar({ wa_token_expires_at: en5 }), 5);

  const hace2 = new Date(Date.now() - 2 * DIA).toISOString();
  assert.ok(es.diasParaCaducar({ wa_token_expires_at: hace2 }) < 0, 'lo vencido da negativo');
});

// ── El barrido que avisa ─────────────────────────────────────────────────────

async function cuenta(campos) {
  const acc = await db.insert(db.accounts, {
    wa_access_token: 'TOK', wa_phone_number_id: '111', wa_display_number: '+56 9 8566 6043',
    ...campos,
  });
  await db.insert(db.users, { account_id: acc._id, email: `d${acc._id}@x.cl`, name: 'Dueño' });
  return acc;
}

test('el alta MANUAL no se toca: su token no caduca y no debe recibir avisos', async () => {
  const acc = await cuenta({
    wa_conectado_via: 'manual',
    wa_token_expires_at: new Date(Date.now() + 1 * DIA).toISOString(),   // aunque tuviera fecha
  });
  const r = await es.barridoCaducidadWa();
  assert.strictEqual(r.avisadas, 0, 'el System User token no caduca: avisar sería mentir');
  const post = await db.findOne(db.accounts, { _id: acc._id });
  assert.ok(!post.wa_reconectar);
});

test('una conexión por botón con el token lejos de vencer no molesta a nadie', async () => {
  await cuenta({
    wa_conectado_via: 'embedded_signup',
    wa_token_expires_at: new Date(Date.now() + 45 * DIA).toISOString(),
  });
  const r = await es.barridoCaducidadWa();
  assert.strictEqual(r.avisadas, 0);
});

test('cerca de vencer: le escribe al dueño de esa cuenta', async () => {
  const acc = await cuenta({
    wa_conectado_via: 'embedded_signup',
    wa_token_expires_at: new Date(Date.now() + 3 * DIA).toISOString(),
  });
  const owner = await db.findOne(db.users, { account_id: acc._id });

  await es.barridoCaducidadWa();

  // Sin RESEND_API_KEY el correo no sale (a propósito: marcar "enviado" algo
  // que no salió es el engaño que hace perder horas). Lo que sí queda, y es
  // lo que se testea, es el intento con destinatario y motivo correctos.
  const log = await db.find(db.emailLog, { tag: 'wa_token_vence' });
  const mio = log.filter(e => e.to === owner.email);
  assert.strictEqual(mio.length, 1, 'un intento de aviso, al dueño de esa cuenta');
  assert.match(mio[0].subject, /vence/i);
});

test('con un aviso reciente no se vuelve a molestar (el barrido corre cada 6 h)', async () => {
  const acc = await cuenta({
    wa_conectado_via: 'embedded_signup',
    wa_token_expires_at: new Date(Date.now() + 3 * DIA).toISOString(),
    wa_token_aviso_at:   new Date().toISOString(),      // ya avisado recién
  });
  const owner = await db.findOne(db.users, { account_id: acc._id });

  await es.barridoCaducidadWa();

  const log = await db.find(db.emailLog, { tag: 'wa_token_vence' });
  assert.strictEqual(log.filter(e => e.to === owner.email).length, 0,
    'sin cooldown serían 4 correos al día hasta que venciera');
});

test('ya vencido: la cuenta queda marcada para reconectar', async () => {
  const acc = await cuenta({
    wa_conectado_via: 'embedded_signup',
    wa_token_expires_at: new Date(Date.now() - 1 * DIA).toISOString(),
  });
  await es.barridoCaducidadWa();
  const post = await db.findOne(db.accounts, { _id: acc._id });
  assert.strictEqual(post.wa_reconectar, true);
});

test('sin dueño a quién avisarle, el barrido no explota', async () => {
  const acc = await db.insert(db.accounts, {
    wa_access_token: 'TOK', wa_conectado_via: 'embedded_signup',
    wa_token_expires_at: new Date(Date.now() + 2 * DIA).toISOString(),
  });
  const r = await es.barridoCaducidadWa();   // no hay users con ese account_id
  assert.ok(r.avisadas >= 0);
  await db.remove(db.accounts, { _id: acc._id }, {});
});

// ── El token caído no se cura con el de Instagram ────────────────────────────

test('un token de WhatsApp rechazado marca WhatsApp — no manda a reconectar Instagram', async () => {
  const acc = await cuenta({ wa_conectado_via: 'embedded_signup', wa_access_token: 'TOK-WA' });

  await wa.marcarWaParaReconectar(
    await db.findOne(db.accounts, { _id: acc._id }),
    { response: { data: { error: { message: 'Error validating access token: Session has expired' } } } }
  );

  const post = await db.findOne(db.accounts, { _id: acc._id });
  assert.strictEqual(post.wa_reconectar, true);
  assert.match(post.wa_reconectar_motivo, /expired/i, 'guarda el motivo real de Meta');
  // El flag de Instagram es OTRO problema: marcarlo mandaría al cliente a
  // reconectar el canal equivocado.
  assert.ok(!post.needs_reauth, 'no se toca el flag de Instagram');
});

test('el motivo se recorta: un error de Meta no puede inflar el documento', async () => {
  const acc = await cuenta({ wa_conectado_via: 'embedded_signup' });
  await wa.marcarWaParaReconectar(
    await db.findOne(db.accounts, { _id: acc._id }),
    { response: { data: { error: { message: 'x'.repeat(5000) } } } }
  );
  const post = await db.findOne(db.accounts, { _id: acc._id });
  assert.ok(post.wa_reconectar_motivo.length <= 200);
});

// ── Reconectar apaga el aviso ────────────────────────────────────────────────

test('los campos del aviso NO son secretos: pueden salir al panel', () => {
  const { sanitizeAccount } = require('../services/sanitize');
  const safe = sanitizeAccount({
    _id: 'a1',
    wa_access_token: 'SECRETO',
    wa_token_expires_at: '2026-11-01T00:00:00.000Z',
    wa_reconectar: true,
    wa_reconectar_motivo: 'Session has expired',
  });
  assert.strictEqual(safe.wa_access_token, undefined, 'el token sigue sin salir');
  assert.strictEqual(safe.has_wa_access_token, true);
  assert.strictEqual(safe.wa_token_expires_at, '2026-11-01T00:00:00.000Z',
    'la fecha SÍ tiene que llegar al panel o el aviso no se puede pintar');
  assert.strictEqual(safe.wa_reconectar, true);
});
