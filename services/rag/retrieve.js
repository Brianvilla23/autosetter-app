/**
 * Atinov — RAG Retrieval (few-shot dinámico)
 *
 * Antes de que el agente responda, busca insights/ejemplos relevantes del
 * MISMO cliente (priorizando conversaciones ganadas) y los devuelve como
 * texto listo para inyectar en el system prompt (vía `extraContext`, que
 * generateReply() ya acepta — integración mínima, no invasiva).
 *
 * Si el RAG no está configurado (sin SUPABASE_URL), devuelve null y el agente
 * responde exactamente como hoy.
 */

const { isEnabled, getClient, embed } = require('./supabase');

/**
 * Construye el bloque de few-shot dinámico para un mensaje entrante.
 * @param {Object} p
 * @param {string} p.accountId
 * @param {string} p.message    — último mensaje del lead (sobre qué buscar)
 * @param {string} [p.apiKey]
 * @param {number} [p.limit]    — cuántos ejemplos inyectar (default 3)
 * @returns {Promise<string|null>}  texto para extraContext, o null
 */
async function retrieveContext({ accountId, message, apiKey, limit = 3 }) {
  if (!isEnabled() || !accountId || !message) return null;
  const client = getClient();
  if (!client) return null;

  const vec = await embed(message, apiKey);
  if (!vec) return null;

  try {
    // Insights más relevantes (objeciones manejadas, preguntas calificadoras,
    // mensajes efectivos) del mismo account, ponderados por éxito.
    const { data: insights, error } = await client.rpc('match_insights', {
      p_account_id: accountId,
      p_embedding:  vec,
      p_kind:       null,
      p_limit:      limit,
    });
    if (error) { console.warn('[rag] match_insights:', error.message); return null; }
    if (!insights || !insights.length) return null;

    const kindLabel = {
      objecion:              'OBJECIÓN MANEJADA',
      pregunta_calificadora: 'PREGUNTA QUE CALIFICÓ',
      msg_efectivo:          'MENSAJE QUE FUNCIONÓ',
      motivo_perdida:        'MOTIVO DE PÉRDIDA (evitá esto)',
    };
    const lines = insights
      .filter(i => i.similarity > 0.7) // solo lo realmente parecido
      .map(i => `• [${kindLabel[i.kind] || i.kind}${i.outcome ? `, ${i.outcome}` : ''}] ${i.text}`);

    if (!lines.length) return null;

    return `APRENDIZAJE DE TUS CONVERSACIONES ANTERIORES (usalo como guía, no lo copies literal):\n${lines.join('\n')}`;
  } catch (e) {
    console.error('[rag] retrieveContext error:', e.message);
    return null;
  }
}

module.exports = { retrieveContext };
