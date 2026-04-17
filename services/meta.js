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
  const url = igUserId
    ? `${IG_BASE}/${igUserId}/messages`
    : `${FB_BASE}/me/messages`;

  try {
    const res = await axios.post(
      url,
      { recipient: { id: recipientId }, message: { text } },
      { params: { access_token: accessToken } }
    );
    return res.data;
  } catch (err) {
    console.error('Meta API error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get user info (username/name) from a sender's IG scoped ID.
 * Tries multiple endpoints since the sender ID from webhooks may differ.
 */
async function getIGUserInfo(igUserId, accessToken) {
  // Try 1: Instagram Platform API direct user lookup
  try {
    const res = await axios.get(`${IG_BASE}/${igUserId}`, {
      params: { fields: 'id,name,username', access_token: accessToken }
    });
    if (res.data.username) return res.data;
  } catch (e) {
    // silent
  }

  // Try 2: Look up via conversation participants
  try {
    const res = await axios.get(`${IG_BASE}/me/conversations`, {
      params: {
        user_id: igUserId,
        platform: 'instagram',
        fields: 'participants',
        access_token: accessToken
      }
    });
    const data = res.data?.data?.[0];
    const participant = data?.participants?.data?.find(p => p.id === igUserId || p.username);
    if (participant?.username) return participant;
  } catch (e) {
    // silent
  }

  // Fallback: return numeric ID as username
  return { username: igUserId, name: igUserId };
}

module.exports = { sendMessage, getIGUserInfo };
