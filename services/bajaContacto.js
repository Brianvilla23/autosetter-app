/**
 * Atinov — "No me escriban más": la baja del contacto
 *
 * Las campañas ya revisaban `lead.mkt_opt_out` antes de enviar, pero ningún
 * código lo escribía: nadie podía darse de baja (hallazgo del 30-09-2026).
 * Eso choca con la Ley del Consumidor (art. 28 B: quien recibe comunicaciones
 * comerciales puede pedir que se suspendan, y hay que hacerlo) y con las
 * reglas de WhatsApp sobre respetar el opt-out.
 *
 * Qué hace la baja:
 *  - marca al contacto (mkt_opt_out + fecha + motivo + lo que escribió)
 *  - corta todo lo PROACTIVO: campañas, seguimientos y avisos de cita/pedido
 *  - el agente responde UNA vez, corto: "listo, no te vuelvo a escribir…"
 *  - si la persona vuelve a escribir por su cuenta, se le contesta (fue ella
 *    la que inició), pero la baja sigue: el dueño la quita a mano en el CRM.
 *
 * La detección es conservadora a propósito: confundir "quiero darme de baja
 * del gimnasio" (un trámite que el negocio tiene que atender) con "no me
 * escriban" sería peor que no detectar. Por eso "baja" solo cuenta sola o
 * referida a mensajes, lista o promociones, y las frases largas no cuentan.
 */

const db = require('../db/database');

const MAX_PALABRAS = 14;   // "no me escriban más" no viene dentro de un párrafo

const normalizar = (t) => String(t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Solo el imperativo dirigido al negocio: "no me manden" es baja, "no me
// mandaron el pedido" es un reclamo que hay que atender.
const VERBOS = 'escribas|escriban|mandes|manden|envies|envien|contactes|contacten|llames|llamen|molestes|molesten|hables|hablen';

// Pide cambiar de canal o de horario, no dejar de recibir: "no me escribas
// acá, mejor por WhatsApp", "no me llames, escríbeme".
const CAMBIO_DE_CANAL = /\b(mejor|en vez|por whatsapp|por wsp|por correo|al correo|por mail|al mail|escribeme|escribanme|llamame|llamenme|a este numero|a otro|despues|mas tarde|ahora no|hoy no)\b/;

const PATRONES = [
  // "no me escriban más", "no me manden nada", "no me contacten"
  new RegExp(`\\bno (me|nos) (${VERBOS})\\b`),
  // "dejen de escribirme", "deja de mandarme mensajes" (no "dejaron de mandarme")
  /\bdej(a|en|e|es|ar) de (escribir|mandar|enviar|contactar|llamar|molestar)\w*/,
  // "no quiero recibir más mensajes / promociones"
  /\bno quiero (recibir|mas|seguir recibiendo)\b.*\b(mensaje|mensajes|promo|promocion|promociones|publicidad|ofertas|info|informacion|nada)\b/,
  // "sáquenme de la lista", "quítame de tu lista", "bórrenme de la lista"
  /\b(saca|saquen|saquenme|sacame|quita|quiten|quitenme|quitame|borra|borren|borrenme|borrame|elimina|eliminen|eliminenme|eliminame)\w* (de )?(la|tu|su|sus|esta) (lista|base)\b/,
  // "eliminen mi número"
  /\b(elimin|borr)\w* mi (numero|contacto|telefono)\b/,
  // "baja de los mensajes / de la lista / de las promociones"
  /\bbaja de (los mensajes|la lista|las promociones|promociones|la publicidad|sus mensajes|tus mensajes)\b/,
  // Botones de WhatsApp para dejar de recibir promociones
  /\b(detener|dejar de recibir|no recibir) (promociones|mensajes de marketing|mensajes)\b/,
  /\bstop promotions\b/,
];

// Mensajes que SON la baja por sí solos.
const SOLOS = new Set([
  'stop', 'baja', 'de baja', 'dame de baja', 'denme de baja', 'darme de baja',
  'unsubscribe', 'desuscribir', 'desuscribirme', 'cancelar suscripcion', 'basta',
  'basta de mensajes', 'no mas mensajes', 'no mas', 'spam',
]);

/** ¿Este mensaje es un pedido de no recibir más mensajes? */
function pideBaja(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  if (SOLOS.has(t)) return true;
  if (t.split(' ').length > MAX_PALABRAS) return false;
  if (CAMBIO_DE_CANAL.test(t)) return false;
  return PATRONES.some(p => p.test(t));
}

/** Lo que el agente responde, una sola vez. Sin "¡" ni emoji, como persona. */
const ACUSE_BAJA = 'listo, no te vuelvo a escribir. si algún día necesitas algo, me escribes por acá';

/** ¿El contacto pidió no recibir mensajes proactivos? */
const dadoDeBaja = (lead) => !!(lead && lead.mkt_opt_out === true);

/**
 * Marca la baja y corta lo que ya estaba programado. Idempotente: si ya
 * estaba de baja, no pisa la fecha original.
 */
async function registrarBaja({ lead, motivo = 'pidio_baja', texto = '' }) {
  if (!lead?._id) return false;
  if (dadoDeBaja(lead)) return false;
  await db.update(db.leads, { _id: lead._id }, {
    mkt_opt_out:    true,
    opt_out_at:     new Date().toISOString(),
    opt_out_motivo: motivo,
    opt_out_texto:  String(texto || '').slice(0, 200),
  });
  try {
    const { cancelPendingForLead } = require('./followup');
    await cancelPendingForLead(lead._id, 'pidió no recibir mensajes');
  } catch { /* el seguimiento igual revisa la baja antes de enviar */ }
  console.log(`🔕 Baja registrada para el lead ${lead._id} (${motivo})`);
  return true;
}

/** El dueño la quita desde el CRM (la persona volvió a pedir información). */
async function quitarBaja(leadId) {
  await db.update(db.leads, { _id: leadId }, {
    mkt_opt_out: false, opt_out_at: null, opt_out_motivo: null, opt_out_texto: null,
  });
}

module.exports = { pideBaja, registrarBaja, quitarBaja, dadoDeBaja, ACUSE_BAJA, normalizar };
