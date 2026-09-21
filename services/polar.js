// services/polar.js
// ─────────────────────────────────────────────────────────────────────────────
// Polar.sh adapter — Merchant of Record alternative to Lemon Squeezy.
//
// Activación: setear envs POLAR_API_KEY, POLAR_PRODUCT_ID (el ID del
// PRODUCTO en Polar; POLAR_PRODUCT_PRICE_ID sigue aceptado como respaldo) y
// POLAR_WEBHOOK_SECRET en Railway. Luego POLAR_ENABLED=1 hace que
// /api/billing/checkout acepte provider=polar.
//
// Docs API: https://polar.sh/docs/api-reference
// Endpoints clave (revisados 2026-09-21):
//   POST /v1/checkouts/                    → crea checkout con `products: [id]`
//                                            (/checkouts/custom y product_price_id
//                                            están DEPRECADOS)
//   GET  /v1/subscriptions/{id}            → consulta suscripción
//   POST /v1/subscriptions/{id}/cancel     → cancela
//
// Webhook events que manejamos:
//   - checkout.updated      (status=succeeded → primer pago)
//   - subscription.created  (alias de checkout.updated en algunos flows)
//   - subscription.active
//   - subscription.canceled
//   - subscription.revoked  (cancelación inmediata por impago)
//   - order.paid            (billing_reason=subscription_cycle → RENOVACIÓN
//                            mensual; sin esto el cliente que pagaba quedaba
//                            vencido al mes)
//
// Firma del webhook: Polar usa Standard Webhooks (https://www.standardwebhooks.com):
//   firma = base64( HMAC-SHA256( clave, `${webhook-id}.${webhook-timestamp}.${body}` ) )
//   header webhook-signature = "v1,<base64> v1,<base64> ..." (varias si rotó)
//   clave = base64decode(secreto sin "whsec_")   → secretos creados desde 2026-09-08
//   clave = utf8(secreto completo "whsec_...")     → secretos anteriores ("Polar HMAC")
// Se prueban las dos derivaciones. Hasta el 21-09 el código firmaba solo el
// body en hex con "sha256=", un formato que Polar nunca envió: TODO webhook
// real daba 401 y ninguna suscripción se activaba.
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
 * @param {string} [params.plan]           — id del plan comprado (inicial/crecimiento/escala/medida/founder)
 * @returns {Promise<{ url: string, id: string }>}
 */
/** ID del producto de Polar a vender. Puro, para poder testearlo. */
function productoDe(priceId) {
  return priceId || process.env.POLAR_PRODUCT_ID || process.env.POLAR_PRODUCT_PRICE_ID || null;
}

/** Cuerpo del POST /v1/checkouts/. Puro, para poder testearlo sin red. */
function buildCheckoutBody({ userId, email, name, appUrl, productId, plan }) {
  return {
    // La API actual recibe una lista de productos; el primero queda
    // seleccionado. product_price_id está deprecado y /checkouts/custom ya no
    // figura en la referencia (2026-09-21).
    products:       [productId],
    success_url:    `${appUrl}/?billing=success&provider=polar&checkout_id={CHECKOUT_ID}`,
    customer_email: email,
    customer_name:  name,
    // metadata vuelve en cada evento del webhook: es la reconciliación.
    metadata: {
      userId,
      // Antes quedaba fijo en 'founder': un pago de Crecimiento o Escala
      // activaba la cuenta con los límites de Founder (revisión 12-09).
      plan: plan || 'founder',
    },
  };
}

