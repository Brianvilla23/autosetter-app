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
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return 0;
    let items = JSON.parse(match[0]);
    if (!Array.isArray(items)) return 0;

    let creadas = 0;
    const cupo = MAX_PROPUESTAS_PENDIENTES - pendientes.length;
    for (const it of items.slice(0, cupo)) {
      if (!it?.causa || !it?.propuesta) continue;
      // No duplicar una propuesta pendiente con la misma causa
      if (pendientes.some(p => p.causa === it.causa)) continue;
      await db.insert(db.improvements, {
        account_id: accountId,
        agent_id: agent._id,
        causa: String(it.causa).slice(0, 200),
        evidencia: String(it.evidencia || '').slice(0, 300),
        propuesta: String(it.propuesta).slice(0, 400),
        status: 'pending',
        muestra: perdidos.length,
      });
      creadas++;
    }
    if (creadas) console.log(`💡 [mejoras] ${creadas} propuesta(s) para cuenta ${accountId} (muestra: ${perdidos.length} conversaciones perdidas)`);
    return creadas;
  } catch (e) {
    console.warn('[mejoras] análisis falló (no bloquea):', e.message);
    return 0;
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
  const marker = '\n\n═══ MEJORAS APROBADAS (del análisis semanal de conversaciones perdidas) ═══';
  let instructions = agent.instructions || '';
  if (!instructions.includes(marker)) instructions += marker;
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

module.exports = { analyzeAccount, applyImprovement, dismissImprovement, sweepImprovements };
