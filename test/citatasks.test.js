/**
 * Atinov — Playbook de cita (vertical barberías)
 *
 * El caso que lo define: el amigo barbero de Brayan corta de 17 a 21, a veces
 * atrasado, y pierde horas porque la gente se olvida. Lo que se fija acá:
 *  - los tiempos se anclan a la cita en hora de Chile, con cambio de hora incluido;
 *  - un paso cuyo momento ya pasó NO se agenda (nada de confirmar a las 08:00
 *    una cita creada a las 19:00 del mismo día);
 *  - cancelada y no vino apagan lo pendiente; atendida arma el después;
 *  - reprogramar bota los recordatorios de la hora vieja y rearma;
 *  - un atraso corre el recordatorio los mismos minutos;
 *  - el worker respeta manejo humano, estado de la cita y falta de plantilla;
 *  - sin plantilla y fuera de la ventana de 24 h, avisa en el hilo y no manda.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-citatasks-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const core = require('../services/agendaCore');
const db = require('../db/database');
const ct = require('../services/citaTasks');

const SET_ON = {
  agenda_playbook_enabled: true,
  agenda_confirmar_hora: '08:00',
  agenda_recordar_horas: 2,
  agenda_feedback_horas: 1,
  agenda_volver_dias: 21,
  agenda_template_confirmar: 'cita_confirmar',
  agenda_template_recordar: 'cita_recordar',
  agenda_template_feedback: 'cita_feedback',
  agenda_template_volver: 'cita_volver',
};

/** Una cita suelta, con los ids que el worker necesita. */
async function nuevaCita(over = {}) {
  const doc = {
    _id: 'cita-' + crypto.randomUUID(),
    account_id: over.account_id || 'acc-1',
    lead_id: over.lead_id === undefined ? 'lead-1' : over.lead_id,
    nombre: 'Matías Soto', telefono: '+56911111111',
    fecha: '2026-12-15', hora: '19:00', servicio: 'Corte', duracion_min: 30,
    estado: 'agendada', origen: 'agente',
    createdAt: new Date().toISOString(),
    ...over,
  };
  await db.insert(db.citas, doc);
  return db.findOne(db.citas, { _id: doc._id });
}

const pasos = (citaId) => db.find(db.pedidoTasks, { cita_id: citaId });
const vivos = async (citaId) => (await pasos(citaId)).filter(t => !t.cancelled && !t.sent_at);

// ── Núcleo horario ───────────────────────────────────────────────────────────

test('la hora de Chile se ancla bien en verano y en invierno', () => {
  // Chile usa UTC-3 en verano (septiembre a abril) y UTC-4 en invierno.
  assert.strictEqual(core.instanteChile('2026-12-15', '19:00'), '2026-12-15T22:00:00.000Z');
  assert.strictEqual(core.instanteChile('2026-07-15', '19:00'), '2026-07-15T23:00:00.000Z');
  assert.strictEqual(core.offsetChileMin(new Date('2026-12-15T22:00:00Z')), -180);
  assert.strictEqual(core.offsetChileMin(new Date('2026-07-15T23:00:00Z')), -240);
});

test('fecha u hora inválida devuelve null en vez de una fecha inventada', () => {
  // El patrón por sí solo deja pasar "2026-13-40", que Date.UTC desborda en
  // silencio a febrero de 2027: un recordatorio dos meses tarde.
  assert.strictEqual(core.instanteChile('2026-13-40', '19:00'), null);
  assert.strictEqual(core.instanteChile('2026-02-30', '19:00'), null);
  assert.strictEqual(core.instanteChile('2026-12-15', '99:99'), null);
  assert.strictEqual(core.instanteChile('', ''), null);
  assert.strictEqual(core.instanteChile(null, null), null);
  assert.ok(core.instanteChile('2028-02-29', '19:00'), 'el 29 de febrero bisiesto sí existe');
});

