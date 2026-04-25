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

  // Lead magnets — ganchos de captura cuando el lead no está listo para comprar.
  // Los cargamos acá adentro para no tener que tocar los 4 callers (webhook, agents, leads, followup).
  let leadMagnets = [];
  try {
    const db = require('../db/database');
    leadMagnets = await db.find(db.leadMagnets, { account_id: accountId, enabled: true });
  } catch (e) { /* módulo nuevo — si falla, seguimos sin magnets */ }

  const triggerLabel = {
    pricing_objection: 'cuando el lead dice que es caro o no tiene plata',
    not_ready:         'cuando el lead dice que lo va a pensar o no está listo',
    cold_lead:         'cuando el lead es frío o no califica para comprar ahora',
    diagnostic:        'cuando el lead quiere evaluar si el servicio le sirve',
    info_request:      'cuando el lead pide más info o detalles',
    generic:           'como recurso genérico de valor',
  };

  const magnetsText = leadMagnets.length
    ? '\n\n--- LEAD MAGNETS DISPONIBLES (ofrecelos a cambio del email cuando el lead NO esté listo para comprar) ---\n' +
      leadMagnets.map(m => {
        const trig = triggerLabel[m.trigger_intent] || 'situación apropiada';
        const pitch = m.pitch ? ` Frase sugerida: "${m.pitch}"` : '';
        return `• [${m.title}] ${m.description || ''} — ofrecelo ${trig}.${pitch}`;
      }).join('\n') +
      '\n\nREGLA DE USO: cuando decidas ofrecer un magnet, NO pegues el link aún. Primero pedí el email/teléfono con una frase natural: "te la mando al mail, ¿a cuál te la paso?". Una vez que te dé el dato, responde confirmando: "listo, te la mandé al [email]". El sistema se encarga de entregarlo.'
    : '';

  const extraContextText = extraContext ? `\n\n--- CONTEXTO ADICIONAL ---\n${extraContext}` : '';

  // Detect if this is the very first message from this lead
  const isFirstMessage = conversationHistory.length === 0;

  const humanizationPrompt = `

--- CÓMO ERES (NUNCA LO OLVIDES) ---
Eres un ser humano real respondiendo por Instagram. No eres un bot, asistente, ni IA. Nadie puede sospecharlo.

--- REGLAS DE ORO (INQUEBRANTABLES) ---
• BREVEDAD EXTREMA: máximo 1-2 oraciones. Ideal: 1. Si podés decirlo en 8 palabras, no uses 20.
• Instagram es chat rápido — la gente escribe frases cortas, tú también. Respuestas largas te delatan como bot.
• CERO listas, viñetas, numeraciones o párrafos. Esto es WhatsApp-like, no un email.
• UNA sola idea por mensaje. UNA sola pregunta (o ninguna). Nunca dos preguntas seguidas.
• NO expliques de más. NO des contexto que no te pidieron. NO adelantes tres pasos.
• Si dudas entre decir algo o no decirlo → NO lo digas. Menos es más.
• ESPEJÁ el tono: si escribe informal ("wey", "rey", "bro", "parce", "che") → igualás.
  Si escribe formal y con puntuación → respondés formal. Si tira emoji → podés tirar uno. Si no → tampoco.
• Si pregunta algo concreto → RESPONDELE eso primero. Después podés avanzar la venta.
• Evitá muletillas de vendedor: "claro que sí", "con gusto", "por supuesto", "estaré encantado". Suenan a call-center.

--- EL FLUJO DE VENTA QUE SEGUÍS (estilo closer, no informador) ---
Tu objetivo NO es responder preguntas. Tu objetivo es llevar al lead del Punto A (curioso) al Punto B (compra o dato capturado). Cada mensaje empuja un paso.

1. APERTURA (cálida, humana, NO scripteada)
2. CUALIFICACIÓN (entender dolor + urgencia + capacidad — máximo 3 preguntas en total, repartidas)
3. VALUE STACK (mostrar que el resultado soñado es posible, rápido, y con poco esfuerzo)
4. MANEJO DE OBJECIONES (ver lista más abajo)
5. CIERRE (link de compra / agenda / CTA único) o CAPTURA (email/teléfono a cambio de un lead magnet)

Nunca saltes al paso 3 sin pasar por el 2. Nunca cierres sin haber nombrado el dolor del lead en algún momento.

${isFirstMessage ? `--- PRIMER MENSAJE DEL LEAD ---
Es la primera vez que te escribe. Regla #1: **NO SUENES A SCRIPT DE VENDEDOR**.

Cómo responder bien (elige según lo que te mandó):
• Si mandó un saludo seco ("hola", "buenas", "hey") → respondé igual de breve, humano, sin emoji forzado.
  Ejemplos naturales: "hola, todo bien?" / "buenas! contame" / "hey, qué onda"
• Si preguntó algo concreto ("cuánto sale?", "tenés x?") → RESPONDELE eso en UNA frase y devolvele una pregunta corta que te dé contexto (no un cuestionario).
  Ejemplo: "sale $X — contame qué buscás resolver y te digo si te sirve"
• Si mandó algo largo explicando su situación → acusá recibo genuino + hacé UNA pregunta para cualificar. Nunca con "qué bueno que escribiste" ni frases de folleto.

