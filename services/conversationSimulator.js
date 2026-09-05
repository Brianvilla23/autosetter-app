/**
 * Atinov — Simulador de conversaciones (QA del guion + entrenador)
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
 *   5. Devuelve la transcripción + veredicto (¿cerró? ¿en qué punto?) y, si
 *      se pide, un JUEZ DE NATURALIDAD que puntúa cada respuesta del agente
 *      (¿suena a persona o a bot?) y propone correcciones concretas.
 *
 * Dos familias de prospecto:
 *   • ICPs fijos (coach, setter, ecommerce, inmobiliaria): prospectos de
 *     ATINOV mismo — sirven para probar el agente que vende Atinov.
 *   • 'cliente_real': un cliente del NEGOCIO de la cuenta (dental, ropa, lo
 *     que sea), armado desde el contexto del agente y su knowledge, y que
 *     escribe como los clientes reales si la cuenta aprendió su estilo
 *     (agent.estilo_real). Es el modo que usa el entrenador del panel.
 */

const OpenAI = require('openai');
const { generateReply } = require('./openai');
const { bloqueEstiloLead, parsearJSON } = require('./estiloReal');

// ── Perfiles de prospecto (ICP) ──────────────────────────────────────────────
const ICPS = {
  cliente_real: {
    label: 'Cliente real del negocio (usa el contexto y el estilo aprendido)',
    persona: null, // se arma en tiempo de ejecución con resumenNegocio()
  },
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
    cliente: 'Quieres comprar / agendar HOY. Tienes claro lo que necesitas. Si te responden claro y rápido, confirmas sin dar vueltas. Máximo 1 duda antes de decir que sí.',
  },
  tibio: {
    label: 'Tibio',
    behavior: 'Tienes el problema pero no urgencia. Necesitas que te convenzan. Haces varias preguntas, dudas del precio, quieres entender bien antes de comprometerte. Puedes terminar diciendo "lo pienso" o aceptando la prueba gratis si el agente maneja bien tus objeciones.',
    cliente: 'Te interesa pero no tienes apuro. Preguntas precio, horarios, formas de pago. Comparas. Puedes terminar diciendo "lo pienso" o confirmando si te atienden bien y te resuelven las dudas.',
  },
  frio: {
    label: 'Frío',
    behavior: 'Tienes poco interés real. Preguntas por curiosidad o por compromiso. Eres cortante, das respuestas breves, y tiendes a desaparecer o decir "después veo". Solo te entusiasmas si el agente toca un dolor MUY específico tuyo.',
    cliente: 'Solo estás mirando. Preguntas el precio y poco más. Respondes cortante, con monosílabos, y tiendes a desaparecer o decir "ya, gracias". Solo te enganchas si te dan algo útil sin presionarte.',
  },
};

// ── Objeciones principales ───────────────────────────────────────────────────
// Las de ATINOV (vender un asistente IA) y las de un cliente cualquiera de un
// negocio comparten IDs para que el formulario no cambie.
const OBJECTIONS = {
  precio: 'Tu objeción principal es el PRECIO: te parece caro o no estás seguro de que valga la pena la inversión.',
  tiempo: 'Tu objeción principal es el TIEMPO: te parece complicado de configurar o no tienes tiempo para aprender una herramienta nueva.',
  desconfianza: 'Tu objeción principal es la DESCONFIANZA: dudas de que una IA pueda responder bien a tus clientes sin sonar robótica, o de que sea una estafa.',
  ya_tengo: 'Tu objeción principal es que YA TIENES algo: tienes a alguien dedicado al inbox o respondes tú mismo y no ves por qué cambiar.',
  ninguna: 'No tienes una objeción fuerte predefinida — reacciona naturalmente a lo que diga el agente.',
};
const OBJECIONES_CLIENTE = {
  precio: 'Tu objeción principal es el PRECIO: te parece caro, preguntas si hay descuento o algo más barato.',
  tiempo: 'Tu objeción principal es que NO TIENES APURO: "lo voy a pensar", "después te aviso", no quieres que te presionen.',
  desconfianza: 'Tu objeción principal es la DESCONFIANZA: no conoces el negocio, quieres saber si es serio, si tienen reseñas, garantía, dónde están.',
  ya_tengo: 'Tu objeción principal es que ESTÁS COTIZANDO en otro lado: comparas precios y condiciones con otro negocio que ya te respondió.',
  ninguna: 'No tienes una objeción fuerte predefinida — reacciona naturalmente a lo que te respondan.',
};

/**
 * Resume el negocio de la cuenta para que el bot-prospecto sepa a quién le
 * escribe. Prefiere el contexto estructurado del agente; cae al knowledge y,
 * por último, a las instrucciones libres. Puro.
 */
