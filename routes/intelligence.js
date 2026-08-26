/**
 * Atinov — Panel Inteligencia (API)
 *
 * Agrega y expone lo que el agente APRENDIÓ de las conversaciones del cliente
 * (RAG / conversation_insights en Supabase): objeciones top, motivos de
 * pérdida, mensajes y preguntas que funcionan. Convierte conversaciones que
 * NO cerraron en inteligencia de mercado visible.
 *
 * Si el RAG no está configurado devuelve { enabled:false } y la UI muestra
 * un empty-state — nunca rompe.
 */

const express = require('express');
const router = express.Router();
// ⚠️ Este require faltó desde el nacimiento del archivo: GET /improvements
// usaba `db` sin importarlo → ReferenceError → 500. La auto-mejora semanal
// generaba propuestas que el dueño JAMÁS pudo ver — el sistema entero parecía
// funcionar porque el sweep corría y guardaba, pero el panel moría al listar.
const db = require('../db/database');

function assertOwnsAccount(req, accountId) {
  return accountId && req.user && req.user.accountId === accountId;
}

/** Normaliza texto para agrupar insights casi idénticos. */
function norm(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Agrupa una lista de insights por texto normalizado → [{text, count, outcome}] */
function aggregate(items, cap = 12) {
  const map = new Map();
  for (const i of items) {
    const key = norm(i.text);
    if (!key) continue;
    const cur = map.get(key);
    if (cur) {
      cur.count++;
      // conservar el outcome más informativo (ganado > perdido > en_curso)
      if (i.outcome === 'ganado') cur.outcome = 'ganado';
      if (cur.created_at < i.created_at) cur.created_at = i.created_at;
    } else {
      map.set(key, { text: i.text, count: 1, outcome: i.outcome || null, created_at: i.created_at });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, cap)
    .map(({ text, count, outcome }) => ({ text, count, outcome }));
}

// ── MEJORAS PROPUESTAS (auto-mejora semanal del agente) ─────────────────────
// El job semanal analiza conversaciones perdidas y propone mejoras al prompt.
// El dueño las aprueba (se anexan a agent.instructions) o descarta, 1 clic.

// GET /api/intelligence/improvements?accountId=X
router.get('/improvements', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const items = (await db.find(db.improvements, { account_id: accountId, status: 'pending' }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ improvements: items.map(i => ({
      id: i._id, causa: i.causa, evidencia: i.evidencia, propuesta: i.propuesta,
      muestra: i.muestra, createdAt: i.createdAt,
      // Propuestas anteriores a la subida manual no traen origen: son del semanal.
      origen: i.origen || 'semanal',
    })) });
  } catch (e) { next(e); }
});

