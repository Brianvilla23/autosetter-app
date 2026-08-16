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

/**
 * GET /api/llamadas/gasto?dias=30
 * Dashboard de gasto de voz: serie por DÍA (hora Chile), agregados de hoy /
 * esta semana / este mes, valor real del minuto y desglose por vía
 * (teléfono vs WhatsApp). Todo sale de db.llamadas — no consulta a Twilio ni
 * a OpenAI, así que es instantáneo y no gasta.
 *
 * "Valor del minuto" = costo estimado total / minutos conectados. Es la
 * cifra que el dueño compara contra lo que le cobra el plan.
 */
router.get('/gasto', async (req, res, next) => {
  try {
    const accountId = req.user.accountId;
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 7), 90);
    const desde = new Date(Date.now() - dias * 86400e3);
    const todas = await db.find(db.llamadas, { account_id: accountId });
    const conectadas = todas.filter(l => l.status === 'terminada' && new Date(l.createdAt) >= desde);

    const TZ = 'America/Santiago';
    const fechaCL = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
    const hoy = fechaCL(new Date());
    const mes = hoy.slice(0, 7);
    // Lunes de esta semana (hora Chile)
    const ahoraCL = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    const dow = (ahoraCL.getDay() + 6) % 7; // lunes=0
    const lunes = new Date(ahoraCL); lunes.setDate(ahoraCL.getDate() - dow); lunes.setHours(0, 0, 0, 0);
    const lunesStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(lunes);

    const agg = (arr) => {
      const seg = arr.reduce((s, l) => s + (l.duracion_seg || 0), 0);
      const usd = arr.reduce((s, l) => s + (l.costo_usd?.total_est || 0), 0);
      const min = seg / 60;
      return {
        llamadas: arr.length,
        minutos: Number(min.toFixed(1)),
        costo_usd: Number(usd.toFixed(2)),
        usd_por_min: min > 0 ? Number((usd / min).toFixed(3)) : null,
      };
    };

    // Serie diaria completa (con ceros) para graficar sin huecos
    const porDia = {};
    for (let i = dias - 1; i >= 0; i--) {
      porDia[fechaCL(new Date(Date.now() - i * 86400e3))] = [];
    }
    for (const l of conectadas) {
      const k = l.fecha_chile || fechaCL(l.createdAt);
      if (porDia[k]) porDia[k].push(l);
    }
    const serie = Object.entries(porDia).map(([fecha, arr]) => ({ fecha, ...agg(arr) }));

    const deHoy    = conectadas.filter(l => (l.fecha_chile || fechaCL(l.createdAt)) === hoy);
    const deSemana = conectadas.filter(l => (l.fecha_chile || fechaCL(l.createdAt)) >= lunesStr);
    const deMes    = conectadas.filter(l => (l.fecha_chile || fechaCL(l.createdAt)).startsWith(mes));

    const { USD_MIN_TWILIO_MOVIL, USD_MIN_OPENAI_EST } = require('../services/telefonia');
    res.json({
      dias,
      hoy:    { fecha: hoy, ...agg(deHoy) },
      semana: { desde: lunesStr, ...agg(deSemana) },
      mes:    { mes, ...agg(deMes) },
      periodo: agg(conectadas),
      por_via: {
        telefono: agg(conectadas.filter(l => (l.via || 'telefono') === 'telefono')),
        whatsapp: agg(conectadas.filter(l => l.via === 'whatsapp')),
      },
      tarifa_referencia: {
        twilio_usd_min: USD_MIN_TWILIO_MOVIL,
        openai_usd_min_est: USD_MIN_OPENAI_EST,
        total_usd_min_est: Number((USD_MIN_TWILIO_MOVIL + USD_MIN_OPENAI_EST).toFixed(4)),
        nota: 'Twilio factura por minuto redondeado hacia arriba; OpenAI es estimación media (US$0.02-0.06/min).',
      },
      no_contestadas_periodo: todas.filter(l => l.status === 'no_contesto' && new Date(l.createdAt) >= desde).length,
      serie,
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
    via: ll.via || 'telefono',
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
