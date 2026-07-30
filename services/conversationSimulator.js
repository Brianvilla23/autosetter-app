/**
 * Atinov — Simulador de conversaciones (QA del guion)
 *
 * Hace conversar a un "bot prospecto" (lead simulado con perfil configurable)
 * contra el agente REAL de Atinov (mismo generateReply que producción). Sirve
 * para iterar el guion del agente SIN gastar DMs reales ni arriesgar baneo de
 * Meta. 100% offline respecto a Instagram — solo usa OpenAI.
 *
 * Flujo:
 *   1. El prospecto abre (o el agente abre y el prospecto responde).
 *   2. generateReply() del agente responde (igual que en webhook real).
 *   3. El bot-prospecto reacciona según su perfil (ICP/temperatura/objeción).
 *   4. Loop N turnos o hasta que el prospecto cierre/abandone.
 *   5. Devuelve la transcripción + veredicto (¿cerró? ¿en qué punto?).
 */

const OpenAI = require('openai');
const { generateReply } = require('./openai');

// ── Perfiles de prospecto (ICP) ──────────────────────────────────────────────
const ICPS = {
  coach: {
    label: 'Coach / Mentora',
    persona: 'Eres dueña de un negocio de coaching/mentoría 1-a-1. Recibes muchos DMs de Instagram con preguntas repetidas sobre precio y disponibilidad. Tu tiempo es limitado y se te enfrían leads buenos.',
  },
  setter: {
    label: 'Setter / Closer / Agencia',
    persona: 'Eres appointment setter o tienes una agencia de marketing. Manejas alto volumen de DMs y conoces la jerga de ventas (HOT/WARM/COLD, ROI, conversión). Eres escéptico con las herramientas nuevas.',
  },
  ecommerce: {
    label: 'E-commerce / Tienda',
    persona: 'Tienes una tienda online que vende por Instagram. Los clientes preguntan tallas, stock y envío por DM, y si no contestas rápido compran en otro lado.',
  },
  inmobiliaria: {
    label: 'Inmobiliaria / Realtor',
    persona: 'Eres agente inmobiliario. Publicas propiedades en Instagram y te llegan muchas consultas por DM, la mayoría curiosos preguntando precio sin intención real de comprar.',
  },
};

// ── Temperaturas (qué tan listo está para comprar) ───────────────────────────
const TEMPERATURES = {
  caliente: {
    label: 'Caliente',
    behavior: 'Tienes un problema claro y URGENCIA de resolverlo. Estás abierto a probar. Si el agente te explica bien el valor y te ofrece una prueba gratis, ACEPTAS sin demasiada vuelta. Pones 1-2 objeciones suaves máximo antes de decir que sí.',
  },
  tibio: {
    label: 'Tibio',
    behavior: 'Tienes el problema pero no urgencia. Necesitas que te convenzan. Haces varias preguntas, dudas del precio, quieres entender bien antes de comprometerte. Puedes terminar diciendo "lo pienso" o aceptando la prueba gratis si el agente maneja bien tus objeciones.',
  },
  frio: {
    label: 'Frío',
    behavior: 'Tienes poco interés real. Preguntas por curiosidad o por compromiso. Eres cortante, das respuestas breves, y tiendes a desaparecer o decir "después veo". Solo te entusiasmas si el agente toca un dolor MUY específico tuyo.',
  },
};

// ── Objeciones principales ───────────────────────────────────────────────────
const OBJECTIONS = {
  precio: 'Tu objeción principal es el PRECIO: te parece caro o no estás seguro de que valga la pena la inversión.',
  tiempo: 'Tu objeción principal es el TIEMPO: te parece complicado de configurar o no tienes tiempo para aprender una herramienta nueva.',
  desconfianza: 'Tu objeción principal es la DESCONFIANZA: dudas de que una IA pueda responder bien a tus clientes sin sonar robótica, o de que sea una estafa.',
  ya_tengo: 'Tu objeción principal es que YA TIENES algo: tienes a alguien dedicado al inbox o respondes tú mismo y no ves por qué cambiar.',
  ninguna: 'No tienes una objeción fuerte predefinida — reacciona naturalmente a lo que diga el agente.',
};

/**
 * Construye el system prompt del prospecto simulado.
 */
function buildLeadSystemPrompt({ icp, temperature, objection, extraNotes }) {
  const i = ICPS[icp] || ICPS.coach;
  const t = TEMPERATURES[temperature] || TEMPERATURES.tibio;
  const o = OBJECTIONS[objection] || OBJECTIONS.ninguna;
  return `Estás simulando ser un PROSPECTO real en una conversación de Instagram DM. Una persona (un vendedor) te va a escribir ofreciéndote un asistente con IA para responder tus DMs.

TU PERFIL:
${i.persona}

TU TEMPERATURA DE COMPRA:
${t.behavior}

TU OBJECIÓN:
${o}

${extraNotes ? `NOTAS EXTRA: ${extraNotes}\n` : ''}
REGLAS DE ACTUACIÓN:
- Responde SIEMPRE en español neutro de LATAM, en primera persona, como en un chat de Instagram real.
- Mensajes CORTOS (1-3 líneas máximo), informales, como se escribe en DM.
- NO seas demasiado fácil ni demasiado difícil: actúa coherente con tu temperatura.
- NUNCA reveles que eres una simulación ni menciones que eres una IA.
- Si el vendedor maneja bien tus objeciones y tu temperatura lo permite, puedes aceptar la prueba gratis ("dale, lo pruebo" / "ya, pásame el acceso").
- Si el vendedor es flojo, repetitivo o no toca tu dolor, enfríate o corta la conversación ("lo pienso", "después veo", dejas de responder con interés).
- Reacciona a lo que el vendedor REALMENTE dice, no a un guion fijo.`;
}

