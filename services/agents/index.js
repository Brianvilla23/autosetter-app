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
 */

const db = require('../../db/database');
const { roleOf, canSendAuto } = require('../../config/agentRoles');

/**
 * Selecciona el agente que debe atender un lead inbound.
 * @param {Object} account
 * @param {Object} [lead]   — para respetar handoff_state
 * @returns {Promise<{ agent: Object|null, canAuto: boolean, reason: string }>}
 */
async function selectAgent(account, lead = null) {
  const agents = await db.find(
    db.agents,
    { account_id: account._id, enabled: true },
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
  if (!agents.length) {
    return { agent: null, canAuto: false, reason: 'no_agents' };
  }

  // Si el lead está siendo trabajado en frío por el humano, no auto-responder
  // hasta que haya pasado a 'automated' (lo hace el handoff por señal de calor).
  if (lead && lead.handoff_state === 'human_assisted') {
    return { agent: null, canAuto: false, reason: 'human_assisted' };
  }

  // Preferir el primer agente de NUTRICIÓN habilitado (puede enviar auto).
  const nurture = agents.find(a => roleOf(a) === 'nurture');
  if (nurture) {
    return { agent: nurture, canAuto: canSendAuto(nurture), reason: 'nurture' };
  }

  // No hay nurture; solo hay prospect(s). El webhook NO auto-responde:
  // prospección la maneja el humano con drafts.
  return { agent: agents[0], canAuto: false, reason: 'only_prospect' };
}

module.exports = { selectAgent };