// ── Configuración ────────────────────────────────────────────────────────────

test('la configuración cae en valores sanos y es opt-in', () => {
  const off = ct.configDe({});
  assert.strictEqual(off.activo, false, 'apagado por defecto');
  assert.strictEqual(off.confirmarHora, '08:00');
  assert.strictEqual(off.recordarHoras, 2);
  assert.strictEqual(off.volverDias, 21);
  assert.strictEqual(off.incentivoVolver, null, 'no promete nada que el dueño no escribió');

  const raro = ct.configDe({ agenda_confirmar_hora: '99:99', agenda_recordar_horas: -5 });
  assert.strictEqual(raro.confirmarHora, '08:00', 'hora basura → default');
  assert.strictEqual(raro.recordarHoras, 2, 'número basura → default');

  assert.deepStrictEqual(ct.plantillasFaltantes({}), [], 'apagado no reclama plantillas');
  const faltan = ct.plantillasFaltantes({ agenda_playbook_enabled: true, agenda_template_recordar: 'x' });
  assert.ok(faltan.includes('confirmar_dia') && faltan.includes('volver'));
  assert.ok(!faltan.includes('recordar'));
});

// ── Agendamiento ─────────────────────────────────────────────────────────────

test('una cita futura arma confirmación del día y recordatorio', async () => {
  const cita = await nuevaCita();
  const r = await ct.alCrearCita(cita, SET_ON, new Date('2026-12-10T12:00:00Z'));
  assert.strictEqual(r.agendadas, 2);

  const t = await vivos(cita._id);
  const conf = t.find(x => x.tipo === 'confirmar_dia');
  const rec  = t.find(x => x.tipo === 'recordar');
  assert.strictEqual(conf.scheduled_for, '2026-12-15T11:00:00.000Z', '08:00 de Chile');
  assert.strictEqual(rec.scheduled_for,  '2026-12-15T20:00:00.000Z', 'dos horas antes de las 19:00');
  assert.strictEqual(conf.categoria, 'utility');
  assert.strictEqual(conf.origen, 'cita', 'el worker de citas filtra por esto');
});

test('no se agenda un paso cuyo momento ya pasó', async () => {
  const cita = await nuevaCita();
  // Se agenda el mismo día a las 18:00 de Chile: las 08:00 ya pasaron.
  const r = await ct.alCrearCita(cita, SET_ON, new Date('2026-12-15T21:00:00Z'));
  assert.strictEqual(r.agendadas, 0, 'ni la confirmación ni el recordatorio (faltaba 1 h)');
  assert.strictEqual((await vivos(cita._id)).length, 0);
});

test('apagado no agenda nada, y una cita sin conversación tampoco', async () => {
  const a = await nuevaCita();
  assert.strictEqual((await ct.alCrearCita(a, {}, new Date('2026-12-10T12:00:00Z'))).agendadas, 0);
  const b = await nuevaCita({ lead_id: null });
  const r = await ct.alCrearCita(b, SET_ON, new Date('2026-12-10T12:00:00Z'));
  assert.strictEqual(r.agendadas, 0);
  assert.match(r.ignorado, /sin conversación/);
});

test('no duplica pasos si la cita pasa dos veces por el playbook', async () => {
  const cita = await nuevaCita();
  const ahora = new Date('2026-12-10T12:00:00Z');
  await ct.alCrearCita(cita, SET_ON, ahora);
  await ct.alCrearCita(cita, SET_ON, ahora);
  assert.strictEqual((await vivos(cita._id)).length, 2);
});

// ── Cambios de estado ────────────────────────────────────────────────────────

test('cancelada y no vino apagan todo lo pendiente', async () => {
  for (const estado of ['cancelada', 'no_vino']) {
    const cita = await nuevaCita();
    await ct.alCrearCita(cita, SET_ON, new Date('2026-12-10T12:00:00Z'));
    assert.strictEqual((await vivos(cita._id)).length, 2);

    await db.update(db.citas, { _id: cita._id }, { estado });
    const r = await ct.alCambiarEstado(await db.findOne(db.citas, { _id: cita._id }), SET_ON);
    assert.strictEqual(r.canceladas, 2, estado);
    assert.strictEqual((await vivos(cita._id)).length, 0, estado);
  }
});

