/**
 * Atinov — Respuesta viva: que no repita y que no se alargue (módulo puro)
 *
 * De la prueba real del 20-09-2026 (video de Brayan) salieron tres problemas
 * que las reglas del prompt NO estaban evitando:
 *
 *  1. A "¿de qué se trata tu servicio?" contestó con 55 palabras en una sola
 *     burbuja: cuatro canales enumerados, tres capacidades y DOS preguntas
 *     seguidas. El prompt ya pedía "máximo 1-2 oraciones" y "una sola
 *     pregunta"; el modelo igual se pasó. Una regla enterrada entre cientos de
 *     líneas no se cumple sola: hace falta medirla después de generar.
 *  2. La nota de voz siguiente dijo casi lo mismo que el texto anterior. El
 *     agente no tenía en ninguna parte "esto ya se lo contaste": la memoria
 *     del lead guarda lo que dijo EL LEAD, no lo que dijo el agente.
 *  3. La voz sonaba a máquina. Buena parte no es el modelo de voz: es el
 *     TEXTO. Una enumeración de cuatro marcas separadas por comas, leída en
 *     voz alta, suena a robot aunque la voz sea perfecta. Un texto para hablar
 *     se escribe con frases cortas terminadas en punto.
 *
 * Este módulo hace dos cosas, las dos sin red y sin base de datos:
 *  · arma el bloque "LO QUE YA LE DIJISTE" para el prompt, y
 *  · mide la respuesta generada y dice si hay que reescribirla.
 *
 * La decisión de reescribir la toma el CÓDIGO con números, no el modelo
 * juzgándose a sí mismo.
 */

// ── Límites ──────────────────────────────────────────────────────────────────
// Una nota de voz de más de 30 palabras ya dura ~15 segundos: nadie escucha
// eso de un desconocido. El texto aguanta un poco más porque se escanea.
//
// Ajustados el 23-09-2026 con un chat real (ver HUELLA más abajo): en
// WhatsApp la mitad de los mensajes tiene 7 palabras o menos, el 88 % tiene
// 20 o menos y 3 de cada 4 son una sola oración. El tope anterior de 45
// palabras y 3 oraciones dejaba pasar respuestas que ninguna persona escribe.
const LIMITES = {
  voz:   { palabras: 25, oraciones: 2, preguntas: 1 },
  texto: { palabras: 30, oraciones: 2, preguntas: 1 },
};

/** Tres o más elementos separados por comas antes de un "y" = enumeración. */
const ENUMERACION_MIN = 3;

/** Qué tan parecida puede ser una respuesta a algo ya dicho, de 0 a 1. */
const SIMILITUD_MAX = 0.5;

/** Palabras sin contenido: no cuentan para comparar dos mensajes. */
const VACIAS = new Set([
  'a','al','ante','con','de','del','desde','el','en','entre','hacia','hasta','la','las','lo','los',
  'para','por','se','sin','sobre','tras','un','una','unas','unos','y','o','u','e','que','qué','como',
  'cómo','cuando','cuándo','donde','dónde','es','son','ser','estar','está','están','este','esta',
  'esto','ese','esa','eso','mi','tu','su','sus','tus','mis','te','me','le','les','nos','yo','tú','él',
  'ella','ya','muy','más','menos','también','pero','si','sí','no','ah','eh','bueno','igual','todo',
  'toda','todos','todas','hay','va','van','ir','tiene','tienen','tener','hacer','hace','puede','pueden',
]);

