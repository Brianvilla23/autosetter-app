/**
 * Atinov — La baja: "no me escriban más"
 *
 * Las campañas revisaban mkt_opt_out pero nadie lo escribía: nadie podía
 * darse de baja (Ley del Consumidor, art. 28 B). Lo que se fija acá: que se
 * detecte quien pide no recibir mensajes, y sobre todo que NO se confunda con
 * un reclamo ("no me mandaron el pedido") ni con un cambio de canal.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-baja-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../db/database');
const b = require('../services/bajaContacto');

test('detecta los pedidos de no recibir más mensajes', () => {
  for (const t of [
    'No me escriban más',
    'no me manden más mensajes por favor',
    'dejen de escribirme',
    'deja de mandarme promociones',
    'STOP',
    'Dame de baja',
    'no quiero recibir más promociones',
    'sáquenme de la lista',
    'eliminen mi número',
    'Detener promociones',
    'no me contacten más',
    'basta de mensajes',
  ]) assert.strictEqual(b.pideBaja(t), true, t);
});

test('NO confunde reclamos, trámites ni cambios de canal con una baja', () => {
  for (const t of [
    'no me mandaron el pedido',
    'no me llegó el mensaje con el link',
    'quiero darme de baja del gimnasio',
    'no me escribas por acá, mejor por WhatsApp',
    'no me llames, escríbeme',
    'ahora no puedo, me escriben más tarde?',
    'hola, cuánto sale el corte?',
    'no me gustó el color, se puede cambiar?',
    'mándame el catálogo',
    '',
  ]) assert.strictEqual(b.pideBaja(t), false, t);
});

test('un párrafo largo no cuenta aunque traiga la frase', () => {
  const largo = 'hola, mira, te cuento que ayer fui al local y no me atendieron bien, la verdad no me escriban más si no van a solucionar nada de lo que pasó con mi pedido de la semana pasada';
  assert.strictEqual(b.pideBaja(largo), false);
});

test('registrar la baja marca el contacto y no pisa la fecha si ya estaba', async () => {
  const lead = await db.insert(db.leads, { account_id: 'acc1', ig_user_id: '1', automation: 'automated' });
  assert.strictEqual(await b.registrarBaja({ lead, texto: 'no me escriban más' }), true);
  const marcado = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(marcado.mkt_opt_out, true);
  assert.strictEqual(marcado.opt_out_motivo, 'pidio_baja');
  assert.strictEqual(marcado.opt_out_texto, 'no me escriban más');
  assert.ok(marcado.opt_out_at);
  assert.strictEqual(b.dadoDeBaja(marcado), true);

  assert.strictEqual(await b.registrarBaja({ lead: marcado, texto: 'otra vez' }), false, 'idempotente');
  const igual = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(igual.opt_out_at, marcado.opt_out_at);

  await b.quitarBaja(lead._id);
  const limpio = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(limpio.mkt_opt_out, false);
  assert.strictEqual(limpio.opt_out_texto, null);
});

test('el acuse suena a persona: corto, sin "¡" ni emoji', () => {
  assert.ok(b.ACUSE_BAJA.split(/\s+/).length <= 20);
  assert.ok(!/[¡¿]/.test(b.ACUSE_BAJA));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(b.ACUSE_BAJA));
});
