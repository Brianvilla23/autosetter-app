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

// ─────────────────────────────────────────────────────────────────────────────
// COMPLEXITY DETECTION — decide si vale la pena gastar en reasoning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Señales de que el mensaje necesita reasoning de verdad:
 * - Objeciones clásicas (precio, tiempo, desconfianza)
 * - Negociación activa
 * - Preguntas técnicas o condicionales
 * - Historia larga (conversación ya se complicó)
 * - Mensajes largos del prospecto (está elaborando un razonamiento)
 */
const OBJECTION_PATTERNS = [
  /\b(caro|carísim|precio|cost|cobra|cuanto|cuánto|tarif|pagar|vale la pena)\b/i,
  /\b(no tengo (dinero|plata|pesos)|no puedo pagar|sin presupuesto|no me alcanza)\b/i,
  /\b(déjame pensarlo|dejame pensar|lo pienso|lo consulto|ver si)\b/i,
  /\b(no estoy seguro|no sé si|tengo dudas|me da miedo|desconf)\b/i,
  /\b(ya (probé|intenté|hice|compré).*(no funcion|no sirv|perd))\b/i,
  /\b(garant(í|i)a|reembolso|devol|cancelar)\b/i,
  /\b(estafa|fraude|scam|fake|verdadero|real|legítimo)\b/i,
  /\b(competencia|mejor que|comparado con|vs|versus)\b/i,
];

const TECHNICAL_QUESTION_PATTERNS = [
  /\b(cómo funciona|cómo hace|cómo lograr|cómo garantiz|de qué forma|qué pasa si)\b/i,
  /\b(por qué|para qué|con qué|con quién|dónde|cuándo exactam)\b/i,
  /\b(diferencia entre|diferencia con|en qué se diferenc)\b/i,
  /\b(proceso|metodolog|sistema|plan de trabajo|paso a paso)\b/i,
];

const NEGOTIATION_PATTERNS = [
  /\b(descuento|rebaja|más barato|mas barato|oferta|promoción|promocion)\b/i,
  /\b(cuotas|mensualidad|financ|en partes|a plazos)\b/i,
  /\b(primero probar|muestra|demo|prueba gratis|trial)\b/i,
];

function detectComplexity({ newMessage, conversationHistory }) {
  const text = (newMessage || '').toLowerCase();
  let score = 0;
  const reasons = [];

  // Señal 1: objeciones
  if (OBJECTION_PATTERNS.some(p => p.test(text))) {
    score += 3;
    reasons.push('objeción');
  }

  // Señal 2: preguntas técnicas/condicionales
  if (TECHNICAL_QUESTION_PATTERNS.some(p => p.test(text))) {
    score += 2;
    reasons.push('pregunta técnica');
  }

  // Señal 3: negociación
  if (NEGOTIATION_PATTERNS.some(p => p.test(text))) {
    score += 3;
    reasons.push('negociación');
  }

  // Señal 4: mensaje largo — el prospecto está elaborando
  if (text.length > 250) {
    score += 2;
    reasons.push('mensaje extenso');
  }

  // Señal 5: conversación avanzada — más en juego
  if (conversationHistory.length >= 6) {
    score += 1;
    reasons.push('conversación avanzada');
  }

  // Señal 6: historia muy larga + mensaje con pregunta — probablemente cierre o bloqueo
  if (conversationHistory.length >= 10 && text.includes('?')) {
    score += 2;
    reasons.push('cierre crítico');
  }

  // Threshold: score >= 3 → usa reasoning
  return { useReasoning: score >= 3, score, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE REPLY — ahora con selección de modelo híbrida
// ─────────────────────────────────────────────────────────────────────────────

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

  // ── Detectar complejidad y elegir modelo ───────────────────────────────────
  const complexity = detectComplexity({ newMessage, conversationHistory });
  // Permitir override vía env var (para A/B testing y ahorro en trial)
  const fastModel      = process.env.OPENAI_FAST_MODEL      || 'gpt-4o-mini';
  const reasoningModel = process.env.OPENAI_REASONING_MODEL || 'o4-mini';
  const useReasoningGlobal = process.env.OPENAI_USE_REASONING !== 'false'; // default on

  const shouldUseReasoning = complexity.useReasoning && useReasoningGlobal;
  const selectedModel = shouldUseReasoning ? reasoningModel : fastModel;

  if (shouldUseReasoning) {
    console.log(`🧠 Reasoning ON (${selectedModel}) — score=${complexity.score} reasons=[${complexity.reasons.join(', ')}]`);
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(m => ({
      role: m.role === 'agent' ? 'assistant' : 'user',
      content: m.content
    })),
    { role: 'user', content: newMessage }
  ];

  // Reasoning models (o1/o3/o4) NO aceptan 'temperature' ni 'max_tokens' tradicional
  // Usan 'max_completion_tokens' y reasoning_effort. También no aceptan system role clásico.
  const isReasoningModel = /^o[134]/.test(selectedModel);

  let response;
  if (isReasoningModel) {
    // Para reasoning models: consolidar system en primer 'developer'/'user' message
    const reasoningMessages = [
      { role: 'developer', content: systemPrompt },
      ...conversationHistory.map(m => ({
        role: m.role === 'agent' ? 'assistant' : 'user',
        content: m.content
      })),
      { role: 'user', content: newMessage }
    ];
    response = await client.chat.completions.create({
      model: selectedModel,
      messages: reasoningMessages,
      max_completion_tokens: 800, // reasoning tokens + output
      reasoning_effort: 'low',    // bajo para respuestas rápidas y baratas (chat IG debe ser veloz)
    });
  } else {
    response = await client.chat.completions.create({
      model: selectedModel,
      messages,
      max_tokens: 300,
      temperature: 0.85,
    });
  }

  const reply = response.choices[0].message.content;

  // Log de uso para panel admin
  try {
    const usage = response.usage || {};
    await db.insert(db.aiUsage, {
      accountId:           accountId || null,
      agentId:             agent._id || agent.id || null,
      model:               selectedModel,
      reasoning:           shouldUseReasoning,
      complexityScore:     complexity.score,
      complexityReasons:   complexity.reasons,
      promptTokens:        usage.prompt_tokens || 0,
      completionTokens:    usage.completion_tokens || 0,
      reasoningTokens:     usage.completion_tokens_details?.reasoning_tokens || 0,
      totalTokens:         usage.total_tokens || 0,
    });
  } catch (e) {
    // no bloquear por fallo de logging
    if (process.env.NODE_ENV !== 'production') console.warn('aiUsage log skip:', e.message);
  }

  return reply;
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

module.exports = { generateReply, classifyLead, detectComplexity };
