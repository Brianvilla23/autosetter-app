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
      funciona: aggregate([
        ...by('msg_efectivo').map(r => ({ ...r, _label: 'mensaje' })),
        ...by('pregunta_calificadora').map(r => ({ ...r, _label: 'pregunta' })),
      ]),
    });
  } catch (e) { next(e); }
});

module.exports = router;