// POST /api/intelligence/improvements/apply  Body: { accountId, id }
router.post('/improvements/apply', async (req, res, next) => {
  try {
    const { accountId, id } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const { applyImprovement } = require('../services/promptImprover');
    const r = await applyImprovement(id, accountId);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { next(e); }
});

// POST /api/intelligence/improvements/analizar-texto  Body: { accountId, texto }
// "Sube conversaciones reales y mejora tu agente": análisis LLM bajo demanda.
// Gasta plata de la key de la plataforma → los 4 candados, no 1: requireAuth y
// checkSubscription vienen del mount, analysisLimiter es el rate limit propio
// por IP, y el tope diario por cuenta vive acá (cambiar de IP es trivial).
const MAX_ANALISIS_DIA = 10;
const { analysisLimiter } = require('../middleware/security');
router.post('/improvements/analizar-texto', analysisLimiter, async (req, res, next) => {
  try {
    const { accountId, texto } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    // Tope diario por cuenta, reset perezoso por fecha (patrón de voice.js).
    const settings = await db.findOne(db.settings, { account_id: accountId });
    const hoy = new Date().toISOString().slice(0, 10);
    const usadosHoy = settings?.upload_analysis_date === hoy
      ? Number(settings.upload_analysis_count || 0)
      : 0;
    if (usadosHoy >= MAX_ANALISIS_DIA) {
      return res.status(429).json({
        error: `Alcanzaste el máximo de ${MAX_ANALISIS_DIA} análisis por día. Vuelve mañana.`,
      });
    }

    // API key: misma precedencia que todo el repo (plataforma → cuenta).
    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;

    const { analyzeUploadedText } = require('../services/promptImprover');
    const r = await analyzeUploadedText({ accountId, texto, apiKey });
    if (!r.ok) return res.status(400).json({ error: r.error });

    // Contar el análisis DESPUÉS del éxito (mismo criterio que las sesiones
    // de voz): un error del modelo no quema cupo del dueño.
    if (settings) {
      await db.update(db.settings, { _id: settings._id },
        { upload_analysis_date: hoy, upload_analysis_count: usadosHoy + 1 }).catch(() => null);
    } else {
      await db.insert(db.settings, {
        account_id: accountId, upload_analysis_date: hoy, upload_analysis_count: 1,
      }).catch(() => null);
    }

    res.json({ ...r, restantes_hoy: MAX_ANALISIS_DIA - (usadosHoy + 1) });
  } catch (e) { next(e); }
});

// POST /api/intelligence/improvements/dismiss  Body: { accountId, id }
router.post('/improvements/dismiss', async (req, res, next) => {
  try {
    const { accountId, id } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const { dismissImprovement } = require('../services/promptImprover');
    const r = await dismissImprovement(id, accountId);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { next(e); }
});

// GET /api/intelligence?accountId=X
router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const { isEnabled, getClient } = require('../services/rag/supabase');
    if (!isEnabled()) return res.json({ enabled: false, reason: 'rag_off' });
    const client = getClient();
    if (!client) return res.json({ enabled: false, reason: 'rag_off' });

    // Insights del account (los más recientes; agregamos en memoria)
    const { data: insights, error } = await client
      .from('conversation_insights')
      .select('kind, text, outcome, lead_id, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return res.json({ enabled: false, reason: error.message });

    const rows = insights || [];
    const by = (kind) => rows.filter(r => r.kind === kind);

    // Conversaciones de las que se aprendió + tamaño de la memoria
    const conversaciones = new Set(rows.map(r => r.lead_id)).size;
    const { count: chunks } = await client
      .from('conversation_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);

    res.json({
      enabled: true,
      stats: {
        conversaciones,
        insights: rows.length,
        objeciones: by('objecion').length,
        perdidas: by('motivo_perdida').length,
        memoria: chunks ?? 0,
      },
      objeciones:      aggregate(by('objecion')),
      motivos_perdida: aggregate(by('motivo_perdida')),
      huecos:          aggregate(by('hueco_conocimiento'), 8),
      funciona: aggregate([
        ...by('msg_efectivo').map(r => ({ ...r, _label: 'mensaje' })),
        ...by('pregunta_calificadora').map(r => ({ ...r, _label: 'pregunta' })),
      ]),
    });
  } catch (e) { next(e); }
});

// GET /api/intelligence/scores?accountId — mapa lead_id → score (0..100)
// Lo consume el CRM para ordenar el pipeline por probabilidad de cierre.
// Si el RAG está apagado devuelve {} y el CRM se ve como siempre.
router.get('/scores', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const { isEnabled, getClient } = require('../services/rag/supabase');
    if (!isEnabled()) return res.json({ scores: {} });
    const client = getClient();
    if (!client) return res.json({ scores: {} });

    const { data } = await client
      .from('lead_scores')
      .select('lead_id, score')
      .eq('account_id', accountId)
      .limit(2000);
    const scores = {};
    for (const r of (data || [])) scores[r.lead_id] = Math.round(r.score);
    res.json({ scores });
  } catch (e) { next(e); }
});

// POST /api/intelligence/teach
// Body: { accountId, gapText, answer }
// "Enseñarle al agente": crea una entrada en la base de conocimiento con la
// respuesta del dueño y marca el hueco como resuelto (borra esos insights).
router.post('/teach', async (req, res, next) => {
  try {
    const { accountId, gapText, answer } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    if (!gapText || !answer || !String(answer).trim()) {
      return res.status(400).json({ error: 'gapText y answer son requeridos' });
    }

    const title = String(gapText).slice(0, 120);
    const entry = await db.insert(db.knowledge, {
      account_id: accountId,
      title,
      content: String(answer).trim().slice(0, 4000),
      is_main: false,
      agent_ids: [], // disponible para todos los agentes de la cuenta
      source: 'inteligencia_hueco',
    });

    // Resolver el hueco: borrar los insights de ese texto (el conocimiento ya existe)
    const { isEnabled, getClient } = require('../services/rag/supabase');
    if (isEnabled()) {
      const client = getClient();
      if (client) {
        const { data: matches } = await client
          .from('conversation_insights')
          .select('id, text')
          .eq('account_id', accountId)
          .eq('kind', 'hueco_conocimiento');
        const ids = (matches || []).filter(m => norm(m.text) === norm(gapText)).map(m => m.id);
        if (ids.length) await client.from('conversation_insights').delete().in('id', ids);
      }
    }

    res.json({ ok: true, knowledge: { ...entry, id: entry._id } });
  } catch (e) { next(e); }
});

module.exports = router;