const normalizar = (t) => String(t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[^a-z0-9ñ\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Palabras con contenido de un texto, sin repetir. */
function contenido(texto) {
  return new Set(normalizar(texto).split(' ').filter(w => w.length > 3 && !VACIAS.has(w)));
}

/**
 * Cuánto de `b` ya estaba en `a`, de 0 a 1. Se mide contra el mensaje NUEVO
 * (no contra la unión) a propósito: un mensaje nuevo y corto que solo repite
 * cosas viejas debe dar alto aunque el viejo fuera larguísimo.
 */
function similitud(a, b) {
  const A = contenido(a), B = contenido(b);
  if (!B.size) return 0;
  let comunes = 0;
  for (const w of B) if (A.has(w)) comunes++;
  return comunes / B.size;
}

// ── Medición de la respuesta ─────────────────────────────────────────────────

/**
 * Palabras que abren una pregunta. Dos de estas en una sola = pregunta doble.
 *
 * OJO con `\b`: en JavaScript el límite de palabra se define sobre [A-Za-z0-9_],
 * así que la "é" no es carácter de palabra y `\bqué\b` NO matchea nunca. Por
 * eso los límites van como lookarounds que sí incluyen las vocales acentuadas.
 */
const LETRA = 'a-záéíóúüñ0-9_';
const INTERROGATIVAS = new RegExp(
  `(?<![${LETRA}])(?:qué|cómo|cuándo|cuánto|cuánta|cuántos|cuántas|dónde|quién|quiénes|cuál|cuáles`
  + `|como|cuando|cuanto|cuanta|cuantos|cuantas|donde|quien|quienes|cual|cuales)(?![${LETRA}])`,
  'gi'
);

/**
 * ¿La pregunta pide dos cosas a la vez? En la prueba del 20-09 el cierre fue
 * "¿qué vendes y qué te tiene complicado con los mensajes?": un solo signo de
 * interrogación, pero dos preguntas. Contar los signos no lo veía.
 */
function preguntaDoble(texto) {
  const t = String(texto || '');
  // Cada tramo que termina en "?" es una pregunta; se mira dentro de cada uno.
  return t.split('?').slice(0, -1).some(tramo => {
    const desde = Math.max(tramo.lastIndexOf('.'), tramo.lastIndexOf('\n'), tramo.lastIndexOf('¿'));
    const pregunta = tramo.slice(desde + 1);
    if (!/\sy\s|\sni\s|,/.test(pregunta)) return false;
    const enc = pregunta.match(INTERROGATIVAS) || [];
    return enc.length >= 2;
  });
}

/** Cuenta lo que importa de un texto de respuesta. */
function medir(texto) {
  const t = String(texto || '').trim();
  const sinLinks = t.replace(/https?:\/\/\S+/g, '');
  const palabras = sinLinks.split(/\s+/).filter(Boolean).length;
  // Oraciones: cortes por punto, signo de cierre o salto de línea.
  const oraciones = sinLinks.split(/[.!?¿¡\n]+/).map(s => s.trim()).filter(Boolean).length;
  // Se cuentan los signos de cierre Y las preguntas dobles: "¿qué vendes y qué
  // te complica?" lleva un solo signo pero son dos preguntas.
  const marcas = (t.match(/\?/g) || []).length;
  const doble = preguntaDoble(t);
  const preguntas = marcas + (doble ? 1 : 0);
  // Enumeración: una misma oración con 3+ comas, o 2 comas y un "y" final.
  const enumeracion = sinLinks.split(/[.\n]/).some(frag => {
    const comas = (frag.match(/,/g) || []).length;
    return comas >= ENUMERACION_MIN || (comas >= 2 && /,\s*[^,]*\sy\s/.test(frag));
  });
  return { palabras, oraciones, preguntas, enumeracion, preguntaDoble: doble };
}

/**
 * ¿Hay que reescribir? Devuelve los motivos en lenguaje que el modelo entiende,
 * para pasárselos tal cual en la corrección.
 *
 * @param {string} texto       la respuesta generada
 * @param {object} opts
 * @param {boolean} opts.voz   va a salir como nota de voz
 * @param {string[]} opts.dichos mensajes que el agente ya mandó (los últimos)
 */
function revisar(texto, { voz = false, dichos = [] } = {}) {
  const t = String(texto || '').trim();
  if (!t) return { ok: true, motivos: [] };

  const lim = voz ? LIMITES.voz : LIMITES.texto;
  const m = medir(t);
  const motivos = [];

  if (m.palabras > lim.palabras) {
    motivos.push(`Tiene ${m.palabras} palabras y el máximo son ${lim.palabras}. Déjalo en una o dos frases.`);
  }
  if (m.oraciones > lim.oraciones) {
    motivos.push(`Tiene ${m.oraciones} oraciones y el máximo son ${lim.oraciones}. Quédate con la que de verdad responde.`);
  }
  if (m.preguntas > lim.preguntas) {
    motivos.push(m.preguntaDoble
      ? 'Pide dos cosas en la misma pregunta. Deja UNA sola, la más útil, y borra la otra.'
      : 'Hace más de una pregunta. Deja UNA sola, la más útil, y borra la otra.');
  }
  if (m.enumeracion) {
    motivos.push(voz
      ? 'Enumera varias cosas seguidas. Hablado suena a robot: di UNA sola y en frase corta.'
      : 'Enumera varias cosas seguidas. Menciona solo la que le sirve a esta persona.');
  }
  const callCenter = frasesDeCallCenter(t);
  if (callCenter.length) {
    motivos.push(`Usa "${callCenter[0]}", que es frase de call center: en un chat real no aparece nunca. Dilo como lo escribiría una persona apurada, sin fórmulas de cortesía.`);
  }

  // Repetición contra lo ya dicho por el agente. Un mensaje muy corto no se
  // juzga: con dos o tres palabras con contenido, la proporción se dispara por
  // casualidad ("cuéntame qué vendes" daba 0,5 solo porque "vendes" aparecía
  // antes). Bajo ese piso no hay forma honesta de saber si repite.
  if (contenido(t).size >= 4) {
  for (const d of (dichos || [])) {
    const s = similitud(d, t);
    if (s > SIMILITUD_MAX) {
      motivos.push(`Esto ya se lo dijiste casi igual antes ("${String(d).slice(0, 70)}…"). No lo repitas: da el siguiente paso o pregunta algo nuevo.`);
      break;
    }
  }
  }

  if (voz) {
    // Lo hablado necesita puntos, no comas: el punto es donde la voz respira.
    const frag = t.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
    if (frag.some(f => f.split(/\s+/).length > 18)) {
      motivos.push('Hay una frase demasiado larga para decirla de corrido. Pártela en dos frases cortas terminadas en punto.');
    }
  }

  return { ok: motivos.length === 0, motivos, medida: m };
}

// ── Huella de chat real ──────────────────────────────────────────────────────
// Medida el 23-09-2026 sobre un grupo de WhatsApp chileno real exportado por
// Brayan (120 personas, 2024-2026). De él solo salieron estas estadísticas:
// ningún mensaje, nombre ni número entró al código. Sobre los 6.620 mensajes
// de conversación (sin reportes de turno ni adjuntos):
//   · mediana de 7 palabras; 72 % tiene 12 o menos; 76 % es una sola oración
//   · de 898 preguntas, 3 abren con "¿" (0,3 %); de las exclamaciones, 2 % con "¡"
//   · 12 % termina en punto y 66 % sin ningún signo
//   · menos de 5 % lleva emoji
//   · 83 % de los turnos es UNA burbuja: partir la respuesta no es lo normal
//   · "con gusto", "claro que sí", "no dudes en", "en qué puedo ayudarte":
//     cero veces en diez mil mensajes
// El agente escribía exactamente al revés: "¿" y "¡" de apertura, punto final
// en todo y emoji de cortesía. Son marcas de máquina que cualquiera nota sin
// saber explicar por qué. Se corrigen en código porque son mecánicas: no hace
// falta que el modelo "se acuerde".

const FRASES_CALL_CENTER = [
  'con gusto', 'claro que si', 'por supuesto', 'estare encantad', 'no dudes en',
  'estoy aqui para', 'quedo atent', 'quedo a tu disposicion', 'en que puedo ayudarte',
  'sera un placer', 'excelente pregunta', 'gracias por contactarnos', 'gracias por escribirnos',
];

/** Frases de call center presentes en el texto (normalizadas, sin tildes). */
function frasesDeCallCenter(texto) {
  const t = normalizar(texto);
  return FRASES_CALL_CENTER.filter(f => t.includes(f));
}

// Emojis, banderas, tonos de piel y los unidores que los arman.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/u;
const EMOJI_G = new RegExp(EMOJI.source, 'gu');

/** ¿Alguno de estos textos del cliente trae emoji? */
function usaEmoji(textos) {
  return (Array.isArray(textos) ? textos : [textos]).some(t => EMOJI.test(String(t || '')));
}

/**
 * WhatsApp, Instagram y Messenger no dibujan Markdown: un link del modelo
 * llegaba al cliente como "[atinov.com/app](https://atinov.com/app?register=1)"
 * (visto el 24-09-2026 en la respuesta a un comentario). Se deja el link solo,
 * que las apps sí convierten en enlace, y se sacan negritas y títulos.
 * Los marcadores del agente ([AGENDAR: ...], [PAGO: ...]) no llevan "(" pegado
 * al corchete, así que no se tocan.
 */
function sinMarkdown(texto) {
  return String(texto || '')
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_, etiqueta, url) => url)
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * Deja la respuesta con la puntuación de un chat de verdad:
 *  · sin "¿" ni "¡" de apertura (el de cierre se queda)
 *  · sin emojis, salvo que el cliente los use
 *  · sin el punto final (los puntos entre oraciones y los "..." se quedan)
 * No toca palabras ni marcadores [AGENDAR: ...] / [PAGO: ...].
 */
function aplicarHuella(texto, { leadUsaEmoji = false } = {}) {
  let t = sinMarkdown(String(texto || ''));
  if (!t.trim()) return t;
  t = t.replace(/[¿¡]/g, '');
  if (!leadUsaEmoji) {
    t = t.replace(EMOJI_G, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.!?])/g, '$1')
      .replace(/[ \t]+\n/g, '\n');
  }
  t = t.trim();
  if (/[^.]\.$/.test(t)) t = t.slice(0, -1);
  return t;
}

