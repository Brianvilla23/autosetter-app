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
 * Responde una página mínima que se cierra sola.
 */
async function handleOAuthCallback(req, res) {
  const page = (titulo, cuerpo) => res.set('Content-Type', 'text/html; charset=utf-8').send(
    `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title></head>` +
    `<body style="font-family:sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><h2>${titulo}</h2><p>${cuerpo}</p></div>` +
    `<script>setTimeout(()=>{try{window.close()}catch(e){}},4000)</script></body></html>`
  );
  try {
    if (!cal.isConfigured()) return res.status(400).send('Google Calendar no configurado');
    const { code, state, error } = req.query;
    if (error) return page('Conexión cancelada', 'Cerraste el permiso de Google. Puedes intentarlo de nuevo desde Atinov.');
    if (!code || !state) return res.status(400).send('Faltan parámetros');

    const accountId = cal.verifyState(state);
    if (!accountId) return res.status(400).send('State inválido o expirado — reintenta desde Atinov');

    const cuenta = await db.findOne(db.accounts, { _id: accountId });
    if (!cuenta) return res.status(404).send('Cuenta no encontrada');

    const tokens = await cal.exchangeCode(String(code));
    if (!tokens?.refresh_token) {
      return page('Falta un permiso', 'Google no entregó el acceso permanente. Reintenta y acepta todos los permisos.');
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
    return page('✅ Calendario conectado', 'Tu agente ya puede agendar citas reales. Puedes cerrar esta ventana.');
  } catch (e) {
    console.error('[agenda] callback OAuth falló:', e.response?.data || e.message);
    return res.status(500).send('Error conectando el calendario — reintenta desde Atinov');
  }
}

module.exports = { router, handleOAuthCallback };
