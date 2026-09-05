/**
 * Atinov — Estilo real: el agente aprende CÓMO HABLAN los clientes del negocio
 *
 * El prompt de humanización ya le dice al agente qué hacer (SPIN, Cialdini,
 * brevedad). Lo que no puede decirle es cómo escribe la gente que le escribe
 * a ESTE negocio: "hola precio?", "cuanto sale la limpieza", "ya po y donde
 * estan". Ese registro solo se aprende de mensajes reales, y los modelos
 * imitan ejemplos mucho mejor de lo que obedecen adjetivos ("sé informal").
 *
 * Dos fuentes, un mismo perfil:
 *   • BANDEJA — los mensajes que los leads ya le mandaron a la cuenta (role
 *     'user') y las respuestas que el dueño escribió a mano (role 'manual').
 *     Cero fricción: un clic.
 *   • TEXTO PEGADO — un export de WhatsApp o cualquier conversación copiada
 *     (de antes de tener el agente, de otro canal, de una prueba manual).
 *
 * El modelo devuelve un PERFIL (registro, largo, muletillas, muestras
 * textuales anonimizadas, pares cliente→humano). Se guarda en
 * agent.estilo_real y openai.js lo inyecta al final del system prompt. El
 * simulador lo usa al revés: para que el bot-prospecto escriba como los
 * clientes reales y el entrenamiento deje de ser contra un lead de cartón.
 *
 * Privacidad (Ley 21.719): antes de salir al modelo el corpus pasa por
 * anonimizar() (teléfonos, correos, links, @usuarios) y el modelo recibe la
 * instrucción de reemplazar nombres por [nombre]. El perfil guardado solo
 * contiene frases sueltas sin identificadores — no es historial.
 */

const OpenAI = require('openai');
const db     = require('../db/database');

const LIMITES = {
  muestras: 12,        // frases textuales de clientes que se guardan
  pares: 6,            // pares cliente → humano
  muletillas: 10,
  largoMuestra: 160,   // chars por muestra
  largoPar: 220,       // chars por lado de un par
  largoCampo: 200,     // registro / largo / emojis / observaciones
  minMensajes: 8,      // menos que esto no hay registro que aprender
  maxMensajesCorpus: 400,
  maxCharsLLM: 14000,
};

// ── Anonimización (puro) ─────────────────────────────────────────────────────

/**
 * Borra identificadores directos antes de mandar texto al modelo o guardarlo.
 * Nombres propios no se detectan acá (imposible sin NER): eso se le pide al
 * modelo explícitamente y el perfil resultante nunca incluye nombres.
 */
