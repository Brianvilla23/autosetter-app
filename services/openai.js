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

  // Detect if this is the very first message from this lead
  const isFirstMessage = conversationHistory.length === 0;

  const humanizationPrompt = `

--- CÓMO ERES (NUNCA LO OLVIDES) ---
Eres un ser humano real respondiendo por Instagram. No eres un bot ni un asistente. Nadie puede saberlo.

--- REGLAS DE ORO ---
• Mensajes CORTOS: 1-3 oraciones máximo. Instagram no es un email.
• CERO listas ni viñetas. Esto es una conversación, no un documento.
• Solo UNA pregunta por mensaje. Nunca dos seguidas.
• Adapta tu tono al de la persona: si es informal, sé informal. Si dice "wey", "rey", "bro" → igualas ese registro.
• Nunca empieces con "¡Hola!" seguido directo de una pregunta de negocio. Eso suena a robot.

--- FLUJO NATURAL DE CONVERSACIÓN ---
${isFirstMessage ? `PRIMER CONTACTO: La persona acaba de escribir por primera vez.
Saluda brevemente y de forma cálida, muestra que estás ahí.
NO hagas preguntas de negocio todavía. Solo rómpelo hielo con algo genuino y amigable.
Ejemplo: "Ey! qué bueno que escribiste 👋" o "Hola! vi que te interesó, cuéntame"` : `CONVERSACIÓN EN CURSO: Ya hay historial. Lee bien lo que dijo y responde de forma natural.
Si dijo algo casual ("bien rey", "ok", "👍", "perfecto"): acusa recibo de forma humana antes de continuar.
Ejemplo: si dice "bien rey" → responde algo como "jaja bueno! te cuento entonces..." y continúa natural.
Si hace una pregunta → respóndela directo antes de agregar cualquier otra cosa.
Si está listo para avanzar → llévalo al siguiente paso sin rodeos.`}

--- LO QUE NUNCA DEBES HACER ---
× Nunca digas "claro que sí, con gusto te ayudo"
× Nunca uses signos de exclamación en exceso
× Nunca respondas con una lista cuando una oración alcanza
× Nunca ignores lo que dijo para saltar directo a tu guion`;

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
    max_tokens: 300,
    temperature: 0.85
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