test('atendida apaga el recordatorio y arma el después', async () => {
  const cita = await nuevaCita();
  await ct.alCrearCita(cita, SET_ON, new Date('2026-12-10T12:00:00Z'));
  await db.update(db.citas, { _id: cita._id }, { estado: 'atendida' });

  const r = await ct.alCambiarEstado(
    await db.findOne(db.citas, { _id: cita._id }), SET_ON, new Date('2026-12-15T22:45:00Z'));
  assert.strictEqual(r.agendadas, 2);

  const t = await vivos(cita._id);
  assert.deepStrictEqual(t.map(x => x.tipo).sort(), ['feedback', 'volver']);
  const fb = t.find(x => x.tipo === 'feedback');
  const vv = t.find(x => x.tipo === 'volver');
  // fin = 19:00 + 30 min = 19:30 Chile = 22:30Z; feedback a +1 h, volver a +21 días.
  assert.strictEqual(fb.scheduled_for, '2026-12-15T23:30:00.000Z');
  assert.strictEqual(vv.scheduled_for, '2027-01-05T22:30:00.000Z');
  assert.strictEqual(vv.categoria, 'marketing', 'la invitación a volver gasta cupo de marketing');
  assert.strictEqual(fb.categoria, 'utility');
});

test('una cita vieja marcada atendida hoy manda el feedback altiro, no en el pasado', async () => {
  // La cita fue hace más de 21 días, así que la invitación a volver ya venció.
  const cita = await nuevaCita({ estado: 'atendida', fecha: '2026-10-01' });
  const ahora = new Date('2026-12-20T15:00:00Z');
  await ct.alCambiarEstado(cita, SET_ON, ahora);
  const t = await vivos(cita._id);
  const fb = t.find(x => x.tipo === 'feedback');
  assert.ok(fb, 'el feedback sí sale');
  assert.strictEqual(fb.scheduled_for, ahora.toISOString());
  assert.ok(!t.find(x => x.tipo === 'volver'), 'la invitación a volver ya venció: no se agenda');
});

test('reprogramar bota los recordatorios viejos y rearma sobre la hora nueva', async () => {
  const cita = await nuevaCita();
  await ct.alCrearCita(cita, SET_ON, new Date('2026-12-10T12:00:00Z'));
  await db.update(db.citas, { _id: cita._id }, { fecha: '2026-12-18', hora: '20:00' });

  const r = await ct.alReprogramar(
    await db.findOne(db.citas, { _id: cita._id }), SET_ON, new Date('2026-12-10T12:00:00Z'));
  assert.strictEqual(r.agendadas, 2);

  const t = await vivos(cita._id);
  assert.strictEqual(t.length, 2, 'los de la hora vieja quedaron cancelados');
  assert.strictEqual(t.find(x => x.tipo === 'recordar').scheduled_for, '2026-12-18T21:00:00.000Z');
  const cancelados = (await pasos(cita._id)).filter(x => x.cancelled);
  assert.strictEqual(cancelados.length, 2);
  assert.match(cancelados[0].reason, /reprogramada/);
});

// ── Atraso ───────────────────────────────────────────────────────────────────

