/**
 * DMCloser — Templates de emails transaccionales
 *
 * HTML self-contained (inline CSS) para máxima compatibilidad con clientes
 * de correo (Gmail, Outlook, Apple Mail). Tema dark alineado con landing.
 *
 * Cada template devuelve { subject, html } listo para pasar a sendEmail().
 */

const APP_URL = process.env.APP_URL || 'https://dmcloser-app.up.railway.app';

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT BASE
// ─────────────────────────────────────────────────────────────────────────────
function layout({ preheader, title, body, ctaText, ctaUrl }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a12;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#f0f0ff;">
  <span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:#0a0a12;">${escapeHtml(preheader || '')}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a12;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111120;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden;">
        <!-- header -->
        <tr><td style="padding:32px 36px 0;">
          <div style="display:inline-block;background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%);border-radius:8px;width:36px;height:36px;text-align:center;line-height:36px;font-size:18px;vertical-align:middle;">💬</div>
          <span style="font-weight:800;font-size:20px;color:#f0f0ff;margin-left:10px;vertical-align:middle;">DMCloser</span>
        </td></tr>
        <!-- title -->
        <tr><td style="padding:28px 36px 0;">
          <h1 style="margin:0;font-size:22px;font-weight:700;line-height:1.3;color:#f0f0ff;">${title}</h1>
        </td></tr>
        <!-- body -->
        <tr><td style="padding:18px 36px 24px;color:#a0a0c0;font-size:15px;line-height:1.65;">
          ${body}
        </td></tr>
        ${ctaText && ctaUrl ? `
        <!-- cta -->
        <tr><td style="padding:8px 36px 36px;" align="left">
          <a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%);color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(ctaText)}</a>
        </td></tr>` : ''}
        <!-- footer -->
        <tr><td style="padding:24px 36px 32px;border-top:1px solid rgba(255,255,255,.06);color:#606080;font-size:12.5px;line-height:1.6;">
          © 2026 DMCloser — La Serena, Chile<br>
          <a href="${APP_URL}/terms.html" style="color:#8b5cf6;text-decoration:none;">Términos</a> ·
          <a href="${APP_URL}/privacy.html" style="color:#8b5cf6;text-decoration:none;">Privacidad</a> ·
          <a href="mailto:soporte@dmcloser.app" style="color:#8b5cf6;text-decoration:none;">Soporte</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. WELCOME — tras registro
// ─────────────────────────────────────────────────────────────────────────────
function welcomeEmail({ name, email }) {
  const firstName = (name || email.split('@')[0]).split(' ')[0];
  return {
    subject: '👋 Bienvenido a DMCloser — tu prueba de 3 días está activa',
    html: layout({
      preheader: 'Tu prueba gratuita de 3 días ya está activa. Conectá tu Instagram y el bot empieza a cerrar DMs por vos.',
      title: `Hola ${escapeHtml(firstName)}, bienvenido a DMCloser 👋`,
      body: `
        <p style="margin:0 0 14px;">Acabás de crear tu cuenta y tu <strong style="color:#f0f0ff;">prueba gratuita de 3 días</strong> está activa. Sin tarjeta, sin trampa.</p>
        <p style="margin:0 0 14px;">Para que el bot empiece a trabajar ahora mismo, hay 3 pasos rápidos (~10 minutos):</p>
        <ol style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;"><strong style="color:#f0f0ff;">Conectá tu Instagram Business</strong> desde Settings. El bot solo responde a DMs de esa cuenta.</li>
          <li style="margin-bottom:6px;"><strong style="color:#f0f0ff;">Cargá tu base de conocimiento</strong> — preguntas frecuentes, precios, objeciones típicas.</li>
          <li style="margin-bottom:6px;"><strong style="color:#f0f0ff;">Ajustá el tono de tu agente IA</strong> — así responde como vos, no como un robot.</li>
        </ol>
        <p style="margin:0 0 14px;">Si te trabás en cualquier paso, respondé este email y te ayudo en persona.</p>
      `,
      ctaText: 'Conectar mi Instagram →',
      ctaUrl: `${APP_URL}/app`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TRIAL ENDING — 2 días antes de que venza la prueba
// ─────────────────────────────────────────────────────────────────────────────
function trialEndingEmail({ name, email, daysLeft }) {
  const firstName = (name || email.split('@')[0]).split(' ')[0];
  const d = daysLeft <= 1 ? 'menos de 24 horas' : `${daysLeft} días`;
  return {
    subject: `⏰ ${firstName}, tu prueba gratuita vence en ${d}`,
    html: layout({
      preheader: `Te quedan ${d} de prueba. Elegí plan para no perder tus conversaciones ni el agente que configuraste.`,
      title: `Te quedan ${d} de prueba`,
      body: `
        <p style="margin:0 0 14px;">Hola ${escapeHtml(firstName)} — tu prueba gratuita de DMCloser vence pronto.</p>
        <p style="margin:0 0 14px;">Si activás un plan <strong style="color:#f0f0ff;">antes del vencimiento</strong>, mantenés:</p>
        <ul style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;">Tu cuenta de Instagram conectada (no hay que re-loguear)</li>
          <li style="margin-bottom:6px;">Todas las conversaciones y leads que el bot ya clasificó</li>
          <li style="margin-bottom:6px;">Tu agente IA con las instrucciones y base de conocimiento que cargaste</li>
        </ul>
        <p style="margin:0 0 14px;">Si esperás a que venza, el bot deja de responder DMs — tus prospectos siguen escribiendo pero nadie les contesta.</p>
      `,
      ctaText: 'Elegir plan y seguir →',
      ctaUrl: `${APP_URL}/pricing.html`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SUBSCRIPTION ACTIVATED — tras primer pago exitoso
// ─────────────────────────────────────────────────────────────────────────────
function subscriptionActivatedEmail({ name, email, plan }) {
  const firstName = (name || email.split('@')[0]).split(' ')[0];
  const planName  = String(plan || 'plan').charAt(0).toUpperCase() + String(plan || 'plan').slice(1);
  return {
    subject: `🎉 ¡Bienvenido al plan ${planName}!`,
    html: layout({
      preheader: `Tu suscripción ${planName} está activa. El bot ya está trabajando por vos 24/7.`,
      title: `🎉 ¡Listo ${escapeHtml(firstName)}, estás en el plan ${planName}!`,
      body: `
        <p style="margin:0 0 14px;">Tu suscripción está <strong style="color:#f0f0ff;">activa</strong> y el cobro se procesó correctamente.</p>
        <p style="margin:0 0 14px;">A partir de ahora, el bot responde tus DMs 24/7, clasifica leads HOT/WARM/COLD automáticamente y te notifica cuando alguien está listo para comprar o agendar.</p>
        <p style="margin:0 0 14px;"><strong style="color:#f0f0ff;">Tips para sacarle jugo desde el día 1:</strong></p>
        <ul style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;">Activá las notificaciones push para no perder ningún HOT lead</li>
          <li style="margin-bottom:6px;">Revisá la bandeja de "Conversaciones" todos los días — ahí está el oro</li>
          <li style="margin-bottom:6px;">Si ves respuestas que te chirrían, editá las instrucciones del agente</li>
        </ul>
        <p style="margin:0;">Podés cancelar o cambiar de plan cuando quieras desde tu panel de facturación.</p>
      `,
      ctaText: 'Ir a mi panel →',
      ctaUrl: `${APP_URL}/app`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PAYMENT FAILED — cobro fallido
// ─────────────────────────────────────────────────────────────────────────────
function paymentFailedEmail({ name, email }) {
  const firstName = (name || email.split('@')[0]).split(' ')[0];
  return {
    subject: '⚠️ No pudimos procesar tu pago — acción requerida',
    html: layout({
      preheader: 'Tu próximo cobro de DMCloser falló. Actualizá tu método de pago en 7 días para evitar la suspensión.',
      title: `${escapeHtml(firstName)}, tu pago falló`,
      body: `
        <p style="margin:0 0 14px;">Intentamos cobrar tu suscripción de DMCloser pero el pago no se pudo procesar. Puede ser por saldo insuficiente, tarjeta vencida o un bloqueo del banco.</p>
        <p style="margin:0 0 14px;"><strong style="color:#f0f0ff;">Qué pasa ahora:</strong></p>
        <ul style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;">Durante <strong style="color:#f0f0ff;">7 días</strong> el bot sigue funcionando normalmente.</li>
          <li style="margin-bottom:6px;">El sistema reintenta el cobro automáticamente los días 3 y 5.</li>
          <li style="margin-bottom:6px;">Si el día 7 sigue sin cobrar, suspendemos la cuenta hasta regularizar.</li>
        </ul>
        <p style="margin:0 0 14px;">Para evitar la suspensión, entrá al panel y actualizá tu método de pago:</p>
      `,
      ctaText: 'Actualizar método de pago →',
      ctaUrl: `${APP_URL}/app`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. TRIAL ENDED — cuando la prueba ya venció
// ─────────────────────────────────────────────────────────────────────────────
function trialEndedEmail({ name, email }) {
  const firstName = (name || email.split('@')[0]).split(' ')[0];
  return {
    subject: '📭 Tu prueba de DMCloser venció — el bot está en pausa',
    html: layout({
      preheader: 'Pausamos tu cuenta pero tus datos siguen ahí. Activá un plan cuando quieras y el bot vuelve al toque.',
      title: `${escapeHtml(firstName)}, tu prueba terminó`,
      body: `
        <p style="margin:0 0 14px;">La prueba gratuita de DMCloser llegó a su fin. El bot dejó de responder DMs, pero <strong style="color:#f0f0ff;">tus datos, agente y conexión a Instagram siguen intactos</strong>.</p>
        <p style="margin:0 0 14px;">Cuando quieras retomar, activás un plan en 1 click y el bot vuelve a trabajar desde donde lo dejó.</p>
        <p style="margin:0 0 14px;">¿Necesitás más tiempo para evaluarlo o tenés dudas? Respondé este email y hablamos.</p>
      `,
      ctaText: 'Ver planes →',
      ctaUrl: `${APP_URL}/pricing.html`,
    }),
  };
}

module.exports = {
  welcomeEmail,
  trialEndingEmail,
  subscriptionActivatedEmail,
  paymentFailedEmail,
  trialEndedEmail,
};
