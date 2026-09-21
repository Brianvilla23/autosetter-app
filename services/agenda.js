/**
 * Atinov — Agenda propia: persistencia, marcador del agente y atraso
 *
 * Complementa a services/calendar.js (Google). Cuando la cuenta tiene la
 * agenda propia ACTIVA, el agente ve los cupos reales de acá y el marcador
 * [AGENDAR] crea la cita en db.citas (y, si además hay Google Calendar
 * conectado, la espeja allá como mejor esfuerzo para que el barbero la vea
 * en el celular).
 *
 * La lógica pura (cupos, validación, atraso) está en services/agendaCore.js.
 * Fail-closed: sin agenda activa, nada de esto entra al prompt ni resuelve
 * marcadores — el flujo de Google sigue exactamente igual que antes.
 */

const db   = require('../db/database');
const core = require('./agendaCore');

const TZ = 'America/Santiago';

function hoyChile(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(fecha);
}
function ahoraMinChile(fecha = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(fecha);
  const h = Number(p.find(x => x.type === 'hour').value), m = Number(p.find(x => x.type === 'minute').value);
  return h * 60 + m;
}

function configDe(settings) {
  return core.sanearConfig(settings && settings.agenda);
}
function agendaActiva(settings) {
  return configDe(settings).activa === true;
}

async function guardarConfig(accountId, raw) {
  const cfg = core.sanearConfig(raw);
  const settings = await db.findOne(db.settings, { account_id: accountId });
  if (settings) await db.update(db.settings, { _id: settings._id }, { agenda: cfg });
  else await db.insert(db.settings, { account_id: accountId, openai_key: '', agenda: cfg });
  return cfg;
}

const ACTIVAS = ['agendada', 'confirmada'];

/** Citas activas de una cuenta para una fecha (o todas las futuras si no se pasa fecha). */
async function citasDelDia(accountId, fecha) {
  const q = { account_id: accountId };
  if (fecha) q.fecha = fecha;
  const todas = await db.find(db.citas, q);
  return todas.sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}

/**
 * Crea una cita si la hora es válida y libre. Candado contra dos agentes
 * agendando el mismo cupo a la vez: se inserta y DESPUÉS se busca solape con
 * una cita activa más antigua; si la hay, se retira la propia y se devuelve
 * conflicto. NeDB serializa sus operaciones, así que el "más antiguo gana"
 * es determinista.
 */