/**
 * Genera el siguiente mensaje del prospecto simulado.
 * conversationHistory: [{ role:'agent'|'user', content }]  (igual que generateReply)
 * Desde la perspectiva del lead bot: 'agent' = el vendedor (assistant para él es AL REVÉS).
 */
async function generateLeadMessage({ client, leadSystemPrompt, conversationHistory, model }) {
  // Para el bot-prospecto, los mensajes del AGENTE son 'user' (lo que le llega)
  // y los del PROSPECTO son 'assistant' (lo que él mismo dijo).
  const messages = [
    { role: 'system', content: leadSystemPrompt },
    ...conversationHistory.map(m => ({
      role: m.role === 'agent' ? 'user' : 'assistant',
      content: m.content,
    })),
  ];
  const res = await client.chat.completions.create({
    model: model || process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
    messages,
    max_tokens: 100,
    temperature: 0.9,
  });
  return res.choices[0].message.content.trim();
}

/**
 * Detecta si el prospecto "cerró" (aceptó la prueba) o "abandonó".
 */
function detectOutcome(lastLeadMsg) {
  const t = (lastLeadMsg || '').toLowerCase();
  if (/\b(dale|ya|listo|ok|perfecto|me sirve|lo pruebo|prob[ée]mos|pasame|pásame|mándame|mandame|quiero probar|me interesa|empecemos|vamos)\b/.test(t)
      && /\b(prueba|acceso|link|empez|prob|adelante|sí|si)\b/.test(t)) {
    return 'cerrado';
  }
  if (/\b(no me interesa|no gracias|déjalo|dejalo|despu[ée]s veo|lo pienso|no por ahora|otro momento|no es para mí|no es para mi)\b/.test(t)) {
    return 'frio_o_abandono';
  }
  return 'en_curso';
}

/**
 * Corre una simulación completa.
 *
 * @param {Object} p
 * @param {Object} p.agent       — agente real (con .instructions)
 * @param {Array}  p.knowledge   — knowledge del agente
 * @param {Array}  p.links       — links del agente
 * @param {string} p.icp         — coach|setter|ecommerce|inmobiliaria
 * @param {string} p.temperature — caliente|tibio|frio
 * @param {string} p.objection   — precio|tiempo|desconfianza|ya_tengo|ninguna
 * @param {string} [p.opener]    — primer mensaje. Si 'lead', el prospecto abre.
 *                                 Si texto, es lo que el AGENTE/Brayan dice primero.
 * @param {number} [p.maxTurns]  — pares de mensajes máximos (default 6)
 * @param {string} [p.extraNotes]
 * @param {string} p.accountId
 * @param {string} [p.apiKey]
 */
async function runSimulation({ agent, knowledge = [], links = [], icp, temperature, objection,
                               opener, maxTurns = 6, extraNotes, accountId, apiKey }) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('No hay OPENAI_API_KEY configurada');
  const client = new OpenAI({ apiKey: key });

  const leadSystemPrompt = buildLeadSystemPrompt({ icp, temperature, objection, extraNotes });
  const transcript = []; // [{ role:'agent'|'lead', content }]
  let outcome = 'en_curso';

  // ── Mensaje inicial ──
  // Modo A: el flujo real de Atinov — Brayan/humano abre con saludo simple,
  // el lead responde, y el bot toma desde ahí. Replicamos eso: si `opener`
  // es texto, es el saludo humano; el lead responde primero.
  // Modo B: si opener === 'lead', el prospecto abre (ej: comentó "info").
  let history = []; // formato generateReply: {role:'agent'|'user', content}

  if (opener && opener !== 'lead') {
    // El humano (Brayan) abre con un saludo. Va como mensaje del AGENTE.
    transcript.push({ role: 'agent', content: opener });
    history.push({ role: 'agent', content: opener });
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. Turno del PROSPECTO
    const leadMsg = await generateLeadMessage({ client, leadSystemPrompt, conversationHistory: history });
    transcript.push({ role: 'lead', content: leadMsg });
    history.push({ role: 'user', content: leadMsg }); // 'user' = lead, para generateReply

    outcome = detectOutcome(leadMsg);
    if (outcome === 'cerrado' || outcome === 'frio_o_abandono') break;

    // 2. Turno del AGENTE real (mismo motor que producción)
    const agentReply = await generateReply({
      agent, knowledge, links,
      conversationHistory: history.slice(0, -1), // todo menos el último (que va como newMessage)
      newMessage: leadMsg,
      accountId, apiKey,
    });
    transcript.push({ role: 'agent', content: agentReply });
    history.push({ role: 'agent', content: agentReply });
  }

  return {
    transcript,
    outcome,
    turns: transcript.length,
    profile: {
      icp: ICPS[icp]?.label || icp,
      temperature: TEMPERATURES[temperature]?.label || temperature,
      objection,
    },
  };
}

module.exports = { runSimulation, ICPS, TEMPERATURES, OBJECTIONS };
