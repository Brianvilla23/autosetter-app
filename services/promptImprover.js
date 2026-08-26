/**
 * Atinov — Auto-mejora del agente (Tier 2: "Atinov aprende", demostrable)
 *
 * Job semanal: analiza las conversaciones PERDIDAS/frías de los últimos 7
 * días de cada cuenta, clusteriza por qué se pierden, y genera 1-3
 * propuestas CONCRETAS de mejora para las instrucciones del agente. El dueño
 * las ve en el Panel de Inteligencia y las aprueba o descarta con un clic —
 * autonomía gobernada: el agente propone, el humano decide.
 *
 * Extiende el patrón de "huecos de conocimiento" (el dueño responde una vez
 * y queda para siempre) de huecos de CONOCIMIENTO a huecos de ESTRATEGIA.
 *
 * Al aprobar, la propuesta se anexa a agent.instructions bajo la sección
 * "MEJORAS APROBADAS" con fecha — nunca pisa lo que el dueño escribió.
 */

const OpenAI = require('openai');
const db     = require('../db/database');

const MAX_PROPUESTAS_PENDIENTES = 3;   // no apilar si el dueño no ha revisado
const MAX_CONVERSACIONES_MUESTRA = 12; // cap de tokens del análisis
const SEND_AFTER_UTC_HOUR = 13;        // corre los lunes ≥13 UTC (~9-10am Chile)
const MAX_TEXTO_LLM = 14000;           // cap de caracteres que viajan al modelo
const MIN_TEXTO_SUBIDO = 200;          // menos que esto no tiene señal que analizar

/**
 * Saca el array de propuestas de la respuesta cruda del modelo. El modelo a
 * veces envuelve el JSON en texto o en un bloque de código: se rescata el
 * primer [...] que aparezca. Si no hay array válido → [] (nunca throw).
 */
function parsearPropuestas(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const items = JSON.parse(match[0]);
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

/**
 * Guarda como pendientes las propuestas que quepan en el cupo, sin duplicar
 * causas ya pendientes. Devuelve cuántas creó.
 */
async function guardarPropuestas({ accountId, agentId, items, pendientes, origen, muestra = null }) {
  let creadas = 0;
  const cupo = MAX_PROPUESTAS_PENDIENTES - pendientes.length;
  for (const it of items.slice(0, cupo)) {
    if (!it?.causa || !it?.propuesta) continue;
    if (pendientes.some(p => p.causa === it.causa)) continue;
    await db.insert(db.improvements, {
      account_id: accountId,
      agent_id: agentId,
      causa: String(it.causa).slice(0, 200),
      evidencia: String(it.evidencia || '').slice(0, 300),
      propuesta: String(it.propuesta).slice(0, 400),
      status: 'pending',
      origen,
      muestra,
    });
    creadas++;
  }
  return creadas;
}

/**
 * Analiza una cuenta y guarda propuestas pendientes. Devuelve cuántas creó.
 */
async function analyzeAccount(accountId, apiKey) {
  if (!apiKey) return 0;

  // No apilar propuestas si ya hay pendientes sin revisar
  const pendientes = await db.find(db.improvements, { account_id: accountId, status: 'pending' });
  if (pendientes.length >= MAX_PROPUESTAS_PENDIENTES) return 0;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const leads = await db.find(db.leads, { account_id: accountId });

  // Conversaciones que se enfriaron o perdieron esta semana, con diálogo real
  const perdidos = leads.filter(l =>
    (l.qualification === 'cold' || l.pipeline_stage === 'perdido') &&
    l.last_message_at >= since
  ).slice(0, MAX_CONVERSACIONES_MUESTRA);
  if (perdidos.length < 3) return 0; // muy poca señal para clusterizar

  const agent = await db.findOne(db.agents, { account_id: accountId, enabled: true });
  if (!agent) return 0;

  let transcripts = '';
  for (const lead of perdidos) {
    const msgs = (await db.find(db.messages, { lead_id: lead._id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)))
      .filter(m => m.role !== 'sistema')
      .slice(-8);
    if (msgs.filter(m => m.role === 'user').length < 2) continue;
    transcripts += `\n--- CONVERSACIÓN (${lead.qualification || lead.pipeline_stage}) ---\n`;
    transcripts += msgs.map(m => `${m.role === 'user' ? 'LEAD' : 'AGENTE'}: ${String(m.content).slice(0, 250)}`).join('\n') + '\n';
  }
  if (transcripts.length < 400) return 0;

  const sys = `Eres un coach de ventas analizando por qué un agente IA pierde conversaciones. Te paso las conversaciones perdidas/frías de la semana. Tu trabajo:
1. Detectar los 1-3 PATRONES de pérdida más repetidos (no casos únicos).
2. Por cada patrón, proponer UNA instrucción concreta y accionable para agregar al prompt del agente que lo corrija.

Devuelve SOLO un array JSON (sin texto extra):
[{ "causa": "patrón detectado en 1 frase", "evidencia": "en cuántas de las conversaciones aparece y un ejemplo corto", "propuesta": "la instrucción exacta a agregar al prompt, redactada en imperativo, máximo 300 caracteres, en español con tuteo" }]

Reglas: máximo 3 items. Si las pérdidas son normales (leads sin fit real, curiosos) devuelve []. La propuesta debe ser una regla de comportamiento, nunca conocimiento del negocio (eso va en la Knowledge Base).`;

  try {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: transcripts.slice(0, 14000) },
      ],
    });
    const raw = res.choices?.[0]?.message?.content || '[]';
    const creadas = await guardarPropuestas({
      accountId, agentId: agent._id, items: parsearPropuestas(raw),
      pendientes, origen: 'semanal', muestra: perdidos.length,
    });
    if (creadas) console.log(`💡 [mejoras] ${creadas} propuesta(s) para cuenta ${accountId} (muestra: ${perdidos.length} conversaciones perdidas)`);
    return creadas;
  } catch (e) {
    console.warn('[mejoras] análisis falló (no bloquea):', e.message);
    return 0;
  }
}