async function crearCita({ accountId, leadId = null, nombre, telefono = null, fecha, hora, servicio = null, duracionMin = null, origen = 'agente', notas = '' }) {
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const cfg = configDe(settings);
  if (!cfg.activa) return { ok: false, motivo: 'la agenda no está activa' };
  const sv = core.servicioDe(cfg, servicio);
  const duracion = Math.max(10, Math.min(240, Number(duracionMin) || sv.min));
  const hoy = hoyChile();
  const activas = (await citasDelDia(accountId, fecha)).filter(c => ACTIVAS.includes(c.estado));

  // Idempotencia: el mismo lead a la misma hora es la misma cita (doble
  // marcador, o el lead re-confirmando).
  if (leadId) {
    const misma = activas.find(c => c.lead_id === leadId && c.hora === hora);
    if (misma) return { ok: true, cita: misma, repetida: true };
  }

  const v = core.validarHora(cfg, fecha, hora, activas, { duracion, ahoraMin: fecha === hoy ? ahoraMinChile() : null, hoy });
  if (!v.ok) return { ok: false, motivo: v.motivo, alternativas: alternativas(cfg, fecha, activas, duracion, hoy) };

  const cita = await db.insert(db.citas, {
    account_id: accountId, lead_id: leadId,
    nombre: String(nombre || 'Cliente').slice(0, 80),
    telefono: telefono ? String(telefono).replace(/\D/g, '') : null,
    fecha, hora: core.deMinutos(core.aMinutos(hora)),
    servicio: sv.nombre, precio: sv.precio, duracion_min: duracion,
    estado: 'agendada', origen, notas: String(notas || '').slice(0, 300),
    confirmada_at: null, atendida_at: null, cancelada_at: null, cancel_motivo: null,
    google_event_id: null,
  });

  // Recheck de solape tras insertar: si otra activa MÁS ANTIGUA se cruza, se pierde.
  const otras = (await citasDelDia(accountId, fecha)).filter(c => ACTIVAS.includes(c.estado) && c._id !== cita._id);
  const ini = core.aMinutos(cita.hora), fin = ini + duracion + (cfg.buffer_min || 0);
  const choque = otras.find(c => {
    const a = core.aMinutos(c.hora), b = a + Math.max(10, Number(c.duracion_min) || 30) + (cfg.buffer_min || 0);
    return ini < b && fin > a && String(c.createdAt) < String(cita.createdAt);
  });
  if (choque) {
    await db.remove(db.citas, { _id: cita._id }).catch(() => null);
    return { ok: false, motivo: 'esa hora se acaba de tomar', alternativas: alternativas(cfg, fecha, [...otras], duracion, hoy) };
  }

  // Espejo a Google Calendar (mejor esfuerzo): el barbero la ve en el celular.
  try {
    const cal = require('./calendar');
    if (cal.isConfigured() && settings && settings.google_refresh_token && typeof cal.createEvent === 'function') {
      const ev = await cal.createEvent(settings, accountId, { date: fecha, time: cita.hora, minutes: duracion, nombre: cita.nombre, motivo: sv.nombre });
      if (ev && ev.id) await db.update(db.citas, { _id: cita._id }, { google_event_id: ev.id }).catch(() => null);
    }
  } catch (e) { console.warn('[agenda] espejo a Google falló (no bloquea):', e.message); }

  // Playbook de cita: confirmación del día y recordatorio. Mejor esfuerzo —
  // una cita creada vale aunque los recordatorios no se alcancen a armar.
  try {
    await require('./citaTasks').alCrearCita(cita, settings || {});
  } catch (e) { console.warn('[agenda] playbook de cita no agendó (no bloquea):', e.message); }

  return { ok: true, cita };
}

function alternativas(cfg, fecha, activas, duracion, hoy) {
  const ahoraMin = fecha === hoy ? ahoraMinChile() : null;
  const libres = core.cuposDisponibles(cfg, fecha, activas, { duracion, ahoraMin });
  if (libres.length) return { fecha, horas: libres.slice(0, 4) };
  for (let i = 1; i <= 7; i++) {
    const f = core.sumarDias(fecha, i);
    const c = core.cuposDisponibles(cfg, f, [], { duracion });
    if (c.length) return { fecha: f, horas: c.slice(0, 4) };
  }
  return null;
}

async function cambiarEstado(accountId, citaId, estado, extra = {}) {
  const permitidos = ['agendada', 'confirmada', 'atendida', 'no_vino', 'cancelada'];
  if (!permitidos.includes(estado)) return null;
  const cita = await db.findOne(db.citas, { _id: citaId, account_id: accountId });
  if (!cita) return null;
  const upd = { estado };
  const ahora = new Date().toISOString();
  if (estado === 'confirmada') upd.confirmada_at = ahora;
  if (estado === 'atendida')   upd.atendida_at = ahora;
  if (estado === 'cancelada')  { upd.cancelada_at = ahora; upd.cancel_motivo = String(extra.motivo || '').slice(0, 200); }
  await db.update(db.citas, { _id: citaId }, upd);
  const actualizada = await db.findOne(db.citas, { _id: citaId });

  // Atendida arma el feedback y la invitación a volver; cancelada y no_vino
  // apagan lo pendiente. Escribirle a quien ya canceló es la forma más rápida
  // de que el número quede marcado como spam.
  try {
    const settings = await db.findOne(db.settings, { account_id: accountId });
    const ct = require('./citaTasks');
    await ct.alCambiarEstado(actualizada, settings || {});
    // Cancelada con tiempo: la hora queda libre y se le ofrece a quien la
    // estaba esperando. (No vino no libera nada: esa hora ya se perdió.)
    if (estado === 'cancelada' && ACTIVAS.includes(cita.estado)) {
      await ct.alLiberarHora(cita, settings || {});
    }
  } catch (e) { console.warn('[agenda] playbook de cita (estado) no corrió:', e.message); }

  return actualizada;
}

