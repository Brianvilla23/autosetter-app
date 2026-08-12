/**
 * Atinov — Constantes compartidas de voz (Realtime).
 *
 * Existe para que la demo del dueño (`routes/voice.js`) y el closer en vivo
 * para leads (`routes/closer.js`) usen EXACTAMENTE las mismas reglas. Si esto
 * estuviera duplicado, el día que se afine el comportamiento por voz solo se
 * arreglaría en uno de los dos y el otro quedaría sonando distinto.
 */

// Voces soportadas por Realtime (distintas de las de TTS clásico).
const VOCES_REALTIME = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

// Las voces de TTS clásico (services/audio.js) no existen todas en Realtime.
// Mapear en vez de caer en silencio a la default: el agente debe sonar igual
// que en sus notas de voz.
const EQUIV_VOZ = { nova: 'shimmer', onyx: 'ash', fable: 'ballad' };
const VOZ_DEFAULT = 'marin';

const MODELO = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const MODELO_TRANSCRIPCION = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

// Topes de gasto. El secreto efímero dura 600s por defecto en OpenAI (no 60):
// suficiente para que alguien lo copie y lo use aparte. 60s alcanza de sobra
// para abrir la sesión desde la página.
const SECRETO_SEGUNDOS = 60;
const MAX_TOKENS_SALIDA = 4096; // techo por respuesta, corta un loop infinito

/**
 * Reglas que convierten a un agente de CHAT en uno de VOZ. Sin esto el agente
 * lee emojis en voz alta, larga párrafos que por audio son eternos y suena a
 * robot leyendo un documento.
 */
const REGLAS_VOZ = `
--- ESTÁS HABLANDO POR TELÉFONO (no escribiendo) ---
- Respuestas CORTAS: 1-2 frases. Por voz, un párrafo es una eternidad. Si necesitas explicar algo largo, dilo en partes y pregunta "¿te sigo contando?".
- CERO emojis, cero asteriscos, cero markdown, cero listas numeradas: todo eso se escucha como ruido o se lee en voz alta.
- Números y precios en palabras naturales: "ciento treinta y cinco mil pesos", no "$135.000".
- Habla como chileno real, con tuteo (tú, tienes, puedes). Nunca voseo argentino.
- Si te interrumpen, PARA y escucha. No retomes lo que ibas diciendo salvo que te lo pidan.
- Si no entendiste, dilo simple: "perdona, no te escuché bien, ¿me repites?".
- Silencios cortos son normales: no rellenes con muletillas ni repitas la pregunta.
- Nunca digas que eres una IA ni un asistente virtual salvo que te pregunten directo. Si preguntan, sé honesto y breve, y sigue ayudando.
- No inventes datos que no estén en tu información: si no sabes algo, dilo y ofrece averiguarlo.`;

/**
 * Reglas EXTRA para el closer en vivo. La diferencia con la demo es que acá la
 * persona NO llega de la nada: viene de una conversación por texto que quedó a
 * medias. Tratarla como primer contacto es exactamente el bug de los ecos que
 * costó tres días de prospección rota — el agente volvía a saludar a alguien
 * con quien ya venía hablando.
 */
const REGLAS_CLOSER = `
--- ESTA CONVERSACIÓN YA EMPEZÓ ---
- Esta persona VIENE de hablar contigo por texto y aceptó pasar a voz. NO la saludes como si fuera un primer contacto y NO le preguntes cosas que ya te contó: las tienes más abajo.
- Abre reconociendo dónde quedaron. Algo como "hola, qué bueno que me llamaste — quedamos en lo de [tema]". Corto y natural.
- Tu trabajo acá es RESOLVER lo que la frenó, no volver a calificarla. Ya está calificada.
- Si la persona quiere avanzar, avanza: agenda, cobra o deja el siguiente paso concreto y acordado.
- Si aparece una objeción que no puedes resolver con lo que sabes, no improvises ni prometas: dile que lo confirmas y que le escribes por el chat.
- Si pregunta algo que no está en tu información, dilo derecho. Inventar en una llamada se nota más que por texto.`;