test('un atraso corre el recordatorio los mismos minutos', async () => {
  const cita = await nuevaCita();
  await ct.alCrearCita(cita, SET_ON, new Date('2026-12-10T12:00:00Z'));
  const antes = (await vivos(cita._id)).find(x => x.tipo === 'recordar').scheduled_for;

  const r = await ct.alRegistrarAtraso(cita.account_id, 30, [cita]);
  assert.strictEqual(r.corridas, 1);

  const t = await vivos(cita._id);
  const rec = t.find(x => x.tipo === 'recordar');
  assert.strictEqual(new Date(rec.scheduled_for) - new Date(antes), 30 * 60000);
  assert.strictEqual(rec.corrida_por_atraso, 30);
  assert.strictEqual(t.find(x => x.tipo === 'confirmar_dia').scheduled_for,
    '2026-12-15T11:00:00.000Z', 'la confirmación del día no se toca');

  assert.strictEqual((await ct.alRegistrarAtraso(cita.account_id, 0, [cita])).corridas, 0);
  assert.strictEqual((await ct.alRegistrarAtraso(cita.account_id, 30, [])).corridas, 0);
});

// ── Textos ───────────────────────────────────────────────────────────────────

test('los textos llevan la hora real y solo el primer nombre', () => {
  const cita = { nombre: 'Matías Soto Pérez', hora: '19:00', fecha: '2026-12-15', servicio: 'Corte + barba' };
  const cfg = ct.configDe(SET_ON);
  const conf = ct.textoDe('confirmar_dia', cita, cfg);
  assert.match(conf, /Matías/);
  assert.ok(!conf.includes('Soto'), 'solo el primer nombre');
  assert.match(conf, /19:00/);
  assert.match(ct.textoDe('recordar', cita, cfg), /en 2 horas/);
  assert.match(ct.textoDe('recordar', cita, ct.configDe({ ...SET_ON, agenda_recordar_horas: 1 })), /en una hora/);
  assert.match(ct.textoDe('feedback', cita, cfg), /corte \+ barba/i);

  const sinPromo = ct.textoDe('volver', cita, cfg);
  assert.ok(!/descuento|%/.test(sinPromo), 'no inventa promociones');
  const conPromo = ct.textoDe('volver', cita, ct.configDe({ ...SET_ON, agenda_incentivo_volver: 'Esta semana sale al mismo precio.' }));
  assert.match(conPromo, /mismo precio/);
});

// ── Worker ───────────────────────────────────────────────────────────────────

/** Cuenta + lead listos para que el worker pueda enviar. */
async function escenario(over = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  const leadId = 'lead-' + crypto.randomUUID();
  await db.insert(db.accounts, {
    _id: accountId, wa_phone_number_id: 'pn', wa_access_token: 'tok', nombre_negocio: 'Barbería',
  });
  await db.insert(db.leads, {
    _id: leadId, account_id: accountId, wa_id: '56911111111',
    automation: 'automated', is_bypassed: false, ...(over.lead || {}),
  });
  await db.insert(db.settings, { account_id: accountId, ...SET_ON, ...(over.settings || {}) });
  const cita = await nuevaCita({ account_id: accountId, lead_id: leadId, ...(over.cita || {}) });
  return { accountId, leadId, cita };
}

/** Transporte falso: registra en vez de llamar a Meta. */
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

test('dentro de la ventana de 24 h manda texto con la hora real', async () => {
  const { leadId, cita } = await escenario();
  await db.insert(db.messages, { lead_id: leadId, role: 'user', content: 'hola' });
  await ct.agendarPaso({
    accountId: cita.account_id, leadId, citaId: cita._id,
    tipo: 'recordar', cuandoIso: new Date(Date.now() - 60000).toISOString(),
  });

  const e = espia();
  const r = await ct.procesarCitas(e.deps);
  assert.strictEqual(r.enviadas, 1);
  assert.strictEqual(e.out.plantillas.length, 0);
  assert.match(e.out.textos[0], /19:00/);

  const t = (await pasos(cita._id))[0];
  assert.ok(t.sent_at, 'queda marcada como enviada');
  const hilo = await db.find(db.messages, { lead_id: leadId, playbook_tipo: 'cita_recordar' });
  assert.strictEqual(hilo.length, 1, 'queda en el hilo para que el agente lo vea');
});