// ── Bloques para el prompt ───────────────────────────────────────────────────

/** Los últimos mensajes que mandó el agente, del más nuevo al más viejo. */
function loQueYaDijo(history, max = 4) {
  return (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'agent' || m.role === 'manual') && typeof m.content === 'string' && m.content.trim())
    .slice(-max)
    .map(m => m.content.trim());
}

/**
 * Bloque "LO QUE YA LE DIJISTE". Es lo que le faltaba al agente para razonar
 * sobre sus propias respuestas en vez de volver a explicar lo mismo.
 */
function bloqueNoRepetir(history) {
  const dichos = loQueYaDijo(history);
  if (!dichos.length) return null;
  return [
    '--- LO QUE YA LE DIJISTE (no lo repitas) ---',
    'Estos mensajes ya se los mandaste tú. Esta persona YA los leyó:',
    ...dichos.map(d => `  · "${d.slice(0, 220)}"`),
    'No vuelvas a explicar nada de esto, ni con otras palabras. Si el tema reaparece, da por sabido lo anterior y avanza: aporta algo NUEVO, resuelve la duda concreta o haz la siguiente pregunta.',
  ].join('\n');
}

/**
 * Bloque para cuando la respuesta va a salir hablada. Se agrega ANTES de
 * generar, no después: un texto escrito para leer nunca suena bien hablado
 * por mucho que se ajuste la voz.
 */
