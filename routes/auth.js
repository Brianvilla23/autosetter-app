const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../db/database');

const APP_ID     = process.env.META_APP_ID     || '';
const APP_SECRET = process.env.META_APP_SECRET || '';

// ── Step 1: Redirect user to Meta OAuth ──────────────────────────────────────
router.get('/instagram', (req, res) => {
  const { accountId } = req.query;
  if (!APP_ID) return res.redirect('/?auth=error&msg=' + encodeURIComponent('Para conectar Instagram necesitas configurar META_APP_ID y META_APP_SECRET en el archivo .env. Consulta el tutorial en Settings.'));

  const redirectUri = `${process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`}/auth/callback`;
  const scope = 'instagram_basic,instagram_manage_messages,pages_manage_metadata,pages_read_engagement';

  const url = `https://www.facebook.com/v19.0/dialog/oauth?` +
    `client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope}` +
    `&state=${accountId}` +
    `&response_type=code`;

  res.redirect(url);
});

// ── Step 2: Meta redirects back with code ────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: accountId, error } = req.query;

  if (error) return res.redirect('/?auth=error&msg=' + encodeURIComponent(req.query.error_description || error));
  if (!code)  return res.redirect('/?auth=error&msg=no_code');

  try {
    const redirectUri = `${process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`}/auth/callback`;

    // Exchange code for short-lived token
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: redirectUri, code }
    });
    const shortToken = tokenRes.data.access_token;

    // Exchange for long-lived token (60 days)
    const longRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: APP_ID, client_secret: APP_SECRET, fb_exchange_token: shortToken }
    });
    const longToken = longRes.data.access_token;

    // Get user's pages
    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: longToken, fields: 'id,name,instagram_business_account' }
    });

    const pages = pagesRes.data.data || [];
    const pageWithIG = pages.find(p => p.instagram_business_account);

    if (!pageWithIG) {
      return res.redirect('/?auth=error&msg=' + encodeURIComponent('No se encontró cuenta de Instagram Business vinculada a esta página de Facebook. Necesitas tener una cuenta Instagram Business conectada a una Página de Facebook.'));
    }

    const igId = pageWithIG.instagram_business_account.id;

    // Get IG username
    const igRes = await axios.get(`https://graph.facebook.com/v19.0/${igId}`, {
      params: { fields: 'id,username', access_token: pageWithIG.access_token || longToken }
    });

    const igUsername = igRes.data.username || igId;
    const pageToken  = pageWithIG.access_token || longToken;

    // Update or create account
    if (accountId && accountId !== 'undefined') {
      await db.update(db.accounts, { _id: accountId }, {
        ig_user_id: igId, ig_username: igUsername, access_token: pageToken
      });
    } else {
      // Create new account
      const exists = await db.findOne(db.accounts, { ig_user_id: igId });
      if (!exists) {
        const acc = await db.insert(db.accounts, { ig_user_id: igId, ig_username: igUsername, access_token: pageToken });
        await db.insert(db.settings, { account_id: acc._id, openai_key: '' });
      }
    }

    res.redirect('/?auth=success&ig=@' + igUsername);
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message);
    res.redirect('/?auth=error&msg=' + encodeURIComponent(e.response?.data?.error?.message || e.message));
  }
});

module.exports = router;
