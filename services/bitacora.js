/**
 * Atinov — Bitácora de trabajo (el centro de datos del panel admin)
 *
 * Una entrada por CONVERSACIÓN de trabajo: qué se construyó, qué se decidió,
 * qué commits salieron, qué documentos quedaron y qué pendientes dejó, cada
 * uno con dueño. Es la memoria del proyecto dentro del propio producto, para
 * no depender de acordarse ni de abrir cinco archivos del escritorio.
 *
 * POR QUÉ EXISTE: el trabajo avanza en sesiones largas y disperso entre
 * commits, documentos y decisiones habladas. Cuando pasa una semana nadie
 * recuerda por qué se eligió algo ni qué quedó a medias, y se vuelve a
 * discutir lo ya discutido. Acá queda en un solo lugar, ordenado por fecha y
 * con los pendientes vivos arriba.
 *
 * Es SOLO para el dueño de Atinov (rutas bajo /api/admin): no habla de
 * clientes ni de sus datos, habla del producto.
 *
 * Módulo con db pero sin red: se puede testear entero.
 */

const db = require('../db/database');

/** Quién tiene que mover cada pendiente. Cualquier otro valor cae en 'brayan'. */
const DUENOS = ['brayan', 'claude'];

const texto = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

/** Lista de strings: limpia vacíos, recorta y topea la cantidad. */
function lista(v, maxItems = 40, maxLargo = 400) {
  if (!Array.isArray(v)) return [];
  return v.map(x => texto(x, maxLargo)).filter(Boolean).slice(0, maxItems);
}

/**
 * Pendientes: texto + dueño + si está listo. Acepta strings sueltos para que
 * cargar una entrada a mano no obligue a escribir objetos.
 */
function pendientesDe(v) {
  if (!Array.isArray(v)) return [];
  return v.map((p, i) => {
    const o = typeof p === 'string' ? { texto: p } : (p || {});
    const t = texto(o.texto, 400);
    if (!t) return null;
    return {
      id: texto(o.id, 40) || `p${i}`,
      texto: t,
      de: DUENOS.includes(String(o.de || '').toLowerCase()) ? String(o.de).toLowerCase() : 'brayan',
      listo: o.listo === true,
    };
  }).filter(Boolean).slice(0, 40);
}

/** Normaliza una entrada venga de donde venga. La fecha inválida cae en hoy. */
function sanear(raw = {}) {
  const hoy = require('./limits').hoyChile();
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.fecha || '')) ? raw.fecha : hoy;
  return {
    fecha,
    titulo:     texto(raw.titulo, 160) || 'Sesión de trabajo',
    resumen:    texto(raw.resumen, 2000),
    chat:       texto(raw.chat, 200) || null,
    commits:    lista(raw.commits, 20, 80),
    construido: lista(raw.construido),
    decisiones: lista(raw.decisiones),
    documentos: lista(raw.documentos, 40, 200),
    pendientes: pendientesDe(raw.pendientes),
  };
}

async function crear(raw) {
  const doc = sanear(raw);
  // Una conversación se guarda una sola vez: si ya existe una entrada con el
  // mismo título y fecha, se actualiza en vez de duplicar.
  const previa = await db.findOne(db.bitacora, { fecha: doc.fecha, titulo: doc.titulo });
  if (previa) {
    await db.update(db.bitacora, { _id: previa._id }, doc);
    return { ...previa, ...doc, actualizada: true };
  }
  return db.insert(db.bitacora, doc);
}

/** Actualiza campos sueltos de una entrada. Devuelve null si no existe. */
async function actualizar(id, raw = {}) {
  const previa = await db.findOne(db.bitacora, { _id: String(id || '') });
  if (!previa) return null;
  const upd = {};
  if (raw.titulo !== undefined)     upd.titulo = texto(raw.titulo, 160) || previa.titulo;
  if (raw.resumen !== undefined)    upd.resumen = texto(raw.resumen, 2000);
  if (raw.chat !== undefined)       upd.chat = texto(raw.chat, 200) || null;
  if (raw.fecha !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.fecha))) upd.fecha = raw.fecha;
  if (raw.commits !== undefined)    upd.commits = lista(raw.commits, 20, 80);
  if (raw.construido !== undefined) upd.construido = lista(raw.construido);
  if (raw.decisiones !== undefined) upd.decisiones = lista(raw.decisiones);
  if (raw.documentos !== undefined) upd.documentos = lista(raw.documentos, 40, 200);
  if (raw.pendientes !== undefined) upd.pendientes = pendientesDe(raw.pendientes);
  await db.update(db.bitacora, { _id: previa._id }, upd);
  return db.findOne(db.bitacora, { _id: previa._id });
}

/** Marca un pendiente como listo o lo devuelve a la lista. */
async function marcarPendiente(entradaId, pendienteId, listo) {
  const e = await db.findOne(db.bitacora, { _id: String(entradaId || '') });
  if (!e) return null;
  const ps = (e.pendientes || []);
  const idx = ps.findIndex(p => p.id === String(pendienteId));
  if (idx < 0) return null;
  const nuevos = ps.map((p, i) => (i === idx ? { ...p, listo: listo === true } : p));
  await db.update(db.bitacora, { _id: e._id }, { pendientes: nuevos });
  return db.findOne(db.bitacora, { _id: e._id });
}

async function borrar(id) {
  const e = await db.findOne(db.bitacora, { _id: String(id || '') });
  if (!e) return false;
  await db.remove(db.bitacora, { _id: e._id });
  return true;
}

/**
 * Todo lo que pinta el centro de datos: las entradas de la más nueva a la más
 * vieja, los pendientes abiertos juntos (que es lo que de verdad se mira) y
 * cuatro cifras de cabecera.
 */
async function centro({ limit = 100 } = {}) {
  const todas = await db.find(db.bitacora, {});
  const entradas = todas
    .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || ''))
                 || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, Math.min(Number(limit) || 100, 500));

  const abiertos = [];
  for (const e of entradas) {
    for (const p of (e.pendientes || [])) {
      if (!p.listo) abiertos.push({ ...p, entrada_id: e._id, entrada: e.titulo, fecha: e.fecha });
    }
  }

  const stats = {
    sesiones:    todas.length,
    commits:     [...new Set(todas.flatMap(e => e.commits || []))].length,
    de_brayan:   abiertos.filter(p => p.de === 'brayan').length,
    de_claude:   abiertos.filter(p => p.de === 'claude').length,
    resueltos:   todas.flatMap(e => e.pendientes || []).filter(p => p.listo).length,
    ultima:      entradas[0] ? entradas[0].fecha : null,
  };

  return { stats, abiertos, entradas };
}

module.exports = {
  DUENOS, sanear, crear, actualizar, marcarPendiente, borrar, centro,
};
