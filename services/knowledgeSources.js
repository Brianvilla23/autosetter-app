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

/**
 * Elimina bloques <tag>…</tag> recorriendo el string con indexOf.
 *
 * NO se usa regex acá a propósito: un patrón como /<script[\s\S]*?<\/script>/
 * es catastrófico cuando la página trae muchas aperturas sin cierre. Medido:
 * 625 KB de "<script " repetido = 100 segundos de CPU bloqueando el event loop
 * — o sea, el servidor entero muerto (ni webhooks ni /health) con un solo link.
 * Esta versión es lineal pase lo que pase.
 */
function quitarBloques(html, tag) {
  const abre = `<${tag}`;
  const cierra = `</${tag}>`;
  let out = '';
  let i = 0;
  const bajo = html.toLowerCase();
  while (i < html.length) {
    const ini = bajo.indexOf(abre, i);
    if (ini === -1) { out += html.slice(i); break; }
    out += html.slice(i, ini);
    const fin = bajo.indexOf(cierra, ini);
    if (fin === -1) break;              // sin cierre: se descarta el resto
    i = fin + cierra.length;
  }
  return out;
}

const MAX_HTML = 1_500_000;   // techo antes de limpiar

/** Quita HTML, scripts y estilos; deja texto legible. */
function htmlAtexto(html) {
  let s = String(html || '').slice(0, MAX_HTML);
  for (const tag of ['script', 'style', 'nav', 'footer', 'svg', 'head']) {
    s = quitarBloques(s, tag);
  }
  return s
    .replace(/<[^>]*>/g, ' ')          // lineal: sin cuantificadores anidados
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Un usuario puede escribir CUALQUIER URL y el servidor la va a pedir. Sin
 * este filtro, apuntar a http://169.254.169.254 o a localhost convierte la
 * función en un lector de la red interna de Railway (SSRF). Solo http/https
 * hacia hosts públicos.
 */
/** ¿Esta IP pertenece a un rango que nunca debe alcanzarse desde acá? */
function ipEsPrivada(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {                      // IPv6
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^f[cd]/.test(l)) return true;         // ULA fc00::/7
    if (l.startsWith('fe80')) return true;     // link-local
    // IPv4 mapeada. Node normaliza [::ffff:127.0.0.1] a ::ffff:7f00:1, así que
    // hay que cubrir la forma hexadecimal además de la decimal.
    const v4dec = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4dec) return ipEsPrivada(v4dec[1]);
    const v4hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4hex) {
      const alto = parseInt(v4hex[1], 16), bajo = parseInt(v4hex[2], 16);
      return ipEsPrivada(`${alto >> 8}.${alto & 255}.${bajo >> 8}.${bajo & 255}`);
    }
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n))) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 ||
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) ||
         (a === 169 && b === 254) ||
         (a === 100 && b >= 64 && b <= 127) ||
         a >= 224;                             // multicast y reservados
}

function normalizarHost(h) {
  return String(h || '').toLowerCase().replace(/\.$/, ''); // el punto final resuelve igual
}

/**
 * Valida forma y, sobre todo, A DÓNDE RESUELVE.
 *
 * Chequear solo el texto de la URL no alcanza: dominios públicos como
 * 127.0.0.1.nip.io o localtest.me apuntan a loopback, y un host público puede
 * responder 302 hacia la red interna. Por eso acá se resuelve el DNS y se
 * exige que TODAS las IPs sean públicas.
 */
async function validarUrlPublica(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('La dirección no es válida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Solo se admiten direcciones http o https');
  }
  const host = normalizarHost(u.hostname.replace(/^\[|\]$/g, ''));
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Esa dirección no es pública');
  }
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) {
    throw new Error('Ese puerto no está permitido');
  }

  // Literal IP → se valida directo; nombre → se resuelve.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (ipEsPrivada(host)) throw new Error('Esa dirección no es pública');
  } else {
    const dns = require('dns').promises;
    let dirs;
    try { dirs = await dns.lookup(host, { all: true }); }
    catch (e) { throw new Error('No se pudo resolver esa dirección'); }
    if (!dirs.length || dirs.some(d => ipEsPrivada(d.address))) {
      throw new Error('Esa dirección apunta a una red interna');
    }
  }
  return u.toString();
}

