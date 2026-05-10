/**
 * Atinov — Lead Magnets
 *
 * Son "ganchos" que el bot ofrece a leads que mostraron interés pero no están
 * listos para comprar: PDF, guía, caso de éxito, audio, diagnóstico gratis, etc.
 * El bot los ofrece a cambio del email del lead (captura).
 *
 * A diferencia de `links` (que son URLs genéricas que el bot comparte en
 * conversación) o `magnetLinks` (URLs ig.me con tracking para la bio), los
 * lead magnets tienen:
 *  - un "trigger_intent" (cuándo ofrecerlo: objeción, interés tibio, precio)
 *  - un "delivery" (cómo se le hace llegar al lead: email, DM directo, link)
 *  - contador de conversiones (cuántos dieron el email por este magnet)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { enforceLeadMagnets } = require('../middleware/checkPlanLimits');

// Los triggers posibles — le dicen al bot CUÁNDO ofrecer cada magnet
const VALID_TRIGGERS = ['pricing_objection', 'not_ready', 'cold_lead', 'diagnostic', 'info_request', 'generic'];
const VALID_DELIVERY = ['email', 'dm', 'link'];

/**
 * GET /api/lead-magnets?accountId=X
 * Lista los lead magnets con métricas de conversión.
 */
router.get('/', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Prohibido' });
    }

    const magnets = await db.find(db.leadMagnets, { account_id: accountId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Contadores de entregas por magnet
    const deliveries = await db.find(db.magnetDeliveries, { account_id: accountId });
    const byMagnet = {};
    for (const d of deliveries) {
      byMagnet[d.magnet_id] = (byMagnet[d.magnet_id] || 0) + 1;
    }

    res.json(magnets.map(m => ({
      id:             m._id,
      title:          m.title,
      description:    m.description,
      trigger_intent: m.trigger_intent,
      delivery:       m.delivery,
      delivery_url:   m.delivery_url,
      pitch:          m.pitch,
      enabled:        m.enabled !== false,
      deliveries:     byMagnet[m._id] || 0,
      createdAt:      m.createdAt,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/lead-magnets
 * Body: { accountId, title, description, pitch, trigger_intent, delivery, delivery_url }
 *   - title: nombre corto interno ("Guía 7 errores")
 *   - description: qué recibe el lead ("PDF de 12 págs con...")
 *   - pitch: frase que el bot usa para ofrecerlo al lead
 *   - trigger_intent: cuándo ofrecerlo (pricing_objection, not_ready, cold_lead, diagnostic, info_request, generic)
 *   - delivery: email | dm | link
 *   - delivery_url: URL del recurso (Drive, Dropbox, página, etc.)
 */
router.post('/', enforceLeadMagnets, async (req, res) => {
  try {
    const { accountId, title, description, pitch, trigger_intent, delivery, delivery_url } = req.body;
    if (!accountId || !title) return res.status(400).json({ error: 'accountId y title requeridos' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const trigger = VALID_TRIGGERS.includes(trigger_intent) ? trigger_intent : 'generic';
    const delType = VALID_DELIVERY.includes(delivery) ? delivery : 'email';

    const magnet = await db.insert(db.leadMagnets, {
      account_id:     accountId,
      title:          String(title).slice(0, 120),
      description:    description ? String(description).slice(0, 500) : '',
      pitch:          pitch ? String(pitch).slice(0, 300) : '',
      trigger_intent: trigger,
      delivery:       delType,
      delivery_url:   delivery_url ? String(delivery_url).slice(0, 500) : '',
      enabled:        true,
    });

    res.json({ id: magnet._id, ...magnet });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/lead-magnets/:id
 * Body: campos parciales para actualizar.
 */
router.patch('/:id', async (req, res) => {
  try {
    const magnet = await db.findOne(db.leadMagnets, { _id: req.params.id });
    if (!magnet) return res.status(404).json({ error: 'No encontrado' });
    if (magnet.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const upd = {};
    if (typeof req.body.title === 'string') upd.title = req.body.title.slice(0, 120);
    if (typeof req.body.description === 'string') upd.description = req.body.description.slice(0, 500);
    if (typeof req.body.pitch === 'string') upd.pitch = req.body.pitch.slice(0, 300);
    if (VALID_TRIGGERS.includes(req.body.trigger_intent)) upd.trigger_intent = req.body.trigger_intent;
    if (VALID_DELIVERY.includes(req.body.delivery)) upd.delivery = req.body.delivery;
    if (typeof req.body.delivery_url === 'string') upd.delivery_url = req.body.delivery_url.slice(0, 500);
    if (typeof req.body.enabled === 'boolean') upd.enabled = req.body.enabled;

    await db.update(db.leadMagnets, { _id: req.params.id }, upd);
    res.json({ ok: true, ...upd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/lead-magnets/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const magnet = await db.findOne(db.leadMagnets, { _id: req.params.id });
    if (!magnet) return res.status(404).json({ error: 'No encontrado' });
    if (magnet.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });
    await db.remove(db.leadMagnets, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/lead-magnets/:id/deliveries
 * Lista las entregas (leads que pidieron este magnet).
 */
router.get('/:id/deliveries', async (req, res) => {
  try {
    const magnet = await db.findOne(db.leadMagnets, { _id: req.params.id });
    if (!magnet) return res.status(404).json({ error: 'No encontrado' });
    if (magnet.account_id !== req.user.accountId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Prohibido' });
    }

    const rows = await db.find(db.magnetDeliveries, { magnet_id: req.params.id },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
