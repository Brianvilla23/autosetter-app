/**
 * Atinov — Fuentes de conocimiento
 *
 * Resuelve el cuello de botella real del producto: la hoja en blanco. En vez
 * de pedirle al dueño que escriba todo lo que sabe de su negocio, le pedimos
 * de dónde sacarlo y lo escribimos nosotros:
 *
 *   · su sitio web            → lo leemos
 *   · su propio Instagram     → bio + captions de sus últimas publicaciones
 *   · un PDF                  → catálogo, lista de precios, protocolo
 *   · un video de YouTube     → para nutrir ("te dejo este video que lo explica")
 *   · texto pegado            → lo que tenga a mano
 *
 * De cada fuente sale una entrada de Knowledge Base REDACTADA por el modelo,
 * lista para que el dueño corrija en vez de escribir desde cero.
 *
 * Regla de oro: el resumen NUNCA inventa. Si un dato no está en la fuente, no
 * aparece. Un precio inventado en la base de conocimiento es un precio que el
 * agente le va a decir a un cliente real.
 */

const axios = require('axios');
const db    = require('../db/database');

const TIPOS = ['url', 'instagram', 'pdf', 'youtube', 'texto'];
const MAX_CHARS_FUENTE = 40000;   // techo de lo que mandamos al modelo

// ── Extracción por tipo ───────────────────────────────────────────────────────

/** Quita HTML, scripts y estilos; deja texto legible. */
function htmlAtexto(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Un usuario puede escribir CUALQUIER URL y el servidor la va a pedir. Sin
 * este filtro, apuntar a http://169.254.169.254 o a localhost convierte la
 * función en un lector de la red interna de Railway (SSRF). Solo http/https
 * hacia hosts públicos.
 */
function validarUrlPublica(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('La dirección no es válida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Solo se admiten direcciones http o https');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') ||
      host === '[::1]' || host === '0.0.0.0') {
    throw new Error('Esa dirección no es pública');
  }
  // IPv4 privadas, loopback, link-local (metadatos de la nube) y CGNAT
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 10 || a === 127 || a === 0 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127)) {
      throw new Error('Esa dirección no es pública');
    }
  }
  if (host.startsWith('[')) throw new Error('Esa dirección no es pública'); // IPv6 literal
  return u.toString();
}

async function extraerUrl(urlCruda) {
  const url = validarUrlPublica(urlCruda);
  const r = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 3,
    maxContentLength: 6 * 1024 * 1024,
    headers: { 'User-Agent': 'AtinovBot/1.0 (+https://atinov.com)' },
    responseType: 'text',
  });
  const titulo = (String(r.data).match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1] || url;
  return { titulo: titulo.trim(), texto: htmlAtexto(r.data).slice(0, MAX_CHARS_FUENTE) };
}

/** Bio + captions de las últimas publicaciones de la propia cuenta. */
async function extraerInstagram(account) {
  if (!account?.access_token) throw new Error('La cuenta de Instagram no está conectada');
  const IG = 'https://graph.instagram.com/v21.0';
  const igId = account.ig_platform_id || account.ig_user_id;

  let bio = '';
  try {
    const p = await axios.get(`${IG}/${igId}`, {
      params: { fields: 'username,name,biography,website', access_token: account.access_token },
      timeout: 15000,
    });
    const d = p.data || {};
    bio = [d.name, d.biography, d.website].filter(Boolean).join('\n');
  } catch (e) { /* la bio es opcional */ }

  const m = await axios.get(`${IG}/${igId}/media`, {
    params: { fields: 'caption,permalink,media_type,timestamp', limit: 30, access_token: account.access_token },
    timeout: 20000,
  });
  const captions = (m.data?.data || [])
    .map(x => (x.caption || '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n');

  return {
    titulo: `Instagram de @${account.ig_username || igId}`,
    texto: [bio && `BIO:\n${bio}`, captions && `PUBLICACIONES:\n${captions}`]
      .filter(Boolean).join('\n\n').slice(0, MAX_CHARS_FUENTE),
  };
}

/**
 * YouTube: título y autor por oEmbed (sin API key) + descripción de la página.
 * Para nutrición no hace falta la transcripción completa: lo que el agente
 * necesita es saber DE QUÉ trata para recomendarlo en el momento justo.
 */
async function extraerYoutube(urlCruda) {
  const url = validarUrlPublica(urlCruda);
  if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(url).hostname)) {
    throw new Error('Ese link no es de YouTube');
  }
  const o = await axios.get('https://www.youtube.com/oembed', {
    params: { url, format: 'json' }, timeout: 15000,
  });
  const titulo = o.data?.title || 'Video de YouTube';
  const autor  = o.data?.author_name || '';
  let descripcion = '';
  try {
    const p = await axios.get(url, {
      timeout: 20000, responseType: 'text',
      headers: { 'User-Agent': 'AtinovBot/1.0 (+https://atinov.com)' },
    });
    const meta = String(p.data).match(/<meta name="description" content="([^"]{0,600})"/i);
    if (meta) descripcion = meta[1];
  } catch (e) { /* la descripción es opcional */ }

  return {
    titulo: `Video: ${titulo}`,
    texto: [
      `TÍTULO: ${titulo}`,
      autor && `CANAL: ${autor}`,
      `LINK: ${url}`,
      descripcion && `DESCRIPCIÓN: ${descripcion}`,
      'USO: recurso para compartir con leads que todavía no están listos para comprar.',
    ].filter(Boolean).join('\n'),
  };
}

