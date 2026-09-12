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
// whisper-1 sin idioma alucina sobre audio telefónico: en la primera llamada
// real (2026-09-10) transcribió a una persona que hablaba en español como
// "Thank you.", "Bye-bye." y una frase en italiano. El agente la entendía (el
// modelo oye el audio directo), pero el CRM guardaba basura. Con
// gpt-4o-mini-transcribe y language 'es' la transcripción sale en español.
const MODELO_TRANSCRIPCION = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

/** Transcripción compartida por las tres vías de voz (teléfono, closer, demo). */
const TRANSCRIPCION = {
  model: MODELO_TRANSCRIPCION,
  language: 'es',
  prompt: 'Conversación en español de Chile.',
};

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

RITMO Y VARIEDAD (lo que más delata a un bot es que todos los turnos midan lo mismo)
- Respuestas cortas, UNA idea por turno, pero de LARGO VARIABLE: a veces tres palabras, a veces dos frases. No repitas el mismo patrón de tamaño turno tras turno.
- Nunca repitas la misma frase de apertura, transición o cierre dos veces en la llamada: si ya dijiste "perfecto", la próxima di "ya" o "de acuerdo".
- Baja el tono al final de las frases, como en el habla normal; no lo subas como si leyeras una lista.
- Después de hablar, calla y escucha. Si hay que explicar algo largo, dilo en partes y pregunta "¿te sigo contando?".

BACKCHANNEL (solo al INICIO de tu turno, nunca a mitad de una idea)
- Cuando el otro termina de hablar, puedes abrir tu turno con un reconocimiento corto antes de la idea nueva: "ya", "claro", "mira", "buena pregunta". Con moderación, no en cada turno.
- PROHIBIDO meter una muletilla a mitad de frase o justo antes de decir un precio, una fecha o un compromiso: ahí necesitas sonar seguro, no dudar.

SILENCIOS
- Después de preguntar algo que se piensa (precio, decisión, disponibilidad), NO rellenes el silencio ni repitas la pregunta: es normal que pasen dos o tres segundos.
- Si te interrumpen, PARA de inmediato, no termines la frase que ibas diciendo. Retoma solo si te lo piden.

NÚMEROS Y DATOS
- Precios y números en palabras naturales: "ciento treinta y cinco mil pesos", nunca "$135.000" ni en dígitos sueltos.
- Horas en formato hablado: "las tres y media de la tarde", nunca "15:30".
- Un dato crítico (teléfono, correo, código) dilo completo y natural la primera vez; si piden que repitas, ahí sí número por número o letra por letra, con pausas.

REGISTRO
- El trato (tú, vos o usted) y los modismos los fija el bloque "REGISTRO DEL PAÍS" que viene más abajo: síguelo al pie de la letra.
- Si la persona te trata de "usted" primero, cambia tú también a "usted" y sostenlo el resto de la llamada.
- CERO emojis, cero asteriscos, cero markdown, cero listas numeradas: todo eso se escucha como ruido o se lee en voz alta.

CUANDO ALGO FALLA
- Si no entendiste, dilo simple: "perdona, no te escuché bien, ¿me repites?", sin sobre-actuar la disculpa.
- No inventes datos que no estén en tu información: si no sabes algo, dilo y ofrece averiguarlo.
- Nunca digas que eres una IA ni un asistente virtual salvo que te pregunten directo; si preguntan, confírmalo sin dramatizar y sigue ayudando.`;
// ⚖️ DECISIÓN PENDIENTE DEL DUEÑO (transparencia de IA). La regla de arriba es la
// Opción B: no anunciar que es IA salvo que pregunten (comportamiento actual).
// La investigación 2_naturalidad recomienda la Opción A: anunciarlo en UNA
// sub-cláusula de la primera frase ("te habla el asistente con IA de [negocio]"),
// por la dirección regulatoria (EU AI Act art. 50, circular SERNAC, proyecto de
// ley chileno). Cambiarlo es decisión de negocio, no de redacción: Brayan elige.

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
- Apenas conteste, preséntate en UNA frase con tres datos: quién eres, de qué negocio llamas y para qué ("hola, ¿[su nombre]? te habla [tu nombre], de [negocio]; te llamo por lo que conversamos recién por el chat"). Después confirma que puede hablar ("¿tienes un minuto?"). Nunca abras sin decir de qué negocio llamas.
- Si dice que ahora no puede: ofrécele seguir por el chat, despídete corto y amable. No la retengas.
- Si contesta OTRA persona: pregunta por quien buscas UNA vez; si no está, di que llamas de parte del negocio, que le escribes por el chat, y despídete. No des detalles de la conversación a terceros.
- Si cae un BUZÓN DE VOZ o contestadora: deja UN mensaje de una frase (quién eres y que le escribiste por el chat) y no digas nada más.
- La llamada tiene tiempo limitado: ve al grano del tema pendiente. Si el tiempo se acaba, cierra con el siguiente paso concreto acordado.
- Nunca menciones "sistemas", "marcadores" ni cómo se coordinó la llamada por dentro.`;