/**
 * "Sube conversaciones reales y mejora tu agente": el dueño pega
 * conversaciones de ANTES de tener el agente (su WhatsApp personal, otro
 * canal, un export) y el sistema propone mejoras concretas al prompt.
 *
 * Es el complemento del análisis semanal: aquel aprende de lo que el AGENTE
 * pierde; este aprende de cómo vende EL DUEÑO — lo que funciona se imita, lo
 * que falla se corrige. Mismo riel de salida: propuestas pendientes que se
 * aprueban o descartan con un clic en el Panel Inteligencia.
 *
 * Los candados de gasto (rate limit por IP, tope diario por cuenta) viven en
 * la ruta — acá solo se valida la señal y se llama una vez al modelo.
 */
async function analyzeUploadedText({ accountId, texto, apiKey }) {
  if (!apiKey) return { ok: false, error: 'La cuenta no tiene API key de OpenAI configurada.' };

  const limpio = String(texto || '').trim();
  if (limpio.length < MIN_TEXTO_SUBIDO) {
    return { ok: false, error: `Pega al menos ${MIN_TEXTO_SUBIDO} caracteres de conversación — con menos no hay señal que analizar.` };
  }

  const pendientes = await db.find(db.improvements, { account_id: accountId, status: 'pending' });
  if (pendientes.length >= MAX_PROPUESTAS_PENDIENTES) {
    return { ok: false, error: `Ya tienes ${MAX_PROPUESTAS_PENDIENTES} propuestas esperando revisión. Apruébalas o descártalas antes de analizar más.` };
  }

  const agent = await db.findOne(db.agents, { account_id: accountId, enabled: true });
  if (!agent) return { ok: false, error: 'La cuenta no tiene un agente activo al que proponerle mejoras.' };

  const truncado = limpio.length > MAX_TEXTO_LLM;

  const sys = `Eres un coach de ventas. El dueño de un negocio te pega conversaciones REALES con sus clientes (por WhatsApp, Instagram u otro canal — puede que las haya atendido él mismo, sin agente IA). Tu trabajo es convertirlas en mejoras para el prompt de su agente IA:
1. Detectar 1-3 PATRONES útiles: respuestas o técnicas del dueño que FUNCIONAN (el agente debe imitarlas) y errores repetidos que pierden clientes (el agente debe evitarlos).
2. Por cada patrón, proponer UNA instrucción concreta para el prompt del agente.

Devuelve SOLO un array JSON (sin texto extra):
[{ "causa": "patrón detectado en 1 frase", "evidencia": "dónde se ve en lo pegado, un ejemplo corto", "propuesta": "la instrucción exacta a agregar al prompt, en imperativo, máximo 300 caracteres, en español con tuteo" }]

Reglas: máximo 3 items. La propuesta debe ser una regla de COMPORTAMIENTO (tono, orden de preguntas, manejo de objeciones), nunca conocimiento del negocio como precios u horarios (eso va en la Knowledge Base). Si el texto no tiene conversaciones reales analizables, devuelve [].`;

  try {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: limpio.slice(0, MAX_TEXTO_LLM) },
      ],
    });
    const creadas = await guardarPropuestas({
      accountId, agentId: agent._id,
      items: parsearPropuestas(res.choices?.[0]?.message?.content),
      pendientes, origen: 'subidas',
    });
    if (creadas) console.log(`💡 [mejoras] ${creadas} propuesta(s) desde conversaciones subidas — cuenta ${accountId}`);
    return { ok: true, creadas, truncado };
  } catch (e) {
    console.warn('[mejoras] análisis de texto subido falló:', e.message);
    return { ok: false, error: 'El análisis falló. Intenta de nuevo en un momento.' };
  }
}

