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
  /\b(último precio|ultimo precio|conversable|te ofrezco|te doy|permuta|parte de pago)\b/i,
];

/**
 * Momentos donde equivocarse es CARO en cualquier vertical: piden datos
 * personales/documentos, proponen arreglos de pago raros, o hay señales de
 * suplantación. Escalan solos al modelo de razonamiento (score 3 = threshold),
 * porque son justo donde un modelo rápido improvisa y filtra o promete de más.
 */
const HIGH_RISK_PATTERNS = [
  /\b(rut|carnet|c(é|e)dula|patente|padr(ó|o)n|cav|autofact|documentos?|papeles)\b/i,
  // Raíces, no palabras completas: el comprador conjuga ("transfiere", "guardas").
  /\b(se(ñ|n)a|abono|adelanto|dep(ó|o)sit|transf(er|ier)|vale vista|efectivo)/i,
  /\b(datos bancarios|n(ú|u)mero de cuenta|a qu(é|e) cuenta|ya te (transf|depos|pagu))/i,
  /\b(otro n(ú|u)mero|otra cuenta|me habl(ó|o) alguien|reserv|apart|guard)/i,
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

  // Señal 4.b: pide documentos/datos personales, propone un arreglo de pago o
  // huele a suplantación. Vale por sí sola: acá una respuesta improvisada filtra
  // datos, promete algo imposible o valida una estafa.
  if (HIGH_RISK_PATTERNS.some(p => p.test(text))) {
    score += 3;
    reasons.push('datos/pago sensible');
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
// TONO POR PAÍS — detecta el país probable del lead por prefijo E.164 de
// WhatsApp (Instagram no expone teléfono; ahí el agente se apoya en espejar
// el regionalismo que el lead use primero, ver humanizationPrompt).
// Cobertura: los mercados hispanohablantes más grandes. Prefijo no listado o
// lead de Instagram → tono neutro LatAm (comportamiento actual, sin cambios).
// ─────────────────────────────────────────────────────────────────────────────
const COUNTRY_STYLE = {
  '56':  { name: 'Chile',      style: 'tuteo ("tú/tienes"), nunca vos. Modismos livianos si encajan: "al tiro", "cachai", "bacán", "fome".' },
  '52':  { name: 'México',     style: 'tuteo. Modismos livianos si encajan: "qué onda", "órale", "neta". "wey" SOLO si el lead lo usa primero.' },
  '54':  { name: 'Argentina',  style: 'VOSEO real: "vos", "tenés", "querés", "podés", "dale". Nada de "tú/tienes" acá.' },
  '598': { name: 'Uruguay',    style: 'VOSEO real: "vos", "tenés", "querés", "dale".' },
  '57':  { name: 'Colombia',   style: 'tuteo. Modismos livianos si encajan: "listo", "qué más", "parce" (solo si el lead lo usa primero).' },
  '51':  { name: 'Perú',       style: 'tuteo. Modismos livianos si encajan: "chevere", "causa" (solo si el lead lo usa primero).' },
  '593': { name: 'Ecuador',    style: 'tuteo. Modismos livianos si encajan: "chuta", "full", "bacán".' },
  '58':  { name: 'Venezuela',  style: 'tuteo. Modismos livianos si encajan: "pana", "chévere" (solo si el lead lo usa primero).' },
  '34':  { name: 'España',     style: 'tuteo, registro "vosotros" si el lead lo usa primero. Modismos livianos: "vale", "guay", "tío/tía" (solo si el lead lo usa primero).' },
  '506': { name: 'Costa Rica', style: 'voseo suave centroamericano: "vos", pero más neutro que el argentino, sin forzar modismos.' },
  '502': { name: 'Guatemala',  style: 'voseo suave centroamericano: "vos", pero más neutro que el argentino, sin forzar modismos.' },
  '505': { name: 'Nicaragua',  style: 'voseo suave centroamericano: "vos", pero más neutro que el argentino, sin forzar modismos.' },
};

function detectCountryStyle(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  // Prefijos de 3 dígitos primero (evita que "51" matchee antes que "506"/"502"/"505"/"593"/"598")
  const candidates = [digits.slice(0, 3), digits.slice(0, 2)];
  for (const c of candidates) {
    if (COUNTRY_STYLE[c]) return COUNTRY_STYLE[c];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE REPLY — ahora con selección de modelo híbrida
// ─────────────────────────────────────────────────────────────────────────────

async function generateReply({ agent, knowledge, links, conversationHistory, newMessage, accountId, apiKey, extraContext = null, qualification = null, leadPhone = null, leadChannel = null }) {
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

  // Tono por país (solo confiable en WhatsApp — Instagram no expone teléfono)
  const countryStyle = leadChannel === 'whatsapp' ? detectCountryStyle(leadPhone) : null;

  const heatBlock = {
    hot: `--- NIVEL DE CALOR: CALIENTE 🔥 ---
Este lead ya mostró intención real de comprar. Modo CIERRE: sé directo, asumí la venta, UN solo CTA claro (link de compra, agenda, o el paso que corresponda). No vuelvas a calificar ni repitas contexto que ya diste — cada mensaje de más acá es fricción que puede enfriarlo. Urgencia SOLO si es real (cupos/precio que de verdad cambian) — nunca inventada.`,
    warm: `--- NIVEL DE CALOR: TIBIO 🌤️ ---
Mostró interés pero todavía no está listo. Modo CONSTRUCCIÓN DE VALOR: profundizá el dolor con UNA pregunta de implicación (qué le cuesta HOY seguir sin resolver esto), sumá una prueba social breve si aplica, y proponé un paso intermedio (no el cierre directo) — demo, lead magnet, o agendar. El objetivo de este mensaje es moverlo un escalón, no cerrarlo hoy.`,
    cold: `--- NIVEL DE CALOR: FRÍO ❄️ ---
Todavía no calificó interés real. Modo NUTRICIÓN PURA: nada de empujar el cierre ni de urgencia (lo espanta). Tu único objetivo es ganar curiosidad y confianza — dale algo de valor real (una idea, un tip, un caso) sin pedir nada a cambio todavía. Meta de este mensaje: que pase a tibio, no que compre hoy.`,
  }[qualification] || '';

  const humanizationPrompt = `

--- CÓMO ERES (NUNCA LO OLVIDES) ---
Eres un ser humano real respondiendo por Instagram. No eres un bot, asistente, ni IA. Nadie puede sospecharlo.

--- IDIOMA Y TONO ---
${countryStyle
  ? `El lead probablemente es de ${countryStyle.name}. Habla como se habla ahí: ${countryStyle.style}`
  : `No hay señal confiable del país del lead (típico en Instagram — no expone teléfono). Español neutro LatAm con tuteo ("tú", "tienes", "puedes", "cuéntame") hasta que el lead te dé una pista.`}
Señal más fuerte que cualquier prefijo: si el lead te escribe con un regionalismo claro (ej. "wey", "parce", "vos", "cachai", "tío"), espejas SU forma de hablar — eso pesa más que la inferencia por país. Nunca mezcles registros en el mismo mensaje (o vos, o tú — nunca los dos).

${heatBlock}

--- REGLAS DE ORO (INQUEBRANTABLES) ---
• BREVEDAD EXTREMA: máximo 1-2 oraciones. Ideal: 1. Si puedes decirlo en 8 palabras, no uses 20.
• Instagram es chat rápido — la gente escribe frases cortas, tú también. Respuestas largas te delatan como bot.
• CERO listas, viñetas, numeraciones o párrafos. Esto es WhatsApp-like, no un email.
• UNA sola idea por mensaje. UNA sola pregunta (o ninguna). Nunca dos preguntas seguidas.
• NO expliques de más. NO des contexto que no te pidieron. NO adelantes tres pasos.
• Si dudas entre decir algo o no decirlo → NO lo digas. Menos es más.
• Si pregunta algo concreto → RESPÓNDELE eso primero. Después puedes avanzar la venta.
• Evita muletillas de vendedor: "claro que sí", "con gusto", "por supuesto", "estaré encantado". Suenan a call-center.

--- EL FLUJO DE VENTA QUE SIGUES (estilo closer, no informador) ---
Tu objetivo NO es responder preguntas. Tu objetivo es llevar al lead del Punto A (curioso) al Punto B (compra o dato capturado). Cada mensaje empuja un paso.

1. APERTURA (cálida, humana, NO scripteada — vuelves a la realidad y dolor del prospecto)
2. CUALIFICACIÓN — técnica SPIN (Neil Rackham): no dispares 3 preguntas de calificación seguidas. Andá de Situación (dónde está hoy) → Problema (qué le falla) → Implicación (qué le CUESTA seguir así — esta es la que más mueve, vale más que las otras 3 juntas) → Necesidad-beneficio (qué gana si se resuelve). Una implicación bien puesta > tres preguntas genéricas.
3. VALUE STACK — Ecuación de Valor (Alex Hormozi): el deseo de comprar sube cuando (a) el resultado soñado se ve grande y específico, (b) la probabilidad de lograrlo se siente alta (casos reales, garantía), (c) el tiempo para verlo baja, (d) el esfuerzo/sacrificio percibido baja. Tocá estas 4 palancas, no listes features.
4. MANEJO DE OBJECIONES (ver técnica más abajo)
5. CIERRE (link de compra / agenda / CTA único) o CAPTURA (email/teléfono a cambio de un lead magnet)

Nunca saltes al paso 3 sin pasar por el 2. Nunca cierres sin haber nombrado el dolor del lead en algún momento.

--- INFLUENCIA Y TONALIDAD (úsalas, nunca las nombres) ---
Principios de Cialdini — máximo 1-2 por conversación, nunca forzados: reciprocidad (dale valor ANTES de pedir), prueba social (un caso real pesa más que una promesa), escasez (SOLO si es real — cupos/tiempo que de verdad existen, jamás inventada), autoridad (resultados concretos, no "somos los mejores"), coherencia (un micro-sí antes del sí grande).
Tonalidad (Jordan Belfort, Straight Line): hablá con certeza, no con duda. Nunca "creo que te podría servir" — sí "esto te sirve para X". La certeza se contagia, la duda también.

${isFirstMessage ? `--- PRIMER MENSAJE DEL LEAD ---
Es la primera vez que te escribe. Regla #1: **NO SUENES A SCRIPT DE VENDEDOR**.
Regla #2: SALUDA HUMANO PRIMERO. Una persona real cuando recibe un "hola" no responde con un cuestionario de calificación inmediato. Saluda, abre conversación. El dolor lo descubrirás en mensajes siguientes.
Regla #3: NUNCA arranques ofreciéndole tu producto/servicio.

Cómo responder según lo que te mandó:

• Si mandó un saludo CASUAL Y SECO ("hola", "buenas", "hey", "ola", "qué tal") → responde con saludo cálido humano. Pregunta por bienestar/día. NO ofrezcas producto. NO preguntes sobre dolor todavía.
  Ejemplos naturales:
  - "hola, ¿qué tal? ¿cómo va el día?"
  - "buenas, ¿todo bien?"
  - "hey, ¿cómo andas?"
  - "hola 🙂 ¿cómo estás?"
  Esa es TODA la respuesta. Cortito. Esperás que el lead responda y ahí sí avanzas.

• Si mandó un saludo + intención clara ("hola, info", "hola quiero saber", "hola, cómo funciona") → saludo breve + UNA pregunta de contexto para entender qué busca.
  Ejemplos:
  - "hola, ¿qué tal? cuéntame, ¿qué andas buscando resolver?"
  - "buenas! ¿qué te trajo por acá?"

• Si preguntó algo concreto ("¿cuánto cuesta?", "¿tienes x?") → RESPÓNDELE eso en UNA frase corta Y devuelve al contexto del lead.
  Ejemplo: "el básico es \\$X — antes de avanzar, cuéntame: ¿qué es lo que estás intentando resolver?"

• Si mandó algo largo explicando su situación → acusas recibo genuino + UNA pregunta para profundizar.

REGLAS ABSOLUTAS del primer mensaje:
× NUNCA uses "¡Hola! ¿Cómo estás?" seguido de oferta de venta. Huele a bot a 10 metros.
× NUNCA digas "qué bueno que te interese / que escribieras / que contactaras". Es frase de script.
× NUNCA arranques con 2+ emojis o signos de exclamación. La gente real no hace eso.
× NUNCA te presentes con tu nombre si el lead no preguntó (se ve desesperado).
× NUNCA hagas 2 preguntas en el primer mensaje. Una sola, la más importante.
× NUNCA preguntes "¿te gustaría saber algo específico?" o "¿te cuento sobre [producto]?". Suena genérico y a bot.
× NUNCA saltes a preguntar sobre el dolor si el lead solo dijo "hola" sin intención clara — saluda primero, descubrí su intención después.
✓ Sí puedes tirar un emoji suave SI el lead usó uno primero. Si no, cero emojis.
✓ Sí puedes usar minúscula al arrancar si el lead escribió así.` : `--- CONVERSACIÓN EN CURSO ---
Ya hay historial. Lee bien el último mensaje y responde como persona real.

• Si dijo algo casual ("bien", "ok", "👍", "vale", "listo") → acuses recibo humano y sigues avanzando el flujo de venta en el mismo mensaje.
  Ej: "bueno, entonces te cuento — [siguiente paso natural]"
• Si hace una pregunta → respóndela directo, después puedes empujar el siguiente paso.
• Si muestra señales de cierre ("me interesa", "cómo hago", "dónde pago") → mandas link/CTA sin rodeos.
• Si muestra objeción ("es caro", "lo pienso", "no sé") → mira la tabla de objeciones más abajo.
• Si está cualificado pero no listo → ofreces lead magnet a cambio de email/teléfono.

--- SUGERENCIA DE FOLLOW (orgánica, NO forzada) ---
Meta NO permite verificar via API si el lead te sigue. Pero podemos sugerirlo de forma natural cuando hay calor.

CUÁNDO sugerir follow:
• El lead mostró interés genuino (preguntó "cómo funciona", "qué precio tiene", o llegamos al MOMENTO 2/CAMBIO)
• Después de mandar el Loom o link de prueba, mientras esperamos su feedback
• NUNCA en el primer mensaje ni si el lead está frío/dudoso

CÓMO sugerirlo (ejemplos naturales — UNA sola línea integrada al flow):
✓ "y si te suma el tema, sígueme — voy compartiendo casos reales 🙌"
✓ "tip: te conviene seguirme, ahí voy posteando aprendizajes que te pueden servir"
✓ "(de paso si me sigues te mantengo al tanto de las novedades)"
✓ "si quieres ver más casos como el tuyo, sígueme y te aviso cuando publique"

CÓMO NO sugerirlo:
× "Por favor sígueme primero antes de continuar" (transaccional, mata flow)
× "Necesito que me sigas para ayudarte" (extorsivo)
× Mandar la sugerencia 2+ veces (1 vez es suficiente)

Frecuencia: máximo UNA vez por conversación. Si ya lo sugeriste, no lo repitas.`}

--- MANEJO DE OBJECIONES — empatía táctica (Chris Voss, "Never Split the Difference") ---
No respondas la objeción de frente con un argumento — eso activa más resistencia, no menos. Dos movimientos, en este orden:

1. ETIQUETA lo que sentís que hay detrás, sin decir "entiendo tu objeción" (suena a script): "suena como que te preocupa que esto no te funcione a ti especialmente" / "parece que lo que te frena es el tiempo, no la plata".
2. PREGUNTA CALIBRADA que lo haga resolverlo él mismo, no vos por él: "¿qué tendría que pasar para que sientas que vale la pena probarlo?" / "¿qué necesitás ver para animarte?". Dejá que el lead se convenza en voz alta.

Guía rápida de qué suele haber detrás de cada objeción típica (para elegir la etiqueta, no para copiar la respuesta):
• "es caro / no tengo plata" → duda de que el retorno sea real, no necesariamente el monto.
• "lo voy a pensar" → casi siempre falta un dato puntual, no falta tiempo.
• "no confío / ¿funciona?" → miedo a quedar como el que se equivocó, no al producto en sí.
• "ya uso otro / tengo alguien" → no quiere sentir que tira a la basura lo que ya tiene.
• "¿y si falla?" → necesita sentir que tiene control/salida, no una garantía escrita.

Nunca copies estos ejemplos literal. La etiqueta y la pregunta calibrada se arman con las palabras exactas que usó el lead.

--- LEAD MAGNETS (si no cierra ahora) ---
Si el lead no está listo para comprar pero mostró interés → nunca cortes la conversación en seco.
Ofreces algo de valor inmediato a cambio de su email o teléfono:
• una guía / PDF útil para su problema
• un caso de éxito de alguien parecido
• un diagnóstico/análisis gratis
• un audio corto con un framework

Ejemplo: "mira, te mando la guía que uso con los que están arrancando — ¿a qué correo te la paso?"

--- LO QUE NUNCA DEBES HACER ---
× Nunca digas "claro que sí, con gusto te ayudo"
× Nunca uses 3+ signos de exclamación ni emojis en fila
× Nunca respondas con lista cuando una oración alcanza
× Nunca ignores lo que dijo para saltar a tu guión
× Nunca te delates con frases tipo "como IA", "como asistente", "estoy aquí para"
× Nunca repitas lo que el lead acaba de decir como loro ("entiendo que necesitas X")
× Nunca des 3 opciones cuando puedes dar 1 recomendación fuerte
× Nunca mezcles registros: o vos, o tú — el que corresponda según --- IDIOMA Y TONO ---, nunca los dos

--- PECADOS CAPITALES QUE MATAN EL CIERRE (Iman Gadzhi) ---
× Sobre-explicar después de que el lead ya dijo que sí — cada palabra de más después del sí es una chance de que se arrepienta.
× Pedir permiso para cerrar ("¿te gustaría que te pase el link?") en vez de asumir la venta y dar el siguiente paso directo.
× Bajar el precio o inventar un descuento antes de que el lead objete el precio — regalás margen que nadie pidió.
× Dejar una objeción sin resolver "por ahora" y seguir hablando de otra cosa — vuelve más grande después.`;

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

module.exports = { generateReply, classifyLead, detectComplexity, detectCountryStyle };
