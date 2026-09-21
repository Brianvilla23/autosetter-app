/**
 * Atinov — Polar (merchant of record para cobrar fuera de Chile)
 *
 * Tres fallas que lo dejaban roto en silencio al encenderlo (2026-09-21):
 *  1. La firma del webhook se verificaba con un formato que Polar nunca envió:
 *     todo aviso real daba 401 y ninguna suscripción se activaba.
 *  2. El checkout iba a un endpoint y un campo deprecados.
 *  3. Las renovaciones mensuales (order.paid, subscription_cycle) se ignoraban:
 *     el cliente que pagaba puntual quedaba vencido al mes.
 *
 * Módulo sin red: se testea la firma, el cuerpo del checkout y el parseo.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const polar = require('../services/polar');

// Secreto como lo genera Polar hoy: "whsec_" + base64.
const CLAVE = Buffer.from('una-clave-de-prueba-de-32-bytes!');
const SECRETO = 'whsec_' + CLAVE.toString('base64');

function firmar(clave, id, ts, body) {
  return 'v1,' + crypto.createHmac('sha256', clave).update(`${id}.${ts}.${body}`).digest('base64');
}
const ahora = () => Math.floor(Date.now() / 1000);

// ── Firma ────────────────────────────────────────────────────────────────────

test('acepta la firma Standard Webhooks con la clave base64 (secretos desde 2026-09-08)', () => {
  process.env.POLAR_WEBHOOK_SECRET = SECRETO;
  const body = '{"type":"order.paid"}';
  const ts = String(ahora());
  assert.strictEqual(polar.verifyWebhookSignature(body, {
    'webhook-id': 'msg_a', 'webhook-timestamp': ts, 'webhook-signature': firmar(CLAVE, 'msg_a', ts, body),
  }), true);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('acepta también la derivación histórica de Polar (bytes UTF-8 del secreto completo)', () => {
  process.env.POLAR_WEBHOOK_SECRET = SECRETO;
  const body = '{"type":"order.paid"}';
  const ts = String(ahora());
  const claveVieja = Buffer.from(SECRETO, 'utf8');
  assert.strictEqual(polar.verifyWebhookSignature(body, {
    'webhook-id': 'msg_b', 'webhook-timestamp': ts, 'webhook-signature': firmar(claveVieja, 'msg_b', ts, body),
  }), true);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('el cuerpo se verifica como Buffer crudo, igual que llega de express.raw', () => {
  process.env.POLAR_WEBHOOK_SECRET = SECRETO;
  const body = Buffer.from('{"type":"subscription.active","data":{"id":"s1"}}', 'utf8');
  const ts = String(ahora());
  assert.strictEqual(polar.verifyWebhookSignature(body, {
    'webhook-id': 'msg_c', 'webhook-timestamp': ts, 'webhook-signature': firmar(CLAVE, 'msg_c', ts, body.toString()),
  }), true);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('varias firmas en el header (rotación de secreto): basta con que una calce', () => {
  process.env.POLAR_WEBHOOK_SECRET = SECRETO;
  const body = '{}';
  const ts = String(ahora());
  const buena = firmar(CLAVE, 'msg_d', ts, body);
  const mala = 'v1,' + Buffer.alloc(32, 7).toString('base64');
  assert.strictEqual(polar.verifyWebhookSignature(body, {
    'webhook-id': 'msg_d', 'webhook-timestamp': ts, 'webhook-signature': `${mala} ${buena}`,
  }), true);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('rechaza el reenvío fuera de la ventana de tolerancia', () => {
  process.env.POLAR_WEBHOOK_SECRET = SECRETO;
  const body = '{}';
  const viejo = String(ahora() - polar.TOLERANCIA_SEG - 60);
  assert.strictEqual(polar.verifyWebhookSignature(body, {
    'webhook-id': 'msg_e', 'webhook-timestamp': viejo, 'webhook-signature': firmar(CLAVE, 'msg_e', viejo, body),
  }), false, 'firma correcta pero timestamp vencido');
  // Con un "ahora" inyectado cercano, la misma firma pasa: el problema era solo el reloj.
  assert.strictEqual(polar.verifyWebhookSignature(body, {
    'webhook-id': 'msg_e', 'webhook-timestamp': viejo, 'webhook-signature': firmar(CLAVE, 'msg_e', viejo, body),
  }, { ahora: Number(viejo) + 10 }), true);
  delete process.env.POLAR_WEBHOOK_SECRET;
});

test('cualquier cambio en id, timestamp o body invalida la firma', () => {
  process.env.POLAR_WEBHOOK_SECRET = SECRETO;
  const body = '{"amount":100}';
  const ts = String(ahora());
  const sig = firmar(CLAVE, 'msg_f', ts, body);
  const base = { 'webhook-id': 'msg_f', 'webhook-timestamp': ts, 'webhook-signature': sig };
  assert.strictEqual(polar.verifyWebhookSignature(body, base), true);
  assert.strictEqual(polar.verifyWebhookSignature('{"amount":999}', base), false, 'body alterado');
  assert.strictEqual(polar.verifyWebhookSignature(body, { ...base, 'webhook-id': 'msg_x' }), false, 'id alterado');
  assert.strictEqual(polar.verifyWebhookSignature(body, { ...base, 'webhook-timestamp': String(ahora() + 30) }), false, 'timestamp alterado');
  assert.strictEqual(polar.verifyWebhookSignature(body, { ...base, 'webhook-signature': '' }), false, 'sin firma');
  assert.strictEqual(polar.verifyWebhookSignature(body, { ...base, 'webhook-timestamp': 'ayer' }), false, 'timestamp no numérico');
  delete process.env.POLAR_WEBHOOK_SECRET;
});

// ── Checkout ─────────────────────────────────────────────────────────────────

test('el checkout usa la API actual: products[] y success_url con checkout_id', () => {
  const body = polar.buildCheckoutBody({
    userId: 'u1', email: 'a@b.cl', name: 'Ana', appUrl: 'https://atinov.com',
    productId: 'prod_123', plan: 'crecimiento',
  });
  assert.deepStrictEqual(body.products, ['prod_123']);
  assert.strictEqual(body.product_price_id, undefined, 'el campo deprecado no se manda');
  assert.match(body.success_url, /billing=success&provider=polar&checkout_id=\{CHECKOUT_ID\}/);
  assert.strictEqual(body.customer_email, 'a@b.cl');
  assert.deepStrictEqual(body.metadata, { userId: 'u1', plan: 'crecimiento' });
  assert.strictEqual(polar.buildCheckoutBody({ userId: 'u1', appUrl: 'x', productId: 'p' }).metadata.plan, 'founder');
});

test('el producto sale de POLAR_PRODUCT_ID, con el nombre viejo como respaldo', () => {
  delete process.env.POLAR_PRODUCT_ID; delete process.env.POLAR_PRODUCT_PRICE_ID;
  assert.strictEqual(polar.productoDe(null), null);
  process.env.POLAR_PRODUCT_PRICE_ID = 'viejo';
  assert.strictEqual(polar.productoDe(null), 'viejo', 'el nombre anterior sigue sirviendo');
  process.env.POLAR_PRODUCT_ID = 'nuevo';
  assert.strictEqual(polar.productoDe(null), 'nuevo', 'el nombre nuevo manda');
  assert.strictEqual(polar.productoDe('por-plan'), 'por-plan', 'el del plan pedido manda sobre todo');
  delete process.env.POLAR_PRODUCT_ID; delete process.env.POLAR_PRODUCT_PRICE_ID;
});

// ── Eventos ──────────────────────────────────────────────────────────────────

test('order.paid de un ciclo mensual renueva; el primer cobro y la orden sin pagar no', () => {
  const meta = { userId: 'u1', plan: 'inicial' };
  const ciclo = polar.parseEvent({ type: 'order.paid', data: { id: 'o2', billing_reason: 'subscription_cycle', subscription_id: 's1', metadata: meta } });
  assert.strictEqual(ciclo.action, 'renew');
  assert.strictEqual(ciclo.userId, 'u1');
  assert.strictEqual(ciclo.extra.polarSubscriptionId, 's1');

  const primero = polar.parseEvent({ type: 'order.paid', data: { id: 'o1', billing_reason: 'subscription_create', metadata: meta } });
  assert.strictEqual(primero.action, 'ignore', 'el primer cobro ya lo activa subscription.active');

  const creada = polar.parseEvent({ type: 'order.created', data: { id: 'o3', billing_reason: 'subscription_cycle', metadata: meta } });
  assert.strictEqual(creada.action, 'ignore', 'una orden creada todavía no cobró');

  const sinUsuario = polar.parseEvent({ type: 'order.paid', data: { id: 'o4', billing_reason: 'subscription_cycle', metadata: {} } });
  assert.strictEqual(sinUsuario.action, 'ignore', 'sin userId no hay a quién renovar');
});

test('activación y cancelación siguen igual', () => {
  const meta = { userId: 'u1', plan: 'escala' };
  assert.strictEqual(polar.parseEvent({ type: 'subscription.active', data: { id: 's1', metadata: meta } }).action, 'activate');
  assert.strictEqual(polar.parseEvent({ type: 'checkout.updated', data: { id: 'c1', status: 'succeeded', metadata: meta } }).action, 'activate');
  assert.strictEqual(polar.parseEvent({ type: 'checkout.updated', data: { id: 'c1', status: 'open', metadata: meta } }).action, 'ignore');
  assert.strictEqual(polar.parseEvent({ type: 'subscription.revoked', data: { id: 's1', metadata: meta } }).action, 'cancel');
  assert.strictEqual(polar.parseEvent({ type: 'subscription.active', data: { id: 's1', metadata: meta } }).plan, 'escala', 'el plan viaja en metadata');
});
