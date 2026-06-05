/**
 * Atinov — Prompt del Agente de Prospección (modo asistente)
 *
 * Este agente NO conversa con el lead ni envía mensajes. Asiste al HUMANO que
 * hace la prospección en frío (lo cual cumple las políticas de Meta: el primer
 * contacto frío lo hace una persona, no un bot).
 *
 * Genera DOS tipos de salida según `mode`:
 *  - 'opener'  → sugiere un mensaje de APERTURA para iniciar la conversación
 *                (el humano lo revisa, edita y envía manualmente).
 *  - 'reply'   → redacta una respuesta sugerida a lo que el lead respondió
 *                (draft para que el humano apruebe).
 *
 * Además detecta la SEÑAL DE CALOR: cuando el lead muestra interés real, marca
 * `ready_for_handoff: true` para que el flujo pase al agente de nutrición
 * (automático). Eso se decide fuera de este prompt, en prospectAgent.js.
 */

/**
 * Construye el system prompt del asistente de prospección.
 * @param {Object} p
 * @param {Object} p.agent       — agente role='prospect' (usa su .instructions como contexto del negocio)
 * @param {Array}  p.knowledge   — knowledge base de la cuenta (qué vende, precios, etc.)
 * @param {string} p.mode        — 'opener' | 'reply'
 * @param {string} [p.leadInfo]  — info que el humano sabe del lead (bio, nicho, qué publica)
 */
function buildProspectSystemPrompt({ agent, knowledge = [], mode = 'reply', leadInfo }) {
  const businessContext = (agent && agent.instructions) ? agent.instructions.trim() : '';
  const knowledgeText = knowledge.length
    ? '\n\n--- LO QUE VENDE EL CLIENTE (base de conocimiento) ---\n' +
      knowledge.map(k => `[${k.title}]\n${k.content}`).join('\n\n')
    : '';

  const common = `Eres un asistente de PROSPECCIÓN para un vendedor humano. Tu trabajo NO es hablar con el prospecto — es ayudar al vendedor a redactar mejores mensajes. El vendedor revisa, edita y envía todo manualmente (esto cumple las políticas de Meta: el primer contacto en frío lo hace una persona, nunca un bot).

CONTEXTO DEL NEGOCIO DEL VENDEDOR:
${businessContext || '(sin instrucciones cargadas — usa solo la base de conocimiento)'}
${knowledgeText}
${leadInfo ? `\n--- LO QUE EL VENDEDOR SABE DEL PROSPECTO ---\n${leadInfo}\n` : ''}
REGLAS DE REDACCIÓN:
- Español neutro de LATAM (México y Chile). NUNCA voseo argentino.
- Mensajes CORTOS y humanos, como un DM real de Instagram (1-3 líneas).
- NADA de sonar a plantilla, bot o vendedor desesperado.
- NO arranques vendiendo. Genera curiosidad o toca un dolor específico.
- Personaliza con lo que se sabe del prospecto cuando haya info.`;

  if (mode === 'opener') {
    return `${common}

TU TAREA AHORA: Sugiere UN mensaje de APERTURA para que el vendedor inicie la conversación en frío con este prospecto.
- Que abra una conversación, NO que cierre una venta.
- Idealmente una pregunta genuina o una observación sobre el prospecto.
- Devuelve SOLO el texto del mensaje sugerido, sin comillas ni explicaciones.`;
  }

  // mode === 'reply'
  return `${common}

TU TAREA AHORA: El prospecto respondió. Redacta una respuesta sugerida para que el vendedor la revise y envíe.
- Avanza la conversación con naturalidad: descubrí el dolor, generá interés.
- NO empujes el cierre todavía si el lead recién está entrando en confianza.
- Devuelve SOLO el texto sugerido, sin comillas ni explicaciones.`;
}

module.exports = { buildProspectSystemPrompt };