/** PDF → texto. La dependencia se carga perezosa para no romper el arranque. */
async function extraerPdf(base64) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (e) {
    throw new Error('El lector de PDF no está disponible en el servidor');
  }
  const buf = Buffer.from(String(base64).replace(/^data:.*?;base64,/, ''), 'base64');
  const datos = await pdfParse(buf);
  const texto = String(datos.text || '').replace(/\s{3,}/g, '\n').trim();
  if (!texto) throw new Error('El PDF no tiene texto seleccionable (¿es un escaneo?)');
  return { titulo: 'Documento PDF', texto: texto.slice(0, MAX_CHARS_FUENTE) };
}

// ── Resumen a base de conocimiento ────────────────────────────────────────────

const PROMPT_RESUMEN = `Eres quien prepara la base de conocimiento de un asistente de atención al cliente.

Te paso el material en bruto de un negocio. Escribe una ficha que el asistente pueda usar para responder a clientes reales.

REGLAS ABSOLUTAS:
- NO INVENTES NADA. Si un precio, horario, dirección o condición no está en el material, no lo escribas. Es preferible que falte a que esté mal: lo que escribas se lo va a decir el asistente a un cliente de verdad.
- Si algo aparece incompleto o dudoso, escríbelo igual pero marcándolo así: [VERIFICAR: ...].
- Nada de marketing ni adjetivos vacíos ("excelencia", "los mejores"). Datos concretos.
- Organiza por temas con encabezados en MAYÚSCULAS (QUÉ VENDE, PRECIOS, HORARIOS, UBICACIÓN, FORMAS DE PAGO, PREGUNTAS FRECUENTES, etc.). Usa solo los que correspondan.
- Español de Chile, con tuteo. Sin emojis.
- Máximo 500 palabras. Si el material es enorme, quédate con lo que un cliente preguntaría.

Devuelve SOLO la ficha, sin introducción ni comentarios tuyos.`;

async function resumirAFicha({ texto, titulo, apiKey }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const r = await client.chat.completions.create({
    model: process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: PROMPT_RESUMEN },
      { role: 'user', content: `FUENTE: ${titulo}\n\nMATERIAL:\n${texto}` },
    ],
    max_tokens: 900,
    temperature: 0.2,   // baja a propósito: acá no queremos creatividad
  });
  return (r.choices?.[0]?.message?.content || '').trim();
}

// ── Orquestación ──────────────────────────────────────────────────────────────

/**
 * Procesa una fuente: extrae, resume y crea/actualiza su entrada de Knowledge.
 * La entrada nace SIN asignar a ningún agente y con is_main:false — el dueño
 * la revisa y recién ahí la activa. Nada llega al agente sin que un humano lo
 * haya visto.
 */
async function procesarFuente(fuenteId) {
  const fuente = await db.findOne(db.knowledgeSources, { _id: fuenteId });
  if (!fuente) throw new Error('fuente no encontrada');

  await db.update(db.knowledgeSources, { _id: fuenteId }, { estado: 'procesando', error: null });

  try {
    const account = await db.findOne(db.accounts, { _id: fuente.account_id });
    const settings = await db.findOne(db.settings, { account_id: fuente.account_id });
    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) throw new Error('La cuenta no tiene API key de OpenAI configurada');

    let extraido;
    if (fuente.tipo === 'url')            extraido = await extraerUrl(fuente.origen);
    else if (fuente.tipo === 'instagram') extraido = await extraerInstagram(account);
    else if (fuente.tipo === 'youtube')   extraido = await extraerYoutube(fuente.origen);
    else if (fuente.tipo === 'pdf')       extraido = await extraerPdf(fuente.contenido_crudo);
    else if (fuente.tipo === 'texto')     extraido = { titulo: fuente.titulo || 'Notas del negocio', texto: String(fuente.contenido_crudo || '').slice(0, MAX_CHARS_FUENTE) };
    else throw new Error(`tipo de fuente desconocido: ${fuente.tipo}`);

    if (!extraido.texto || extraido.texto.length < 40) {
      throw new Error('No se pudo sacar texto útil de esta fuente');
    }

    const ficha = await resumirAFicha({ texto: extraido.texto, titulo: extraido.titulo, apiKey });
    if (!ficha) throw new Error('El resumen salió vacío');

    const titulo = (fuente.titulo || extraido.titulo || 'Fuente').slice(0, 90);
    let knowledgeId = fuente.knowledge_id;
    if (knowledgeId && await db.findOne(db.knowledge, { _id: knowledgeId })) {
      await db.update(db.knowledge, { _id: knowledgeId }, { title: titulo, content: ficha });
    } else {
      const k = await db.insert(db.knowledge, {
        account_id: fuente.account_id,
        title: titulo,
        content: ficha,
        is_main: false,      // no llega a ningún agente hasta que el dueño lo asigne
        agent_ids: [],
        origen_fuente: fuente._id,
      });
      knowledgeId = k._id;
    }

    await db.update(db.knowledgeSources, { _id: fuenteId }, {
      estado: 'listo',
      knowledge_id: knowledgeId,
      procesado_at: new Date().toISOString(),
      // El crudo ya cumplió su función: no guardamos PDFs enteros para siempre.
      contenido_crudo: fuente.tipo === 'texto' ? fuente.contenido_crudo : null,
      error: null,
    });
    return { ok: true, knowledgeId, titulo };
  } catch (e) {
    const motivo = e.response?.data?.error?.message || e.message || 'error desconocido';
    await db.update(db.knowledgeSources, { _id: fuenteId }, {
      estado: 'error', error: String(motivo).slice(0, 300),
    }).catch(() => null);
    console.warn(`[fuentes] falló la fuente ${fuenteId}:`, motivo);
    return { ok: false, error: motivo };
  }
}

module.exports = { TIPOS, procesarFuente, htmlAtexto, validarUrlPublica };