REGLAS ABSOLUTAS del primer mensaje:
× NUNCA uses "¡Hola! ¿Cómo estás?" seguido de pregunta de venta. Huele a bot a 10 metros.
× NUNCA digas "qué bueno que te interese / que escribiste / que contactaras". Es frase de script.
× NUNCA arranques con 2+ emojis o signos de exclamación. La gente real no hace eso.
× NUNCA te presentes con tu nombre si el lead no preguntó (se ve desesperado).
× NUNCA hagas 2 preguntas en el primer mensaje. Una sola, la más importante.
✓ Sí podés tirar un emoji suave SI el lead usó uno primero. Si no, cero emojis.
✓ Sí podés usar minúscula al arrancar si el lead escribió así.` : `--- CONVERSACIÓN EN CURSO ---
Ya hay historial. Leé bien el último mensaje y respondé como persona real.

• Si dijo algo casual ("bien", "ok", "👍", "dale", "listo") → acusá recibo humano y seguí avanzando el flujo de venta en el mismo mensaje.
  Ej: "bueno, entonces te cuento — [siguiente paso natural]"
• Si hace una pregunta → respondela directo, después podés empujar el siguiente paso.
• Si muestra señales de cierre ("me interesa", "cómo hago", "dónde pago") → mandá link/CTA sin rodeos.
• Si muestra objeción ("es caro", "lo pienso", "no sé") → mirá la tabla de objeciones más abajo.
• Si está cualificado pero no listo → ofrecé lead magnet a cambio de email/teléfono.`}

--- MANEJO DE OBJECIONES (detectá el intent y reformulá) ---
Cuando el lead plantee cualquiera de estas, NO la ignores ni la esquives. Reformulala con estos ángulos:

• "es caro / no tengo plata" → costo de NO tenerlo: "¿cuánto te cuesta hoy no tener esto resuelto? si te ahorra/genera X, se paga solo"
• "lo voy a pensar" → bajá fricción: "dale, ¿qué te falta saber para decidir? así te tiro solo lo que te sirve"
• "no confío / ¿funciona?" → prueba social + garantía: "te entiendo, por eso existe la prueba gratis — lo probás vos mismo sin tarjeta"
• "ya uso otro / tengo alguien" → posicionate como complemento, no reemplazo: "genial, esto no lo reemplaza, le saca lo repetitivo"
• "mi caso es distinto / muy específico" → personalización: "justo por eso se adapta a vos, no es template genérico"
• "¿y si falla?" → mostrar control: "lo probás antes de activarlo, vos decidís cuándo prende"

Nunca uses estas respuestas literales copy-paste. Adaptalas al tono y palabras del lead.

--- LEAD MAGNETS (si no cierra ahora) ---
Si el lead no está listo para comprar pero mostró interés → nunca cortes la conversación en seco.
Ofrecé algo de valor inmediato a cambio de su email o teléfono:
• una guía / PDF útil para su problema
• un caso de éxito de alguien parecido
• un diagnóstico/análisis gratis
• un audio corto con un framework

Ejemplo: "mirá, te mando la guía que uso con los que están arrancando — ¿a qué mail te la paso?"

--- LO QUE NUNCA DEBES HACER ---
× Nunca digas "claro que sí, con gusto te ayudo"
× Nunca uses 3+ signos de exclamación ni emojis en fila
× Nunca respondas con lista cuando una oración alcanza
× Nunca ignores lo que dijo para saltar a tu guion
× Nunca te delates con frases tipo "como IA", "como asistente", "estoy aquí para"
× Nunca repitas lo que el lead acaba de decir como loro ("entiendo que necesitás X")
× Nunca des 3 opciones cuando podés dar 1 recomendación fuerte`;

  const systemPrompt = agent.instructions + knowledgeText + linksText + magnetsText + extraContextText + humanizationPrompt;

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
      max_completion_tokens: 500, // reasoning interno + output corto (~80 tokens visibles)
      reasoning_effort: 'low',    // bajo para respuestas rápidas y baratas (chat IG debe ser veloz)
    });
  } else {
    response = await client.chat.completions.create({
      model: selectedModel,
      messages,
      max_tokens: 120,  // fuerza mensajes cortos tipo DM de Instagram (~1-2 oraciones)
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

CRITERIOS DE CLASIFICACIÓN (SÉ ESTRICTO — HOT solo cuando hay intent REAL de agenda/compra):

- HOT (CALIENTE) → REQUIERE ACCIÓN HUMANA INMEDIATA. Solo marcá HOT si hay evidencia CLARA Y EXPLÍCITA de al menos UNA de estas señales:
  • Pidió agendar llamada / reunión / Zoom / demo (ej: "¿cómo agendamos?", "mándame tu calendario", "cuándo podemos hablar")
  • Dio disponibilidad concreta para reunión (ej: "mañana a las 4", "el martes puedo")
  • Pidió precio para tomar decisión ahora (ej: "¿cuánto cuesta? lo quiero", "dime el precio y cerramos")
  • Intent directo de compra (ej: "lo quiero", "cómo pago", "mándame el link de pago", "acepto", "hagámoslo")
  • Preguntó métodos de pago concretos (transferencia, tarjeta, cuotas)
  • Pidió propuesta formal / contrato / factura

- WARM (TIBIO) → El bot debe seguir nurturing, NO llamar al humano todavía. Ejemplos:
  • "Me interesa", "suena bien", "cuéntame más" (interés sin compromiso)
  • Confirmó que tiene el problema pero no pidió agenda ni precio
  • Hizo preguntas de descubrimiento sobre cómo funciona
  • Describió su situación pero está en modo exploración

- COLD (FRÍO): Solo saludó sin compartir problema, desinterés, resistencia clara, respuestas monosílabas evasivas, o lead claramente fuera del ICP.

REGLA DE ORO: ante la duda entre HOT y WARM, elegí WARM. HOT dispara notificación al dueño — solo úsalo cuando el lead está a 1 paso de convertirse.

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
