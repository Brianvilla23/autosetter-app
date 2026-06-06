/**
 * Atinov — Lead scoring por embeddings + señales
 *
 * Calcula un score 0..100 combinando:
 *  - similitud de la conversación del lead con conversaciones GANADAS del account
 *  - señales de la conversación (qualification, nº de mensajes del lead, etc.)
 *
 * Se persiste en Supabase (lead_scores) y alimenta el orden del CRM y el
 * umbral de notificación HOT. Desactivado si el RAG no está configurado.
 */

const db = require('../../db/database');
const { isEnabled, getClient, embed } = require('./supabase');

/**
 * Calcula y persiste el score de un lead. Devuelve { score, signals } o null.
 */
async function scoreLead(lead, apiKey) {
  if (!isEnabled() || !lead) return null;
  const client = getClient();
  if (!client) return null;

  const messages = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const userMsgs = messages.filter(m => m.role === 'user');
  if (!userMsgs.length) return null;

  // Texto representativo del lead (sus últimos mensajes)
  const leadText = userMsgs.slice(-5).map(m => m.content).join(' ').slice(0, 4000);
  const vec = await embed(leadText, apiKey);

  const signals = {};
  let score = 0;

  // 1) Similitud con conversaciones GANADAS (hasta 50 pts)
  if (vec) {
    try {
      const { data, error } = await client.rpc('match_chunks', {
        p_account_id: lead.account_id,
        p_embedding:  vec,
        p_outcome:    'ganado',
        p_limit:      3,
      });
      if (!error && data && data.length) {
        const avgSim = data.reduce((s, c) => s + (c.similarity || 0), 0) / data.length;
        signals.similar_won = +avgSim.toFixed(3);
        score += Math.round(avgSim * 50);
      }
    } catch (e) { /* sin datos aún → score base por señales */ }
  }

  // 2) Señales explícitas de la conversación (hasta 50 pts)
  const q = lead.qualification;
  if (q === 'hot')  { score += 35; signals.qualification = 'hot'; }
  else if (q === 'warm') { score += 18; signals.qualification = 'warm'; }
  else if (q === 'cold') { score += 5; signals.qualification = 'cold'; }

  // Engagement: más mensajes del lead = más interés (hasta 15 pts)
  signals.lead_messages = userMsgs.length;
  score += Math.min(15, userMsgs.length * 3);

  score = Math.max(0, Math.min(100, score));

  try {
    await client.from('lead_scores').upsert({
      lead_id: lead._id, account_id: lead.account_id,
      score, signals, updated_at: new Date().toISOString(),
    }, { onConflict: 'lead_id' });
  } catch (e) {
    console.warn('[rag] scoreLead upsert skip:', e.message);
  }

  return { score, signals };
}

module.exports = { scoreLead };
