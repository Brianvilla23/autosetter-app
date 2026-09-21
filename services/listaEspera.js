/**
 * Atinov — Lista de espera de la agenda (vertical barberías)
 *
 * Lo que pidió Brayan: "si el cliente se baja, buscar a otro que haya pedido
 * una hora parecida". La lista de espera NO baja las inasistencias, pero les
 * quita el costo: una hora que se libera a las 16:00 y se vuelve a llenar a
 * las 16:20 no es plata perdida.
 *
 * Cómo se llena: cada vez que alguien pide una hora que ya está tomada, queda
 * anotado su interés (una entrada por persona y por día; si pide otra hora el
 * mismo día, se actualiza). No hace falta que el barbero haga nada.
 *
 * Cómo se usa: cuando una cita futura se cancela o se mueve, se busca a quien
 * pidió una hora cercana ese mismo día, del más cercano al más lejano y, a
 * igual distancia, el que pidió primero. Se le ofrece a varios a la vez: el
 * primero que confirma se la lleva, y el candado de solape de crearCita
 * impide que dos queden con la misma hora.
 *
 * Datos personales (nombre y teléfono) → la colección entra en la cascada de
 * supresión por cuenta.
 */

const db = require('../db/database');
const core = require('./agendaCore');

const DEFAULTS = {
  ventana_min: 60,   // quien pidió las 18:00 sirve para una hora que se libera a las 18:45
  ofrecer_a:   3,    // a cuántos se les ofrece a la vez: el primero que confirma se la lleva
};

/** Motivos de crearCita/validarHora que significan "existe, pero está ocupada". */
const MOTIVOS_OCUPADA = ['esa hora ya está tomada', 'esa hora se acaba de tomar'];

function esOcupada(motivo) {
  return MOTIVOS_OCUPADA.includes(String(motivo || ''));
}

function configDe(settings = {}) {
  const num = (v, d, max) => (Number(v) > 0 && Number(v) <= max ? Number(v) : d);
  return {
    ventanaMin: num(settings.agenda_espera_ventana_min, DEFAULTS.ventana_min, 240),
    ofrecerA:   num(settings.agenda_espera_ofrecer, DEFAULTS.ofrecer_a, 10),
  };
}

/**
 * Anota el interés de una persona en una hora ocupada. Una entrada viva por
 * persona y día: si vuelve a pedir otra hora ese día, se actualiza la hora.
 */
async function registrarInteres({ accountId, leadId, nombre, telefono = null, fecha, hora, servicio = null }) {
  if (!accountId || !leadId || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return null;
  const min = core.aMinutos(hora);
  if (min === null) return null;
  const limpio = {
    hora: core.deMinutos(min),
    servicio: servicio ? String(servicio).slice(0, 80) : null,
    nombre: String(nombre || 'Cliente').slice(0, 80),
    telefono: telefono ? String(telefono).slice(0, 30) : null,
  };
  const previo = await db.findOne(db.listaEspera, {
    account_id: accountId, lead_id: leadId, fecha, estado: 'esperando',
  });
  if (previo) {
    await db.update(db.listaEspera, { _id: previo._id }, limpio);
    return { ...previo, ...limpio, actualizada: true };
  }
  return db.insert(db.listaEspera, {
    account_id: accountId, lead_id: leadId, fecha, estado: 'esperando', ...limpio,
  });
}

/**
 * Ordena candidatos para una hora liberada (puro). Deja solo los que caen
 * dentro de la ventana; primero el más cercano y, empatados, el más antiguo.
 */
function ordenarCandidatos(entradas, hora, ventanaMin = DEFAULTS.ventana_min) {
  const t = core.aMinutos(hora);
  if (t === null) return [];
  return (entradas || [])
    .map(e => ({ ...e, distancia: Math.abs((core.aMinutos(e.hora) ?? 99999) - t) }))
    .filter(e => e.distancia <= ventanaMin)
    .sort((a, b) => (a.distancia - b.distancia)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** Quienes esperan una hora parecida ese día, sin contar a quien la liberó. */
async function candidatosPara({ accountId, fecha, hora, excluirLead = null, ventanaMin }) {
  const todas = await db.find(db.listaEspera, { account_id: accountId, fecha, estado: 'esperando' });
  return ordenarCandidatos(todas.filter(e => e.lead_id !== excluirLead), hora, ventanaMin);
}

/** Marca que a esta entrada ya se le ofreció una hora (no se le vuelve a ofrecer la misma). */
async function marcarOfrecido(esperaId, citaId) {
  await db.update(db.listaEspera, { _id: esperaId }, {
    estado: 'ofrecido', ofrecido_cita_id: citaId, ofrecido_at: new Date().toISOString(),
  }).catch(() => null);
}

/**
 * La persona agendó ese día (por la oferta o por su cuenta): sale de la lista.
 * Cubre las entradas vivas y las ya ofrecidas.
 */
async function marcarTomado(accountId, leadId, fecha) {
  if (!accountId || !leadId || !fecha) return 0;
  const vivas = await db.find(db.listaEspera, { account_id: accountId, lead_id: leadId, fecha });
  let n = 0;
  for (const e of vivas.filter(x => ['esperando', 'ofrecido'].includes(x.estado))) {
    await db.update(db.listaEspera, { _id: e._id }, { estado: 'tomado', tomado_at: new Date().toISOString() })
      .catch(() => null);
    n++;
  }
  return n;
}

/** Para el panel: la lista de espera de un día, ordenada por hora pedida. */
async function delDia(accountId, fecha) {
  const todas = await db.find(db.listaEspera, { account_id: accountId, fecha });
  return todas
    .filter(e => ['esperando', 'ofrecido'].includes(e.estado))
    .sort((a, b) => (core.aMinutos(a.hora) ?? 0) - (core.aMinutos(b.hora) ?? 0))
    .map(e => ({
      id: e._id, nombre: e.nombre, telefono: e.telefono, hora: e.hora,
      servicio: e.servicio, estado: e.estado, lead_id: e.lead_id,
    }));
}

module.exports = {
  DEFAULTS, MOTIVOS_OCUPADA, esOcupada, configDe,
  registrarInteres, ordenarCandidatos, candidatosPara,
  marcarOfrecido, marcarTomado, delDia,
};
