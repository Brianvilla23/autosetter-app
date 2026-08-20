/**
 * Atinov — Definición pura de canales (Tarea 3)
 *
 * SIN dependencias de transporte (meta/whatsapp) ni de DB. Solo la taxonomía
 * de canales y helpers puros. Esto permite testear la lógica de canal sin
 * cargar la cadena de db/red, y lo importan tanto index.js (envío) como
 * unify.js (bandeja unificada).
 */

const CHANNELS = {
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    icon: '📷',
    isConfigured: (account) => !!(account && account.access_token && account.ig_user_id),
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: '📱',
    isConfigured: (account) => !!(account && account.wa_phone_number_id && account.wa_access_token),
  },
};

/**
 * Canales que se pueden PAUSAR sin perder las credenciales.
 *
 * Pausar no es desconectar. Pausar apaga la atención automática y deja las
 * credenciales guardadas, para que reanudar sea un clic y no una tarde
 * peleando con tokens en el panel de Meta. Borrar de verdad las credenciales
 * ("olvidar") es una acción aparte, explícita y avisada.
 *
 * Messenger vive acá aunque no esté en CHANNELS: CHANNELS describe los canales
 * que participan de la bandeja unificada, y agregarlo ahí cambiaría lo que
 * devuelve configuredChannels() para todo el resto del código.
 */
const PAUSABLES = {
  instagram: { flag: 'ig_pausado', label: 'Instagram' },
  whatsapp:  { flag: 'wa_pausado', label: 'WhatsApp' },
  messenger: { flag: 'fb_pausado', label: 'Messenger' },
};

/** ¿Es un canal pausable? Valida lo que llega por la URL antes de tocar la DB. */
function esPausable(canal) {
  return Object.prototype.hasOwnProperty.call(PAUSABLES, String(canal || ''));
}

/**
 * Nombre del campo de la cuenta donde vive la pausa de ese canal.
 * Pasa por esPausable a propósito: con acceso directo, PAUSABLES['__proto__']
 * devuelve Object.prototype (que es truthy) y esto retornaba undefined en vez
 * de null. El canal llega desde la URL, así que se valida siempre.
 */
function flagPausa(canal) {
  const clave = String(canal || '');
  return esPausable(clave) ? PAUSABLES[clave].flag : null;
}

/** ¿Está pausado este canal para esta cuenta? Ante la duda, NO pausado. */
function estaPausado(account, canal) {
  const flag = flagPausa(canal);
  return !!(flag && account && account[flag]);
}

/** Los canales pausados de una cuenta — para mostrarlo de un vistazo. */
function canalesPausados(account) {
  return Object.keys(PAUSABLES).filter(c => estaPausado(account, c));
}

function channelOf(leadOrChannel) {
  const ch = typeof leadOrChannel === 'string' ? leadOrChannel : (leadOrChannel && leadOrChannel.channel);
  return CHANNELS[ch] ? ch : 'instagram';
}

/** ¿Qué canales tiene configurados esta cuenta? */
function configuredChannels(account) {
  return Object.values(CHANNELS).filter(c => c.isConfigured(account)).map(c => c.id);
}

/** Construye la identity de un lead a partir de sus campos de canal. */
function identityOf(lead) {
  if (lead.channel === 'whatsapp') {
    return { channel: 'whatsapp', id: lead.wa_id || lead.ig_user_id, name: lead.wa_name || lead.ig_username };
  }
  return { channel: 'instagram', id: lead.ig_user_id, username: lead.ig_username };
}

module.exports = {
  CHANNELS, channelOf, configuredChannels, identityOf,
  PAUSABLES, esPausable, flagPausa, estaPausado, canalesPausados,
};
