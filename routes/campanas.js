/**
 * Atinov — Rutas de campañas segmentadas (broadcast por WhatsApp)
 *
 * Montado en server.js: /api/campanas con apiLimiter + requireAuth +
 * checkSubscription (mismo riel que wa-templates). Tenant isolation por JWT.
 *
 *   GET  /api/campanas           → lista con estados y estadísticas
 *   POST /api/campanas/estimar   → cuántos destinatarios tiene un segmento HOY
 *   POST /api/campanas           → crear (programada; "ahora" si no trae fecha)
 *   POST /api/campanas/:id/cancelar
 *
 * El gasto real (plantillas de Meta + cuota del plan) lo gobierna el worker
 * con el cap por contacto compartido con el playbook — ver services/campanas.js.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const svc     = require('../services/campanas');

function assertOwnsAccount(req, accountId) {
  return accountId && req.user && req.user.accountId === accountId;
}

router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const lista = (await db.find(db.campanas, { account_id: accountId }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 50)
      .map(c => ({
        id: c._id, nombre: c.nombre, estado: c.estado,
        template_name: c.template_name, segmento: c.segmento,
        scheduled_for: c.scheduled_for, estimado: c.estimado,
        total_snapshot: c.destinatarios?.length ?? null,
        stats: c.stats, nota: c.nota || null, createdAt: c.createdAt,
      }));
    res.json({ campanas: lista });
  } catch (e) { next(e); }
});

router.post('/estimar', async (req, res, next) => {
  try {
    const { accountId, segmento } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const leads = await svc.leadsDeSegmento(accountId, segmento || {});
    res.json({
      destinatarios: Math.min(leads.length, svc.MAX_DESTINATARIOS),
      sin_tope: leads.length,
      tope: svc.MAX_DESTINATARIOS,
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { accountId, nombre, templateName, templateLang, segmento, scheduledFor, conNombre } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const r = await svc.crearCampana({ accountId, nombre, templateName, templateLang, segmento, scheduledFor, conNombre });
    if (!r.ok) return res.status(400).json({ error: r.error });
    await db.insert(db.auditLog, {
      action: 'campana_create', account_id: accountId, target: r.campana.nombre,
      detail: { estimado: r.campana.estimado, template: r.campana.template_name },
      actor: req.user.email || req.user.userId, at: new Date().toISOString(),
    }).catch(() => null);
    res.json({ ok: true, campana: { id: r.campana._id, ...r.campana } });
  } catch (e) { next(e); }
});

router.post('/:id/cancelar', async (req, res, next) => {
  try {
    const { accountId } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const r = await svc.cancelarCampana(req.params.id, accountId);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;
