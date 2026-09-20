/**
 * Atinov — Consultas al copiloto (la cola de aprendizaje del soporte)
 *
 * Lo que se fija:
 *  - cada consulta se guarda con pregunta, respuesta y hallazgos del momento;
 *  - el dueño solo puede calificar consultas de SU cuenta;
 *  - el admin ve estadísticas y la cola "no sirvió y sin revisar";
 *  - marcar revisada la saca de la cola y guarda la nota;
 *  - la colección entra en la cascada de supresión por cuenta;
 *  - estadoDeCuenta() lee las señales nuevas de la base real.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-copiconsultas-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const copiloto = require('../services/copiloto');
const { diagnosticar } = require('../services/copilotoConocimiento');
const { POR_CUENTA } = require('../services/supresionPlan');

const A = 'acc-' + crypto.randomUUID();
const B = 'acc-' + crypto.randomUUID();

test('la consulta se guarda con lo que había en ese momento', async () => {
  const id = await copiloto.registrarConsulta({
    accountId: A, pregunta: '¿por qué no responde?', respuesta: 'WhatsApp está en pausa.',
    hallazgos: ['El canal whatsapp está EN PAUSA'], modelo: 'gpt-4o-mini',
  });
  assert.ok(id);
  const doc = await db.findOne(db.copilotoConsultas, { _id: id });
  assert.strictEqual(doc.account_id, A);
  assert.strictEqual(doc.util, null);
  assert.strictEqual(doc.revisada, false);
  assert.deepStrictEqual(doc.hallazgos, ['El canal whatsapp está EN PAUSA']);
  assert.ok(doc.createdAt);
});

test('solo el dueño de la consulta la califica', async () => {
  const id = await copiloto.registrarConsulta({ accountId: A, pregunta: 'p', respuesta: 'r', hallazgos: [] });
  assert.strictEqual(await copiloto.calificarConsulta({ accountId: B, id, util: false }), false, 'otra cuenta no puede');
  assert.strictEqual(await copiloto.calificarConsulta({ accountId: A, id, util: 'no' }), false, 'util debe ser booleano');
  assert.strictEqual(await copiloto.calificarConsulta({ accountId: A, id, util: false, comentario: 'no era eso' }), true);
  const doc = await db.findOne(db.copilotoConsultas, { _id: id });
  assert.strictEqual(doc.util, false);
  assert.strictEqual(doc.comentario, 'no era eso');
  assert.ok(doc.calificada_at);
});

test('el admin ve la cola y marcar revisada la saca', async () => {
  await db.insert(db.accounts, { _id: A, nombre_negocio: 'Barbería Cruz' });
  const idBuena = await copiloto.registrarConsulta({ accountId: A, pregunta: 'sirvió', respuesta: 'r', hallazgos: [] });
  await copiloto.calificarConsulta({ accountId: A, id: idBuena, util: true });

  let r = await copiloto.resumenConsultas({ filtro: 'sin_revisar' });
  assert.strictEqual(r.stats.utiles, 1);
  assert.strictEqual(r.stats.no_utiles, 1);
  assert.ok(r.stats.sin_calificar >= 1);
  assert.strictEqual(r.stats.sin_revisar, 1);
  assert.strictEqual(r.consultas.length, 1);
  assert.strictEqual(r.consultas[0].util, false);
  assert.strictEqual(r.consultas[0].negocio, 'Barbería Cruz', 'trae el nombre del negocio');

  const rev = await copiloto.marcarRevisada(r.consultas[0].id, 'faltaba explicar la ventana de 24 h');
  assert.ok(rev && rev.revisada);
  assert.strictEqual(await copiloto.marcarRevisada('no-existe'), null);

  r = await copiloto.resumenConsultas({ filtro: 'sin_revisar' });
  assert.strictEqual(r.consultas.length, 0, 'ya no está en la cola');
  assert.strictEqual(r.stats.sin_revisar, 0);

  r = await copiloto.resumenConsultas({ filtro: 'no_utiles' });
  assert.strictEqual(r.consultas.length, 1);
  assert.strictEqual(r.consultas[0].revisada, true);
  assert.strictEqual(r.consultas[0].nota_soporte, 'faltaba explicar la ventana de 24 h');

  r = await copiloto.resumenConsultas({ filtro: 'todas', limit: 2 });
  assert.strictEqual(r.consultas.length, 2, 'respeta el límite');
});

test('la colección entra en la cascada de supresión por cuenta', () => {
  assert.ok(POR_CUENTA.some(([col, campo]) => col === 'copilotoConsultas' && campo === 'account_id'));
});

test('estadoDeCuenta() lee las señales nuevas de la base y el diagnóstico las dice', async () => {
  const C = 'acc-' + crypto.randomUUID();
  const hoy = new Date().toISOString();
  await db.insert(db.accounts, {
    _id: C, nombre_negocio: 'Barbería Sur', wa_phone_number_id: 'pn1', wa_display_number: '+56911111111',
    wa_reconectar: true, fb_page_id: 'pg1', fb_reconectar: true, fb_reconectar_motivo: 'token vencido',
    wa_token_expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  });
  await db.insert(db.users, { account_id: C, email: 'sur@test.cl', role: 'user' });
  await db.insert(db.agents, { account_id: C, name: 'Vale', enabled: true, instructions: 'Cuando cierre manda [PAGO: 12000 | Corte]' });
  await db.insert(db.settings, {
    account_id: C,
    agenda: { activa: true, horario: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } },
    playbook_pedido_enabled: true, playbook_template_tracking: 'pedido_tracking',
  });
  await db.insert(db.waEstados, { account_id: C, wamid: 'w1', estado: 'failed', codigo: 131047, ts: hoy });
  await db.insert(db.waEstados, { account_id: C, wamid: 'w2', estado: 'failed', codigo: 131047, ts: hoy });
  await db.insert(db.waEstados, { account_id: C, wamid: 'w3', estado: 'delivered', codigo: null, ts: hoy });
  await db.insert(db.waEstados, { account_id: C, wamid: 'w4', estado: 'failed', codigo: 131047, ts: new Date(Date.now() - 10 * 86_400_000).toISOString() });
  await db.insert(db.bypassed, { account_id: C, ig_user_id: 'x1' });
  await db.insert(db.errorLog, { accountId: C, kind: 'request', message: 'boom' });

  const e = await copiloto.estadoDeCuenta(C);
  assert.strictEqual(e.wa.reconectar, true);
  assert.strictEqual(e.wa.fallos7d['131047'], 2, 'cuenta solo los fallidos de 7 días');
  assert.strictEqual(e.wa.totalFallos7d, 2);
  assert.ok(e.wa.diasToken >= 2 && e.wa.diasToken <= 3);
  assert.strictEqual(e.fb.reconectar, true);
  assert.strictEqual(e.fb.motivo, 'token vencido');
  assert.strictEqual(e.agenda.activa, true);
  assert.strictEqual(e.agenda.diasConHorario, 0);
  assert.strictEqual(e.playbook.activo, true);
  assert.ok(e.playbook.faltan.includes('llega_hoy') && !e.playbook.faltan.includes('tracking'));
  assert.strictEqual(e.pagos.mp, false);
  assert.strictEqual(e.agentesUsanPago, true);
  assert.strictEqual(e.leads.bypass, 1);
  assert.strictEqual(e.errores24h, 1);

  const h = diagnosticar(e);
  const hay = rx => h.some(x => rx.test(x));
  assert.ok(hay(/WhatsApp está marcado PARA RECONECTAR/));
  assert.ok(hay(/caduca en \d+ día/));
  assert.ok(hay(/2 mensaje.*131047/s));
  assert.ok(hay(/Messenger.*token vencido/s));
  assert.ok(hay(/agenda está ACTIVA pero no tiene horario/));
  assert.ok(hay(/faltan plantillas para: .*llega_hoy/));
  assert.ok(hay(/Mercado Pago/));
  assert.ok(hay(/1 persona\(s\) bajo control humano/));
  assert.ok(hay(/1 error\(es\) interno/));

  // Una cuenta sin nada de esto no recibe ninguno de esos avisos.
  const D = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: D, nombre_negocio: 'Sana', wa_phone_number_id: 'pn2' });
  await db.insert(db.agents, { account_id: D, name: 'Vale', enabled: true, instructions: 'hola' });
  const s = await copiloto.estadoDeCuenta(D);
  const hs = diagnosticar(s);
  for (const rx of [/RECONECTAR/, /caduca/, /131047/, /agenda/i, /plantillas/, /Mercado Pago/, /control humano/, /interno/]) {
    assert.ok(!hs.some(x => rx.test(x)), `sana no debe decir ${rx}`);
  }
});
