/**
 * Atinov — Memoria por lead (cross-canal)
 *
 * El RAG aprende a nivel de NEGOCIO (conversaciones ganadas/perdidas).
 * Esta capa aprende a nivel de LEAD individual: presupuesto, objeciones,
 * preferencias, contexto personal — y lo recuerda en la siguiente
 * conversación venga por el canal que venga ("preguntó por implantes en
 * IG hace 2 semanas, hoy vuelve por WhatsApp").
 *
 * Diseño:
 *  - Los hechos viven EN el documento del lead (memory_facts: string[]),
 *    así viajan con él en el merge de identidades de la bandeja unificada.
 *  - Extracción asíncrona post-respuesta (gpt-4o-mini, ~US$0.0005/turno),
 *    nunca bloquea la respuesta al lead.
 *  - Inyección como bloque de contexto en generateReply (webhook y follow-ups).
 */

const OpenAI = require('openai');
const db     = require('../db/database');

const MAX_FACTS = 12;

// No gastar el extractor en el "hola" inicial: correr recién cuando hay
// conversación real (2+ mensajes del lead).
const MIN_USER_MESSAGES = 2;

/**
 * Bloque de contexto para el system prompt. null si el lead no tiene memoria.
 */
function buildMemoryContext(lead) {
  const facts = Array.isArray(lead?.memory_facts) ? lead.memory_facts.filter(Boolean) : [];
  if (!facts.length) return null;
  return [
    '--- MEMORIA DEL LEAD (hechos de conversaciones anteriores, cualquier canal) ---',
    ...facts.map(f => `• ${f}`),
    'Usa estos hechos con naturalidad ("como me contaste...", "tú que buscabas..."). NUNCA los recites en lista ni digas que tienes "memoria" o "registro". Si un hecho contradice lo que el lead dice HOY, manda lo de hoy.',
  ].join('\n');
}

/**
 * Extrae/actualiza los hechos del lead a partir de la conversación reciente.
 * Fire-and-forget desde runConversation (mismo patrón que classifyLead).
 */
async function updateLeadMemory({ leadId, apiKey }) {
  if (!apiKey) return null;

  const lead = await db.findOne(db.leads, { _id: leadId });
  if (!lead) return null;

  const messages = await db.find(db.messages, { lead_id: leadId },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const userCount = messages.filter(m => m.role === 'user').length;
  if (userCount < MIN_USER_MESSAGES) return null;

  // Últimos 12 turnos alcanzan: los hechos viejos ya están en memory_facts.
  const recent = messages.slice(-12)
    .map(m => `${m.role === 'user' ? 'LEAD' : 'AGENTE'}: ${String(m.content).slice(0, 300)}`)
    .join('\n');
  const existing = Array.isArray(lead.memory_facts) ? lead.memory_facts : [];

  const sys = `Mantienes la ficha de memoria de un prospecto de ventas. Te paso los hechos ya conocidos y la conversación reciente. Devuelve SOLO un array JSON de strings con la ficha ACTUALIZADA (máximo ${MAX_FACTS} hechos).

Qué es un hecho útil: presupuesto, qué busca exactamente, urgencia/plazos, objeciones que puso, datos de contacto que dio, contexto personal o del negocio relevante para venderle, qué se le prometió o envió. Formato "Categoría: dato" (ej: "Presupuesto: hasta $500 mil CLP", "Busca: camioneta 4x4 para el trabajo", "Objeción: le parece caro vs su plan actual").

Reglas: fusiona duplicados, actualiza hechos que cambiaron (manda lo más reciente), elimina lo irrelevante o especulativo. Cada hecho máximo 120 caracteres, en español. Si no hay nada que valga la pena recordar, devuelve [].`;

  try {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `HECHOS CONOCIDOS:\n${existing.length ? existing.map(f => `- ${f}`).join('\n') : '(ninguno)'}\n\nCONVERSACIÓN RECIENTE:\n${recent}` },
      ],
    });

    const raw = res.choices?.[0]?.message?.content || '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return null;
    let facts = JSON.parse(match[0]);
    if (!Array.isArray(facts)) return null;
    facts = facts
      .filter(f => typeof f === 'string' && f.trim().length > 3)
      .map(f => f.trim().slice(0, 160))
      .slice(0, MAX_FACTS);

    // Nunca vaciar memoria existente por una extracción vacía: los hechos
    // solo se reemplazan por hechos (evita pérdida silenciosa si el modelo
    // interpreta "la conversación reciente no aporta" como "devuelve []").
    if (!facts.length && existing.length) return null;

    await db.update(db.leads, { _id: leadId }, {
      memory_facts:      facts,
      memory_updated_at: new Date().toISOString(),
    });
    return facts;
  } catch (e) {
    console.warn('[memoria] extracción falló (no bloquea):', e.message);
    return null;
  }
}

module.exports = { buildMemoryContext, updateLeadMemory, MAX_FACTS };