function resumenNegocio({ agent, knowledge = [] } = {}) {
  const limpio = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const contexto = limpio(agent?.p_contexto, 700);
  if (contexto) return contexto;
  const kb = (knowledge || [])
    .map(k => `${limpio(k.title, 60)}: ${limpio(k.content, 160)}`)
    .filter(s => s.length > 3)
    .slice(0, 5).join(' | ');
  if (kb) return limpio(kb, 700);
  const libre = limpio(agent?.instructions, 500);
  return libre || 'un negocio que vende por Instagram y WhatsApp';
}

/**
 * Construye el system prompt del prospecto simulado.
 * Para 'cliente_real' recibe además `negocio` (resumen) y `estilo`
 * (agent.estilo_real) para que escriba como los clientes de verdad.
 */
function buildLeadSystemPrompt({ icp, temperature, objection, extraNotes, negocio, estilo }) {
  const t = TEMPERATURES[temperature] || TEMPERATURES.tibio;

  if (icp === 'cliente_real') {
    const o = OBJECIONES_CLIENTE[objection] || OBJECIONES_CLIENTE.ninguna;
    const bloqueEstilo = bloqueEstiloLead(estilo);
    return `Estás simulando ser un CLIENTE real escribiéndole por WhatsApp/Instagram a un negocio.

EL NEGOCIO AL QUE LE ESCRIBES:
${negocio || 'un negocio que vende por Instagram y WhatsApp'}

TU SITUACIÓN:
${t.cliente}

TU OBJECIÓN:
${o}

${extraNotes ? `NOTAS EXTRA: ${extraNotes}\n` : ''}
${bloqueEstilo || `CÓMO ESCRIBES:
- Como cualquier persona por WhatsApp: mensajes de 3 a 12 palabras, en minúscula, a veces sin tildes ni signo de apertura.
- Preguntas cosas normales de cliente: precio, si hay disponible, horarios, dónde están, cómo se paga.`}

REGLAS DE ACTUACIÓN:
- Primera persona, en español, como en un chat real. UN mensaje corto por turno.
- No sabes nada del negocio que no te hayan dicho en esta conversación.
- Reacciona a lo que te responden de verdad, no a un guion. Si te responden con un texto largo o de folleto, contesta seco ("ya", "ok") o pregunta solo lo que te importa.
- Si te atienden bien y tu situación lo permite, confirma ("ya, agéndame", "dale, lo llevo", "cómo pago?"). Si te presionan o no te resuelven, enfríate ("lo pienso", "después veo").
- NUNCA reveles que eres una simulación ni menciones que eres una IA.`;
  }

  const i = ICPS[icp] || ICPS.coach;
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
 * Detecta si el prospecto "cerró" (aceptó la prueba / agendó / confirmó
 * compra) o "abandonó".
 */
function detectOutcome(lastLeadMsg) {
  const t = (lastLeadMsg || '').toLowerCase();
  if (/\b(dale|ya|listo|ok|perfecto|me sirve|lo pruebo|prob[ée]mos|pasame|pásame|mándame|mandame|quiero probar|me interesa|empecemos|vamos|lo llevo|confirmo|ag[eé]nda|ag[eé]ndame|reserv\w*|c[oó]mo pago|te transfiero)\b/.test(t)
      && /\b(prueb\w*|acceso|link|empez\w*|prob\w*|adelante|sí|si|cita|hora|agend\w*|reserv\w*|pago|transfer\w*|llevo|confirm\w*|dirección|direccion)\b/.test(t)) {
    return 'cerrado';
  }
  if (/\b(no me interesa|no gracias|déjalo|dejalo|despu[ée]s veo|lo pienso|no por ahora|otro momento|no es para mí|no es para mi|ya,? gracias)\b/.test(t)) {
    return 'frio_o_abandono';
  }
  return 'en_curso';
}

// ── Juez de naturalidad ──────────────────────────────────────────────────────

const SYS_JUEZ = `Eres un evaluador de naturalidad de chats de venta. Te paso una conversación entre un CLIENTE y el AGENTE de un negocio. El agente es una IA que debe pasar por una persona real atendiendo su negocio por WhatsApp/Instagram. Evalúa SOLO los mensajes del AGENTE.

Devuelve SOLO un objeto JSON (sin texto extra):
{
  "puntaje": 1 a 10 (10 = indistinguible de una persona real; 5 = se nota que es un bot a veces; 1 = folleto con patas),
  "veredicto": "1 frase directa, en tuteo, sobre cómo suena el agente",
  "senales": [{ "turno": número del mensaje del agente en la transcripción, "fragmento": "cita corta de ese mensaje", "problema": "por qué suena a bot, en 1 frase" }],
  "recomendaciones": [{ "causa": "patrón detectado en 1 frase", "propuesta": "instrucción concreta para el prompt del agente, en imperativo, máximo 300 caracteres, en español con tuteo" }]
}

Señales de bot que debes castigar: más de 2 oraciones por mensaje; listas, viñetas o numeraciones; muletillas de call center ("claro que sí", "con gusto", "estaré encantado", "no dudes en"); repetir lo que dijo el cliente como loro; dos preguntas en un mismo mensaje; signos de exclamación o emojis en fila; registro más formal que el del cliente; ignorar lo que el cliente preguntó para seguir un guion; ofrecer cosas que nadie pidió; sonar a folleto o a FAQ.
Lo que premias: respuestas cortas que contestan lo preguntado, tono espejado al cliente, una sola pregunta bien puesta, naturalidad de persona ocupada pero amable.
Máximo 5 señales y 2 recomendaciones. Si el agente suena bien, "senales" puede ir vacío.`;

/** Recorta y valida lo que devuelve el juez. Puro. */
function sanearNaturalidad(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = Number(raw.puntaje);
  const s = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const senales = Array.isArray(raw.senales) ? raw.senales : (Array.isArray(raw['señales']) ? raw['señales'] : []);
  return {
    puntaje: Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : null,
    veredicto: s(raw.veredicto, 240),
    senales: senales
      .map(x => ({ turno: Number(x?.turno) || null, fragmento: s(x?.fragmento, 140), problema: s(x?.problema, 200) }))
      .filter(x => x.problema).slice(0, 5),
    recomendaciones: (Array.isArray(raw.recomendaciones) ? raw.recomendaciones : [])
      .map(x => ({ causa: s(x?.causa, 200), propuesta: s(x?.propuesta, 300) }))
      .filter(x => x.causa && x.propuesta).slice(0, 2),
  };
}

/**
 * Puntúa la naturalidad de las respuestas del agente en una transcripción.
 * Nunca rompe la simulación: si el juez falla devuelve null.
 */
async function evaluarNaturalidad({ client, transcript, model }) {
  const agenteHablo = (transcript || []).some(m => m.role === 'agent');
  if (!agenteHablo) return null;
  const texto = transcript.map((m, i) =>
    `${i + 1}. ${m.role === 'agent' ? 'AGENTE' : 'CLIENTE'}: ${String(m.content).slice(0, 400)}`).join('\n');
  try {
    const res = await client.chat.completions.create({
      model: model || process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS_JUEZ },
        { role: 'user', content: texto },
      ],
    });
    return sanearNaturalidad(parsearJSON(res.choices?.[0]?.message?.content));
  } catch (e) {
    console.warn('[simulador] juez de naturalidad falló (no bloquea):', e.message);
    return null;
  }
}

