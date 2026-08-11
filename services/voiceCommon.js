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
};
