/**
 * Atinov — Historial de llamadas telefónicas de la cuenta
 *
 * Solo lectura: la llamada se dispara desde la conversación (marcador
 * [LLAMAR:] con consentimiento), nunca desde un endpoint. Acá el dueño ve
 * qué llamadas hubo, cuánto duraron, qué costaron y la transcripción.
 *
 * Montado en server.js con apiLimiter + requireAuth + checkSubscription.
 * Tenant isolation: todo sale filtrado por el accountId del JWT.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// GET /api/llamadas — últimas llamadas de la cuenta + totales del mes
router.get('/', async (req, res, next) => {
  try {
    const accountId = req.user.accountId;
    const llamadas = await db.find(db.llamadas, { account_id: accountId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const mes = new Date().toISOString().slice(0, 7);
    const delMes = llamadas.filter(l => (l.createdAt || '').startsWith(mes));
    const conectadas = delMes.filter(l => l.status === 'terminada');

    res.json({
      llamadas: llamadas.slice(0, 100).map(resumir),
      totales_mes: {
        mes,
        total: delMes.length,
        conectadas: conectadas.length,
        no_contestadas: delMes.filter(l => l.status === 'no_contesto').length,
        minutos: Math.round(conectadas.reduce((s, l) => s + (l.duracion_seg || 0), 0) / 60),
        costo_usd_est: Number(conectadas.reduce((s, l) => s + (l.costo_usd?.total_est || 0), 0).toFixed(2)),
      },
    });
  } catch (e) { next(e); }
});

// GET /api/llamadas/:id — detalle con transcripción completa
router.get('/:id', async (req, res, next) => {
  try {
    const ll = await db.findOne(db.llamadas, { _id: req.params.id });
    if (!ll || ll.account_id !== req.user.accountId) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ...resumir(ll), transcript: Array.isArray(ll.transcript) ? ll.transcript : [] });
  } catch (e) { next(e); }
});

/** Vista segura: sin ws_lock ni tokens internos, teléfono parcialmente oculto. */
function resumir(ll) {
  return {
    id: ll._id,
    lead_id: ll.lead_id,
    status: ll.status,
    telefono: enmascarar(ll.telefono),
    tema: ll.tema || null,
    dial_at: ll.dial_at || null,
    answered_at: ll.answered_at || null,
    ended_at: ll.ended_at || null,
    duracion_seg: ll.duracion_seg || 0,
    costo_usd: ll.costo_usd || null,
    consent_texto: ll.consent_texto || null,
    consent_at: ll.consent_at || null,
    error: ll.error || null,
    createdAt: ll.createdAt,
  };
}

/** +56912345678 → +56•••••678 (el número completo vive solo en el servidor). */
function enmascarar(tel) {
  const s = String(tel || '');
  if (s.length < 7) return s ? '•••' : null;
  return s.slice(0, 3) + '•'.repeat(Math.max(3, s.length - 6)) + s.slice(-3);
}

module.exports = router;
