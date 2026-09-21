/**
 * Atinov — Agenda propia: el núcleo PURO (sin db, sin red, sin reloj propio)
 *
 * POR QUÉ EXISTE: el primer cliente laboratorio de barberías (amigo de Brayan,
 * 2026-09-19) atiende con horario VARIABLE — cuida a su mamá en la mañana y
 * corta de 17:00 a 21:00, a veces atrasado. Google Calendar entiende
 * "ocupado/libre", no "hoy atiendo de 17 a 21 y voy 20 minutos tarde". Esta
 * agenda sí: horario semanal por defecto, excepciones por fecha, servicios con
 * duración, y un atraso del día que corre todo lo que falta.
 *
 * Todo lo que decide (ventanas del día, cupos libres, si una hora es válida,
 * qué cambia con un atraso) vive acá y se testea sin base de datos. La
 * persistencia y el marcador [AGENDAR] están en services/agenda.js.
 *
 * Convenciones: fechas "YYYY-MM-DD", horas "HH:MM", minutos desde medianoche
 * como enteros, semana 0=domingo … 6=sábado (como Date#getDay).
 */

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Configuración con la que parte una cuenta (todo editable desde el panel). */
function configPorDefecto() {
  return {
    activa: false,
    paso_min: 15,                 // los cupos se ofrecen cada 15 min
    buffer_min: 0,                // colchón entre citas
    // Horario semanal: por día, lista de rangos "HH:MM-HH:MM". Vacío = cerrado.
    horario: { 0: [], 1: ['17:00-21:00'], 2: ['17:00-21:00'], 3: ['17:00-21:00'], 4: ['17:00-21:00'], 5: ['17:00-21:00'], 6: ['10:00-14:00'] },
    // Excepciones por fecha: "YYYY-MM-DD": [] (cerrado) o ["10:00-14:00", ...]
    excepciones: {},
    servicios: [{ nombre: 'Corte', min: 30, precio: 12000 }],
    atraso: { fecha: null, minutos: 0 },   // "hoy voy 20 min tarde"
    max_dias_adelante: 30,
  };
}

const LIMPIA = (v, n) => String(v || '').trim().slice(0, n);

/** Deja una configuración segura para guardar: tipos, topes, rangos válidos. */
function sanearConfig(raw) {
  const base = configPorDefecto();
  if (!raw || typeof raw !== 'object') return base;
  const c = { ...base };
  c.activa = raw.activa === true;
  c.paso_min = [10, 15, 20, 30, 60].includes(Number(raw.paso_min)) ? Number(raw.paso_min) : base.paso_min;
  c.buffer_min = Math.max(0, Math.min(60, Number(raw.buffer_min) || 0));
  c.max_dias_adelante = Math.max(1, Math.min(90, Number(raw.max_dias_adelante) || base.max_dias_adelante));

  const horario = {};
  for (let d = 0; d <= 6; d++) {
    const src = raw.horario && raw.horario[d] !== undefined ? raw.horario[d] : base.horario[d];
    horario[d] = sanearRangos(src);
  }
  c.horario = horario;

  const exc = {};
  if (raw.excepciones && typeof raw.excepciones === 'object') {
    for (const [fecha, rangos] of Object.entries(raw.excepciones).slice(0, 120)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
      exc[fecha] = sanearRangos(rangos);
    }
  }
  c.excepciones = exc;

  const servicios = Array.isArray(raw.servicios) ? raw.servicios : base.servicios;
  c.servicios = servicios
    .filter(s => s && LIMPIA(s.nombre, 1))
    .slice(0, 30)
    .map(s => ({
      nombre: LIMPIA(s.nombre, 60),
      min: Math.max(10, Math.min(240, Number(s.min) || 30)),
      precio: Math.max(0, Number(s.precio) || 0),
    }));
  if (!c.servicios.length) c.servicios = base.servicios;

  const a = raw.atraso && typeof raw.atraso === 'object' ? raw.atraso : {};
  c.atraso = {
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(a.fecha || '')) ? a.fecha : null,
    minutos: Math.max(0, Math.min(240, Number(a.minutos) || 0)),
  };
  return c;
}

function sanearRangos(lista) {
  if (!Array.isArray(lista)) return [];
  const out = [];
  for (const r of lista.slice(0, 6)) {
    const m = String(r || '').match(/^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/);
    if (!m) continue;
    const a = aMinutos(m[1]), b = aMinutos(m[2]);
    if (a === null || b === null || b <= a) continue;
    out.push(`${deMinutos(a)}-${deMinutos(b)}`);
  }
  return out.sort();
}