async function reprogramar(accountId, citaId, { fecha, hora }) {
  const cita = await db.findOne(db.citas, { _id: citaId, account_id: accountId });
  if (!cita) return { ok: false, motivo: 'cita no encontrada' };
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const cfg = configDe(settings);
  const hoy = hoyChile();
  const activas = (await citasDelDia(accountId, fecha)).filter(c => ACTIVAS.includes(c.estado) && c._id !== citaId);
  const v = core.validarHora(cfg, fecha, hora, activas, { duracion: cita.duracion_min, ahoraMin: fecha === hoy ? ahoraMinChile() : null, hoy });
  if (!v.ok) return { ok: false, motivo: v.motivo, alternativas: alternativas(cfg, fecha, activas, cita.duracion_min, hoy) };
  await db.update(db.citas, { _id: citaId }, { fecha, hora: core.deMinutos(core.aMinutos(hora)), estado: 'agendada', confirmada_at: null });
  const movida = await db.findOne(db.citas, { _id: citaId });

  // Los recordatorios de la hora vieja ya no sirven: se botan y se rearman. Y
  // la hora vieja queda libre para quien la estaba esperando.
  try {
    const ct = require('./citaTasks');
    await ct.alReprogramar(movida, settings || {});
    if (cita.fecha !== movida.fecha || cita.hora !== movida.hora) {
      await ct.alLiberarHora(cita, settings || {});
    }
  } catch (e) { console.warn('[agenda] playbook de cita (reprogramar) no corrió:', e.message); }

  return { ok: true, cita: movida };
}

/**
 * "Hoy voy N minutos tarde": se guarda en la config y se devuelven las citas
 * que cambian de hora efectiva, para avisarles (el aviso lo manda quien llame).
 */
async function registrarAtraso(accountId, minutos) {
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const cfg = configDe(settings);
  const hoy = hoyChile();
  cfg.atraso = { fecha: hoy, minutos: Math.max(0, Math.min(240, Number(minutos) || 0)) };
  await guardarConfig(accountId, cfg);
  const citas = await citasDelDia(accountId, hoy);
  const afectadas = core.afectadasPorAtraso(citas, hoy, ahoraMinChile(), cfg.atraso.minutos);

  // El recordatorio "en 2 horas" de las citas corridas se mueve los mismos
  // minutos: avisar la hora vieja sería peor que no avisar.
  let corridas = 0, avisadas = 0;
  try {
    const r = await require('./citaTasks').alRegistrarAtraso(
      accountId, cfg.atraso.minutos, afectadas, settings || {});
    corridas = r.corridas || 0;
    avisadas = r.avisadas || 0;
  } catch (e) { console.warn('[agenda] aviso de atraso no salió:', e.message); }

  return { atraso: cfg.atraso, afectadas, recordatorios_corridos: corridas, avisadas };
}

