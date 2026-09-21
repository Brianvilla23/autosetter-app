/**
 * Atinov — Lista de espera de la agenda (vertical barberías)
 *
 * Lo que pidió Brayan: si alguien se baja, ofrecer la hora a quien pidió una
 * parecida. Lo que se fija acá:
 *  - quien pide una hora OCUPADA queda anotado (una entrada por persona y día);
 *    quien pide una hora que no existe (fuera de horario) no;
 *  - al cancelar una cita futura se le ofrece a los más cercanos, del más
 *    cercano al más lejano y, empatados, al que pidió primero;
 *  - a cada candidato su propio mensaje (el dedupe va por persona);
 *  - "no vino" no libera nada, y una hora que empieza ya no se ofrece;
 *  - si otro la tomó antes, la oferta pendiente se cancela en vez de salir;
 *  - reprogramar libera la hora VIEJA;
 *  - agendar saca a la persona de la lista.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-espera-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const core = require('../services/agendaCore');
const db = require('../db/database');
const espera = require('../services/listaEspera');
const ct = require('../services/citaTasks');
const agenda = require('../services/agenda');
const { POR_CUENTA } = require('../services/supresionPlan');

// Agenda abierta todos los días de 10 a 22, para que la fecha de prueba (unos
// días adelante de HOY real) siempre caiga dentro del horario.
const HORARIO = { 0: ['10:00-22:00'], 1: ['10:00-22:00'], 2: ['10:00-22:00'], 3: ['10:00-22:00'],
                  4: ['10:00-22:00'], 5: ['10:00-22:00'], 6: ['10:00-22:00'] };
const FECHA = core.sumarDias(agenda.hoyChile(), 5);

async function cuenta({ playbook = true } = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, wa_phone_number_id: 'pn', wa_access_token: 'tok', nombre_negocio: 'Barbería' });
  await db.insert(db.settings, {
    account_id: accountId,
    agenda: { activa: true, paso_min: 30, buffer_min: 0, horario: HORARIO,
              servicios: [{ nombre: 'Corte', min: 30, precio: 12000 }] },
    agenda_playbook_enabled: playbook,
    agenda_template_hueco: 'cita_hueco',
  });
  return accountId;
}

async function lead(accountId, nombre = 'Cliente') {
  const _id = 'lead-' + crypto.randomUUID();
  await db.insert(db.leads, { _id, account_id: accountId, wa_id: '569' + Math.floor(Math.random() * 1e8),
                              wa_name: nombre, automation: 'automated', is_bypassed: false });
  return _id;
}

const settingsDe = (accountId) => db.findOne(db.settings, { account_id: accountId });
const ofertasDe = async (citaId) => (await db.find(db.pedidoTasks, { cita_id: citaId, tipo: 'hueco' }))
  .filter(t => !t.cancelled && !t.sent_at);

// ── Núcleo ───────────────────────────────────────────────────────────────────

test('ordena por cercanía y, empatados, al que pidió primero', () => {
  const e = [
    { _id: 'a', hora: '20:00', createdAt: '2026-09-01T10:00:00Z' },  // a 60 min
    { _id: 'b', hora: '19:30', createdAt: '2026-09-01T12:00:00Z' },  // a 30 min, pidió después
    { _id: 'c', hora: '18:30', createdAt: '2026-09-01T11:00:00Z' },  // a 30 min, pidió antes
    { _id: 'd', hora: '21:30', createdAt: '2026-09-01T09:00:00Z' },  // a 150 min: fuera
  ];
  const r = espera.ordenarCandidatos(e, '19:00', 60).map(x => x._id);
  assert.deepStrictEqual(r, ['c', 'b', 'a'], 'cercanos primero, empate por antigüedad, lejanos fuera');
  assert.deepStrictEqual(espera.ordenarCandidatos(e, 'basura', 60), []);
  assert.deepStrictEqual(espera.ordenarCandidatos(null, '19:00'), []);
});

test('solo cuenta como espera la hora ocupada, no la que no existe', () => {
  assert.ok(espera.esOcupada('esa hora ya está tomada'));
  assert.ok(espera.esOcupada('esa hora se acaba de tomar'));
  assert.ok(!espera.esOcupada('fuera del horario de atención'), 'fuera de horario no es espera');
  assert.ok(!espera.esOcupada('ese día no se atiende'));
  assert.ok(!espera.esOcupada(undefined));
});

test('una entrada por persona y día: si pide otra hora, se actualiza', async () => {
  const acc = await cuenta();
  const l = await lead(acc, 'Pedro');
  await espera.registrarInteres({ accountId: acc, leadId: l, nombre: 'Pedro', fecha: FECHA, hora: '19:00' });
  const r = await espera.registrarInteres({ accountId: acc, leadId: l, nombre: 'Pedro', fecha: FECHA, hora: '19:30' });
  assert.strictEqual(r.actualizada, true);
  const vivas = await db.find(db.listaEspera, { account_id: acc, lead_id: l });
  assert.strictEqual(vivas.length, 1);
  assert.strictEqual(vivas[0].hora, '19:30');
  assert.strictEqual(await espera.registrarInteres({ accountId: acc, leadId: l, fecha: 'mañana', hora: '19:00' }), null);
  assert.strictEqual(await espera.registrarInteres({ accountId: acc, leadId: l, fecha: FECHA, hora: 'tarde' }), null);
});

// ── Liberar una hora ─────────────────────────────────────────────────────────

test('al cancelar se le ofrece a los más cercanos, a cada uno su mensaje', async () => {
  const acc = await cuenta();
  const dueno = await lead(acc, 'Dueño');
  const r = await agenda.crearCita({ accountId: acc, leadId: dueno, nombre: 'Dueño', fecha: FECHA, hora: '19:00' });
  assert.ok(r.ok, 'la cita existe');

  const a = await lead(acc, 'Ana'), b = await lead(acc, 'Beto'), c = await lead(acc, 'Caro'), d = await lead(acc, 'Dani');
  await espera.registrarInteres({ accountId: acc, leadId: a, nombre: 'Ana',  fecha: FECHA, hora: '19:00' });
  await espera.registrarInteres({ accountId: acc, leadId: b, nombre: 'Beto', fecha: FECHA, hora: '19:30' });
  await espera.registrarInteres({ accountId: acc, leadId: c, nombre: 'Caro', fecha: FECHA, hora: '18:30' });
  await espera.registrarInteres({ accountId: acc, leadId: d, nombre: 'Dani', fecha: FECHA, hora: '21:30' });
  await espera.registrarInteres({ accountId: acc, leadId: dueno, nombre: 'Dueño', fecha: FECHA, hora: '19:00' });

  await agenda.cambiarEstado(acc, r.cita._id, 'cancelada');

  const of = await ofertasDe(r.cita._id);
  const quienes = of.map(t => t.lead_id);
  assert.strictEqual(of.length, 3, 'por defecto a tres personas');
  assert.ok(quienes.includes(a) && quienes.includes(b) && quienes.includes(c));
  assert.ok(!quienes.includes(d), 'la que pidió 21:30 está fuera de la hora de cercanía');
  assert.ok(!quienes.includes(dueno), 'a quien canceló no se le ofrece su propia hora');
  assert.ok(of.every(t => t.hora === '19:00' && t.fecha === FECHA), 'se ofrece la hora liberada');

  const estados = await db.find(db.listaEspera, { account_id: acc, estado: 'ofrecido' });
  assert.strictEqual(estados.length, 3, 'quedan marcados como ofrecidos');
});

test('no vino no libera nada, y apagado no ofrece', async () => {
  const acc = await cuenta();
  const dueno = await lead(acc), otro = await lead(acc);
  const r = await agenda.crearCita({ accountId: acc, leadId: dueno, nombre: 'X', fecha: FECHA, hora: '15:00' });
  await espera.registrarInteres({ accountId: acc, leadId: otro, nombre: 'Y', fecha: FECHA, hora: '15:00' });
  await agenda.cambiarEstado(acc, r.cita._id, 'no_vino');
  assert.strictEqual((await ofertasDe(r.cita._id)).length, 0, 'no vino: esa hora ya se perdió');

  const acc2 = await cuenta({ playbook: false });
  const d2 = await lead(acc2), o2 = await lead(acc2);
  const r2 = await agenda.crearCita({ accountId: acc2, leadId: d2, nombre: 'X', fecha: FECHA, hora: '15:00' });
  await espera.registrarInteres({ accountId: acc2, leadId: o2, nombre: 'Y', fecha: FECHA, hora: '15:00' });
  await agenda.cambiarEstado(acc2, r2.cita._id, 'cancelada');
  assert.strictEqual((await ofertasDe(r2.cita._id)).length, 0, 'con los recordatorios apagados no se escribe');
});

test('una hora que empieza en menos de 20 minutos no se ofrece', async () => {
  const acc = await cuenta();
  const s = await settingsDe(acc);
  const inicio = new Date(core.instanteChile(FECHA, '19:00'));
  const r = await ct.alLiberarHora(
    { _id: 'x', account_id: acc, lead_id: 'l', fecha: FECHA, hora: '19:00' },
    s, new Date(inicio.getTime() - 10 * 60000));
  assert.strictEqual(r.ofrecidas, 0);
  assert.match(r.ignorado, /cerca/);
});

test('reprogramar libera la hora vieja para quien la esperaba', async () => {
  const acc = await cuenta();
  const dueno = await lead(acc), esperando = await lead(acc, 'Ema');
  const r = await agenda.crearCita({ accountId: acc, leadId: dueno, nombre: 'X', fecha: FECHA, hora: '17:00' });
  await espera.registrarInteres({ accountId: acc, leadId: esperando, nombre: 'Ema', fecha: FECHA, hora: '17:00' });

  const m = await agenda.reprogramar(acc, r.cita._id, { fecha: FECHA, hora: '20:00' });
  assert.ok(m.ok);
  const of = await ofertasDe(r.cita._id);
  assert.strictEqual(of.length, 1);
  assert.strictEqual(of[0].lead_id, esperando);
  assert.strictEqual(of[0].hora, '17:00', 'se ofrece la hora que quedó libre, no la nueva');
});

// ── Worker ───────────────────────────────────────────────────────────────────

function espia() {
  const out = { textos: [], plantillas: [] };
  return {
    out,
    deps: {
      enviarTexto: async (p) => { out.textos.push(p.texto); },
      enviarPlantilla: async (p) => { out.plantillas.push(p.tarea.tipo); },
    },
  };
}

test('la oferta sale con el nombre de quien espera y la hora liberada', async () => {
  const acc = await cuenta();
  const dueno = await lead(acc), fer = await lead(acc, 'Fernanda Rojas');
  const r = await agenda.crearCita({ accountId: acc, leadId: dueno, nombre: 'X', fecha: FECHA, hora: '13:00' });
  await espera.registrarInteres({ accountId: acc, leadId: fer, nombre: 'Fernanda Rojas', fecha: FECHA, hora: '13:00' });
  await db.insert(db.messages, { lead_id: fer, role: 'user', content: '¿tienes a las 13?' });  // ventana abierta
  await agenda.cambiarEstado(acc, r.cita._id, 'cancelada');

  const e = espia();
  await ct.procesarCitas(e.deps);
  const texto = e.out.textos.find(t => /Fernanda/.test(t));
  assert.ok(texto, 'le llega a Fernanda');
  assert.ok(!/Rojas/.test(texto), 'solo el primer nombre');
  assert.match(texto, /13:00/);
  assert.match(texto, /reservo/i);
});

test('si otro tomó la hora antes, la oferta pendiente no sale', async () => {
  const acc = await cuenta();
  const dueno = await lead(acc), gabi = await lead(acc, 'Gabi'), otro = await lead(acc, 'Otro');
  const r = await agenda.crearCita({ accountId: acc, leadId: dueno, nombre: 'X', fecha: FECHA, hora: '14:00' });
  await espera.registrarInteres({ accountId: acc, leadId: gabi, nombre: 'Gabi', fecha: FECHA, hora: '14:00' });
  await agenda.cambiarEstado(acc, r.cita._id, 'cancelada');
  // Alguien agenda a mano esa hora antes de que corra el worker.
  const tomada = await agenda.crearCita({ accountId: acc, leadId: otro, nombre: 'Otro', fecha: FECHA, hora: '14:00' });
  assert.ok(tomada.ok);

  const e = espia();
  await ct.procesarCitas(e.deps);
  assert.ok(!e.out.textos.some(t => /Gabi/.test(t)), 'no se le ofrece una hora que ya no existe');
  const t = (await db.find(db.pedidoTasks, { cita_id: r.cita._id, lead_id: gabi, tipo: 'hueco' }))[0];
  assert.strictEqual(t.cancelled, true);
  assert.match(t.reason, /ya se tomó/);
});

// ── Marcador del agente ──────────────────────────────────────────────────────

test('el agente anota a quien pide una hora ocupada y le dice que le avisará', async () => {
  const acc = await cuenta();
  const dueno = await lead(acc), hugo = await lead(acc, 'Hugo');
  await agenda.crearCita({ accountId: acc, leadId: dueno, nombre: 'X', fecha: FECHA, hora: '16:00' });
  const s = await settingsDe(acc);

  const r = await agenda.resolveAgendaMarkers(`dale [AGENDAR: ${FECHA} | 16:00 | Hugo | Corte]`,
    { settings: s, accountId: acc, leadId: hugo, leadName: 'Hugo', leadPhone: '56922222222' });
  assert.match(r.text, /te aviso apenas se libere/);
  const e = await db.find(db.listaEspera, { account_id: acc, lead_id: hugo });
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].hora, '16:00');
  assert.strictEqual(e[0].estado, 'esperando');

  // Fuera del horario no es "ocupada": no se anota ni se promete aviso.
  const fuera = await agenda.resolveAgendaMarkers(`[AGENDAR: ${FECHA} | 23:30 | Hugo | Corte]`,
    { settings: s, accountId: acc, leadId: hugo, leadName: 'Hugo' });
  assert.ok(!/te aviso/.test(fuera.text));
});

test('agendar saca a la persona de la lista de ese día', async () => {
  const acc = await cuenta();
  const ines = await lead(acc, 'Inés');
  await espera.registrarInteres({ accountId: acc, leadId: ines, nombre: 'Inés', fecha: FECHA, hora: '11:00' });
  const s = await settingsDe(acc);
  const r = await agenda.resolveAgendaMarkers(`[AGENDAR: ${FECHA} | 12:00 | Inés | Corte]`,
    { settings: s, accountId: acc, leadId: ines, leadName: 'Inés' });
  assert.match(r.text, /confirmado/);
  assert.strictEqual((await espera.delDia(acc, FECHA)).filter(x => x.lead_id === ines).length, 0,
    'ya no aparece esperando');
});

test('el panel ve la lista del día, y la colección entra en la supresión', async () => {
  const acc = await cuenta();
  const j = await lead(acc, 'Juan'), k = await lead(acc, 'Kari');
  await espera.registrarInteres({ accountId: acc, leadId: j, nombre: 'Juan', fecha: FECHA, hora: '20:00', telefono: '56933333333' });
  await espera.registrarInteres({ accountId: acc, leadId: k, nombre: 'Kari', fecha: FECHA, hora: '18:00' });
  const dia = await espera.delDia(acc, FECHA);
  assert.deepStrictEqual(dia.map(x => x.nombre), ['Kari', 'Juan'], 'ordenado por la hora que pidió');
  assert.strictEqual(dia[1].telefono, '56933333333');
  assert.ok(POR_CUENTA.some(([col, campo]) => col === 'listaEspera' && campo === 'account_id'));
});
