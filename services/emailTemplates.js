/**
 * DMCloser — Templates de emails transaccionales
 *
 * HTML self-contained (inline CSS) para máxima compatibilidad con clientes
 * de correo (Gmail, Outlook, Apple Mail). Tema dark alineado con landing.
 *
 * Cada template devuelve { subject, html } listo para pasar a sendEmail().
 *
 * Reposicionado 2026-05-03: "bot/automatización" → "asistente con IA",
 * "setter" → "atención al cliente", paleta esmeralda+cian, tuteo neutro
 * estricto. Esto debe ser consistente con landing/pricing/about/contact
 * para que un compliance reviewer (Polar/Stripe) que se registre vea
 * la misma narrativa por todo el funnel.
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
          <div style="display:inline-block;background:linear-gradient(135deg,#10b981 0%,#06b6d4 100%);border-radius:8px;width:36px;height:36px;text-align:center;line-height:36px;font-size:18px;vertical-align:middle;">💬</div>
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
          <a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(135deg,#10b981 0%,#06b6d4 100%);color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(ctaText)}</a>
        </td></tr>` : ''}
        <!-- footer -->
        <tr><td style="padding:24px 36px 32px;border-top:1px solid rgba(255,255,255,.06);color:#606080;font-size:12.5px;line-height:1.6;">
          © 2026 DMCloser — La Serena, Chile<br>
          <a href="${APP_URL}/about.html" style="color:#10b981;text-decoration:none;">Sobre nosotros</a> ·
          <a href="${APP_URL}/contact.html" style="color:#10b981;text-decoration:none;">Contacto</a> ·
          <a href="${APP_URL}/terms.html" style="color:#10b981;text-decoration:none;">Términos</a> ·
          <a href="${APP_URL}/privacy.html" style="color:#10b981;text-decoration:none;">Privacidad</a>
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
      preheader: 'Tu prueba gratuita de 3 días ya está activa. Conecta tu Instagram y el asistente empieza a atender tus DMs.',
      title: `Hola ${escapeHtml(firstName)}, bienvenido a DMCloser 👋`,
      body: `
        <p style="margin:0 0 14px;">Acabas de crear tu cuenta y tu <strong style="color:#f0f0ff;">prueba gratuita de 3 días</strong> está activa. Sin tarjeta, sin trampa.</p>
        <p style="margin:0 0 14px;">Para que tu asistente empiece a atender mensajes ahora mismo, hay 3 pasos rápidos (~10 minutos):</p>
        <ol style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;"><strong style="color:#f0f0ff;">Conecta tu Instagram Business</strong> desde Settings. El asistente solo opera en esa cuenta.</li>
          <li style="margin-bottom:6px;"><strong style="color:#f0f0ff;">Carga tu base de conocimiento</strong> — preguntas frecuentes, precios, políticas, link de reserva.</li>
          <li style="margin-bottom:6px;"><strong style="color:#f0f0ff;">Ajusta el tono del asistente</strong> — así sugiere respuestas con tu estilo, no genéricas.</li>
        </ol>
        <p style="margin:0 0 14px;">Si te trabas en cualquier paso, responde este email y te ayudo en persona.</p>
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
      preheader: `Te quedan ${d} de prueba. Activa tu plan para no perder tus conversaciones ni el asistente que configuraste.`,
      title: `Te quedan ${d} de prueba`,
      body: `
        <p style="margin:0 0 14px;">Hola ${escapeHtml(firstName)} — tu prueba gratuita de DMCloser vence pronto.</p>
        <p style="margin:0 0 14px;">Si activas tu plan <strong style="color:#f0f0ff;">antes del vencimiento</strong>, mantienes:</p>
        <ul style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;">Tu cuenta de Instagram conectada (no hay que re-loguear)</li>
          <li style="margin-bottom:6px;">Todas las conversaciones priorizadas y los clientes atendidos</li>
          <li style="margin-bottom:6px;">Tu asistente con las instrucciones y base de conocimiento que cargaste</li>
        </ul>
        <p style="margin:0 0 14px;">Si esperas a que venza, el asistente queda pausado — los mensajes nuevos siguen llegando, pero sin priorización ni sugerencias hasta que reactives.</p>
      `,
      ctaText: 'Activar mi plan →',
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
      preheader: `Tu suscripción ${planName} está activa. El asistente ya está trabajando contigo 24/7.`,
      title: `🎉 ¡Listo ${escapeHtml(firstName)}, estás en el plan ${planName}!`,
      body: `
        <p style="margin:0 0 14px;">Tu suscripción está <strong style="color:#f0f0ff;">activa</strong> y el cobro se procesó correctamente.</p>
        <p style="margin:0 0 14px;">A partir de ahora, el asistente atiende tus DMs con apoyo de IA, prioriza consultas urgentes y te alerta cuando un cliente está listo para comprar o agendar.</p>
        <p style="margin:0 0 14px;"><strong style="color:#f0f0ff;">Tips para sacarle jugo desde el día 1:</strong></p>
        <ul style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;">Activa las notificaciones push para no perder ningún cliente prioritario</li>
          <li style="margin-bottom:6px;">Revisa la bandeja de "Conversaciones" todos los días — ahí está el oro</li>
          <li style="margin-bottom:6px;">Si ves respuestas que te chirrían, edita las instrucciones del asistente</li>
        </ul>
        <p style="margin:0;">Puedes cancelar o cambiar de plan cuando quieras desde tu panel de facturación.</p>
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
      preheader: 'Tu próximo cobro de DMCloser falló. Actualiza tu método de pago en 7 días para evitar la suspensión.',
      title: `${escapeHtml(firstName)}, tu pago falló`,
      body: `
        <p style="margin:0 0 14px;">Intentamos cobrar tu suscripción de DMCloser pero el pago no se pudo procesar. Puede ser por saldo insuficiente, tarjeta vencida o un bloqueo del banco.</p>
        <p style="margin:0 0 14px;"><strong style="color:#f0f0ff;">Qué pasa ahora:</strong></p>
        <ul style="margin:0 0 14px;padding-left:22px;color:#a0a0c0;">
          <li style="margin-bottom:6px;">Durante <strong style="color:#f0f0ff;">7 días</strong> tu asistente sigue funcionando normalmente.</li>
          <li style="margin-bottom:6px;">El sistema reintenta el cobro automáticamente los días 3 y 5.</li>
          <li style="margin-bottom:6px;">Si el día 7 sigue sin cobrar, suspendemos la cuenta hasta regularizar.</li>
        </ul>
        <p style="margin:0 0 14px;">Para evitar la suspensión, entra al panel y actualiza tu método de pago:</p>
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
    subject: '📭 Tu prueba de DMCloser venció — asistente en pausa',
    html: layout({
      preheader: 'Pausamos tu cuenta pero tus datos siguen intactos. Activa un plan cuando quieras y el asistente vuelve a operar.',
      title: `${escapeHtml(firstName)}, tu prueba terminó`,
      body: `
        <p style="margin:0 0 14px;">La prueba gratuita de DMCloser llegó a su fin. El asistente quedó pausado, pero <strong style="color:#f0f0ff;">tus datos, configuración y conexión a Instagram siguen intactos</strong>.</p>
        <p style="margin:0 0 14px;">Cuando quieras retomar, activas tu plan en 1 click y el asistente vuelve a operar desde donde lo dejó.</p>
        <p style="margin:0 0 14px;">¿Necesitas más tiempo para evaluarlo o tienes dudas? Responde este email y hablamos.</p>
      `,
      ctaText: 'Ver el plan Founder →',
      ctaUrl: `${APP_URL}/pricing.html`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. ACCOUNT NEEDS REAUTH — token Meta caducado y refresh falló
// ─────────────────────────────────────────────────────────────────────────────
// Se dispara cuando services/metaRefresh agotó retries y el asistente no
// puede operar hasta que el usuario reconecte Instagram (OAuth nuevo).
function needsReauthEmail({ name, email }) {
  const firstName = (name || email.split('@')[0]).split(' ')[0];
  return {
    subject: '🔌 Reconecta tu Instagram para que el asistente vuelva a operar',
    html: layout({
      preheader: 'El permiso de Meta para tu cuenta caducó y no se pudo renovar automáticamente. Necesitamos que vuelvas a conectar Instagram (1 click).',
      title: `${escapeHtml(firstName)}, necesitamos que reconectes Instagram`,
      body: `
        <p style="margin:0 0 14px;">El permiso de Meta para tu cuenta de Instagram caducó. Intentamos renovarlo automáticamente pero Meta lo rechazó (puede ser porque revocaste el acceso, cambiaste de cuenta o pasó demasiado tiempo).</p>
        <p style="margin:0 0 14px;"><strong style="color:#f0f0ff;">Mientras esto no se resuelva, el asistente no puede leer ni responder DMs nuevos</strong>. Tus datos quedan intactos.</p>
        <p style="margin:0 0 14px;">Reconectar es un click desde tu panel: te lleva al OAuth oficial de Meta y al volver el asistente reanuda automáticamente.</p>
      `,
      ctaText: 'Reconectar Instagram →',
      ctaUrl: `${APP_URL}/app`,
    }),
  };
}

module.exports = {
  welcomeEmail,
  trialEndingEmail,
  subscriptionActivatedEmail,
  paymentFailedEmail,
  trialEndedEmail,
  needsReauthEmail,
};
