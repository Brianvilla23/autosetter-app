/**
 * DMCloser — Magnet Delivery
 *
 * Cuando el bot ofreció un lead magnet y el lead responde con un email/teléfono,
 * este servicio detecta el dato, dispara la entrega real (email con recurso),
 * y lo registra en magnetDeliveries para métricas.
 *
 * Se llama desde webhook.js ANTES de generar la respuesta del bot, para que la
 * respuesta pueda confirmar la entrega de forma natural.
 */

const db = require('../db/database');
const { sendEmail } = require('./email');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_REGEX = /(\+?\d[\d\s\-().]{7,}\d)/;

/**
 * Detecta si el texto del lead contiene un email/teléfono Y si el bot había
 * ofrecido un magnet recientemente. Si ambas cosas pasan, dispara la entrega.
 *
 * Retorna { delivered: boolean, magnet?, email?, phone? } para que el caller
 * pueda inyectar contexto en el prompt del bot.
 */
async function tryDeliverMagnet({ lead, account, incomingText, recentHistory }) {
  try {
    const emailMatch = incomingText && incomingText.match(EMAIL_REGEX);
    const phoneMatch = incomingText && incomingText.match(PHONE_REGEX);
    if (!emailMatch && !phoneMatch) return { delivered: false };

    const email = emailMatch ? emailMatch[0].toLowerCase() : null;
    const phone = phoneMatch ? phoneMatch[0].replace(/\s+/g, '') : null;

    // Magnets activos de esta cuenta
    const magnets = await db.find(db.leadMagnets, { account_id: account._id, enabled: true });
    if (!magnets.length) return { delivered: false };

    // Buscar en los últimos 4 mensajes del bot señales de que ofreció un magnet.
    // Matching laxo: título o primeras palabras de la descripción/pitch.
    const recentBotText = (recentHistory || [])
      .filter(m => m.role === 'agent' || m.role === 'assistant')
      .slice(-4)
      .map(m => (m.content || '').toLowerCase())
      .join(' \n ');

    if (!recentBotText) return { delivered: false };

    const matchedMagnet = magnets.find(m => {
      const needles = [
        (m.title || '').toLowerCase().slice(0, 30),
        (m.pitch || '').toLowerCase().slice(0, 40),
        (m.description || '').toLowerCase().slice(0, 30),
      ].filter(s => s.length >= 10);
      return needles.some(n => recentBotText.includes(n));
    });

    // Fallback: si no hay match específico pero el bot claramente pidió email/guía,
    // usamos el magnet "generic" o el primero activo.
    const askedForContact = /\b(mail|email|correo|tel[ée]fono|whats?app|te la mando|te lo mando|te env[ií]o)\b/i
      .test(recentBotText);

    const magnet = matchedMagnet
      || (askedForContact ? (magnets.find(m => m.trigger_intent === 'generic') || magnets[0]) : null);

    if (!magnet) return { delivered: false };

    // Evitar doble entrega: si este lead ya recibió este magnet, no re-enviamos
    const existing = await db.findOne(db.magnetDeliveries, {
      account_id: account._id, lead_id: lead._id, magnet_id: magnet._id,
    });
    if (existing) return { delivered: false, alreadyDelivered: true, magnet };

    // Registrar entrega (siempre, aunque falle el email después)
    await db.insert(db.magnetDeliveries, {
      account_id: account._id,
      lead_id:    lead._id,
      magnet_id:  magnet._id,
      email:      email || null,
      phone:      phone || null,
      ig_username: lead.ig_username || null,
      status:     'pending',
    });

    // Actualizar email/teléfono en el lead
    const leadUpdate = {};
    if (email && !lead.email) leadUpdate.email = email;
    if (phone && !lead.phone) leadUpdate.phone = phone;
    if (Object.keys(leadUpdate).length) {
      await db.update(db.leads, { _id: lead._id }, leadUpdate).catch(() => null);
    }

    // Entrega real
    if (email && magnet.delivery !== 'dm') {
      const subject = `Acá tenés: ${magnet.title}`;
      const html = buildMagnetEmail(magnet, lead);
      const r = await sendEmail({
        to: email, subject, html,
        tag: 'lead_magnet',
        userId: null,
      });
      await db.update(db.magnetDeliveries,
        { account_id: account._id, lead_id: lead._id, magnet_id: magnet._id },
        { status: r.ok ? 'sent' : 'failed', deliveryError: r.ok ? null : (r.error || 'unknown') });
    }

    console.log(`🧲 Magnet "${magnet.title}" entregado a ${email || phone} (lead ${lead._id.slice(0,8)})`);
    return { delivered: true, magnet, email, phone };
  } catch (e) {
    console.error('tryDeliverMagnet error:', e.message);
    return { delivered: false, error: e.message };
  }
}

function buildMagnetEmail(magnet, lead) {
  const name = lead.ig_username ? `@${lead.ig_username}` : 'hola';
  const ctaButton = magnet.delivery_url
    ? `<a href="${escape(magnet.delivery_url)}" style="display:inline-block;background:#f97316;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:20px 0">Abrir ${escape(magnet.title)}</a>`
    : '';
  const body = magnet.description ? `<p style="color:#475569;line-height:1.6">${escape(magnet.description)}</p>` : '';

  return `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="background:#fff;border-radius:12px;padding:36px 32px;border:1px solid #e2e8f0">
      <div style="font-size:28px;margin-bottom:16px">🧲</div>
      <h1 style="color:#0f172a;font-size:22px;margin:0 0 12px">${escape(magnet.title)}</h1>
      <p style="color:#64748b;margin:0 0 6px;font-size:14px">Hola ${escape(name)},</p>
      <p style="color:#334155;line-height:1.6;margin:0 0 16px">Acá tenés el recurso que te prometí 👇</p>
      ${body}
      ${ctaButton}
      <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin-top:24px">
        Si tenés alguna duda mientras lo revisás, respondé este mail o seguí la conversación por Instagram.
      </p>
    </div>
    <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px">
      Enviado automáticamente desde DMCloser
    </p>
  </div>
</body></html>`;
}

function escape(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

module.exports = { tryDeliverMagnet };
