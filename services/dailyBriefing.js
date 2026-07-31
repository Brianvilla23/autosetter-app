/**
 * Atinov — Briefing diario proactivo al dueño
 *
 * Cada mañana el dueño recibe (Telegram si lo tiene configurado, sino email)
 * el resumen de lo que su agente hizo en las últimas 24h: conversaciones
 * atendidas, cuántas llegaron fuera de horario, velocidad de respuesta,
 * leads nuevos, HOT esperando, notas de voz y fotos entendidas, follow-ups.
 *
 * Es el "morning briefing" que Meta tiene en waitlist para su Business Agent
 * — acá está en producción. Además es el vehículo del argumento speed-to-lead
 * (responder <5 min hace al lead 21x más propenso a calificar): el dueño VE
 * cada mañana el valor en números, antes de que llegue el cobro mensual.
 *
 * Idempotente por día (dailyBriefingSentAt en el user). Se envía después de
 * las 12:00 UTC (~8-9am Chile). Si no hubo actividad, no se manda nada.
 * Opt-out: user.daily_briefing_enabled = false.
 */

const db = require('../db/database');
const { sendTelegram, sendEmail } = require('./notifications');

const APP_URL = () => process.env.APP_URL || 'https://atinov.com';
const SEND_AFTER_UTC_HOUR = 12;

// Horario "de oficina" en Chile: 9:00-19:59. Fuera de eso, el mensaje habría
// quedado sin respuesta hasta el día siguiente sin el agente.
function santiagoHour(dateStr) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Santiago', hour: 'numeric', hour12: false,
    }).format(new Date(dateStr)));
  } catch (e) { return new Date(dateStr).getUTCHours(); }
}
function isAfterHours(dateStr) {
  const h = santiagoHour(dateStr);
  return h >= 20 || h < 9;
}

/**
 * Métricas de las últimas 24h para una cuenta. También la usa el widget de
 * ventas: "esto hizo tu agente anoche".
 */
async function buildDailyStats(accountId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const leads = await db.find(db.leads, { account_id: accountId });
  const leadIds = new Set(leads.map(l => l._id));

  // Mensajes de las últimas 24h de los leads de esta cuenta
  const allRecent = (await db.find(db.messages, { createdAt: { $gte: since } }))
    .filter(m => leadIds.has(m.lead_id));

  const userMsgs  = allRecent.filter(m => m.role === 'user');
  const agentMsgs = allRecent.filter(m => m.role === 'agent');

  const conversaciones = new Set(userMsgs.map(m => m.lead_id)).size;
  const fueraDeHorario = new Set(
    userMsgs.filter(m => isAfterHours(m.createdAt)).map(m => m.lead_id)
  ).size;

  const notasDeVoz = userMsgs.filter(m => m.media === 'audio').length;
  const fotos      = userMsgs.filter(m => m.media === 'image').length;

  // Velocidad de respuesta: mediana de (msg user → siguiente msg agent) por
  // lead. Pares sobre 30 min se excluyen (takeover humano / límite de plan).
  const byLead = {};
  for (const m of allRecent) (byLead[m.lead_id] ||= []).push(m);
  const gaps = [];
  for (const msgs of Object.values(byLead)) {
    msgs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role === 'user' && msgs[i + 1].role === 'agent') {
        const s = (new Date(msgs[i + 1].createdAt) - new Date(msgs[i].createdAt)) / 1000;
        if (s >= 0 && s <= 1800) gaps.push(s);
      }
    }
  }
  gaps.sort((a, b) => a - b);
  const respuestaMedianaSeg = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;

  const leadsNuevos = leads.filter(l => l.createdAt >= since).length;
  const hotPendientes = leads.filter(l => l.qualification === 'hot' && !l.is_converted).length;

  const followupsEnviados = (await db.find(db.followups, { account_id: accountId }))
    .filter(f => f.sent_at && f.sent_at >= since).length;

  return {
    conversaciones, fueraDeHorario, respuestaMedianaSeg,
    leadsNuevos, hotPendientes, notasDeVoz, fotos, followupsEnviados,
    respuestasAgente: agentMsgs.length,
  };
}

function hayActividad(s) {
  // Solo actividad DE LA VENTANA de 24h. hotPendientes queda fuera a
  // propósito: un HOT estancado sin convertir dispararía el briefing todos
  // los días con "0 conversaciones".
  return s.conversaciones > 0 || s.leadsNuevos > 0 || s.followupsEnviados > 0;
}

function fmtRespuesta(seg) {
  if (seg === null) return null;
  if (seg < 60) return `${seg} segundos`;
  return `${Math.round(seg / 60)} min`;
}

