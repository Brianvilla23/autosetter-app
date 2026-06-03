/**
 * Atinov — Verificación de firma de webhooks de Mercado Pago
 *
 * MP firma cada notificación con el header `x-signature` (HMAC-SHA256) +
 * `x-request-id`. El manifest a firmar es:
 *     id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * donde `ts` y `v1` (el hash) salen del propio header x-signature
 * (formato: "ts=1700000000,v1=abc123...").
 *
 * El secreto es la "Clave secreta" de la integración (Webhooks → configurar).
 * Se setea en env como MP_WEBHOOK_SECRET.
 *
 * Referencia oficial:
 *   https://www.mercadopago.com/developers/es/docs/your-integrations/notifications/webhooks
 *
 * Si MP_WEBHOOK_SECRET no está configurado, verifyMpSignature devuelve
 * `skipped` (no bloquea) — útil mientras se configura. La defensa de fondo
 * sigue siendo que el webhook re-consulta el estado autoritativo a la API
 * de MP con el access token, así que nadie se auto-activa gratis. Pero con
 * el secret configurado, rechazamos forjados antes de gastar una llamada API.
 */

const crypto = require('crypto');

/**
 * @param {Object} req — request de Express (necesita headers + query/body)
 * @returns {{ ok: boolean, reason?: string, skipped?: boolean }}
 */
function verifyMpSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return { ok: true, skipped: true }; // no configurado → no bloquea

  const sigHeader = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!sigHeader || typeof sigHeader !== 'string') {
    return { ok: false, reason: 'missing x-signature' };
  }

  // Parsear "ts=...,v1=..."
  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => {
      const [k, v] = kv.split('=');
      return [String(k).trim(), String(v || '').trim()];
    })
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, reason: 'malformed x-signature' };

  // data.id viene en query (?data.id=) o en el body
  const dataId = req.query?.['data.id'] || req.query?.id || req.body?.data?.id;
  if (!dataId) return { ok: false, reason: 'missing data.id' };

  // Manifest exacto que MP firma (data.id en minúsculas según su spec)
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId || ''};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  try {
    const a = Buffer.from(v1, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'length mismatch' };
    return { ok: crypto.timingSafeEqual(a, b), reason: 'hmac' };
  } catch {
    return { ok: false, reason: 'compare error' };
  }
}

module.exports = { verifyMpSignature };