function bloqueVoz(limite = LIMITES.voz) {
  return [
    '--- ESTA RESPUESTA SE VA A ESCUCHAR, NO A LEER ---',
    'El lead te mandó un audio, así que le vas a contestar con una nota de voz. Escribe pensando en cómo suena dicho en voz alta:',
    `• Máximo ${limite.palabras} palabras. Una nota de voz más larga que eso nadie la escucha completa.`,
    '• Frases CORTAS terminadas en punto. El punto es donde la voz respira; una frase larga con comas sale de corrido y suena a máquina.',
    '• Cero enumeraciones y cero listas de nombres o marcas seguidas. Hablado suena a lectura de catálogo.',
    '• Cero links, cero precios escritos con símbolos, cero emojis: no se pueden decir.',
    '• Escribe como le hablarías a un conocido entre dos cosas que estás haciendo, no como quien lee un guion.',
  ].join('\n');
}

/** La instrucción de corrección que se le manda al modelo para reescribir. */
function promptDeAjuste(texto, motivos, { voz = false } = {}) {
  const lim = voz ? LIMITES.voz : LIMITES.texto;
  return [
    voz
      ? 'Reescribe esta respuesta para que se ESCUCHE bien como nota de voz.'
      : 'Reescribe esta respuesta más corta.',
    '',
    'Respuesta actual:',
    `"${String(texto || '').trim()}"`,
    '',
    'Qué está mal:',
    ...motivos.map(m => `- ${m}`),
    '',
    'Reglas de la reescritura:',
    `- Máximo ${lim.palabras} palabras y ${lim.oraciones} ${lim.oraciones === 1 ? 'oración' : 'oraciones'}.`,
    '- Como máximo UNA pregunta, y solo si aporta.',
    '- Mismo idioma, mismo tono y mismo tuteo. No agregues información nueva ni inventes datos.',
    '- Conserva cualquier marcador entre corchetes tal cual esté (por ejemplo [AGENDAR: ...] o [PAGO: ...]).',
    voz ? '- Frases cortas terminadas en punto, sin enumeraciones, sin links ni emojis.' : '- Sin listas ni viñetas.',
    '',
    'Devuelve SOLO la respuesta reescrita, sin comillas y sin explicar nada.',
  ].join('\n');
}

module.exports = {
  LIMITES, SIMILITUD_MAX,
  normalizar, contenido, similitud,
  medir, revisar,
  frasesDeCallCenter, usaEmoji, aplicarHuella, sinMarkdown,
  loQueYaDijo, bloqueNoRepetir, bloqueVoz, promptDeAjuste,
};
