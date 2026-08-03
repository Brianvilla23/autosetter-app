/**
 * Atinov — Rutas de Google Calendar
 *
 * router (con requireAuth en server.js):
 *   GET  /api/calendar/connect    → { url } para iniciar el consent de Google
 *   GET  /api/calendar/status     → { configured, connected, connected_at }
 *   POST /api/calendar/disconnect → revoca y limpia el refresh_token
 *
 * handleOAuthCallback (SIN requireAuth — se monta aparte en server.js):
 *   GET  /api/calendar/callback   → viene del redirect de Google; la
 *   seguridad es el `state` firmado con HMAC(JWT_SECRET) y con expiry.
 *
 * Todo es inerte sin GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET en el entorno.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const cal     = require('../services/calendar');

/** GET /api/calendar/connect — URL de consent para la cuenta del usuario. */
router.get('/connect', async (req, res) => {
  try {
    if (!cal.isConfigured()) {
      return res.status(400).json({
        error: 'Google Calendar no está configurado en el servidor (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).',
      });
    }
    const accountId = req.user.accountId;
    if (!accountId) return res.status(400).json({ error: 'cuenta no resuelta desde la sesión' });
    res.json({ url: cal.getAuthUrl(accountId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/calendar/status */
router.get('/status', async (req, res) => {
  try {
    const settings = await db.findOne(db.settings, { account_id: req.user.accountId });
    res.json({
      configured: cal.isConfigured(),
      connected: !!settings?.google_refresh_token,
      connected_at: settings?.google_connected_at || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/calendar/disconnect */
router.post('/disconnect', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const settings = await db.findOne(db.settings, { account_id: accountId });
    if (settings?.google_refresh_token) {
      // Revocación best-effort: aunque falle, limpiamos local (fail-closed).
      try {
        const axios = require('axios');
        await axios.post('https://oauth2.googleapis.com/revoke', null, {
          params: { token: settings.google_refresh_token }, timeout: 10000,
        });
      } catch (e) { /* revocación best-effort */ }
      await db.update(db.settings, { account_id: accountId }, {
        google_refresh_token: null, google_connected_at: null,
      });
    }
    cal.clearAccountCache(accountId); // sin esto, el token viejo sirve hasta 1h
    res.json({ ok: true, connected: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Callback del consent de Google (público — protegido por el state firmado).
 * Todos los paths responden una página mínima que redirige a /app.
 */
async function handleOAuthCallback(req, res) {
  // El flujo llega navegando en la MISMA pestaña desde el dashboard, así que
  // TODOS los paths (éxito y error) devuelven una página que redirige a /app —
  // nunca dejar al dueño varado en texto plano fuera de su panel.
  const page = (titulo, cuerpo, status = 200) => res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8').send(
    `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title></head>` +
    `<body style="font-family:sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><h2>${titulo}</h2><p>${cuerpo}</p>` +
    `<p style="opacity:.6;font-size:14px">Volviendo a tu panel…</p></div>` +
    `<script>setTimeout(()=>{window.location.href='/app'},2500)</script></body></html>`
  );
  try {
    if (!cal.isConfigured()) return page('No disponible', 'Google Calendar no está configurado en el servidor.', 400);
    const { code, state, error } = req.query;
    if (error) return page('Conexión cancelada', 'Cerraste el permiso de Google. Puedes intentarlo de nuevo desde Configuración.');
    if (!code || !state) return page('Faltan parámetros', 'Reintenta la conexión desde Configuración.', 400);

    const accountId = cal.verifyState(state);
    if (!accountId) return page('El permiso expiró', 'Pasaron más de 10 minutos — reintenta la conexión desde Configuración.', 400);

    const cuenta = await db.findOne(db.accounts, { _id: accountId });
    if (!cuenta) return page('Cuenta no encontrada', 'Reintenta la conexión desde Configuración.', 404);

    const tokens = await cal.exchangeCode(String(code));
    if (!tokens?.refresh_token) {
      return page('Falta un permiso', 'Google no entregó el acceso permanente. Reintenta y acepta todos los permisos.', 400);
    }

    const existing = await db.findOne(db.settings, { account_id: accountId });
    const campos = {
      google_refresh_token: tokens.refresh_token,
      // No pisar un calendar_id configurado a mano en una reconexión
      google_calendar_id: existing?.google_calendar_id || 'primary',
      google_connected_at: new Date().toISOString(),
    };
    if (existing) await db.update(db.settings, { account_id: accountId }, campos);
    else await db.insert(db.settings, { account_id: accountId, openai_key: '', ...campos });

    // Si había otro Google conectado, su token cacheado NO puede sobrevivir:
    // seguiría leyendo/escribiendo el calendario anterior hasta 1h.
    cal.clearAccountCache(accountId);
    console.log(`📅 Google Calendar conectado para cuenta ${accountId}`);
    return page('✅ Calendario conectado', 'Tu agente ya puede ver tu disponibilidad y agendar citas reales.');
  } catch (e) {
    console.error('[agenda] callback OAuth falló:', e.response?.data || e.message);
    return page('Error al conectar', 'No se pudo completar la conexión — reintenta desde Configuración.', 500);
  }
}

module.exports = { router, handleOAuthCallback };
