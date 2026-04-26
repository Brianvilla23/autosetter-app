const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const db      = require('../db/database');
const { SECRET } = require('../middleware/authMiddleware');

const APP_ID     = process.env.META_APP_ID     || '';
const APP_SECRET = process.env.META_APP_SECRET || '';

// ── Auth helper ─────────────────────────────────────────────────────────────
// El flow OAuth se inicia con un GET del browser tras click en "Conectar IG".
// El SPA no puede agregar Authorization header a un redirect, así que el JWT
// viaja como query param `?token=...`. Si está presente y es válido lo usamos
// para la validación CSRF (state ↔ userId).
function authFromTokenParam(req) {
  const token = req.query.token;
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// ── OAuth State Store (in-memory, 5 min TTL) ─────────────────────────────────
// Map state → { accountId, userId, expiresAt }. Para 20 testers in-memory está
// bien — no hace falta Redis. Limpieza pasiva al validar + sweep cada 10 min.
const oauthStates = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

function generateState({ accountId, userId }) {
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, {
    accountId,
    userId,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  return state;
}

function consumeState(state) {
  const entry = oauthStates.get(state);
  if (!entry) return null;
  oauthStates.delete(state); // one-time use, siempre borrar
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// Sweep periódico para no acumular states abandonados
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates.entries()) {
    if (v.expiresAt < now) oauthStates.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

// ── Step 1: Redirect user to Instagram Business Login OAuth ──────────────────
// El SPA debe llamar con `?token=<JWT>&accountId=<id>` para que podamos atar
// el state CSRF al userId. El callback luego valida que el state existe,
// no expiró, y devuelve el accountId correcto.
router.get('/instagram', (req, res) => {
  const auth = authFromTokenParam(req);
  if (!auth) {
    return res.redirect('/?auth=error&msg=' + encodeURIComponent('Sesión inválida — re-iniciá sesión y reintentá conectar Instagram'));
  }

  const { accountId } = req.query;
  if (!APP_ID) return res.redirect('/?auth=error&msg=' + encodeURIComponent('Para conectar Instagram necesitas configurar META_APP_ID y META_APP_SECRET en el archivo .env. Consulta el tutorial en Settings.'));

  // Validar que el accountId pertenece al user actual
  const targetAccountId = accountId || auth.accountId;
  if (targetAccountId !== auth.accountId) {
    return res.status(403).send('forbidden');
  }

  const redirectUri = `${process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`}/auth/callback`;
  const scope = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';

  // Generar state CSRF token (uno solo, válido 5 min, single-use)
  const state = generateState({ accountId: targetAccountId, userId: auth.userId });

  const url = `https://www.instagram.com/oauth/authorize?` +
    `client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&response_type=code` +
    `&state=${state}`;

  res.redirect(url);
});

// ── Step 2: Instagram redirects back with code ───────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect('/?auth=error&msg=' + encodeURIComponent(req.query.error_description || error));
  if (!code)  return res.redirect('/?auth=error&msg=no_code');
  if (!state) return res.redirect('/?auth=error&msg=' + encodeURIComponent('Falta state — posible CSRF, reintentá el flow'));

  // Validar state CSRF (one-time, 5 min TTL)
  const entry = consumeState(state);
  if (!entry) {
    console.warn('[AUTH] state inválido o expirado:', state);
    return res.redirect('/?auth=error&msg=' + encodeURIComponent('State inválido o expirado, reintentá conectar Instagram'));
  }
  const accountId = entry.accountId;

  try {
    const redirectUri = `${process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`}/auth/callback`;

    // Exchange code for short-lived token via Instagram API
    const tokenRes = await axios.post('https://api.instagram.com/oauth/access_token', new URLSearchParams({
      client_id:     APP_ID,
      client_secret: APP_SECRET,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
      code
    }));
    const shortToken = tokenRes.data.access_token;
    const igId       = String(tokenRes.data.user_id);

    // Exchange for long-lived token (60 days)
    const longRes = await axios.get('https://graph.instagram.com/access_token', {
      params: {
        grant_type:    'ig_exchange_token',
        client_secret: APP_SECRET,
        access_token:  shortToken
      }
    });
    const longToken = longRes.data.access_token;

    // Get IG username from Instagram Platform API
    const igRes = await axios.get('https://graph.instagram.com/me', {
      params: { fields: 'id,username,name', access_token: longToken }
    });
    const igUsername = igRes.data.username || igId;

    // Get the webhook-compatible ID from the Facebook Graph API.
    // graph.facebook.com/me returns the same ID that Instagram webhooks use in entry.id,
    // whereas graph.instagram.com/me returns a different app-scoped platform ID.
    let igIdFinal = igRes.data.id ? String(igRes.data.id) : igId;
    try {
      const fbRes = await axios.get('https://graph.facebook.com/v19.0/me', {
        params: { fields: 'id,username', access_token: longToken }
      });
      if (fbRes.data.id) igIdFinal = String(fbRes.data.id);
      console.log(`[AUTH] graph.facebook.com/me id=${fbRes.data.id} | graph.instagram.com/me id=${igRes.data.id} → using ${igIdFinal}`);
    } catch (fbErr) {
      console.log(`[AUTH] graph.facebook.com/me failed (${fbErr.message}), using instagram id=${igIdFinal}`);
    }

    // Long-lived IG tokens expire 60 days after issue. Compute expiry so the
    // refresh worker knows when to rotate. `longRes.data.expires_in` viene en
    // segundos — si Meta lo devuelve, lo usamos; sino default 60d.
    const expiresInSec = longRes.data.expires_in || 60 * 24 * 3600;
    const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

    // Update or create account
    if (accountId && accountId !== 'undefined') {
      // When reconnecting: preserve ig_user_id (webhook ID from entry.id).
      // Store ig_platform_id (from graph.instagram.com/me) separately — used for sending messages.
      const igPlatformId = igRes.data.id ? String(igRes.data.id) : null;
      console.log(`[AUTH] accountId=${accountId} | ig_platform_id=${igPlatformId} | username=${igUsername} | token_expires=${tokenExpiresAt}`);
      await db.update(db.accounts, { _id: accountId }, {
        ig_username:      igUsername,
        access_token:     longToken,
        ig_platform_id:   igPlatformId,
        token_expires_at: tokenExpiresAt,
        token_refreshed_at: new Date().toISOString(),
      });
    } else {
      const exists = await db.findOne(db.accounts, { ig_user_id: igIdFinal });
      if (!exists) {
        const acc = await db.insert(db.accounts, {
          ig_user_id:       igIdFinal,
          ig_username:      igUsername,
          access_token:     longToken,
          token_expires_at: tokenExpiresAt,
          token_refreshed_at: new Date().toISOString(),
        });
        await db.insert(db.settings, { account_id: acc._id, openai_key: '' });
      } else {
        // Update token for existing account
        await db.update(db.accounts, { ig_user_id: igIdFinal }, {
          ig_username:      igUsername,
          access_token:     longToken,
          token_expires_at: tokenExpiresAt,
          token_refreshed_at: new Date().toISOString(),
        });
      }
    }

    res.redirect('/?auth=success&ig=@' + igUsername);
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message);
    res.redirect('/?auth=error&msg=' + encodeURIComponent(e.response?.data?.error?.message || e.message));
  }
});

module.exports = router;