function briefingTexts(stats) {
  const lines = [];
  if (stats.conversaciones > 0) {
    const c = stats.conversaciones === 1 ? '1 conversación atendida' : `${stats.conversaciones} conversaciones atendidas`;
    lines.push(`💬 ${c}${stats.fueraDeHorario ? ` — ${stats.fueraDeHorario} llegaron fuera de horario y no se perdieron` : ''}`);
  }
  const vel = fmtRespuesta(stats.respuestaMedianaSeg);
  if (vel) lines.push(`⚡ Respuesta típica: ${vel} (responder en <5 min hace al lead 21x más propenso a calificar)`);
  if (stats.leadsNuevos)   lines.push(`🆕 ${stats.leadsNuevos} lead${stats.leadsNuevos === 1 ? '' : 's'} nuevo${stats.leadsNuevos === 1 ? '' : 's'} en el CRM`);
  if (stats.hotPendientes) lines.push(`🔥 ${stats.hotPendientes} lead${stats.hotPendientes === 1 ? '' : 's'} HOT esperando que entres a cerrar`);
  const media = [];
  if (stats.notasDeVoz) media.push(`🎤 ${stats.notasDeVoz} nota${stats.notasDeVoz === 1 ? '' : 's'} de voz`);
  if (stats.fotos)      media.push(`🖼️ ${stats.fotos} foto${stats.fotos === 1 ? '' : 's'}`);
  if (media.length)     lines.push(`${media.join(' · ')} entendida${(stats.notasDeVoz + stats.fotos) === 1 ? '' : 's'} y respondida${(stats.notasDeVoz + stats.fotos) === 1 ? '' : 's'}`);
  if (stats.followupsEnviados) lines.push(`📅 ${stats.followupsEnviados} follow-up${stats.followupsEnviados === 1 ? '' : 's'} enviado${stats.followupsEnviados === 1 ? '' : 's'} a leads que no respondían`);
  return lines;
}

async function sendDailyBriefingToUser(user) {
  if (!user.account_id) return { skipped: 'sin cuenta' };
  const stats = await buildDailyStats(user.account_id);
  if (!hayActividad(stats)) return { skipped: 'sin actividad' };

  const lines = briefingTexts(stats);
  const n = user.notifications || {};

  // Telegram primero (instantáneo, donde ya recibe las alertas HOT)
  if (n.telegram_enabled && n.telegram_bot_token && n.telegram_chat_id) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = [
      `☀️ <b>Esto hizo tu agente en las últimas 24h</b>`,
      ``,
      ...lines.map(esc),
      ``,
      `📊 <a href="${APP_URL()}/app">Ver el panel</a>`,
    ].join('\n');
    const r = await sendTelegram({ botToken: n.telegram_bot_token, chatId: n.telegram_chat_id, text });
    if (r.ok) return { sent: 'telegram' };
    // Si Telegram falla, cae a email
  }

  const to = n.email_address || user.email;
  if (!to || n.email_enabled === false) return { skipped: 'sin canal' };
  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:24px">
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:26px">
        <h2 style="margin:0 0 14px;font-size:19px">☀️ Esto hizo tu agente en las últimas 24h</h2>
        ${lines.map(l => `<p style="margin:0 0 9px;color:#334155;font-size:14.5px;line-height:1.55">${l}</p>`).join('')}
        <a href="${APP_URL()}/app" style="display:inline-block;margin-top:14px;background:#111;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Ver el panel →</a>
      </div>
    </div>`;
  const r = await sendEmail({ to, subject: '☀️ Esto hizo tu agente en las últimas 24 horas', html });
  return r.ok ? { sent: 'email' } : { skipped: 'email falló' };
}

/**
 * Sweep idempotente — corre cada 30 min desde server.js; envía una vez al
 * día por user, después de las SEND_AFTER_UTC_HOUR.
 */
async function sweepDailyBriefings({ force = false, onlyUserId = null } = {}) {
  const now = new Date();
  if (!force && now.getUTCHours() < SEND_AFTER_UTC_HOUR) return { skipped: 'muy temprano' };

  const todayKey = now.toISOString().slice(0, 10);
  const users = await db.find(db.users, onlyUserId ? { _id: onlyUserId } : {});
  let sent = 0, skipped = 0;

  for (const u of users) {
    if (u.daily_briefing_enabled === false) { skipped++; continue; }
    if (!force && u.dailyBriefingSentAt && u.dailyBriefingSentAt.slice(0, 10) === todayKey) { skipped++; continue; }
    try {
      const r = await sendDailyBriefingToUser(u);
      if (r.sent) {
        await db.update(db.users, { _id: u._id }, { dailyBriefingSentAt: now.toISOString() });
        sent++;
        console.log(`☀️ Briefing diario → ${u.email} (${r.sent})`);
      } else {
        // Sin actividad también cuenta como "hecho hoy" para no re-evaluar cada 30 min
        if (r.skipped === 'sin actividad') {
          await db.update(db.users, { _id: u._id }, { dailyBriefingSentAt: now.toISOString() });
        }
        skipped++;
      }
    } catch (e) {
      console.error(`dailyBriefing ${u.email}:`, e.message);
    }
  }
  return { sent, skipped };
}

module.exports = { buildDailyStats, sweepDailyBriefings, sendDailyBriefingToUser };