/** Aprueba una propuesta: la anexa a las instrucciones del agente. */
async function applyImprovement(improvementId, accountId) {
  const imp = await db.findOne(db.improvements, { _id: improvementId, account_id: accountId });
  if (!imp) return { ok: false, error: 'propuesta no encontrada' };
  if (imp.status !== 'pending') return { ok: false, error: 'ya fue revisada' };

  const agent = await db.findOne(db.agents, { _id: imp.agent_id });
  if (!agent) return { ok: false, error: 'agente no encontrado' };

  const fecha = new Date().toISOString().slice(0, 10);
  // Las propuestas ahora vienen de dos fuentes (análisis semanal y
  // conversaciones subidas por el dueño) y comparten UNA sección. Se detecta
  // por el prefijo para no duplicar el encabezado en agentes que ya tienen el
  // texto viejo ("del análisis semanal...").
  const markerPrefijo = '═══ MEJORAS APROBADAS';
  const marker = '\n\n═══ MEJORAS APROBADAS (aprendidas de conversaciones reales) ═══';
  let instructions = agent.instructions || '';
  if (!instructions.includes(markerPrefijo)) instructions += marker;
  instructions += `\n• [${fecha}] ${imp.propuesta}`;

  await db.update(db.agents, { _id: agent._id }, { instructions });
  await db.update(db.improvements, { _id: imp._id }, {
    status: 'approved', reviewed_at: new Date().toISOString(),
  });
  return { ok: true, agente: agent.name };
}

/** Descarta una propuesta. */
async function dismissImprovement(improvementId, accountId) {
  const imp = await db.findOne(db.improvements, { _id: improvementId, account_id: accountId });
  if (!imp) return { ok: false, error: 'propuesta no encontrada' };
  await db.update(db.improvements, { _id: imp._id }, {
    status: 'dismissed', reviewed_at: new Date().toISOString(),
  });
  return { ok: true };
}

/**
 * Sweep semanal — corre desde server.js cada hora; ejecuta los lunes ≥13 UTC,
 * una vez por semana por cuenta (flag improverRanAt).
 */
async function sweepImprovements({ force = false } = {}) {
  const now = new Date();
  if (!force) {
    if (now.getUTCDay() !== 1 || now.getUTCHours() < SEND_AFTER_UTC_HOUR) return { skipped: 'no es lunes por la mañana' };
  }
  const weekStart = new Date(now); weekStart.setUTCDate(now.getUTCDate() - 6);
  const weekStartIso = weekStart.toISOString();

  const accounts = await db.find(db.accounts, {});
  let analizadas = 0, propuestas = 0;
  for (const acc of accounts) {
    if (!force && acc.improverRanAt && acc.improverRanAt >= weekStartIso) continue;
    const settings = await db.findOne(db.settings, { account_id: acc._id });
    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) continue;
    try {
      propuestas += await analyzeAccount(acc._id, apiKey);
      analizadas++;
      await db.update(db.accounts, { _id: acc._id }, { improverRanAt: now.toISOString() });
    } catch (e) { console.error(`[mejoras] cuenta ${acc._id}:`, e.message); }
  }
  return { analizadas, propuestas };
}

module.exports = {
  analyzeAccount, applyImprovement, dismissImprovement, sweepImprovements,
  analyzeUploadedText, parsearPropuestas, guardarPropuestas,
  MAX_PROPUESTAS_PENDIENTES, MIN_TEXTO_SUBIDO, MAX_TEXTO_LLM,
};
