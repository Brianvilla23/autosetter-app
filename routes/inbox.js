/**
 * DMCloser — Inbox unificado
 *
 * Vista tipo mensajería: lista de conversaciones con preview, badges,
 * filtros (HOT, sin leer, bypassed) y unread count.
 *
 * Reusa los endpoints existentes de /api/leads para enviar mensajes,
 * tomar/devolver control y ver el thread completo. Acá solo agrego:
 *   GET  /api/inbox?accountId=X&filter=...&search=...&limit=N → lista
 *   POST /api/inbox/:leadId/read                              → marcar leído
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

const VALID_FILTERS = ['all', 'hot', 'warm', 'cold', 'unread', 'bypassed', 'converted'];

/**
 * GET /api/inbox?accountId=X&filter=all|hot|warm|cold|unread|bypassed|converted&search=user&limit=100
 * Devuelve la lista de conversaciones con metadata para mostrar como inbox.
 *
 * Cada item incluye:
 *   - Información del lead (id, ig_username, qualification, etc.)
 *   - Último mensaje (preview, role, when)
 *   - unread (true si el último mensaje del lead es posterior a read_at)
 *   - messageCount total de mensajes
 *
 * Performance: 1 query por colección, todo el merging en memoria.
 * Para SaaS chico (cuentas con <10k leads) es suficiente.
 */
router.get('/', async (req, res) => {
  try {
    const { accountId, filter = 'all', search } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Prohibido' });
    }
    if (filter && !VALID_FILTERS.includes(filter)) {
      return res.status(400).json({ error: `filter debe ser uno de: ${VALID_FILTERS.join(', ')}` });
    }

    let leads = await db.find(db.leads, { account_id: accountId });

    // Filtros
    if (filter === 'hot' || filter === 'warm' || filter === 'cold') {
      leads = leads.filter(l => l.qualification === filter);
    } else if (filter === 'bypassed') {
      leads = leads.filter(l => l.is_bypassed);
    } else if (filter === 'converted') {
      leads = leads.filter(l => l.is_converted);
    }
    // (unread se calcula después de hidratar últimos mensajes)

    if (search) {
      const q = String(search).replace('@', '').toLowerCase();
      leads = leads.filter(l => (l.ig_username || '').toLowerCase().includes(q));
    }

    if (!leads.length) {
      return res.json({ items: [], total: 0, unreadCount: 0 });
    }

    // Cargar TODOS los mensajes de los leads filtrados de una vez y agrupar.
    // Para evitar N queries.
    const leadIds = leads.map(l => l._id);
    const allMessages = await db.find(db.messages, {});
    const messagesByLead = {};
    for (const m of allMessages) {
      if (!leadIds.includes(m.lead_id)) continue;
      (messagesByLead[m.lead_id] = messagesByLead[m.lead_id] || []).push(m);
    }
    // Ordenar mensajes por fecha asc y dejar solo el último de cada lead
    for (const id of leadIds) {
      const arr = messagesByLead[id] || [];
      arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      messagesByLead[id] = arr;
    }

    // Hidratar items
    let items = leads.map(l => {
      const msgs = messagesByLead[l._id] || [];
      const last = msgs[msgs.length - 1] || null;
      const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user');
      const readAt = l.read_at ? new Date(l.read_at).getTime() : 0;
      const unread = !!(lastUserMsg && new Date(lastUserMsg.createdAt).getTime() > readAt);

      return {
        id:             l._id,
        ig_username:    l.ig_username,
        ig_user_id:     l.ig_user_id,
        qualification: l.qualification || null,
        qualification_reason: l.qualification_reason || null,
        is_bypassed:   !!l.is_bypassed,
        is_converted:  !!l.is_converted,
        automation:    l.automation || 'automated',
        agent_id:      l.agent_id || null,
        last_message_at: l.last_message_at || l.createdAt,
        last_message: last ? {
          role:    last.role,
          preview: String(last.content || '').slice(0, 120),
          when:    last.createdAt,
        } : null,
        message_count: msgs.length,
        unread,
        email:         l.email || null,
      };
    });

    if (filter === 'unread') {
      items = items.filter(i => i.unread);
    }

    // Ordenar por actividad reciente
    items.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));

    const unreadCount = items.filter(i => i.unread).length;
    const sliced = items.slice(0, limit);

    res.json({ items: sliced, total: items.length, unreadCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/inbox/:leadId/read
 * Marca la conversación como leída (read_at = now).
 */
router.post('/:leadId/read', async (req, res) => {
  try {
    const lead = await db.findOne(db.leads, { _id: req.params.leadId });
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
    if (lead.account_id !== req.user.accountId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Prohibido' });
    }
    await db.update(db.leads, { _id: req.params.leadId }, { read_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/inbox/counters?accountId=X
 * Devuelve solo los contadores por filtro para badges del UI.
 * Más liviano que cargar todos los items.
 */
router.get('/counters', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Prohibido' });
    }

    const leads = await db.find(db.leads, { account_id: accountId });
    const messages = await db.find(db.messages, {});
    const leadIds = new Set(leads.map(l => l._id));
    const lastUserByLead = {};
    for (const m of messages) {
      if (!leadIds.has(m.lead_id) || m.role !== 'user') continue;
      const prev = lastUserByLead[m.lead_id];
      if (!prev || new Date(m.createdAt) > new Date(prev.createdAt)) {
        lastUserByLead[m.lead_id] = m;
      }
    }

    let unread = 0;
    for (const l of leads) {
      const lastUser = lastUserByLead[l._id];
      if (!lastUser) continue;
      const readAt = l.read_at ? new Date(l.read_at).getTime() : 0;
      if (new Date(lastUser.createdAt).getTime() > readAt) unread++;
    }

    res.json({
      all:       leads.length,
      unread,
      hot:       leads.filter(l => l.qualification === 'hot').length,
      warm:      leads.filter(l => l.qualification === 'warm').length,
      cold:      leads.filter(l => l.qualification === 'cold').length,
      bypassed:  leads.filter(l => l.is_bypassed).length,
      converted: leads.filter(l => l.is_converted).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
