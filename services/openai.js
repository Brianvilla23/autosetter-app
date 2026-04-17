const OpenAI = require('openai');
const db = require('../db/database');

async function getApiKey(apiKey, accountId) {
  let key = apiKey || process.env.OPENAI_API_KEY;
  if (!key && accountId) {
    const settings = await db.findOne(db.settings, { account_id: accountId });
    key = settings?.openai_key;
  }
  return key;
}

async function generateReply({ agent, knowledge, links, conversationHistory, newMessage, accountId, apiKey, extraContext = null }) {
  const key = await getApiKey(apiKey, accountId);
  if (!key) throw new Error('No OpenAI API key configured. Add it in Settings.');

  const client = new OpenAI({ apiKey: key });

  // Build system prompt
  const knowledgeText = knowledge.length
    ? '\n\n--- BASE DE CONOCIMIENTO ---\n' + knowledge.map(k => `[${k.title}]\n${k.content}`).join('\n\n')
    : '';

  const linksText = links.length
    ? '\n\n--- LINKS QUE PUEDES COMPARTIR (úsalos cuando sea apropiado) ---\n' +
      links.map(l => `• ${l.name}: ${l.url}${l.description ? ` — ${l.description}` : ''}`).join('\n')
    : '';

  const extraContextText = extraContext ? `\n\n--- CONTEXTO ADICIONAL ---\n${extraContext}` : '';

  const humanizationPrompt = `

--- ESTILO DE COMUNICACIÓN (OBLIGATORIO) ---
Eres un humano respondiendo por Instagram DM. Sigue estas reglas sin excepción:

1. MENSAJES CORTOS: máximo 2-3 oraciones por respuesta. Instagram no es email.
2. TONO CASUAL: escribe como hablarías con alguien de confianza. Usa contracciones, lenguaje relajado.
3. NADA DE LISTAS: nunca uses viñetas (•, -, *) ni numeración. Es una conversación, no un documento.
4. UNA PREGUNTA A LA VEZ: si necesitas preguntar algo, haz solo UNA pregunta por mensaje.
5. NATURALIDAD: está bien empezar con "uy", "mira", "oye", "claro que sí", "qué bueno que preguntas".
6. VARIACIÓN: no siempre empieces con "Hola". Varía las aperturas según el contexto.
7. NUNCA digas que eres IA, bot o asistente virtual.
8. Si el prospecto es informal, sé más informal. Si es formal, ajústate.`;

  const systemPrompt = agent.instructions + knowledgeText + linksText + extraContextText + humanizationPrompt;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(m => ({
      role: m.role === 'agent' ? 'assistant' : 'user',
      content: m.content
    })),
    { role: 'user', content: newMessage }
  ];

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 500,
    temperature: 0.75
  });

  return response.choices[0].message.content;
}

// ── LEAD CLASSIFICATION ──────────────────────────────────────────────────────
async function classifyLead({ conversationHistory, accountId, apiKey }) {
  const key = await getApiKey(apiKey, accountId);
  if (!key) return null;

  // Only classify once we have at least 3 messages (enough context)
  const userMessages = conversationHistory.filter(m => m.role === 'user');
  if (userMessages.length < 2) return null;

  const client = new OpenAI({ apiKey: key });

  const conversationText = conversationHistory
    .map(m => `${m.role === 'agent' ? 'AGENTE' : 'PROSPECTO'}: ${m.content}`)
    .join('\n');

  const prompt = `Eres un experto en ventas. Analiza esta conversación y clasifica al prospecto.

CONVERSACIÓN:
${conversationText}

CRITERIOS DE CLASIFICACIÓN:
- HOT (CALIENTE): Tiene problema claro, describió su situación, mostró interés en la solución, preguntó cómo agendar o quiere avanzar. Alto potencial de cierre.
- WARM (TIBIO): Describió su problema pero aún no mostró interés claro en una solución o necesita más nurturing.
- COLD (FRÍO): Solo saludó sin compartir problema real, mostró desinterés, resistencia clara, o no responde las preguntas de calificación.

Responde ÚNICAMENTE con JSON válido, sin markdown ni texto extra:
{"qualification":"hot","reason":"razón breve en español"}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.2
    });

    const content = response.choices[0].message.content.trim();
    // Strip markdown code blocks if present
    const clean = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(clean);
    if (['hot', 'warm', 'cold'].includes(result.qualification)) return result;
    return null;
  } catch (e) {
    console.error('classifyLead error:', e.message);
    return null;
  }
}

module.exports = { generateReply, classifyLead };
