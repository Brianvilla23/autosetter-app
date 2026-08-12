/**
 * Atinov — Suite de correo transaccional
 *
 * Nace de un incidente real (12-08-2026): el correo de "olvidé mi contraseña"
 * nunca llegó y NO había forma de saber por qué — ese camino de envío no
 * dejaba rastro en `db.emailLog`, y cuando faltaba la API key el log decía
 * "enviado" igual. El dueño quedó fuera del panel sin diagnóstico posible.
 *
 * Estos tests fijan las dos reglas que lo impiden:
 *  1. Un correo que NO se envió jamás se registra como enviado.
 *  2. TODO envío deja rastro en emailLog, venga del módulo que venga.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-email-test-')
);
delete process.env.RESEND_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../db/database');

test('sin RESEND_API_KEY: el envío falla y NO se registra como enviado', async () => {
  const { sendEmail } = require('../services/email');
  const r = await sendEmail({
    to: 'brayan@ejemplo.cl', subject: 'Restablece tu contraseña', html: '<p>link</p>', tag: 'reset',
  });

  assert.strictEqual(r.ok, false, 'un correo que no salió NO puede devolver ok:true');
  assert.match(r.error || '', /RESEND_API_KEY/, 'el motivo dice qué falta');

  const log = await db.find(db.emailLog, { tag: 'reset' });
  assert.strictEqual(log.length, 1, 'el intento quedó registrado');
  assert.strictEqual(log[0].ok, false, 'registrado como FALLIDO, no como enviado');
  assert.match(log[0].error || '', /RESEND_API_KEY/);
});

test('el correo de notificaciones también deja rastro (mismo log que el resto)', async () => {
  const { sendEmail } = require('../services/notifications');
  const r = await sendEmail({
    to: 'brayan@ejemplo.cl', subject: 'Lead caliente', html: '<p>x</p>', tag: 'hot_lead',
  });

  assert.strictEqual(r.ok, false);
  assert.ok(r.reason, 'mantiene `reason` para los llamadores viejos');

  const log = await db.find(db.emailLog, { tag: 'hot_lead' });
  assert.strictEqual(log.length, 1, 'notifications.sendEmail ahora sí registra');
});

test('el remitente queda guardado — es la causa #1 de correo rechazado', async () => {
  process.env.RESEND_FROM = 'Atinov <notificaciones@atinov.com>';
  const { sendEmail } = require('../services/notifications');
  await sendEmail({ to: 'x@ejemplo.cl', subject: 'S', html: '<p>x</p>', tag: 'remitente' });

  const log = await db.find(db.emailLog, { tag: 'remitente' });
  assert.strictEqual(log[0].from, 'Atinov <notificaciones@atinov.com>',
    'se guarda CON QUÉ remitente se intentó, para saber cuál verificar en Resend');
});