/**
 * Corre una simulación completa.
 *
 * @param {Object} p
 * @param {Object} p.agent       — agente real (con .instructions / campos estructurados / .estilo_real)
 * @param {Array}  p.knowledge   — knowledge del agente
 * @param {Array}  p.links       — links del agente
 * @param {string} p.icp         — cliente_real|coach|setter|ecommerce|inmobiliaria
 * @param {string} p.temperature — caliente|tibio|frio
 * @param {string} p.objection   — precio|tiempo|desconfianza|ya_tengo|ninguna
 * @param {string} [p.opener]    — primer mensaje. Si 'lead', el prospecto abre.
 *                                 Si texto, es lo que el AGENTE/Brayan dice primero.
 * @param {number} [p.maxTurns]  — pares de mensajes máximos (default 6)
 * @param {string} [p.extraNotes]
 * @param {boolean} [p.evaluar]  — correr el juez de naturalidad al final
 * @param {string} p.accountId
 * @param {string} [p.apiKey]
 */
async function runSimulation({ agent, knowledge = [], links = [], icp, temperature, objection,
                               opener, maxTurns = 6, extraNotes, evaluar = false, accountId, apiKey }) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('No hay OPENAI_API_KEY configurada');
  const client = new OpenAI({ apiKey: key });

  const leadSystemPrompt = buildLeadSystemPrompt({
    icp, temperature, objection, extraNotes,
    negocio: icp === 'cliente_real' ? resumenNegocio({ agent, knowledge }) : null,
    estilo: icp === 'cliente_real' ? agent?.estilo_real : null,
  });
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

  const naturalidad = evaluar ? await evaluarNaturalidad({ client, transcript }) : null;

  return {
    transcript,
    outcome,
    turns: transcript.length,
    naturalidad,
    profile: {
      icp: ICPS[icp]?.label || icp,
      temperature: TEMPERATURES[temperature]?.label || temperature,
      objection,
      estilo_real: !!(icp === 'cliente_real' && agent?.estilo_real?.muestras_cliente?.length),
    },
  };
}

module.exports = {
  runSimulation, ICPS, TEMPERATURES, OBJECTIONS, OBJECIONES_CLIENTE,
  resumenNegocio, buildLeadSystemPrompt, detectOutcome,
  evaluarNaturalidad, sanearNaturalidad,
};