test('fuera de la ventana usa plantilla, y sin plantilla avisa y no manda', async () => {
  const conPlantilla = await escenario();
  await ct.agendarPaso({
    accountId: conPlantilla.cita.account_id, leadId: conPlantilla.leadId, citaId: conPlantilla.cita._id,
    tipo: 'recordar', cuandoIso: new Date(Date.now() - 60000).toISOString(),
  });
  let e = espia();
  await ct.procesarCitas(e.deps);
  assert.deepStrictEqual(e.out.plantillas, ['recordar']);
  assert.strictEqual(e.out.textos.length, 0);

  const sinPlantilla = await escenario({ settings: { agenda_template_recordar: null } });
  await ct.agendarPaso({
    accountId: sinPlantilla.cita.account_id, leadId: sinPlantilla.leadId, citaId: sinPlantilla.cita._id,
    tipo: 'recordar', cuandoIso: new Date(Date.now() - 60000).toISOString(),
  });
  e = espia();
  await ct.procesarCitas(e.deps);
  assert.strictEqual(e.out.plantillas.length, 0, 'no manda nada');
  const aviso = await db.find(db.messages, { lead_id: sinPlantilla.leadId, role: 'sistema' });
  assert.ok(aviso.some(m => /plantilla configurada/.test(m.content)), 'avisa en el hilo');
  const t = (await pasos(sinPlantilla.cita._id))[0];
  assert.ok(t.cancelled);
});

test('el worker respeta el manejo humano y el estado de la cita', async () => {
  const humano = await escenario({ lead: { is_bypassed: true } });
  await ct.agendarPaso({
    accountId: humano.cita.account_id, leadId: humano.leadId, citaId: humano.cita._id,
    tipo: 'recordar', cuandoIso: new Date(Date.now() - 60000).toISOString(),
  });
  const cancelada = await escenario();
  await db.update(db.citas, { _id: cancelada.cita._id }, { estado: 'cancelada' });
  await ct.agendarPaso({
    accountId: cancelada.cita.account_id, leadId: cancelada.leadId, citaId: cancelada.cita._id,
    tipo: 'recordar', cuandoIso: new Date(Date.now() - 60000).toISOString(),
  });

  const e = espia();
  await ct.procesarCitas(e.deps);
  assert.strictEqual(e.out.textos.length + e.out.plantillas.length, 0, 'ninguno de los dos sale');
  assert.match((await pasos(humano.cita._id))[0].reason, /manejo humano/);
  assert.match((await pasos(cancelada.cita._id))[0].reason, /cancelada/);
});

test('el worker apagado cancela sus propias tareas', async () => {
  const s = await escenario({ settings: { agenda_playbook_enabled: false } });
  await ct.agendarPaso({
    accountId: s.cita.account_id, leadId: s.leadId, citaId: s.cita._id,
    tipo: 'recordar', cuandoIso: new Date(Date.now() - 60000).toISOString(),
  });
  const e = espia();
  await ct.procesarCitas(e.deps);
  assert.strictEqual(e.out.textos.length + e.out.plantillas.length, 0);
  assert.match((await pasos(s.cita._id))[0].reason, /apagado/);
});

test('el worker de citas no toca las tareas del playbook de pedidos', async () => {
  const s = await escenario();
  await db.insert(db.pedidoTasks, {
    _id: 'tarea-pedido-1', account_id: s.accountId, lead_id: s.leadId, order_id: 'o1',
    tipo: 'tracking', categoria: 'utility', prioridad: 0,
    scheduled_for: new Date(Date.now() - 60000).toISOString(), sent_at: null, cancelled: false,
  });
  const e = espia();
  await ct.procesarCitas(e.deps);
  const pedido = await db.findOne(db.pedidoTasks, { _id: 'tarea-pedido-1' });
  assert.strictEqual(pedido.sent_at, null);
  assert.strictEqual(pedido.cancelled, false);
});