/** Bloque para el prompt del agente. null si la agenda no está activa. */
async function buildAgendaContext(settings, accountId) {
  const cfg = configDe(settings);
  if (!cfg.activa) return null;
  const hoy = hoyChile();
  const citas = await db.find(db.citas, { account_id: accountId, estado: { $in: ACTIVAS } }).catch(() => []);
  const resumen = core.resumenDisponibilidad(cfg, hoy, ahoraMinChile(), citas, { dias: 7 });
  const servicios = cfg.servicios.map(s => `${s.nombre} (${s.min} min${s.precio ? `, $${s.precio.toLocaleString('es-CL')}` : ''})`).join(' · ');
  return [
    '--- AGENDA DEL NEGOCIO (cupos reales, hora de Chile) ---',
    `Hoy es ${core.fechaLegible(hoy)} (${hoy}). Servicios: ${servicios}.`,
    'Cupos libres:',
    resumen || '- sin atención en los próximos días',
    'Ofrece SOLO horas de esta lista. Si la persona pide otra, dile que no está disponible y propón las dos más cercanas.',
    'Cuando la persona ELIJA día y hora de la lista, responde en UNA línea corta seguida del marcador exacto:',
    '[AGENDAR: YYYY-MM-DD | HH:MM | nombre de la persona | servicio]',
    'Ejemplo: "listo, te dejo esa hora 👌 [AGENDAR: 2026-09-22 | 18:30 | Matías | Corte]"',
    'El sistema reemplaza el marcador por la confirmación real. Un solo marcador por mensaje, nunca inventes horas.',
  ].join('\n');
}

/**
 * Reemplaza los marcadores [AGENDAR: ...] por la confirmación real (o por una
 * propuesta de horas si el cupo ya no está). Nunca rompe el mensaje.
 */
async function resolveAgendaMarkers(text, { settings, accountId, leadId, leadName, leadPhone }) {
  if (!text || !/\[AGENDAR/i.test(text)) return { text, citas: [] };
  const cfg = configDe(settings);
  const citas = [];
  let out = text;
  core.MARKER_RE.lastIndex = 0;
  for (const m of [...text.matchAll(core.MARKER_RE)]) {
    const [full, fecha, horaRaw, nombreRaw, servicioRaw, minStr] = m;
    let replacement = '';
    if (cfg.activa) {
      const hora = core.deMinutos(core.aMinutos(horaRaw) ?? -1);
      const r = await crearCita({
        accountId, leadId, nombre: nombreRaw.trim() || leadName || 'Cliente', telefono: leadPhone,
        fecha, hora, servicio: servicioRaw.trim() || null, duracionMin: minStr ? parseInt(minStr, 10) : null, origen: 'agente',
      });
      const espera = require('./listaEspera');
      if (r.ok) {
        replacement = `📅 ${core.fechaLegible(fecha)} a las ${r.cita.hora} — ${r.cita.servicio}, confirmado`;
        await espera.marcarTomado(accountId, leadId, fecha).catch(() => 0);
        if (!r.repetida) {
          citas.push(r.cita);
          await db.insert(db.messages, { lead_id: leadId, account_id: accountId, role: 'sistema', content: `📅 Cita agendada: ${r.cita.servicio} — ${r.cita.nombre}, ${core.fechaLegible(fecha)} ${r.cita.hora}` }).catch(() => null);
        }
      } else if (r.alternativas) {
        // La hora existe pero está ocupada: queda anotado por si se libera.
        let anotado = false;
        if (espera.esOcupada(r.motivo) && leadId) {
          anotado = !!(await espera.registrarInteres({
            accountId, leadId, nombre: nombreRaw.trim() || leadName || 'Cliente', telefono: leadPhone,
            fecha, hora, servicio: servicioRaw.trim() || null,
          }).catch(() => null));
        }
        replacement = `esa hora ya no está disponible 😕 el ${core.fechaLegible(r.alternativas.fecha)} tengo ${r.alternativas.horas.join(', ')} — ¿cuál te acomoda?`
          + (anotado ? ' Si prefieres la que pediste, te aviso apenas se libere.' : '');
      } else {
        replacement = 'esa hora ya no está disponible 😕 ¿te busco otro día?';
      }
    } else {
      console.warn('[agenda] marcador AGENDAR con la agenda propia inactiva — se elimina');
    }
    out = out.replace(full, replacement);
  }
  out = out.replace(/\[AGENDAR[^\]]*\]?/gi, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
  return { text: out, citas };
}

module.exports = {
  hoyChile, ahoraMinChile, configDe, agendaActiva, guardarConfig,
  citasDelDia, crearCita, cambiarEstado, reprogramar, registrarAtraso,
  buildAgendaContext, resolveAgendaMarkers, ACTIVAS,
};
