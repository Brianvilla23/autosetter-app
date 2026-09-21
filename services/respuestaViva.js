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
const LIMITES = {
  voz:   { palabras: 30, oraciones: 2, preguntas: 1 },
  texto: { palabras: 45, oraciones: 3, preguntas: 1 },
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
  loQueYaDijo, bloqueNoRepetir, bloqueVoz, promptDeAjuste,
};
