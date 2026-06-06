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

module.exports = { CHANNELS, channelOf, configuredChannels, identityOf };
