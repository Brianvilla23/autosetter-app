// services/polar.js
// ─────────────────────────────────────────────────────────────────────────────
// Polar.sh adapter — Merchant of Record alternative to Lemon Squeezy.
//
// Activación: setear envs POLAR_API_KEY, POLAR_PRODUCT_PRICE_ID,
// POLAR_WEBHOOK_SECRET en Railway. Luego POLAR_ENABLED=1 hace que
// /api/billing/checkout acepte provider=polar.
//
// Docs API: https://docs.polar.sh/api-reference
// Endpoints clave:
//   POST /v1/checkouts/custom              → crea checkout
//   GET  /v1/subscriptions/{id}            → consulta suscripción
//   POST /v1/subscriptions/{id}/cancel     → cancela
//
// Webhook events que manejamos:
//   - checkout.updated      (status=succeeded → primer pago)
//   - subscription.created  (alias de checkout.updated en algunos flows)
//   - subscription.active
//   - subscription.canceled
//   - subscription.revoked  (cancelación inmediata por impago)
//
// Razón de existir: Lemon Squeezy rechazó la solicitud de tienda 2026-05-01
// por categoría "social media automation" según los underwriters de Stripe.
// Polar es MoR creator-friendly con review 24-48h y más permisivo en la
// categoría. Postmortem completo en `atinov_lecciones.md`.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const crypto = require('crypto');

const POLAR_API_BASE = 'https://api.polar.sh/v1';

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────
function polarHeaders() {
  const key = process.env.POLAR_API_KEY;
  if (!key) throw new Error('POLAR_API_KEY no configurado en Railway');
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

function isPolarEnabled() {
  return process.env.POLAR_ENABLED === '1' && !!process.env.POLAR_API_KEY;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout creation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Crea un checkout en Polar para el plan Founder.
 *
 * @param {Object} params
 * @param {string} params.userId           — ID del usuario en nuestra DB
 * @param {string} params.email            — email del usuario
 * @param {string} params.name             — nombre del usuario
 * @param {string} params.appUrl           — URL base de la app (para redirect)
 * @param {string} [params.priceId]        — override del POLAR_PRODUCT_PRICE_ID env
 * @returns {Promise<{ url: string, id: string }>}
 */
async function createCheckout({ userId, email, name, appUrl, priceId }) {
  const productPriceId = priceId || process.env.POLAR_PRODUCT_PRICE_ID;
  if (!productPriceId) {
    throw new Error('POLAR_PRODUCT_PRICE_ID no configurado');
  }

  const body = {
    product_price_id: productPriceId,
    success_url:      `${appUrl}/?billing=success&provider=polar`,
    customer_email:   email,
    customer_name:    name,
    // metadata se devuelve en el webhook event para reconciliación
    metadata: {
      userId,
      plan: 'founder',
    },
  };

  const resp = await axios.post(
    `${POLAR_API_BASE}/checkouts/custom`,
    body,
    { headers: polarHeaders() }
  );

  return {
    url: resp.data.url,
    id:  resp.data.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription operations
// ─────────────────────────────────────────────────────────────────────────────
async function getSubscription(subscriptionId) {
  const resp = await axios.get(
    `${POLAR_API_BASE}/subscriptions/${subscriptionId}`,
    { headers: polarHeaders() }
  );
  return resp.data;
}

async function cancelSubscription(subscriptionId) {
  const resp = await axios.post(
    `${POLAR_API_BASE}/subscriptions/${subscriptionId}/cancel`,
    {},
    { headers: polarHeaders() }
  );
  return resp.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook signature verification — HMAC-SHA256 del raw body
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Valida la firma del webhook de Polar.
 *
 * Polar firma con HMAC-SHA256 usando POLAR_WEBHOOK_SECRET y manda
 * el resultado en el header `webhook-signature` (formato: `sha256=<hex>`).
 *
 * IMPORTANTE: el body que se firma es el RAW body, no el JSON parseado.
 * Por eso este endpoint debe registrarse con `express.raw()` ANTES del
 * `express.json()` global, igual que el webhook de LS.
 *
 * @param {Buffer} rawBody                — payload exacto recibido
 * @param {string} signatureHeader        — valor del header `webhook-signature`
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[POLAR] POLAR_WEBHOOK_SECRET no configurado — rechazando webhook');
    return false;
  }
  if (!signatureHeader) return false;

  // Acepta tanto "sha256=<hex>" como solo "<hex>"
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7)
    : signatureHeader;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Comparación timing-safe (defensa contra timing attacks)
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook event handler — devuelve { action, userId, plan, extra }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parsea un evento de webhook de Polar y devuelve la acción a ejecutar.
 * El caller (en routes/billing.js o server.js) usa esto para llamar
 * activateSubscription() o cancelarla.
 *
 * @param {Object} event   — payload parseado del webhook
 * @returns {{ action: 'activate'|'cancel'|'renew'|'ignore', userId?: string, plan?: string, extra?: Object }}
 */
function parseEvent(event) {
  const type    = event.type;
  const payload = event.data || {};
  const meta    = payload.metadata || {};

  // El metadata.userId lo seteamos en createCheckout
  const userId = meta.userId;
  const plan   = meta.plan || 'founder';

  switch (type) {
    case 'checkout.updated':
      // Polar manda este event con status='succeeded' al completarse el pago
      if (payload.status === 'succeeded' && userId) {
        return {
          action: 'activate',
          userId,
          plan,
          extra: {
            polarCheckoutId:    payload.id,
            polarCustomerId:    payload.customer_id,
            polarSubscriptionId: payload.subscription_id || null,
          },
        };
      }
      return { action: 'ignore' };

    case 'subscription.created':
    case 'subscription.active':
      if (userId) {
        return {
          action: 'activate',
          userId,
          plan,
          extra: {
            polarSubscriptionId: payload.id,
            polarCustomerId:     payload.customer_id,
          },
        };
      }
      return { action: 'ignore' };

    case 'subscription.canceled':
    case 'subscription.revoked':
      if (userId) {
        return {
          action: 'cancel',
          userId,
          plan,
          extra: {
            polarSubscriptionId: payload.id,
            cancellationReason:  payload.cancellation_reason || type,
          },
        };
      }
      return { action: 'ignore' };

    default:
      // Eventos no manejados (order.created, refund.created, etc.) — log y skip
      return { action: 'ignore' };
  }
}

module.exports = {
  isPolarEnabled,
  polarHeaders,
  createCheckout,
  getSubscription,
  cancelSubscription,
  verifyWebhookSignature,
  parseEvent,
};