/**
 * Reglas EXTRA cuando el que marca es EL AGENTE (llamada saliente por
 * teléfono). La diferencia con el closer web: acá la persona contesta un
 * teléfono que suena — hay que confirmar que puede hablar, y puede caer un
 * buzón de voz o contestar otra persona.
 */
const REGLAS_LLAMADA_SALIENTE = `
--- TÚ HICISTE ESTA LLAMADA (saliente, avisada por el chat) ---
- Le avisaste por el chat hace un minuto y la persona ACEPTÓ que la llamaras. No es una llamada en frío.
- Cuando conteste, preséntate en UNA frase natural ("hola, soy [tu nombre], te dije por el chat que te llamaba") y confirma que puede hablar ("¿me escuchas bien? ¿puedes hablar ahora?").
- Si dice que ahora no puede: ofrécele seguir por el chat, despídete corto y amable. No la retengas.
- Si contesta OTRA persona: pregunta por quien buscas UNA vez; si no está, di que llamas de parte del negocio, que le escribes por el chat, y despídete. No des detalles de la conversación a terceros.
- Si cae un BUZÓN DE VOZ o contestadora: deja UN mensaje de una frase (quién eres y que le escribiste por el chat) y no digas nada más.
- La llamada tiene tiempo limitado: ve al grano del tema pendiente. Si el tiempo se acaba, cierra con el siguiente paso concreto acordado.
- Nunca menciones "sistemas", "marcadores" ni cómo se coordinó la llamada por dentro.`;

/**
 * Bloques de instrucciones para una sesión de voz CON un lead (closer web o
 * llamada telefónica). Vive acá para que las dos vías armen el prompt IGUAL
 * y afinar el comportamiento sea un cambio en un solo lugar.
 * Devuelve un array de bloques; el caller hace .filter(Boolean).join('\n').
 */
function construirBloquesLead({ agent, kbTexto, lead, messages, buildMemoryContext, turnos = 14 }) {
  return [
    agent.instructions || '',
    kbTexto || '',
    REGLAS_VOZ,
    REGLAS_CLOSER,
    lead?.name ? `\n--- QUIÉN ES ---\nSe llama ${lead.name}. Te escribió por ${lead.channel || 'el chat'}.` : null,
    typeof buildMemoryContext === 'function' ? buildMemoryContext(lead) : null,
    construirHistorialVoz(messages, turnos),
  ];
}

/**
 * Historial reciente en texto plano para el prompt de voz. Texto y no formato
 * de mensajes porque Realtime recibe UN bloque de instrucciones.
 */
function construirHistorialVoz(messages, turnos = 14) {
  const visibles = (messages || []).filter(m => m.role === 'user' || m.role === 'agent' || m.role === 'manual' || m.role === 'assistant');
  const recientes = visibles.slice(-turnos);
  if (!recientes.length) return null;
  const lineas = recientes.map(m => {
    const quien = m.role === 'user' ? 'LEAD' : 'TÚ';
    return `${quien}: ${String(m.content || '').slice(0, 400)}`;
  });
  return [
    '--- LO QUE YA CONVERSARON POR TEXTO (lo más reciente al final) ---',
    ...lineas,
    'Retoma DESDE acá. No repitas preguntas ya respondidas arriba.',
  ].join('\n');
}

module.exports = {
  VOCES_REALTIME,
  EQUIV_VOZ,
  VOZ_DEFAULT,
  MODELO,
  MODELO_TRANSCRIPCION,
  SECRETO_SEGUNDOS,
  MAX_TOKENS_SALIDA,
  REGLAS_VOZ,
  REGLAS_CLOSER,
  REGLAS_LLAMADA_SALIENTE,
  construirBloquesLead,
  construirHistorialVoz,
};
