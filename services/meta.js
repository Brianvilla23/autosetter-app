const axios = require('axios');

// Instagram Business Login tokens work with graph.instagram.com (not graph.facebook.com)
const IG_BASE = 'https://graph.instagram.com/v21.0';
const FB_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Send a text message via Instagram DM
 * Uses Instagram Platform API (required for Instagram Business Login tokens)
 * Endpoint: POST /{ig-user-id}/messages on graph.instagram.com
 */
async function sendMessage({ recipientId, text, accessToken, igUserId }) {
  // If igUserId provided, use Instagram Platform API (Business Login flow)
  // Otherwise fall back to Facebook Graph API /me/messages (legacy)
  const url = igUserId
    ? `${IG_BASE}/${igUserId}/messages`
    : `${FB_BASE}/me/messages`;

  try {
    const res = await axios.post(
      url,
      {
        recipient: { id: recipientId },
        message: { text }
      },
      {
        params: { access_token: accessToken }
      }
    );
    return res.data;
  } catch (err) {
    console.error('Meta API error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get user info (username) from Instagram user ID
 */
async function getIGUserInfo(igUserId, accessToken) {
  try {
    const res = await axios.get(`${IG_BASE}/${igUserId}`, {
      params: {
        fields: 'name,username',
        access_token: accessToken
      }
    });
    return res.data;
  } catch {
    // Fallback to Facebook Graph API
    try {
      const res = await axios.get(`${FB_BASE}/${igUserId}`, {
        params: { fields: 'name,username', access_token: accessToken }
      });
      return res.data;
    } catch {
      return { username: igUserId, name: igUserId };
    }
  }
}

module.exports = { sendMessage, getIGUserInfo };
