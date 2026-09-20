/**
 * Atinov — Agenda propia (barberías)
 *
 * El caso que la define: un barbero con horario variable (cuida a su mamá en
 * la mañana, corta de 17 a 21) que a veces va atrasado. Lo que se fija:
 *  - el horario semanal manda, y una excepción por fecha lo pisa (cerrado o distinto);
 *  - los cupos salen cada `paso_min`, no chocan con citas ni con el buffer, y
 *    hoy no se ofrece lo que ya pasó;
 *  - un atraso corre las citas que faltan y estira el fin del día;
 *  - crear una cita valida hora y solape; el mismo lead a la misma hora es la misma cita;
 *  - el marcador [AGENDAR] crea la cita o propone alternativas, nunca rompe el mensaje;
 *  - con la agenda inactiva nada entra al prompt ni resuelve marcadores.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-agenda-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const core = require('../services/agendaCore');
const db = require('../db/database');
const agenda = require('../services/agenda');
const { POR_CUENTA } = require('../services/supresionPlan');

// Barbero laboratorio: lun-vie 17:00-21:00, sáb 10:00-14:00, dom cerrado.
function cfgBarbero(extra = {}) {
  return core.sanearConfig({
    activa: true, paso_min: 30, buffer_min: 0,
    horario: { 0: [], 1: ['17:00-21:00'], 2: ['17:00-21:00'], 3: ['17:00-21:00'], 4: ['17:00-21:00'], 5: ['17:00-21:00'], 6: ['10:00-14:00'] },
    servicios: [{ nombre: 'Corte', min: 30, precio: 12000 }, { nombre: 'Corte + barba', min: 45, precio: 18000 }],
    ...extra,
  });
}

// ── Núcleo puro ──────────────────────────────────────────────────────────────

test('horario semanal y excepciones por fecha', () => {
  const cfg = cfgBarbero({ excepciones: { '2026-09-23': [], '2026-09-24': ['10:00-12:00'] } });
  assert.deepStrictEqual(core.ventanasDelDia(cfg, '2026-09-21'), [[1020, 1260]], 'lunes 17-21');
  assert.deepStrictEqual(core.ventanasDelDia(cfg, '2026-09-20'), [], 'domingo cerrado');
  assert.deepStrictEqual(core.ventanasDelDia(cfg, '2026-09-23'), [], 'miércoles cerrado por excepción (mamá)');
  assert.deepStrictEqual(core.ventanasDelDia(cfg, '2026-09-24'), [[600, 720]], 'jueves distinto por excepción');
  assert.strictEqual(core.fechaLegible('2026-09-21'), 'lun 21 sep');
});

test('cupos: cada 30 min, sin chocar con citas, y hoy no se ofrece lo que ya pasó', () => {
  const cfg = cfgBarbero();
  const citas = [{ fecha: '2026-09-21', hora: '18:00', duracion_min: 30, estado: 'agendada' }];
  assert.deepStrictEqual(core.cuposDisponibles(cfg, '2026-09-21', citas), ['17:00', '17:30', '18:30', '19:00', '19:30', '20:00', '20:30']);
  // hoy a las 18:40: solo desde ~18:45 hacia adelante (margen de 5 min) y cortado al paso
  assert.deepStrictEqual(core.cuposDisponibles(cfg, '2026-09-21', citas, { ahoraMin: 18 * 60 + 40 }), ['19:00', '19:30', '20:00', '20:30']);
  // servicio de 45 min: el último cupo tiene que caber antes de las 21:00
  assert.deepStrictEqual(core.cuposDisponibles(cfg, '2026-09-21', [], { duracion: 45 }), ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00']);
  // una cita cancelada no ocupa
  assert.strictEqual(core.cuposDisponibles(cfg, '2026-09-21', [{ ...citas[0], estado: 'cancelada' }]).length, 8);
});

test('atraso: corre las citas que faltan, estira el día y no toca las que ya pasaron', () => {
  const cfg = cfgBarbero({ atraso: { fecha: '2026-09-21', minutos: 30 } });
  const citas = [
    { fecha: '2026-09-21', hora: '17:00', duracion_min: 30, estado: 'atendida' },
    { fecha: '2026-09-21', hora: '17:30', duracion_min: 30, estado: 'agendada' },
    { fecha: '2026-09-21', hora: '19:00', duracion_min: 30, estado: 'confirmada' },
  ];
  const ahora = 17 * 60 + 45;   // 17:45, va 30 tarde: la de 17:30 pasa a 18:00, la de 19:00 a 19:30
  const cupos = core.cuposDisponibles(cfg, '2026-09-21', citas, { ahoraMin: ahora });
  assert.ok(!cupos.includes('18:00'), 'la de 17:30 corrida ocupa 18:00');
  assert.ok(!cupos.includes('19:30'), 'la de 19:00 corrida ocupa 19:30');
  assert.ok(cupos.includes('21:00'), 'el día se estira 30 min: 21:00 queda disponible');
  const af = core.afectadasPorAtraso(citas, '2026-09-21', ahora, 30);
  assert.deepStrictEqual(af.map(c => [c.hora, c.hora_estimada]), [['17:30', '18:00'], ['19:00', '19:30']]);
  const v = core.validarHora(cfg, '2026-09-21', '21:00', citas, { ahoraMin: ahora, hoy: '2026-09-21' });
  assert.strictEqual(v.ok, true, 'con el atraso, 21:00 entra');
});

test('validarHora explica el motivo', () => {
  const cfg = cfgBarbero();
  const hoy = '2026-09-21';
  assert.strictEqual(core.validarHora(cfg, '2026-09-20', '11:00', [], { hoy }).ok, false);
  assert.match(core.validarHora(cfg, '2026-09-20', '11:00', [], { hoy }).motivo, /pasó/);
  assert.match(core.validarHora(cfg, '2026-09-27', '11:00', [], { hoy }).motivo, /no se atiende/);   // domingo
  assert.match(core.validarHora(cfg, '2026-09-22', '16:00', [], { hoy }).motivo, /fuera del horario/);
  assert.match(core.validarHora(cfg, '2026-09-22', '20:45', [], { hoy }).motivo, /fuera del horario/, '20:45+30 no cabe');
  assert.match(core.validarHora(cfg, '2026-09-22', '18:00', [{ fecha: '2026-09-22', hora: '18:15', duracion_min: 30, estado: 'agendada' }], { hoy }).motivo, /tomada/);
  assert.strictEqual(core.validarHora(cfg, '2026-09-22', '18:00', [], { hoy }).ok, true);
});

test('sanearConfig no deja pasar basura', () => {
  const c = core.sanearConfig({ activa: 'sí', paso_min: 7, horario: { 1: ['17:00-16:00', '25:00-26:00', '18:00-20:00'] }, servicios: [{ nombre: '', min: 5 }, { nombre: 'Barba', min: 5000, precio: -3 }], excepciones: { 'ayer': [], '2026-10-01': ['09:00-13:00'] } });
  assert.strictEqual(c.activa, false);
  assert.strictEqual(c.paso_min, 15);
  assert.deepStrictEqual(c.horario[1], ['18:00-20:00']);
  assert.deepStrictEqual(c.servicios, [{ nombre: 'Barba', min: 240, precio: 0 }]);
  assert.deepStrictEqual(Object.keys(c.excepciones), ['2026-10-01']);
});

// ── Persistencia + marcador ──────────────────────────────────────────────────

async function cuentaConAgenda(extra = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'barberia' });
  await db.insert(db.settings, { account_id: accountId, openai_key: '', agenda: cfgBarbero(extra) });
  return accountId;
}
const manana = core.sumarDias(agenda.hoyChile(), 1);
// La semana que viene, un día laboral seguro (lunes): siempre futuro y con horario.
function proximoLunes() {
  let f = core.sumarDias(agenda.hoyChile(), 1);
  while (core.diaSemana(f) !== 1) f = core.sumarDias(f, 1);
  return f;
}

test('crearCita: valida, evita solapes y repite la misma cita del mismo lead', async () => {
  const accountId = await cuentaConAgenda();
  const f = proximoLunes();
  const a = await agenda.crearCita({ accountId, leadId: 'l1', nombre: 'Matías', telefono: '+56 9 1111 1111', fecha: f, hora: '18:00', servicio: 'Corte + barba' });
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.strictEqual(a.cita.duracion_min, 45);
  assert.strictEqual(a.cita.precio, 18000);
  assert.strictEqual(a.cita.telefono, '56911111111');

  const solape = await agenda.crearCita({ accountId, leadId: 'l2', nombre: 'Pedro', fecha: f, hora: '18:30' });
  assert.strictEqual(solape.ok, false);
  assert.match(solape.motivo, /tomada/);
  assert.ok(solape.alternativas && solape.alternativas.horas.length, 'propone horas');
  assert.ok(!solape.alternativas.horas.includes('18:30'));

  const repetida = await agenda.crearCita({ accountId, leadId: 'l1', nombre: 'Matías', fecha: f, hora: '18:00' });
  assert.strictEqual(repetida.ok, true);
  assert.strictEqual(repetida.repetida, true);
  assert.strictEqual(repetida.cita._id, a.cita._id);

  const fuera = await agenda.crearCita({ accountId, leadId: 'l3', nombre: 'Ana', fecha: f, hora: '09:00' });
  assert.strictEqual(fuera.ok, false);
  assert.match(fuera.motivo, /fuera del horario/);
});

test('resolveAgendaMarkers: crea la cita y deja la confirmación; si no hay cupo, propone; nunca deja el marcador crudo', async () => {
  const accountId = await cuentaConAgenda();
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const f = proximoLunes();
  const r1 = await agenda.resolveAgendaMarkers(`listo, te dejo esa hora 👌 [AGENDAR: ${f} | 19:00 | Matías | Corte]`, { settings, accountId, leadId: 'l1', leadName: 'Matías', leadPhone: '56911111111' });
  assert.strictEqual(r1.citas.length, 1);
  assert.match(r1.text, /📅 .*19:00 — Corte, confirmado/);
  assert.ok(!/\[AGENDAR/.test(r1.text));
  const msgs = await db.find(db.messages, { lead_id: 'l1', role: 'sistema' });
  assert.strictEqual(msgs.length, 1);

  const r2 = await agenda.resolveAgendaMarkers(`dale [AGENDAR: ${f} | 19:00 | Pedro | Corte]`, { settings, accountId, leadId: 'l2', leadName: 'Pedro' });
  assert.strictEqual(r2.citas.length, 0);
  assert.match(r2.text, /ya no está disponible/);
  assert.match(r2.text, /¿cuál te acomoda\?/);
  assert.ok(!r2.text.includes('19:00,') && !/tengo [^—]*\b19:00\b/.test(r2.text), 'no propone la hora tomada');

  const r3 = await agenda.resolveAgendaMarkers('quedamos así [AGENDAR: 2026-', { settings, accountId, leadId: 'l3' });
  assert.strictEqual(r3.text, 'quedamos así', 'marcador truncado: se limpia');
});

test('agenda inactiva: sin contexto y el marcador se elimina sin crear nada', async () => {
  const accountId = await cuentaConAgenda({ activa: false });
  const settings = await db.findOne(db.settings, { account_id: accountId });
  assert.strictEqual(await agenda.buildAgendaContext(settings, accountId), null);
  const r = await agenda.resolveAgendaMarkers(`ok [AGENDAR: ${manana} | 18:00 | X | Corte]`, { settings, accountId, leadId: 'lx' });
  assert.strictEqual(r.text, 'ok');
  assert.strictEqual((await db.find(db.citas, { account_id: accountId })).length, 0);
});

test('buildAgendaContext lista cupos reales y el marcador; registrarAtraso devuelve las afectadas', async () => {
  const accountId = await cuentaConAgenda();
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const ctx = await agenda.buildAgendaContext(settings, accountId);
  assert.match(ctx, /AGENDA DEL NEGOCIO/);
  assert.match(ctx, /\[AGENDAR: YYYY-MM-DD \| HH:MM/);
  assert.match(ctx, /Corte \(30 min, \$12\.000\)/);

  const r = await agenda.registrarAtraso(accountId, 20);
  assert.strictEqual(r.atraso.minutos, 20);
  assert.strictEqual(r.atraso.fecha, agenda.hoyChile());
  assert.ok(Array.isArray(r.afectadas));
  const s2 = await db.findOne(db.settings, { account_id: accountId });
  assert.strictEqual(s2.agenda.atraso.minutos, 20, 'quedó guardado');
});

test('cambiarEstado y reprogramar', async () => {
  const accountId = await cuentaConAgenda();
  const f = proximoLunes();
  const a = await agenda.crearCita({ accountId, leadId: 'l9', nombre: 'Luis', fecha: f, hora: '17:00' });
  const conf = await agenda.cambiarEstado(accountId, a.cita._id, 'confirmada');
  assert.strictEqual(conf.estado, 'confirmada');
  assert.ok(conf.confirmada_at);
  const rep = await agenda.reprogramar(accountId, a.cita._id, { fecha: f, hora: '20:00' });
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(rep.cita.hora, '20:00');
  assert.strictEqual(rep.cita.estado, 'agendada', 'reprogramar vuelve a pedir confirmación');
  assert.strictEqual(await agenda.cambiarEstado('otra-cuenta', a.cita._id, 'cancelada'), null, 'tenencia');
  const canc = await agenda.cambiarEstado(accountId, a.cita._id, 'cancelada', { motivo: 'no puede' });
  assert.strictEqual(canc.cancel_motivo, 'no puede');
});

test('citas está en la cascada de supresión (lleva nombre y teléfono)', () => {
  const fila = POR_CUENTA.find(([c]) => c === 'citas');
  assert.ok(fila, 'falta citas en supresionPlan');
  assert.strictEqual(fila[1], 'account_id');
});