function aMinutos(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function deMinutos(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Día de la semana (0-6) de una fecha "YYYY-MM-DD", sin depender de la zona horaria del servidor. */
function diaSemana(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function sumarDias(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** "sáb 20 sep" — para hablarle a una persona. */
function fechaLegible(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return `${DIAS[diaSemana(fecha)]} ${d} ${MESES[m - 1]}`;
}

/**
 * Minutos que Chile va por delante de UTC en un instante dado (negativo).
 * Se saca formateando el instante en América/Santiago y comparando, así el
 * cambio de hora lo resuelve la base de datos horaria del sistema y no una
 * constante que se equivoca medio año.
 */
function offsetChileMin(instante) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante)) p[x.type] = x.value;
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((comoUtc - instante.getTime()) / 60000);
}

/**
 * Instante real (ISO en UTC) de una fecha "YYYY-MM-DD" y una hora "HH:MM" de
 * Chile. Dos pasadas: la primera estima el offset, la segunda lo confirma con
 * el instante ya corregido — así el día del cambio de hora también cae bien.
 * Devuelve null si la fecha o la hora no son válidas.
 */
function instanteChile(fecha, hora) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return null;
  const min = aMinutos(hora);
  if (min === null) return null;
  const [y, m, d] = fecha.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  // El formato no basta: "2026-13-40" pasa el patrón y Date.UTC lo desborda
  // silenciosamente a febrero del año siguiente. Se verifica que la fecha
  // construida sea la misma que pidieron.
  const chk = new Date(base);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
  let ts = base;
  for (let i = 0; i < 2; i++) ts = base - offsetChileMin(new Date(ts)) * 60000;
  return new Date(ts).toISOString();
}

/** Ventanas de atención de un día como [[iniMin, finMin], ...]. La excepción manda. */
function ventanasDelDia(cfg, fecha) {
  const rangos = cfg.excepciones && Object.prototype.hasOwnProperty.call(cfg.excepciones, fecha)
    ? cfg.excepciones[fecha]
    : (cfg.horario[diaSemana(fecha)] || []);
  return rangos.map(r => r.split('-').map(aMinutos)).filter(([a, b]) => a !== null && b !== null && b > a);
}

function atrasoDe(cfg, fecha) {
  return cfg.atraso && cfg.atraso.fecha === fecha ? Number(cfg.atraso.minutos) || 0 : 0;
}

/**
 * Intervalos ocupados del día a partir de las citas activas. Con atraso, las
 * citas de HOY que todavía no pasan se corren: el barbero va tarde y todo lo
 * que sigue también.
 */
