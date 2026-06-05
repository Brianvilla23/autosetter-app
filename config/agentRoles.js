/**
 * Atinov — Roles de agente
 *
 * Fuente única de verdad de los dos tipos de agente. Separar los roles
 * resuelve el problema central del beta: el mismo prompt respondía a leads
 * inbound (nutrición) y a contactos en frío (prospección), causando cierres
 * apurados y riesgo de baneo de Meta por automatizar el primer contacto frío.
 *
 * REGLA DE COMPATIBILIDAD: un agente sin `role` definido se trata como
 * 'nurture' (el comportamiento actual). Esto garantiza que las cuentas
 * existentes NO cambien de comportamiento al deployar.
 */

const ROLES = {
  // Nutrición / Closer — opera AUTOMÁTICO sobre leads que YA mostraron interés.
  // Es el flujo actual del webhook. Compatible con políticas de Meta.
  nurture: {
    id: 'nurture',
    label: 'Nutrición / Closer',
    desc: 'Atiende automáticamente a leads que ya escribieron, comentaron o dieron un trigger. Califica, nutre y agenda.',
    canSendAuto: true,   // puede encolar y enviar respuestas automáticamente
    isDefault: true,
  },

  // Prospección — NO automatiza el primer contacto en frío (eso lo hace el
  // humano, para cumplir Meta). Su rol es ASISTIR al humano: sugerir aperturas,
  // redactar respuestas (drafts), y preparar el handoff al flujo automático.
  prospect: {
    id: 'prospect',
    label: 'Prospección (asistente)',
    desc: 'NO envía mensajes en frío. Sugiere aperturas y redacta respuestas para que el humano las revise y envíe. Prepara el handoff cuando el lead entra en calor.',
    canSendAuto: false,  // NUNCA encola envíos automáticos — solo genera borradores
    isDefault: false,
  },
};

const ROLE_IDS = Object.keys(ROLES);

/** Normaliza el role de un agente: si no tiene, es 'nurture' (compat). */
function roleOf(agent) {
  const r = agent && agent.role;
  return ROLE_IDS.includes(r) ? r : 'nurture';
}

/** ¿Este agente puede enviar respuestas automáticamente? */
function canSendAuto(agent) {
  return ROLES[roleOf(agent)].canSendAuto;
}

function isValidRole(r) {
  return ROLE_IDS.includes(r);
}

module.exports = { ROLES, ROLE_IDS, roleOf, canSendAuto, isValidRole };