async function createCheckout({ userId, email, name, appUrl, priceId, plan }) {
  const productId = productoDe(priceId);
  if (!productId) {
    throw new Error('POLAR_PRODUCT_ID no configurado');
  }

  const body = buildCheckoutBody({ userId, email, name, appUrl, productId, plan });

  const resp = await axios.post(
    `${POLAR_API_BASE}/checkouts/`,
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
// Webhook signature verification — Standard Webhooks
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Valida la firma del webhook de Polar (ver cabecera del archivo para el
 * esquema exacto: id.timestamp.body, clave base64 tras "whsec_", firma
 * base64 con prefijo "v1,").
 *
 * IMPORTANTE: el body que se firma es el RAW body, no el JSON parseado.
 * Por eso este endpoint debe registrarse con `express.raw()` ANTES del
 * `express.json()` global, igual que el webhook de LS.
 *
 * Firma real de la función más abajo; este bloque solo explica el contrato.
 */
/** Ventana de reenvío aceptada. Standard Webhooks recomienda acotarla; 5 min es lo usual. */
const TOLERANCIA_SEG = 5 * 60;

/**
 * Las dos claves posibles para el mismo secreto "whsec_...": la del estándar
 * (base64 decodificado) y la histórica de Polar (bytes UTF-8 del string
 * completo). Se prueban ambas porque no sabemos cuándo se generó el secreto.
 */
function clavesDe(secret) {
  const sinPrefijo = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const claves = [];
  try { claves.push(Buffer.from(sinPrefijo, 'base64')); } catch { /* no era base64 */ }
  claves.push(Buffer.from(secret, 'utf8'));
  return claves;
}

/**
 * Verifica un webhook de Polar según Standard Webhooks.
 *
 * @param {Buffer|string} rawBody   payload exacto recibido
 * @param {object} headers          { 'webhook-id', 'webhook-timestamp', 'webhook-signature' }
 * @param {object} [opts]           { ahora: segundos unix, para tests }
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, headers = {}, opts = {}) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[POLAR] POLAR_WEBHOOK_SECRET no configurado — rechazando webhook');
    return false;
  }
  // Compatibilidad con la firma vieja (string suelto): nunca fue lo que Polar
  // manda, así que se rechaza sin más.
  if (typeof headers !== 'object' || headers === null) return false;

  const id  = String(headers['webhook-id'] || '');
  const ts  = String(headers['webhook-timestamp'] || '');
  const sig = String(headers['webhook-signature'] || '');
  if (!id || !ts || !sig) return false;

  // Anti-replay: el timestamp tiene que estar cerca de ahora.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const ahora = Number.isFinite(opts.ahora) ? opts.ahora : Math.floor(Date.now() / 1000);
  if (Math.abs(ahora - tsNum) > TOLERANCIA_SEG) return false;

  const cuerpo = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const firmado = Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), cuerpo]);

  // El header trae una o varias firmas "v1,<base64>" separadas por espacio
  // (varias cuando el secreto se rotó hace poco).
  const candidatas = sig.split(' ')
    .map(x => x.trim())
    .filter(x => x.startsWith('v1,'))
    .map(x => x.slice(3));
  if (!candidatas.length) return false;

  for (const clave of clavesDe(secret)) {
    const esperada = crypto.createHmac('sha256', clave).update(firmado).digest();
    for (const c of candidatas) {
      let dada;
      try { dada = Buffer.from(c, 'base64'); } catch { continue; }
      if (dada.length === esperada.length && crypto.timingSafeEqual(dada, esperada)) return true;
    }
  }
  return false;
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

    // RENOVACIÓN mensual. Polar emite order.paid en cada cobro; el primero
    // trae billing_reason=subscription_create (ya lo activa subscription.active
    // o checkout.updated), los siguientes subscription_cycle. Hasta el 21-09
    // esto se ignoraba y el cliente que pagaba puntual quedaba vencido al mes.
    // Se usa order.paid y no order.created: la orden creada aún no cobró.
    case 'order.paid':
      if (userId && payload.billing_reason === 'subscription_cycle') {
        return {
          action: 'renew',
          userId,
          plan,
          extra: { polarOrderId: payload.id, polarSubscriptionId: payload.subscription_id || null },
        };
      }
      return { action: 'ignore' };

    default:
      // Eventos no manejados (order.created, refund.created, etc.) — log y skip
      return { action: 'ignore' };
  }
}

module.exports = {
  buildCheckoutBody,
  productoDe,
  TOLERANCIA_SEG,
  isPolarEnabled,
  polarHeaders,
  createCheckout,
  getSubscription,
  cancelSubscription,
  verifyWebhookSignature,
  parseEvent,
};