/**
 * Descarga con redirecciones MANUALES: cada salto se vuelve a validar. Dejar
 * que axios siga redirecciones solo permite entrar por un host público que
 * responde 302 hacia 127.0.0.1 — verificado como explotable.
 */
async function bajarSeguro(urlInicial, { maxSaltos = 3 } = {}) {
  let url = await validarUrlPublica(urlInicial);
  for (let salto = 0; salto <= maxSaltos; salto++) {
    const r = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 0,
      maxContentLength: 6 * 1024 * 1024,
      maxBodyLength: 6 * 1024 * 1024,
      validateStatus: s => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      headers: { 'User-Agent': 'AtinovBot/1.0 (+https://atinov.com)' },
      responseType: 'text',
    });
    if (r.status < 300) return { data: r.data, url };
    const destino = r.headers?.location;
    if (!destino) throw new Error('Redirección sin destino');
    url = await validarUrlPublica(new URL(destino, url).toString());
  }
  throw new Error('Demasiadas redirecciones');
}

async function extraerUrl(urlCruda) {
  const { data, url } = await bajarSeguro(urlCruda);
  const titulo = (String(data).slice(0, 20000).match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1] || url;
  return { titulo: titulo.trim(), texto: htmlAtexto(data).slice(0, MAX_CHARS_FUENTE) };
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
    const p = await bajarSeguro(url, { maxSaltos: 2 });   // mismos límites que el resto
    const meta = String(p.data).slice(0, 200000)
      .match(/<meta name="description" content="([^"]{0,600})"/i);
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
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PAGINAS_PDF = 60;
const TIMEOUT_PDF_MS = 20000;

async function extraerPdf(base64) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (e) {
    throw new Error('El lector de PDF no está disponible en el servidor');
  }
  const buf = Buffer.from(String(base64).replace(/^data:.*?;base64,/, ''), 'base64');
  if (buf.length > MAX_PDF_BYTES) throw new Error('El PDF pesa más de 8 MB');
  // Firma real: sin esto, cualquier archivo renombrado entra al parser.
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('El archivo no parece un PDF válido');
  }

  // Tope de páginas + timeout: un PDF de 3 MB con 20.000 páginas tarda 94
  // segundos y bloquea el proceso entero (pdf-parse corre en el hilo principal).
  const parseo = pdfParse(buf, { max: MAX_PAGINAS_PDF });
  const datos = await Promise.race([
    parseo,
    new Promise((_, rej) => setTimeout(() => rej(new Error('El PDF tardó demasiado en leerse')), TIMEOUT_PDF_MS)),
  ]);

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
    // Idempotente: se busca por origen_fuente además del id guardado. Dos
    // reprocesos simultáneos leían ambos knowledge_id:null y creaban DOS
    // fichas, dejando una huérfana que el dueño no sabía de dónde salió.
    let knowledgeId = fuente.knowledge_id;
    let existente = knowledgeId ? await db.findOne(db.knowledge, { _id: knowledgeId }) : null;
    if (!existente) {
      existente = await db.findOne(db.knowledge, { account_id: fuente.account_id, origen_fuente: fuente._id });
      if (existente) knowledgeId = existente._id;
    }
    if (existente) {
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

/**
 * Al arrancar, rescatar fuentes que quedaron 'procesando' porque el contenedor
 * se reinició a mitad (Railway redeploya seguido). Sin esto quedan colgadas
 * para siempre y la UI ni siquiera ofrece reintentar.
 */
async function rescatarFuentesColgadas() {
  try {
    const colgadas = await db.find(db.knowledgeSources, { estado: 'procesando' });
    for (const f of colgadas) {
      await db.update(db.knowledgeSources, { _id: f._id }, {
        estado: 'error',
        error: 'El proceso se interrumpió (reinicio del servidor). Reintenta.',
      }).catch(() => null);
    }
    if (colgadas.length) console.log(`[fuentes] ${colgadas.length} fuente(s) colgada(s) marcadas para reintentar`);
  } catch (e) { /* best-effort al arranque */ }
}

module.exports = { TIPOS, procesarFuente, htmlAtexto, validarUrlPublica, rescatarFuentesColgadas };