function ocupadosDe(citas, cfg, fecha, ahoraMin = null) {
  const atraso = atrasoDe(cfg, fecha);
  const out = [];
  for (const c of citas || []) {
    if (c.fecha !== fecha) continue;
    if (['cancelada', 'no_vino', 'atendida'].includes(c.estado)) continue;
    const ini = aMinutos(c.hora);
    if (ini === null) continue;
    const dur = Math.max(10, Number(c.duracion_min) || 30);
    const corr = atraso && (ahoraMin === null || ini + dur > ahoraMin - atraso) ? atraso : 0;
    out.push([ini + corr, ini + corr + dur + (Number(cfg.buffer_min) || 0)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Cupos libres de un día para un servicio de `duracion` minutos.
 * `ahoraMin` (minutos de hoy, hora Chile) excluye lo que ya pasó; null = día futuro.
 */
function cuposDisponibles(cfg, fecha, citas, { duracion = 30, ahoraMin = null } = {}) {
  const ventanas = ventanasDelDia(cfg, fecha);
  if (!ventanas.length) return [];
  const paso = Number(cfg.paso_min) || 15;
  const atraso = atrasoDe(cfg, fecha);
  const ocupados = ocupadosDe(citas, cfg, fecha, ahoraMin);
  const desde = ahoraMin === null ? -1 : ahoraMin + atraso + 5;   // 5 min de margen para llegar
  const cupos = [];
  for (const [ini, fin] of ventanas) {
    const finReal = fin + atraso;                                   // el día se estira con el atraso
    for (let t = ini; t + duracion <= finReal; t += paso) {
      if (t < desde) continue;
      const choca = ocupados.some(([a, b]) => t < b && t + duracion > a);
      if (!choca) cupos.push(deMinutos(t));
    }
  }
  return cupos;
}

/** ¿Se puede agendar `hora` ese día? Devuelve { ok } o { ok:false, motivo }. */
function validarHora(cfg, fecha, hora, citas, { duracion = 30, ahoraMin = null, hoy = null } = {}) {
  const t = aMinutos(hora);
  if (t === null) return { ok: false, motivo: 'hora inválida' };
  if (hoy && fecha < hoy) return { ok: false, motivo: 'esa fecha ya pasó' };
  if (hoy && fecha > sumarDias(hoy, Number(cfg.max_dias_adelante) || 30)) return { ok: false, motivo: 'demasiado lejos en el futuro' };
  const ventanas = ventanasDelDia(cfg, fecha);
  if (!ventanas.length) return { ok: false, motivo: 'ese día no se atiende' };
  const atraso = atrasoDe(cfg, fecha);
  const dentro = ventanas.some(([ini, fin]) => t >= ini && t + duracion <= fin + atraso);
  if (!dentro) return { ok: false, motivo: 'fuera del horario de atención' };
  if (ahoraMin !== null && t < ahoraMin + atraso) return { ok: false, motivo: 'esa hora ya pasó' };
  const choca = ocupadosDe(citas, cfg, fecha, ahoraMin).some(([a, b]) => t < b && t + duracion > a);
  if (choca) return { ok: false, motivo: 'esa hora ya está tomada' };
  return { ok: true };
}

/** Servicio por nombre (tolerante) o el primero. */
function servicioDe(cfg, nombre) {
  const q = LIMPIA(nombre, 60).toLowerCase();
  const lista = cfg.servicios || [];
  return lista.find(s => s.nombre.toLowerCase() === q)
    || lista.find(s => q && (s.nombre.toLowerCase().includes(q) || q.includes(s.nombre.toLowerCase())))
    || lista[0]
    || { nombre: 'Corte', min: 30, precio: 0 };
}

/**
 * Texto de disponibilidad para el prompt del agente: hoy y los próximos días
 * con atención, con los cupos libres del servicio base. Corto a propósito: es
 * lo que el modelo lee cada turno.
 */
function resumenDisponibilidad(cfg, hoy, ahoraMin, citas, { dias = 7 } = {}) {
  const dur = (cfg.servicios && cfg.servicios[0] && cfg.servicios[0].min) || 30;
  const lineas = [];
  for (let i = 0; i < dias; i++) {
    const f = sumarDias(hoy, i);
    if (!ventanasDelDia(cfg, f).length) continue;
    const cupos = cuposDisponibles(cfg, f, citas, { duracion: dur, ahoraMin: i === 0 ? ahoraMin : null });
    const etiqueta = i === 0 ? `hoy ${fechaLegible(f)}` : i === 1 ? `mañana ${fechaLegible(f)}` : fechaLegible(f);
    lineas.push(`- ${etiqueta} (${f}): ${cupos.length ? cupos.join(', ') : 'sin cupos'}`);
  }
  const atraso = atrasoDe(cfg, hoy);
  if (atraso) lineas.push(`(hoy el barbero va ${atraso} min atrasado: las horas de arriba ya lo consideran)`);
  return lineas.join('\n');
}

/** Citas que cambian de hora efectiva por un atraso de hoy (para avisarles). */
function afectadasPorAtraso(citas, hoy, ahoraMin, minutos) {
  return (citas || [])
    .filter(c => c.fecha === hoy && ['agendada', 'confirmada'].includes(c.estado))
    .filter(c => { const t = aMinutos(c.hora); return t !== null && t + Math.max(10, Number(c.duracion_min) || 30) > ahoraMin; })
    .map(c => ({ ...c, hora_estimada: deMinutos(aMinutos(c.hora) + minutos) }))
    .sort((a, b) => aMinutos(a.hora) - aMinutos(b.hora));
}

// Marcador del agente. Compatible con el de Google Calendar:
//   [AGENDAR: YYYY-MM-DD | HH:MM | nombre | servicio]
//   [AGENDAR: YYYY-MM-DD | HH:MM | nombre | servicio | minutos]
const MARKER_RE = /\[AGENDAR:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{1,2}:\d{2})\s*\|\s*([^|\]]*?)\s*\|\s*([^|\]]*?)\s*(?:\|\s*(\d{1,3})\s*)?\]/gi;

module.exports = {
  configPorDefecto, sanearConfig, sanearRangos,
  aMinutos, deMinutos, diaSemana, sumarDias, fechaLegible,
  offsetChileMin, instanteChile,
  ventanasDelDia, ocupadosDe, cuposDisponibles, validarHora, servicioDe,
  resumenDisponibilidad, afectadasPorAtraso, MARKER_RE,
};
