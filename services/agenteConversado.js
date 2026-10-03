/**
 * Atinov — Crear y cambiar el agente conversando
 *
 * Brayan (02-10-2026): "para la creación del agente sí o sí debe ser
 * hablando en formato natural, como todos los modelos de IA, y así mejorar
 * la forma de responder, dándole estructura y facilidad para los cambios".
 *
 * El formulario guiado (objetivo, contexto, límites, objeciones, derivación,
 * ejemplos) le saca un buen prompt a quien se sienta a llenarlo; casi nadie
 * lo hace. Acá el dueño conversa: cuenta su negocio como se lo contaría a un
 * empleado nuevo, y pide cambios igual ("que no ofrezca la prueba al tiro",
 * "más corto", "que tutee"). Un asistente lo entrevista, una pregunta a la
 * vez, y traduce lo que dice a los MISMOS campos del formulario. Así el
 * formulario y la conversación nunca se contradicen, y el prompt que arma
 * promptEstructurado no cambia.
 *
 * Cada cambio guarda antes una copia de cómo estaba el agente: "deshacer"
 * vuelve atrás de a un paso (hasta 10).
 */

const OpenAI = require('openai');
const { OBJETIVOS, esObjetivoValido, sanearEjemplos } = require('./promptEstructurado');

// Campos que la conversación puede tocar y su largo máximo (los mismos que
// usa promptEstructurado al armar el prompt).
const CAMPOS_TEXTO = {
  name:         60,
  cargo:        80,
  p_contexto:   4000,
  p_limites:    2000,
  p_objeciones: 2000,
  p_escalacion: 1500,
  instructions: 4000,
};
const NOMBRES = {
  name: 'Nombre', cargo: 'Rol', objetivo: 'Objetivo', p_contexto: 'Contexto del negocio',
  p_limites: 'Límites', p_objeciones: 'Objeciones', p_escalacion: 'Cuándo derivar a una persona',
  instructions: 'Instrucciones adicionales', p_ejemplos: 'Ejemplos',
};
const MAX_VERSIONES = 10;
const MAX_MENSAJES = 30;
const MAX_LARGO_MENSAJE = 2000;

/** Lo que hoy tiene el agente, en el formato que entiende el asistente. */
function foto(agent = {}) {
  const f = {};
  for (const c of Object.keys(CAMPOS_TEXTO)) f[c] = agent[c] || '';
  f.objetivo = agent.objetivo || '';
  f.p_ejemplos = Array.isArray(agent.p_ejemplos) ? agent.p_ejemplos : [];
  return f;
}

/**
 * Convierte los cambios que propone el modelo en una actualización segura:
 * solo campos conocidos, strings acotados, objetivo válido, ejemplos saneados.
 * Devuelve { upd, campos } (campos = nombres legibles de lo que cambió).
 */
function sanearCambios(cambios, agent = {}) {
  const upd = {};
  if (!cambios || typeof cambios !== 'object') return { upd, campos: [] };
  for (const [c, max] of Object.entries(CAMPOS_TEXTO)) {
    if (typeof cambios[c] !== 'string') continue;
    const v = cambios[c].trim().slice(0, max);
    if (c === 'name' && !v) continue;                 // el agente no se queda sin nombre
    if (v !== String(agent[c] || '')) upd[c] = v;
  }
  if (typeof cambios.objetivo === 'string' && cambios.objetivo !== (agent.objetivo || '')) {
    if (cambios.objetivo === '' || esObjetivoValido(cambios.objetivo)) upd.objetivo = cambios.objetivo;
  }
  if (Array.isArray(cambios.p_ejemplos)) {
    const ej = sanearEjemplos(cambios.p_ejemplos);
    if (JSON.stringify(ej) !== JSON.stringify(sanearEjemplos(agent.p_ejemplos || []))) upd.p_ejemplos = ej;
  }
  return { upd, campos: Object.keys(upd).map(c => NOMBRES[c] || c) };
}

/** Pila de versiones para deshacer: la nueva foto va primero. */
function apilarVersion(agent) {
  const previas = Array.isArray(agent.versiones_conversadas) ? agent.versiones_conversadas : [];
  return [{ ...foto(agent), guardada_at: new Date().toISOString() }, ...previas].slice(0, MAX_VERSIONES);
}

/** Lo que hay que escribir para volver a la versión anterior, o null. */
function versionAnterior(agent) {
  const previas = Array.isArray(agent.versiones_conversadas) ? agent.versiones_conversadas : [];
  if (!previas.length) return null;
  const [ultima, ...resto] = previas;
  const { guardada_at, ...campos } = ultima;
  return { upd: { ...campos, versiones_conversadas: resto } };
}

