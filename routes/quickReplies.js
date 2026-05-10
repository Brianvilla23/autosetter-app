/**
 * Atinov — Quick Replies (Plantillas de respuesta rápida)
 *
 * Permite al dueño guardar respuestas frecuentes ("info de envío",
 * "horarios", "link de pago") y aplicarlas con un click desde el inbox
 * cuando toma control de una conversación.
 *
 * Variables soportadas en el template (se reemplazan al insertar):
 *   {nombre}    → @ig_username del lead
 *   {agente}    → nombre del agente activo
 *   {primernombre} → primera palabra de ig_username (heurística)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

/**
 * GET /api/quick-replies?accountId=X
 * Lista todas las plantillas del account, ordenadas por sortOrder y luego createdAt.
 */
router.get('/', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Prohibido' });
    }

    const items = await db.find(db.quickReplies, { account_id: accountId },
      (a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || (a.createdAt || '').localeCompare(b.createdAt || ''));

    res.json(items.map(q => ({
      id:        q._id,
      title:     q.title,
      content:   q.content,
      shortcut:  q.shortcut || null,
      sortOrder: q.sortOrder ?? 0,
      uses:      q.uses || 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/quick-replies
 * Body: { accountId, title, content, shortcut?, sortOrder? }
 */
router.post('/', async (req, res) => {
  try {
    const { accountId, title, content, shortcut, sortOrder } = req.body;
    if (!accountId || !title || !content) {
      return res.status(400).json({ error: 'accountId, title y content requeridos' });
    }
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const item = await db.insert(db.quickReplies, {
      account_id: accountId,
      title:      String(title).slice(0, 80),
      content:    String(content).slice(0, 1000),
      shortcut:   shortcut ? String(shortcut).slice(0, 20) : null,
      sortOrder:  Number.isFinite(parseInt(sortOrder)) ? parseInt(sortOrder) : 0,
      uses:       0,
    });

    res.json({ id: item._id, ...item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/quick-replies/:id
 */
router.patch('/:id', async (req, res) => {
  try {
    const item = await db.findOne(db.quickReplies, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: 'No encontrado' });
    if (item.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const upd = {};
    if (typeof req.body.title === 'string')    upd.title    = req.body.title.slice(0, 80);
    if (typeof req.body.content === 'string')  upd.content  = req.body.content.slice(0, 1000);
    if (typeof req.body.shortcut === 'string') upd.shortcut = req.body.shortcut.slice(0, 20) || null;
    if (req.body.shortcut === null)            upd.shortcut = null;
    if (Number.isFinite(parseInt(req.body.sortOrder))) upd.sortOrder = parseInt(req.body.sortOrder);

    await db.update(db.quickReplies, { _id: req.params.id }, upd);
    res.json({ ok: true, ...upd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/quick-replies/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const item = await db.findOne(db.quickReplies, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: 'No encontrado' });
    if (item.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });
    await db.remove(db.quickReplies, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/quick-replies/:id/used
 * Incrementa el contador de uso (analytics: cuál se usa más).
 */
router.post('/:id/used', async (req, res) => {
  try {
    const item = await db.findOne(db.quickReplies, { _id: req.params.id });
    if (!item) return res.status(404).json({ error: 'No encontrado' });
    if (item.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });
    await db.update(db.quickReplies, { _id: req.params.id }, { uses: (item.uses || 0) + 1 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
