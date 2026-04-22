/**
 * DMCloser — Growth Routes
 * Lead magnet links (ig.me con tracking) y export CSV.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// ─────────────────────────────────────────────────────────────────────────────
// MAGNET LINKS — URLs ig.me con tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/magnet-links?accountId=X
 * Lista los magnet links del usuario con clicks acumulados.
 */
router.get('/magnet-links', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const links = await db.find(db.magnetLinks, { account_id: accountId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Adjuntar contador de clicks
    const clicks = await db.find(db.linkClicks, { account_id: accountId });
    const countBySlug = {};
    for (const c of clicks) {
      countBySlug[c.slug] = (countBySlug[c.slug] || 0) + 1;
    }

    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.json(links.map(l => ({
      id:           l._id,
      slug:         l.slug,
      label:        l.label,
      source:       l.source,
      preset_text:  l.preset_text,
      clicks:       countBySlug[l.slug] || 0,
      createdAt:    l.createdAt,
      redirect_url: `${base}/go/${l.slug}`,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/growth/magnet-links
 * Crea un magnet link. Body: { accountId, label, source, preset_text }
 * El slug se genera automáticamente (hash corto).
 */
router.post('/magnet-links', async (req, res) => {
  try {
    const { accountId, label, source = 'bio', preset_text } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId y label requeridos' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    // Verificar que la cuenta tenga username
    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account?.ig_username) return res.status(400).json({ error: 'Cuenta sin username de Instagram' });

    // Generar slug corto y único
    const slug = Math.random().toString(36).slice(2, 8);

    const link = await db.insert(db.magnetLinks, {
      account_id:  accountId,
      ig_username: account.ig_username,
      slug,
      label:       String(label).slice(0, 80),
      source:      String(source).slice(0, 40),
      preset_text: preset_text ? String(preset_text).slice(0, 280) : null,
    });

    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      id:           link._id,
      slug:         link.slug,
      label:        link.label,
      source:       link.source,
      preset_text:  link.preset_text,
      clicks:       0,
      redirect_url: `${base}/go/${link.slug}`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/growth/magnet-links/:id
 */
router.delete('/magnet-links/:id', async (req, res) => {
  try {
    const link = await db.findOne(db.magnetLinks, { _id: req.params.id });
    if (!link) return res.status(404).json({ error: 'No encontrado' });
    if (link.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });
    await db.remove(db.magnetLinks, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT CSV de leads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/export-leads?accountId=X
 * Devuelve un CSV con todos los leads de la cuenta.
 */
router.get('/export-leads', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const leads = await db.find(db.leads, { account_id: accountId });
    const agents = await db.find(db.agents, { account_id: accountId });
    const agentById = {};
    for (const a of agents) agentById[a._id] = a.name;

    // Contar mensajes por lead (optimización: una sola pasada)
    const allMessages = await db.find(db.messages, {});
    const msgCountByLead = {};
    for (const m of allMessages) {
      msgCountByLead[m.lead_id] = (msgCountByLead[m.lead_id] || 0) + 1;
    }

    const rows = [
      ['ig_username', 'qualification', 'status', 'automation', 'agent',
       'is_converted', 'is_bypassed', 'message_count', 'first_contact', 'last_message_at']
    ];

    for (const l of leads) {
      rows.push([
        l.ig_username || '',
        l.qualification || '',
        l.status || '',
        l.automation || '',
        agentById[l.agent_id] || '',
        l.is_converted ? 'yes' : 'no',
        l.is_bypassed  ? 'yes' : 'no',
        msgCountByLead[l._id] || 0,
        l.createdAt || '',
        l.last_message_at || '',
      ]);
    }

    const csv = rows.map(row => row.map(cell => {
      const s = String(cell ?? '');
      // Escapar comillas y envolver si contiene separador/nueva línea/comillas
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',')).join('\n');

    const filename = `dmcloser-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM para que Excel abra bien los acentos
    res.send('\uFEFF' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS de follow-ups (para dashboard del usuario)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/followup-stats?accountId=X
 */
router.get('/followup-stats', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const all = await db.find(db.followups, { account_id: accountId });
    res.json({
      total:     all.length,
      sent:      all.filter(f => f.sent_at).length,
      pending:   all.filter(f => !f.sent_at && !f.cancelled).length,
      cancelled: all.filter(f => f.cancelled).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
