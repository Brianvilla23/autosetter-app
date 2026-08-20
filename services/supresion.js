/**
 * Atinov — Supresión de datos (Ley 21.719 + eliminación de datos de Meta)
 *
 * UNA sola cascada, usada por los dos caminos que borran una cuenta:
 *  - el dueño, desde Ajustes → Eliminar mi cuenta (autoservicio)
 *  - un admin, desde DELETE /api/admin/users/:id
 *
 * Antes la cascada vivía escrita a mano dentro de admin.js y le faltaban
 * colecciones que SÍ guardan dato personal: knowledgeSources, leadMagnets,
 * magnetDeliveries, linkClicks, postRules, improvements, aiUsage y emailLog.
 * La página pública /data-deletion promete que se borran las conversaciones y
 * la base de conocimiento — esto lo cumple de verdad, y al estar en un solo
 * lugar los dos caminos no pueden volver a divergir.
 *
 * LO QUE SOBREVIVE, a propósito:
 *  - billableEvents → retención contable (tributaria chilena). Guarda montos,
 *    no contenido de conversaciones.
 *  - auditLog → rastro administrativo de quién borró qué y cuándo. Es la
 *    prueba de que la supresión ocurrió; borrarlo la haría indemostrable.
 *
 * Ambas excepciones están declaradas en /data-deletion §3, así que lo que
 * hace el código y lo que dice la página pública coinciden.
 */

const db = require('../db/database');

// Las listas viven aparte, sin require de db, para que el test las pueda
// verificar sin cargar NeDB (dos test files abriendo los mismos .db en
// paralelo disparan EPERM en la compactación).
const { POR_CUENTA, POR_USUARIO, CONSERVADO } = require('./supresionPlan');

async function borrar(nombre, query) {
  const store = db[nombre];
  if (!store) return 0;                      // colección que no existe en este entorno
  try {
    return (await db.remove(store, query)) || 0;
  } catch (e) {
    // Un fallo aislado no puede abortar la supresión entera y dejar la cuenta
    // a medio borrar: se anota y se sigue con el resto.
    console.error(`[supresion] falló limpiando ${nombre}: ${e.message}`);
    return 0;
  }
}

/**
 * Borra todos los datos personales de una cuenta.
 *
 * @param {object} args
 * @param {string} args.accountId       cuenta a suprimir
 * @param {string} [args.userId]        usuario dueño (para emailLog/referrals)
 * @param {boolean} [args.borrarUsuario] si además se elimina el login
 * @returns {Promise<{detalle: Object<string,number>, total: number, conservado: object}>}
 */
async function suprimirCuenta({ accountId, userId, borrarUsuario = true }) {
  if (!accountId) throw new Error('suprimirCuenta requiere accountId');

  const detalle = {};

  // Los mensajes cuelgan del lead, no de la cuenta: hay que resolver los ids
  // ANTES de borrar los leads o quedan huérfanos e imposibles de encontrar.
  const leads   = await db.find(db.leads, { account_id: accountId });
  const leadIds = leads.map(l => l._id);
  if (leadIds.length) {
    detalle.messages = await borrar('messages', { lead_id: { $in: leadIds } });
  } else {
    detalle.messages = 0;
  }

  for (const [nombre, campo] of POR_CUENTA) {
    detalle[nombre] = await borrar(nombre, { [campo]: accountId });
  }

  // Los leads van después de todo lo que se indexa por lead_id.
  detalle.leads = await borrar('leads', { account_id: accountId });

  if (userId) {
    for (const [nombre, campo] of POR_USUARIO) {
      detalle[nombre] = await borrar(nombre, { [campo]: userId });
    }
  }

  detalle.accounts = await borrar('accounts', { _id: accountId });
  if (borrarUsuario && userId) {
    detalle.users = await borrar('users', { _id: userId });
  }

  const total = Object.values(detalle).reduce((a, b) => a + b, 0);
  console.warn(`🗑️ SUPRESIÓN completa — account ${accountId}: ${total} registros en ${Object.keys(detalle).length} colecciones`);

  return { detalle, total, conservado: CONSERVADO };
}

module.exports = { suprimirCuenta, POR_CUENTA, POR_USUARIO, CONSERVADO };