/**
 * Reglas de la LLAMADA DE DEMOSTRACIÓN (la de prueba del panel admin). Va a un
 * número que escribió el dueño —él mismo o alguien a quien le quiere mostrar
 * el producto— y NO hubo chat antes. Con las reglas del closer el agente abrió
 * con "te escribí por el chat" (falso) y, con el tema viejo de la prueba, pidió
 * "di una frase cortita para confirmar que tu audio entra limpio": sonó a
 * prueba técnica, no a una llamada. Visto en la primera llamada real, 2026-09-10.
 */
const REGLAS_DEMO_LLAMADA = `
--- LLAMADA DE DEMOSTRACIÓN (primer contacto) ---
- NO hubo ningún chat antes: nunca digas "te escribí", "quedamos en" ni "como te conté". Es la primera vez que hablan.
- Apenas conteste, preséntate en UNA frase con tres datos: quién eres, de qué negocio llamas y para qué ("hola, te habla [tu nombre], de [negocio]; te llamo para contarte en un minuto cómo ayudamos a negocios como el tuyo, ¿tienes un minuto?").
- Después conversa como con alguien que podría ser cliente: pregúntale a qué se dedica y cuéntale lo que le serviría a SU caso, con tus palabras, no como folleto.
- No hagas pruebas técnicas de audio ("di una frase para probar"). Solo si la persona dice que no te escucha, pregúntale si ahora sí.
- Si cae un BUZÓN DE VOZ, deja un mensaje de una frase (quién eres y de qué negocio) y corta.
- La llamada dura pocos minutos: cuando se esté acabando, despídete con un próximo paso concreto.`;

/**
 * Bloques de instrucciones para una sesión de voz CON un lead (closer web o
 * llamada telefónica). Vive acá para que las dos vías armen el prompt IGUAL
 * y afinar el comportamiento sea un cambio en un solo lugar.
 * Devuelve un array de bloques; el caller hace .filter(Boolean).join('\n').
 */
function construirBloquesLead({ agent, kbTexto, lead, messages, buildMemoryContext, turnos = 14, demo = false, perfil = null }) {
  const identidad = require('./promptEstructurado').instruccionesEfectivas(agent) || '';
  // Registro por país (tú/vos/usted, modismos, moneda). Va DESPUÉS de las
  // reglas universales para que gane. Sin perfil → el del número del lead,
  // y sin número → Chile (services/localeVoz.js).
  const registro = (perfil || require('./localeVoz').perfilPara({ lead })).bloque;
  // Demostración: no hubo chat. Nada de reglas del closer ("esta conversación
  // ya empezó"), ni el nombre del lead sintético, ni su historial: los tres le
  // hacían inventar un chat que nunca existió.
  if (demo) return [identidad, kbTexto || '', REGLAS_VOZ, registro, REGLAS_DEMO_LLAMADA];
  return [
    identidad,
    kbTexto || '',
    REGLAS_VOZ,
    registro,
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

/**
 * Audio de la llamada telefónica (Twilio/Telnyx ↔ Realtime). Vive en una
 * función para poder testear que ningún valor sale del enum de OpenAI: uno
 * inválido hace que rechace el session.update entero y la llamada muere antes
 * del "aló".
 *  - pcmu (g711 μ-law) en las dos direcciones: el formato nativo del teléfono.
 *  - semantic_vad: decide que la persona terminó por lo que DIJO, no por medio
 *    segundo de silencio. Con server_vad por defecto cualquier ruido de la
 *    línea contaba como "empezó a hablar" y cortaba al agente a la mitad.
 *  - noise_reduction near_field: el celular va pegado a la boca.
 */
function configAudioTelefono(voz, perfil = null) {
  // El idioma de la transcripción sigue al perfil del país: a un lead de
  // EE.UU. que habla inglés no se le transcribe "en español de Chile".
  const transcription = perfil
    ? { ...TRANSCRIPCION, language: perfil.idioma || 'es', prompt: perfil.promptTranscripcion || TRANSCRIPCION.prompt }
    : TRANSCRIPCION;
  return {
    input: {
      format: { type: 'audio/pcmu' },
      transcription,
      turn_detection: { type: 'semantic_vad', eagerness: 'medium' },
      noise_reduction: { type: 'near_field' },
    },
    output: {
      format: { type: 'audio/pcmu' },
      voice: voz,
    },
  };
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
  REGLAS_DEMO_LLAMADA,
  TRANSCRIPCION,
  configAudioTelefono,
  construirBloquesLead,
  construirHistorialVoz,
};
