const axios = require('axios');

const BASE = 'https://graph.facebook.com/v19.0';

/**
 * Send a text message via Instagram DM
 */
async function sendMessage({ recipientId, text, accessToken }) {
  try {
    const res = await axios.post(
      `${BASE}/me/messages`,
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
    const res = await axios.get(`${BASE}/${igUserId}`, {
      params: {
        fields: 'name,username',
        access_token: accessToken
      }
    });
    return res.data;
  } catch {
    return { username: igUserId, name: igUserId };
  }
}

module.exports = { sendMessage, getIGUserInfo };