function promptSistema(agent) {
  const objetivos = Object.entries(OBJETIVOS).map(([k, o]) => `"${k}" (${o.label})`).join(', ');
  return `Eres quien configura el agente de atención y ventas de un negocio en Atinov. Conversas con el DUEÑO del negocio, en español de Chile, tuteando, como un colega que lo ayuda: frases cortas, sin tecnicismos, sin listas largas.

Tu trabajo: entender su negocio y dejar el agente bien configurado, y después aplicar cualquier cambio que pida.

Cómo conversas:
- Una sola pregunta por mensaje. Primero lo esencial: qué vende, a quién, precios, cómo se compra o agenda, y qué quiere que logre el agente. Después afinas: qué nunca debe prometer, cómo responder a "está caro" o "lo voy a pensar", cuándo pasarle la conversación a él, y cómo escribe con sus clientes.
- Si ya tienes lo esencial, no sigas preguntando por preguntar: dile en una frase cómo quedó y ofrécele probarlo en el chat de prueba.
- Si pide un cambio ("que no ofrezca la prueba al tiro", "más corto", "que tutee", "que no hable de precios"), aplícalo en el campo que corresponda y dile en una frase qué cambiaste. No le preguntes si está seguro.
- No inventes datos del negocio. Si falta algo que el agente necesita (un precio, un horario), pregúntalo.
- Escribe los campos en segunda persona, hablándole al agente ("Vendes…", "Nunca prometas…"), claros y concretos.
- Los ejemplos (p_ejemplos) son lo que más copia el agente: escríbelos como escribiría el dueño a sus clientes de verdad, cortos, sin "¡" ni "¿" de apertura, sin emojis salvo que él los use.

Campos del agente:
- name: nombre del agente (corto)
- cargo: su rol, ej. "asistente de ventas de la barbería"
- objetivo: uno de ${objetivos}, o ""
- p_contexto: qué vende el negocio, a quién, precios, horarios, cómo se compra, lo que lo diferencia
- p_limites: lo que el agente nunca debe hacer, decir ni prometer
- p_objeciones: cómo responder a las objeciones típicas
- p_escalacion: cuándo derivar a una persona
- instructions: cualquier otra instrucción que no calce arriba (tono, largo, estilo)
- p_ejemplos: lista de hasta 5 { "cliente": "...", "agente": "..." }

Así está configurado hoy:
${JSON.stringify(foto(agent), null, 2)}

Responde SIEMPRE con un objeto JSON y nada más:
{"respuesta": "<lo que le dices al dueño>", "cambios": { <solo los campos que cambian, con su valor COMPLETO nuevo> }, "listo": <true si el agente ya tiene lo esencial para atender>}
Si no cambia nada, "cambios" va vacío: {}.`;
}

/** Una vuelta de conversación. Devuelve { respuesta, cambios, listo }. */
async function conversar({ agent, mensajes, apiKey, model }) {
  if (!apiKey) throw new Error('Falta la clave de OpenAI');
  const historial = (Array.isArray(mensajes) ? mensajes : [])
    .slice(-MAX_MENSAJES)
    .filter(m => m && typeof m.texto === 'string' && m.texto.trim())
    .map(m => ({
      role: m.rol === 'asistente' ? 'assistant' : 'user',
      content: m.texto.slice(0, MAX_LARGO_MENSAJE),
    }));
  if (!historial.length || historial[historial.length - 1].role !== 'user') {
    throw new Error('Falta el mensaje del dueño');
  }
  const client = new OpenAI({ apiKey });
  const r = await client.chat.completions.create({
    model: model || process.env.OPENAI_BUILDER_MODEL || 'gpt-4o',
    messages: [{ role: 'system', content: promptSistema(agent) }, ...historial],
    response_format: { type: 'json_object' },
    temperature: 0.4,
    max_tokens: 1800,
  });
  let datos = {};
  try { datos = JSON.parse(r.choices?.[0]?.message?.content || '{}'); } catch { datos = {}; }
  return {
    respuesta: String(datos.respuesta || 'No te entendí bien, ¿me lo cuentas de otra forma?').slice(0, 1500),
    cambios: datos.cambios && typeof datos.cambios === 'object' ? datos.cambios : {},
    listo: datos.listo === true,
  };
}

module.exports = {
  conversar, sanearCambios, apilarVersion, versionAnterior, foto, promptSistema,
  CAMPOS_TEXTO, NOMBRES, MAX_VERSIONES,
};
