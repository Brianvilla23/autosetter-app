/**
 * Atinov — Agente de Prospección (lógica)
 *
 * Genera borradores (drafts) para que el HUMANO los revise y envíe. NUNCA
 * encola un envío automático (eso lo garantiza el caller mirando canSendAuto).
 *
 * Usa el mismo cliente OpenAI que el resto del sistema. Cuando se sume Claude
 * como modelo de razonamiento (decisión de Brayan), este es uno de los puntos
 * naturales para enrutarlo, ya que prospección se beneficia de redacción fina.
 */

const OpenAI = require('openai');
const { buildProspectSystemPrompt } = require('../prompts/prospectPrompt');

/** Heurística rápida de "señal de calor" en lo que dijo el lead. */
function detectWarmthSignal(text) {
  const t = (text || '').toLowerCase();
  // Señales de interés real → el lead deja de ser "frío" y puede pasar a nutrición auto.
  const hot = /\b(precio|cu[áa]nto|cu[áa]nto sale|cu[áa]nto cuesta|me interesa|quiero|c[óo]mo funciona|cont[áa]me|cuent[áa]me|info|m[áa]s info|agendar|demo|prueba|cuando podemos|d[óo]nde|link)\b/.test(t);
  return hot;
}

/**
 * Genera un borrador de prospección.
 * @param {Object} p
 * @param {Object} p.agent       — agente role='prospect'
 * @param {Array}  p.knowledge
 * @param {Array}  [p.conversationHistory] — [{role:'agent'|'user', content}]
 * @param {string} [p.lastLeadMessage]     — lo último que dijo el prospecto (para mode reply)
 * @param {string} p.mode        — 'opener' | 'reply'
 * @param {string} [p.leadInfo]  — contexto que el humano tiene del prospecto
 * @param {string} p.apiKey
 * @returns {{ draft: string, ready_for_handoff: boolean }}
 */
async function generateProspectDraft({ agent, knowledge = [], conversationHistory = [],
                                       lastLeadMessage = '', mode = 'reply', leadInfo, apiKey }) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('No hay OPENAI_API_KEY configurada');
  const client = new OpenAI({ apiKey: key });

  const system = buildProspectSystemPrompt({ agent, knowledge, mode, leadInfo });

  const messages = [{ role: 'system', content: system }];
  // Para 'reply' incluimos el historial (el del lead va como 'user', el del vendedor como 'assistant')
  if (mode === 'reply') {
    for (const m of conversationHistory) {
      messages.push({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.content });
    }
    if (lastLeadMessage) messages.push({ role: 'user', content: lastLeadMessage });
  } else {
    // opener: solo pedimos el mensaje de apertura
    messages.push({ role: 'user', content: 'Genera el mensaje de apertura.' });
  }

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
    messages,
    max_tokens: 120,
    temperature: 0.85,
  });

  const draft = (res.choices[0].message.content || '').trim();
  const ready_for_handoff = mode === 'reply' && detectWarmthSignal(lastLeadMessage);

  return { draft, ready_for_handoff };
}

module.exports = { generateProspectDraft, detectWarmthSignal };
