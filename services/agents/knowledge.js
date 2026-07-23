/**
 * Atinov — Selección de knowledge por agente
 *
 * Fuente única de la regla "qué sabe este agente". Antes estaba duplicada en 7
 * archivos (webhook, followup, leads, publicChat, admin, agents×2), lo que hacía
 * fácil que se desincronizaran.
 *
 * Regla base (comportamiento histórico): el agente ve las entradas marcadas
 * `is_main` (base común de la cuenta) MÁS las asignadas explícitamente a él.
 *
 * Excepción `ignore_main_knowledge`: un agente que vende algo COMPLETAMENTE
 * distinto al negocio de la cuenta (ej: el agente que vende el auto de Brayan
 * dentro de la cuenta que vende Atinov) NO debe recibir la base común, o
 * terminaría mezclando el pitch del SaaS con la venta del vehículo. Con la
 * bandera en true ve SOLO su propio knowledge.
 */

/**
 * @param {Array}  allKnowledge — todas las entradas de la cuenta
 * @param {Object} agent        — agente que va a responder
 * @returns {Array} entradas que el agente puede usar
 */
function knowledgeForAgent(allKnowledge, agent) {
  const agentId = agent && (agent._id || agent.id);
  const own = k => (k.agent_ids || []).includes(agentId);
  if (agent && agent.ignore_main_knowledge) return allKnowledge.filter(own);
  return allKnowledge.filter(k => k.is_main || own(k));
}

module.exports = { knowledgeForAgent };
