/**
 * Atinov — Selección y enrutamiento de agentes
 *
 * Encapsula la decisión de QUÉ agente atiende una conversación inbound y SI
 * puede hacerlo automáticamente. Reemplaza el viejo `agents[0]` del webhook.
 *
 * Lógica:
 *  - Para inbound (lead escribió/comentó/dio trigger), responde el agente de
 *    NUTRICIÓN (automático). Es el flujo compatible con Meta.
 *  - El agente de PROSPECCIÓN no se dispara por webhook: su trabajo es asistir
 *    al humano (drafts) vía el endpoint /prospect-draft. Si una cuenta SOLO
 *    tiene un agente prospect, el webhook NO auto-responde (canAuto=false).
 *  - Respeta `lead.handoff_state`: si un lead está 'human_assisted' (el humano
 *    lo está trabajando en frío), el webhook no toma el control hasta que la
 *    señal de calor lo pase a 'automated'.
 *  - Ruteo por canal: un agente con `channels` (ej: ['whatsapp']) solo atiende
 *    esos canales y GANA sobre los agentes sin `channels` en su canal. Un agente
 *    sin `channels` (o con lista vacía) es catch-all: atiende cualquier canal
 *    donde ningún agente lo reclame explícitamente (compat con agentes viejos).
 */

const db = require('../../db/database');
const { roleOf, canSendAuto } = require('../../config/agentRoles');

/** Canales que el webhook puede reportar. Catch-all = sin lista o lista vacía. */
const AGENT_CHANNELS = ['instagram', 'whatsapp'];

function hasExplicitChannels(agent) {
  return Array.isArray(agent.channels) && agent.channels.length > 0;
}

/** ¿Puede este agente atender el canal? (sin canal conocido, todos pueden) */
function servesChannel(agent, channel) {
  if (!channel || !hasExplicitChannels(agent)) return true;
  return agent.channels.includes(channel);
}

/**
 * Selecciona el agente que debe atender un lead inbound.
 * @param {Object} account
 * @param {Object} [lead]     — para respetar handoff_state
 * @param {string} [channel]  — 'instagram' | 'whatsapp' (origen del mensaje)
 * @returns {Promise<{ agent: Object|null, canAuto: boolean, reason: string }>}
 */
async function selectAgent(account, lead = null, channel = null) {
  const all = await db.find(
    db.agents,
    { account_id: account._id, enabled: true },
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
  const agents = all.filter(a => servesChannel(a, channel));
  if (!agents.length) {
    return { agent: null, canAuto: false, reason: all.length ? 'no_agents_for_channel' : 'no_agents' };
  }

  // Si el lead está siendo trabajado en frío por el humano, no auto-responder
  // hasta que haya pasado a 'automated' (lo hace el handoff por señal de calor).
  if (lead && lead.handoff_state === 'human_assisted') {
    return { agent: null, canAuto: false, reason: 'human_assisted' };
  }

  // Preferir NUTRICIÓN con canal explícito; si nadie reclama el canal, el
  // primer nurture catch-all (comportamiento histórico).
  const nurtures = agents.filter(a => roleOf(a) === 'nurture');
  const nurture =
    (channel && nurtures.find(a => hasExplicitChannels(a))) || nurtures[0];
  if (nurture) {
    return { agent: nurture, canAuto: canSendAuto(nurture), reason: 'nurture' };
  }

  // No hay nurture; solo hay prospect(s). El webhook NO auto-responde:
  // prospección la maneja el humano con drafts.
  return { agent: agents[0], canAuto: false, reason: 'only_prospect' };
}

module.exports = { selectAgent, AGENT_CHANNELS, servesChannel };