function anonimizar(texto) {
  return String(texto || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[link]')
    // +56 9 8566 6043 / 985666043 / (55) 1234-5678 — 8+ dígitos con separadores
    .replace(/\+?\(?\d[\d\s().-]{6,}\d/g, m => (m.replace(/\D/g, '').length >= 8 ? '[teléfono]' : m))
    .replace(/(^|[^\w])@[\w.]{2,}/g, '$1[@usuario]');
}

// ── Parseo de chats exportados (puro) ────────────────────────────────────────

const LINEAS_SISTEMA = [
  /cifrados? de extremo a extremo/i, /end-to-end encrypted/i,
  /<multimedia omitido>/i, /<media omitted>/i, /(imagen|video|audio|sticker|gif|documento) omitid[oa]/i,
  /^\s*[\u200e\u200f]?\s*$/,
];

// WhatsApp Android: "5/9/26, 10:31 - Ana: hola"  /  "05/09/2026 10:31 - Ana: hola"
// WhatsApp iOS:     "[5/9/26, 10:31:07] Ana: hola"
// Genérico:         "Ana: hola"  /  "Cliente: hola"  /  "Yo: buenas"
const RE_WA = /^\s*[\u200e\u200f]?\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?\]?\s*[-–]?\s*([^:]{1,40}?):\s(.*)$/i;
const RE_GENERICO = /^\s*([^\d:\n][^:\n]{0,30}):\s(.+)$/;

/**
 * Convierte un chat pegado en [{ autor, texto }]. Las líneas sin autor se
 * pegan al mensaje anterior (mensajes multilínea). Líneas de sistema fuera.
 */
function parsearChatExportado(texto) {
  const out = [];
  for (const cruda of String(texto || '').split(/\r?\n/)) {
    const linea = cruda.replace(/[\u200e\u200f]/g, '');
    if (!linea.trim()) continue;
    if (LINEAS_SISTEMA.some(re => re.test(linea))) continue;
    const m = linea.match(RE_WA) || linea.match(RE_GENERICO);
    if (m) {
      out.push({ autor: m[1].trim(), texto: m[2].trim() });
    } else if (out.length) {
      out[out.length - 1].texto += '\n' + linea.trim();
    }
  }
  return out.filter(m => m.texto);
}

// ── Corpus desde la bandeja ──────────────────────────────────────────────────

/**
 * De los mensajes de la bandeja saca lo que sirve para aprender estilo:
 * frases de clientes (role 'user') y pares cliente → respuesta HUMANA (role
 * 'manual', escrita por el dueño). Las respuestas del agente NO cuentan como
 * ejemplo humano: aprenderíamos del bot que queremos mejorar.
 * mensajes: [{ role, content }] en orden cronológico de UNA conversación.
 */
function muestrasDesdeMensajes(mensajes) {
  const clientes = [];
  const pares = [];
  const lista = Array.isArray(mensajes) ? mensajes : [];
  for (let i = 0; i < lista.length; i++) {
    const m = lista[i];
    const texto = String(m?.content || '').trim();
    if (!texto) continue;
    if (m.role === 'user') {
      clientes.push(texto);
      const sig = lista[i + 1];
      if (sig?.role === 'manual' && String(sig.content || '').trim()) {
        pares.push({ cliente: texto, humano: String(sig.content).trim() });
      }
    }
  }
  return { clientes, pares };
}

/** Lee la bandeja de la cuenta y arma el corpus (anonimizado). */
async function corpusDesdeBandeja(accountId) {
  const leads = (await db.find(db.leads, { account_id: accountId }))
    .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))
    .slice(0, 80);
  let clientes = [], pares = [], conversaciones = 0;
  for (const lead of leads) {
    const msgs = await db.find(db.messages, { lead_id: lead._id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const m = muestrasDesdeMensajes(msgs);
    if (!m.clientes.length) continue;
    conversaciones++;
    clientes = clientes.concat(m.clientes);
    pares = pares.concat(m.pares);
    if (clientes.length >= LIMITES.maxMensajesCorpus) break;
  }
  clientes = clientes.slice(0, LIMITES.maxMensajesCorpus).map(anonimizar);
  pares = pares.slice(0, 60).map(p => ({ cliente: anonimizar(p.cliente), humano: anonimizar(p.humano) }));
  return { clientes, pares, conversaciones, n_mensajes: clientes.length };
}

/** Arma el corpus desde texto pegado (export de WhatsApp o chat copiado). */
function corpusDesdeTexto(texto) {
  const lineas = parsearChatExportado(texto);
  const filas = lineas.slice(0, LIMITES.maxMensajesCorpus)
    .map(l => `${l.autor}: ${anonimizar(l.texto)}`);
  return { filas, n_mensajes: lineas.length };
}

// ── Saneo del perfil (puro) ──────────────────────────────────────────────────

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const lista = (v, max, largo) => (Array.isArray(v) ? v : [])
  .map(x => str(x, largo)).filter(Boolean)
  .filter((x, i, arr) => arr.indexOf(x) === i)
  .slice(0, max);

/**
 * Valida y recorta lo que devuelve el modelo. Devuelve null si no hay
 * señal (sin muestras): un perfil vacío no aporta y ensuciaría el prompt.
 */
function sanearPerfil(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const muestras = lista(raw.muestras_cliente, LIMITES.muestras, LIMITES.largoMuestra);
  if (muestras.length < 3) return null;
  const pares = (Array.isArray(raw.pares) ? raw.pares : [])
    .map(p => ({ cliente: str(p?.cliente, LIMITES.largoPar), humano: str(p?.humano, LIMITES.largoPar) }))
    .filter(p => p.cliente && p.humano)
    .slice(0, LIMITES.pares);
  return {
    registro:      str(raw.registro, LIMITES.largoCampo),
    largo:         str(raw.largo, LIMITES.largoCampo),
    emojis:        str(raw.emojis, LIMITES.largoCampo),
    muletillas:    lista(raw.muletillas, LIMITES.muletillas, 30),
    saludos:       lista(raw.saludos, 5, 60),
    observaciones: str(raw.observaciones, LIMITES.largoCampo),
    muestras_cliente: muestras,
    pares,
  };
}

/** Rescata el primer objeto JSON de la respuesta del modelo (nunca throw). */
function parsearJSON(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── Bloques de prompt (puro) ─────────────────────────────────────────────────

/**
 * Bloque que va al final del system prompt del agente. Va DESPUÉS de las
 * reglas de humanización porque los ejemplos concretos pesan más que las
 * reglas abstractas y queremos que sea lo último que el modelo lee.
 */
function bloqueEstilo(perfil) {
  if (!perfil || !Array.isArray(perfil.muestras_cliente) || !perfil.muestras_cliente.length) return '';
  const p = [];
  p.push(`\n\n--- ASÍ ESCRIBEN TUS CLIENTES DE VERDAD (aprendido de ${perfil.n_mensajes || 'sus'} mensajes reales) ---`);
  if (perfil.registro) p.push(`Registro: ${perfil.registro}`);
  if (perfil.largo) p.push(`Largo típico: ${perfil.largo}`);
  if (perfil.muletillas?.length) p.push(`Muletillas que usan: ${perfil.muletillas.map(m => `"${m}"`).join(', ')}`);
  if (perfil.emojis) p.push(`Emojis: ${perfil.emojis}`);
  if (perfil.observaciones) p.push(`Ojo: ${perfil.observaciones}`);
  p.push('Mensajes reales (calibra tu nivel de informalidad con esto — NO los repitas):');
  p.push(perfil.muestras_cliente.map(m => `• "${m}"`).join('\n'));
  if (perfil.pares?.length) {
    p.push('\nASÍ RESPONDE UN HUMANO DE ESTE NEGOCIO (imita tono y largo, no el contenido):');
    p.push(perfil.pares.map(x => `Cliente: ${x.cliente}\nHumano: ${x.humano}`).join('\n\n'));
  }
  p.push('\nREGLA: escribe al MISMO nivel que estos mensajes — mismo largo, misma informalidad, sus muletillas si calzan naturalmente. Si el cliente escribe en minúsculas y sin tildes, tú también puedes. Nunca más formal ni más largo que el humano de los ejemplos.');
  return p.join('\n');
}

/**
 * Bloque para el bot-prospecto del simulador: que escriba como los clientes
 * reales (cortito, con sus muletillas, con sus errores) y no en "español
 * neutro de manual". Sin perfil → '' y el simulador cae a su default.
 */
function bloqueEstiloLead(perfil) {
  if (!perfil || !Array.isArray(perfil.muestras_cliente) || !perfil.muestras_cliente.length) return '';
  const p = ['CÓMO ESCRIBES (aprendido de clientes reales de este negocio):'];
  if (perfil.registro) p.push(`- Registro: ${perfil.registro}`);
  if (perfil.largo) p.push(`- Largo: ${perfil.largo}`);
  if (perfil.muletillas?.length) p.push(`- Muletillas: ${perfil.muletillas.join(', ')}`);
  p.push('- Mensajes reales de gente como tú (copia el ESTILO, no el texto):');
  p.push(perfil.muestras_cliente.slice(0, 8).map(m => `  "${m}"`).join('\n'));
  p.push('- Escribe exactamente así de corto y así de informal. Errores de tipeo y falta de tildes son bienvenidos si los ejemplos los tienen.');
  return p.join('\n');
}

// ── Aprender (LLM) ───────────────────────────────────────────────────────────

const SYS_APRENDER = `Eres lingüista de conversaciones de venta por chat (WhatsApp / Instagram). Te paso mensajes REALES entre clientes y un negocio. Tu trabajo NO es evaluar la venta: es describir CÓMO ESCRIBEN para que un agente pueda sonar igual de natural.

Devuelve SOLO un objeto JSON (sin texto extra) con esta forma:
{
  "registro": "1 frase: país/región probable, tuteo o voseo, formal o informal, mayúsculas, tildes, puntuación",
  "largo": "1 frase: cuántas palabras suele tener un mensaje de cliente y uno del negocio",
  "muletillas": ["hasta 10 palabras o expresiones repetidas: po, ya, dale, al tiro, cachai, órale, vale..."],
  "emojis": "1 frase: si usan, cuáles y con qué frecuencia",
  "saludos": ["hasta 5 formas reales de saludar o abrir"],
  "observaciones": "1 frase con lo más distintivo (ej: preguntan precio antes de saludar, mandan 3 mensajes seguidos, escriben en minúscula)",
  "muestras_cliente": ["10-12 mensajes TEXTUALES de clientes, cortos y variados: saludo, pregunta de precio, duda, objeción, confirmación"],
  "pares": [{ "cliente": "mensaje textual del cliente", "humano": "la respuesta textual del NEGOCIO cuando fue claramente una persona (no un bot): natural, corta, buena" }]
}

Reglas:
- Copia los mensajes TAL CUAL (minúsculas, sin tildes, errores de tipeo incluidos). No los corrijas ni los embellezcas.
- Reemplaza cualquier nombre de persona por [nombre]. Nada de teléfonos, correos ni direcciones.
- En "pares" solo van respuestas del negocio que suenen a persona real y que estén BIEN (claras, cortas, cálidas). Máximo 6. Si no hay respuestas humanas buenas, deja el array vacío.
- Si te indico quién es el negocio, úsalo para separar lados. Si no, dedúcelo: el negocio es quien responde precios/horarios/disponibilidad.
- Si el texto no tiene conversaciones reales analizables, devuelve {"muestras_cliente": []}.`;

/**
 * Aprende el estilo desde la bandeja o desde texto pegado y lo guarda en el
 * agente activo de la cuenta. Los candados de gasto viven en la ruta.
 */
async function aprenderEstilo({ accountId, fuente = 'bandeja', texto = '', apiKey, nombreNegocio = '' }) {
  const agent = await db.findOne(db.agents, { account_id: accountId, enabled: true });
  if (!agent) return { ok: false, error: 'La cuenta no tiene un agente activo al que enseñarle.' };

  let cuerpo = '', nMensajes = 0, conversaciones = null;
  if (fuente === 'texto') {
    const c = corpusDesdeTexto(texto);
    nMensajes = c.n_mensajes;
    if (nMensajes < LIMITES.minMensajes) {
      return { ok: false, error: `Necesito al menos ${LIMITES.minMensajes} mensajes con formato "Nombre: mensaje" (o un export de WhatsApp). Encontré ${nMensajes}.` };
    }
    cuerpo = c.filas.join('\n');
  } else {
    const c = await corpusDesdeBandeja(accountId);
    nMensajes = c.n_mensajes; conversaciones = c.conversaciones;
    if (nMensajes < LIMITES.minMensajes) {
      return { ok: false, error: `Tu bandeja tiene ${nMensajes} mensaje(s) de clientes — necesito al menos ${LIMITES.minMensajes} para aprender un estilo. Pega conversaciones reales mientras tanto.` };
    }
    cuerpo = 'MENSAJES DE CLIENTES:\n' + c.clientes.map(m => `CLIENTE: ${m}`).join('\n');
    if (c.pares.length) {
      cuerpo += '\n\nRESPUESTAS ESCRITAS A MANO POR EL NEGOCIO (persona real):\n'
        + c.pares.map(p => `CLIENTE: ${p.cliente}\nNEGOCIO: ${p.humano}`).join('\n\n');
    }
  }
  if (!apiKey) return { ok: false, error: 'La cuenta no tiene API key de OpenAI configurada.' };

  const truncado = cuerpo.length > LIMITES.maxCharsLLM;
  const cabecera = nombreNegocio ? `El negocio es "${nombreNegocio}".\n\n` : '';
  try {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS_APRENDER },
        { role: 'user', content: cabecera + cuerpo.slice(0, LIMITES.maxCharsLLM) },
      ],
    });
    const perfil = sanearPerfil(parsearJSON(res.choices?.[0]?.message?.content));
    if (!perfil) return { ok: false, error: 'No encontré conversaciones reales analizables en esa fuente.' };

    const guardado = {
      ...perfil,
      fuente, n_mensajes: nMensajes, conversaciones,
      aprendido_en: new Date().toISOString(),
    };
    await db.update(db.agents, { _id: agent._id }, { estilo_real: guardado });
    console.log(`🗣️ [estilo] perfil aprendido desde ${fuente} (${nMensajes} mensajes) — agente ${agent.name}`);
    return { ok: true, perfil: guardado, agente: agent.name, truncado };
  } catch (e) {
    console.warn('[estilo] aprendizaje falló:', e.message);
    return { ok: false, error: 'El aprendizaje falló. Intenta de nuevo en un momento.' };
  }
}

/** Borra el perfil aprendido del agente activo. */
async function olvidarEstilo(accountId) {
  const agent = await db.findOne(db.agents, { account_id: accountId, enabled: true });
  if (!agent) return { ok: false, error: 'sin agente activo' };
  await db.update(db.agents, { _id: agent._id }, { estilo_real: null });
  return { ok: true };
}

module.exports = {
  LIMITES,
  anonimizar, parsearChatExportado, muestrasDesdeMensajes, corpusDesdeTexto,
  sanearPerfil, parsearJSON, bloqueEstilo, bloqueEstiloLead,
  corpusDesdeBandeja, aprenderEstilo, olvidarEstilo,
};
