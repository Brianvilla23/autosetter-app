const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../db/database');

const APP_ID     = process.env.META_APP_ID     || '';
const APP_SECRET = process.env.META_APP_SECRET || '';

// ── Step 1: Redirect user to Instagram Business Login OAuth ──────────────────
router.get('/instagram', (req, res) => {
  const { accountId } = req.query;
  if (!APP_ID) return res.redirect('/?auth=error&msg=' + encodeURIComponent('Para conectar Instagram necesitas configurar META_APP_ID y META_APP_SECRET en el archivo .env. Consulta el tutorial en Settings.'));

  const redirectUri = `${process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`}/auth/callback`;
  const scope = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';

  const url = `https://www.instagram.com/oauth/authorize?` +
    `client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&response_type=code` +
    `&state=${accountId || ''}`;

  res.redirect(url);
});

// ── Step 2: Instagram redirects back with code ───────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: accountId, error } = req.query;

  if (error) return res.redirect('/?auth=error&msg=' + encodeURIComponent(req.query.error_description || error));
  if (!code)  return res.redirect('/?auth=error&msg=no_code');

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

    // Get IG username
    const igRes = await axios.get('https://graph.instagram.com/me', {
      params: { fields: 'id,username,name', access_token: longToken }
    });
    const igUsername = igRes.data.username || igId;
    const igIdFinal  = igRes.data.id ? String(igRes.data.id) : igId; // use /me id (authoritative)

    console.log(`[AUTH DEBUG] token_user_id=${igId} | /me id=${igRes.data.id} | igIdFinal=${igIdFinal} | username=${igUsername}`);

    // Update or create account
    if (accountId && accountId !== 'undefined') {
      await db.update(db.accounts, { _id: accountId }, {
        ig_user_id: igIdFinal, ig_username: igUsername, access_token: longToken
      });
    } else {
      const exists = await db.findOne(db.accounts, { ig_user_id: igIdFinal });
      if (!exists) {
        const acc = await db.insert(db.accounts, { ig_user_id: igIdFinal, ig_username: igUsername, access_token: longToken });
        await db.insert(db.settings, { account_id: acc._id, openai_key: '' });
      } else {
        // Update token for existing account
        await db.update(db.accounts, { ig_user_id: igIdFinal }, {
          ig_username: igUsername, access_token: longToken
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
