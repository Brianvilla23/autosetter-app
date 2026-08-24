/**
 * Atinov — API del copiloto del panel
 *
 * El chat interno del dueño. Va SIN checkSubscription a propósito: una cuenta
 * con la suscripción vencida es justo la que más necesita preguntar qué pasó y
 * cómo arreglarlo. Dejarla sin ayuda solo empeora la cancelación.
 */

const express = require('express');
const router  = express.Router();
const copiloto = require('../services/copiloto');

/** El accountId sale del token, nunca del body: nadie consulta cuenta ajena. */
function cuentaDelToken(req) {
  return req.user?.accountId || null;
}

/**
 * POST /api/copiloto/chat
 * Body: { mensaje, historial? }
 */
router.post('/chat', async (req, res, next) => {
  try {
    const accountId = cuentaDelToken(req);
    if (!accountId) return res.status(400).json({ error: 'Tu sesión no tiene una cuenta asociada.' });

    const { mensaje, historial } = req.body || {};
    const r = await copiloto.responder({ accountId, mensaje, historial });
    if (!r.ok) return res.status(400).json({ error: r.error });

    res.json({ ok: true, respuesta: r.respuesta, usadas: r.usadas, tope: r.tope });
  } catch (e) { next(e); }
});

/**
 * GET /api/copiloto/estado
 * El mismo estado que ve el copiloto, para que el panel pueda mostrar los
 * avisos sin gastar una consulta al modelo.
 */
router.get('/estado', async (req, res, next) => {
  try {
    const accountId = cuentaDelToken(req);
    if (!accountId) return res.status(400).json({ error: 'Tu sesión no tiene una cuenta asociada.' });

    const estado = await copiloto.estadoDeCuenta(accountId);
    if (!estado) return res.status(404).json({ error: 'Cuenta no encontrada.' });

    const { diagnosticar } = require('../services/copilotoConocimiento');
    res.json({ ok: true, estado, hallazgos: diagnosticar(estado) });
  } catch (e) { next(e); }
});

module.exports = router;
