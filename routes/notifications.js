/**
 * DMCloser — Notifications Routes
 *
 * GET  /api/notifications         → lee la config del usuario
 * PUT  /api/notifications         → guarda la config
 * POST /api/notifications/test    → envía notificación de prueba (body: { channel })
 *
 * Canales soportados: 'email' | 'whatsapp' | 'webhook'
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { sendTestNotification } = require('../services/notifications');

// Schema por defecto
function defaultConfig() {
  return {
    email_enabled:     true,
    email_address:     '',
    whatsapp_enabled:  false,
    whatsapp_number:   '',   // E.164 sin "+" (ej: 56912345678)
    whatsapp_apikey:   '',
    webhook_enabled:   false,
    webhook_url:       '',
  };
}

// ─── GET /api/notifications ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const user = await db.findOne(db.users, { _id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const config = { ...defaultConfig(), ...(user.notifications || {}) };
    res.json({ config });
  } catch (e) {
    console.error('GET /notifications error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// ─── PUT /api/notifications ──────────────────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = [
      'email_enabled', 'email_address',
      'whatsapp_enabled', 'whatsapp_number', 'whatsapp_apikey',
      'webhook_enabled', 'webhook_url',
    ];
    const notifications = {};
    for (const k of allowed) {
      if (k in body) notifications[k] = body[k];
    }

    // Sanitizar phone: quitar no-dígitos
    if (notifications.whatsapp_number) {
      notifications.whatsapp_number = String(notifications.whatsapp_number).replace(/[^0-9]/g, '');
    }
    // Validar URL webhook si existe
    if (notifications.webhook_url) {
      const url = String(notifications.webhook_url).trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'webhook_url debe empezar con http:// o https://' });
      }
      notifications.webhook_url = url;
    }

    const user = await db.findOne(db.users, { _id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const merged = { ...defaultConfig(), ...(user.notifications || {}), ...notifications };
    await db.update(db.users, { _id: req.user.userId }, { notifications: merged });

    res.json({ ok: true, config: merged });
  } catch (e) {
    console.error('PUT /notifications error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// ─── POST /api/notifications/test ────────────────────────────────────────────
router.post('/test', async (req, res) => {
  try {
    const { channel } = req.body || {};
    if (!['email', 'whatsapp', 'webhook'].includes(channel)) {
      return res.status(400).json({ error: 'channel inválido' });
    }
    const result = await sendTestNotification({ userId: req.user.userId, channel });
    res.json(result);
  } catch (e) {
    console.error('POST /notifications/test error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
