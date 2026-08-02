/**
 * Atinov — Pago dentro del chat (Mercado Pago)
 *
 * El cierre de venta sin sacar al lead de la conversación: cuando el lead
 * confirma que quiere pagar/reservar, el agente incluye el marcador
 *   [PAGO: monto_en_CLP | descripción]
 * y este módulo lo reemplaza por un link real de Checkout Pro ANTES de
 * guardar/encolar el mensaje. El webhook de confirmación mueve el lead a
 * "ganado" en el kanban con el monto real — la señal de venta objetiva.
 *
 * FAIL-CLOSED: sin mp_access_token en los settings de la cuenta, el agente
 * ni siquiera recibe la capacidad en su prompt, y cualquier marcador
 * residual se elimina del texto en vez de romper el mensaje.
 *
 * El patrón es el mismo del comercio conversacional que ya opera en Brasil
 * (Pix in-chat): conversación → link de pago → webhook → CRM. WhatsApp Pay
 * no existe en Chile; esto es el equivalente con rieles chilenos.
 */

const axios = require('axios');
const db    = require('../db/database');

const MP_BASE = 'https://api.mercadopago.com';
const APP_URL = () => process.env.APP_URL || 'https://atinov.com';

const MARKER_RE = /\[PAGO:\s*\$?\s*([\d.,]+)\s*\|\s*([^\]]{3,120})\]/gi;

/** Bloque de capacidad para el system prompt — solo si la cuenta tiene MP. */
function buildPaymentContext(settings) {
  if (!settings?.mp_access_token) return null;
  return [
    '--- CAPACIDAD DE COBRO (Mercado Pago) ---',
    'Puedes generar un link de pago REAL cuando el lead CONFIRME explícitamente que quiere pagar, reservar o abonar. Para hacerlo incluye en tu respuesta el marcador exacto:',
    '[PAGO: monto_en_CLP | descripción corta]',
    'Ejemplo: "perfecto, te dejo el pago de la reserva acá: [PAGO: 15000 | Reserva evaluación]"',
    'El sistema reemplaza el marcador por el link real de Mercado Pago.',
    'Reglas: solo tras confirmación explícita del lead (nunca lo ofrezcas en el primer mensaje ni como presión), un solo marcador por mensaje, y el monto debe ser el acordado en la conversación.',
  ].join('\n');
}

/**
 * Crea un link de Checkout Pro. Devuelve la URL o lanza.
 * external_reference = accountId:leadId — el webhook lo usa para validar.
 */
async function createPaymentLink({ accessToken, amountCLP, title, accountId, leadId }) {
  const res = await axios.post(`${MP_BASE}/checkout/preferences`, {
    items: [{
      title: String(title).slice(0, 120),
      quantity: 1,
      unit_price: amountCLP,
      currency_id: 'CLP',
    }],
    external_reference: `${accountId}:${leadId}`,
    notification_url: `${APP_URL()}/webhook/mercadopago?acc=${encodeURIComponent(accountId)}&lead=${encodeURIComponent(leadId)}`,
  }, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  const url = res.data?.init_point;
  if (!url) throw new Error('Mercado Pago no devolvió init_point');
  return url;
}

/**
 * Reemplaza los marcadores [PAGO: ...] del reply por links reales.
 * Sin token o ante cualquier error: elimina el marcador y avisa por log —
 * el mensaje sale igual, nunca se rompe la conversación por el cobro.
 */
async function resolvePaymentMarkers(text, { settings, accountId, leadId }) {
  if (!text || !MARKER_RE.test(text)) return { text, links: [] };
  MARKER_RE.lastIndex = 0;

  const links = [];
  let out = text;
  const matches = [...text.matchAll(MARKER_RE)];
  for (const m of matches) {
    const raw = m[1].replace(/\./g, '').replace(/,/g, '');
    const amount = parseInt(raw, 10);
    const title = m[2].trim();
    let replacement = '';
    if (settings?.mp_access_token && Number.isFinite(amount) && amount >= 100) {
      try {
        const url = await createPaymentLink({
          accessToken: settings.mp_access_token,
          amountCLP: amount,
          title,
          accountId,
          leadId,
        });
        replacement = url;
        links.push({ amount, title, url });
      } catch (e) {
        console.warn('[pago] no se pudo crear link MP:', e.response?.data?.message || e.message);
      }
    } else if (!settings?.mp_access_token) {
      console.warn('[pago] marcador PAGO en reply pero la cuenta no tiene mp_access_token — se elimina');
    }
    out = out.replace(m[0], replacement);
  }
  // Limpiar dobles espacios que deja un marcador eliminado
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
  return { text: out, links };
}

/**
 * Procesa una notificación del webhook de MP. Verificación server-to-server:
 * no confiamos en el body del webhook — consultamos el pago directo a la API
 * de MP con el token de la cuenta y solo actuamos si está aprobado y su
 * external_reference calza con la cuenta/lead de la URL.
 */
async function handleMpNotification({ accountId, leadId, paymentId }) {
  const settings = await db.findOne(db.settings, { account_id: accountId });
  if (!settings?.mp_access_token) return { ok: false, reason: 'cuenta sin MP' };

  const res = await axios.get(`${MP_BASE}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${settings.mp_access_token}` },
    timeout: 15000,
  });
  const pago = res.data;
  if (pago?.status !== 'approved') return { ok: false, reason: `status ${pago?.status}` };
  if (pago?.external_reference !== `${accountId}:${leadId}`) {
    return { ok: false, reason: 'external_reference no coincide' };
  }

  const lead = await db.findOne(db.leads, { _id: leadId, account_id: accountId });
  if (!lead) return { ok: false, reason: 'lead no encontrado' };
  if (lead.mp_payment_id === String(pago.id)) return { ok: true, dedup: true };

  await db.update(db.leads, { _id: leadId }, {
    pipeline_stage: 'ganado',
    is_converted: true,
    deal_value: pago.transaction_amount,
    deal_currency: 'CLP',
    mp_payment_id: String(pago.id),
    stage_changed_at: new Date().toISOString(),
  });
  await db.insert(db.messages, {
    lead_id: leadId,
    role: 'sistema',
    content: `💰 Pago confirmado por Mercado Pago: $${Number(pago.transaction_amount).toLocaleString('es-CL')} CLP (${pago.description || 'sin descripción'})`,
  });
  console.log(`💰 [MP] Pago aprobado → lead ${leadId} a GANADO ($${pago.transaction_amount} CLP)`);
  return { ok: true, amount: pago.transaction_amount };
}

module.exports = {
  buildPaymentContext,
  createPaymentLink,
  resolvePaymentMarkers,
  handleMpNotification,
};
