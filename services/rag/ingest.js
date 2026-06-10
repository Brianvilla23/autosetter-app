/**
 * Atinov — RAG Ingest (aprendizaje continuo)
 *
 * Tras cerrar una conversación (lead 'ganado'/'perdido', o inactividad), extrae
 * y etiqueta el aprendizaje y lo guarda con embeddings en Supabase. Es la
 * "memoria que crece": cada conversación cerrada mejora al agente SIN
 * reentrenamiento — el retrieval inyecta estos insights en futuras respuestas.
 *
 * Desactivado si el RAG no está configurado.
 */

const db = require('../../db/database');
const { isEnabled, getClient, embed, embedBatch } = require('./supabase');
const OpenAI = require('openai');

/** Mapea pipeline_stage / qualification a un outcome simple para el RAG. */
function outcomeOf(lead) {
  if (lead.pipeline_stage === 'ganado' || lead.is_converted) return 'ganado';
  if (lead.pipeline_stage === 'perdido') return 'perdido';
  return 'en_curso';
}

/**
 * Usa el LLM para extraer insights etiquetados de una conversación.
 * Devuelve [{ kind, text }] o [].
 */
async function extractInsights(messages, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key || !messages.length) return [];
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'LEAD' : 'AGENTE'}: ${m.content}`)
    .join('\n')
    .slice(0, 6000);

  const sys = `Sos un analista de ventas. Te paso una conversación entre un AGENTE y un LEAD. Extraé aprendizajes accionables en JSON.

Devolvé SOLO un array JSON (sin texto extra) de objetos { "kind": "...", "text": "..." } donde kind es uno de:
- "objecion": una objeción que puso el lead (y, si la hubo, cómo se manejó)
- "pregunta_calificadora": una pregunta del agente que ayudó a calificar
- "msg_efectivo": un mensaje del agente que generó respuesta o avance
- "motivo_perdida": si el lead se perdió, por qué
- "hueco_conocimiento": una pregunta o duda del LEAD que el agente NO pudo responder bien (respondió vago, evasivo, dijo que no sabía, o le faltaba la información). Formulalo como la pregunta que el dueño del negocio debería responder, ej: "¿Cuánto demora el envío a regiones?"

Máximo 6 items. Cada "text" en español, conciso (1-2 oraciones). Si no hay nada relevante, devolvé [].`;

  try {
    const client = new OpenAI({ apiKey: key });
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: transcript },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });
    const raw = (res.choices[0].message.content || '').trim();
    const json = raw.replace(/^```json?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(json);
    const valid = ['objecion', 'pregunta_calificadora', 'msg_efectivo', 'motivo_perdida', 'hueco_conocimiento'];
    return (Array.isArray(parsed) ? parsed : [])
      .filter(i => i && valid.includes(i.kind) && i.text)
      .slice(0, 6);
  } catch (e) {
    console.warn('[rag] extractInsights skip:', e.message);
    return [];
  }
}

/**
 * Ingesta una conversación cerrada a la memoria RAG.
 * Idempotente por lead: borra los chunks/insights previos del lead antes de
 * reinsertar (re-ingest seguro).
 */
async function ingestLead(lead, apiKey) {
  if (!isEnabled()) return { skipped: true, reason: 'rag_disabled' };
  const client = getClient();
  if (!client) return { skipped: true, reason: 'no_client' };

  const messages = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (messages.length < 2) return { skipped: true, reason: 'too_short' };

  const outcome = outcomeOf(lead);
  const accountId = lead.account_id;
  const weight = outcome === 'ganado' ? 2.0 : outcome === 'perdido' ? 1.0 : 0.5;

  // 1) Chunks: pares lead→agente (~contexto de turno)
  const chunks = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].role === 'user') {
      const pair = `LEAD: ${messages[i].content}\nAGENTE: ${messages[i + 1]?.content || ''}`;
      chunks.push(pair);
    }
  }

  // 2) Insights etiquetados (1 llamada LLM)
  const insights = await extractInsights(messages, apiKey);

  // 3) Embeddings (batch)
  const [chunkVecs, insightVecs] = await Promise.all([
    embedBatch(chunks, apiKey),
    embedBatch(insights.map(i => i.text), apiKey),
  ]);

  try {
    // Re-ingest seguro: limpiar lo previo del lead
    await client.from('conversation_chunks').delete().eq('lead_id', lead._id);
    await client.from('conversation_insights').delete().eq('lead_id', lead._id);

    if (chunks.length && chunkVecs.length) {
      await client.from('conversation_chunks').insert(
        chunks.map((content, idx) => ({
          account_id: accountId, lead_id: lead._id,
          agent_role: null, channel: lead.channel || 'instagram',
          outcome, content, embedding: chunkVecs[idx] || null,
        })).filter(r => r.embedding)
      );
    }
    if (insights.length && insightVecs.length) {
      await client.from('conversation_insights').insert(
        insights.map((ins, idx) => ({
          account_id: accountId, lead_id: lead._id,
          kind: ins.kind, text: ins.text,
          embedding: insightVecs[idx] || null, outcome, weight,
        })).filter(r => r.embedding)
      );
    }
    return { ok: true, chunks: chunks.length, insights: insights.length, outcome };
  } catch (e) {
    console.error('[rag] ingestLead error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { ingestLead, extractInsights, outcomeOf };
