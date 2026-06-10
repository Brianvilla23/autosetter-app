/**
 * Atinov — Reporte semanal "Tu agente esta semana"
 *
 * Arma las estadísticas de los últimos 7 días por cuenta (NeDB) + lo que el
 * agente aprendió (RAG/Supabase, si está activo) y manda el email del lunes.
 * El valor: el cliente SIENTE lo que hizo su agente sin abrir la app.
 *
 * Idempotente: guarda weeklyReportSentAt en el user y no re-manda en la
 * misma semana. Si no hay actividad ni aprendizaje, no manda (cero spam).
 */

const db = require('../db/database');

/** Lunes 00:00 UTC de la semana actual (frontera de idempotencia). */
function startOfWeek(now = new Date()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // lunes=0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Junta los números de los últimos 7 días para una cuenta. */
async function buildWeeklyStats(accountId) {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const leads = await db.find(db.leads, { account_id: accountId });
  const leadIds = new Set(leads.map(l => l._id));
  const msgs = await db.find(db.messages, {});
  const weekMsgs = msgs.filter(m => leadIds.has(m.lead_id) && (m.createdAt || '') >= since);

  const stats = {
    conversaciones: new Set(weekMsgs.map(m => m.lead_id)).size,
    nuevos:  leads.filter(l => (l.createdAt || '') >= since).length,
    hot:     leads.filter(l => l.qualification === 'hot' && l.pipeline_stage !== 'ganado' && l.pipeline_stage !== 'perdido').length,
    ganados: leads.filter(l => l.pipeline_stage === 'ganado' && (l.stage_changed_at || '') >= since).length,
    top_objecion: null,
    top_perdida:  null,
    huecos: 0,
  };

  // Aprendizaje del RAG (si está activo): objeción top, pérdida top, huecos
  try {
    const { isEnabled, getClient } = require('./rag/supabase');
    if (isEnabled()) {
      const client = getClient();
      if (client) {
        const { data } = await client
          .from('conversation_insights')
          .select('kind, text, created_at')
          .eq('account_id', accountId)
          .order('created_at', { ascending: false })
          .limit(300);
        const rows = data || [];
        const top = (kind) => {
          // preferir lo de la semana; si no hay, el histórico más frecuente
          const all = rows.filter(r => r.kind === kind);
          const week = all.filter(r => (r.created_at || '') >= since);
          const pool = week.length ? week : all;
          if (!pool.length) return null;
          const counts = new Map();
          for (const r of pool) {
            const k = r.text.toLowerCase().trim();
            counts.set(k, (counts.get(k) || { n: 0, text: r.text }));
            counts.get(k).n++;
          }
          return [...counts.values()].sort((a, b) => b.n - a.n)[0].text;
        };
        stats.top_objecion = top('objecion');
        stats.top_perdida  = top('motivo_perdida');
        stats.huecos = new Set(rows.filter(r => r.kind === 'hueco_conocimiento').map(r => r.text.toLowerCase().trim())).size;
      }
    }
  } catch (e) { /* RAG opcional */ }

  return stats;
}

/** ¿Hay algo que valga la pena contar? (evita mails vacíos) */
function isWorthSending(s) {
  return (s.conversaciones + s.nuevos + s.hot + s.ganados) > 0 || s.huecos > 0 || !!s.top_objecion;
}

/**
 * Sweep: manda el reporte a cada user activo que no lo recibió esta semana.
 * Pensado para correr cada hora; solo actúa lunes ≥ 11 UTC (≈8am Chile).
 * `force` (admin/test) ignora día/hora e idempotencia.
 */
async function sweepWeeklyReports({ force = false, onlyAccountId = null } = {}) {
  const now = new Date();
  if (!force) {
    const isMonday = now.getUTCDay() === 1;
    if (!isMonday || now.getUTCHours() < 11) return { skipped: 'not_monday_morning' };
  }

  const { sendEmail } = require('./email');
  const { weeklyReportEmail } = require('./emailTemplates');
  const weekStart = startOfWeek(now).toISOString();

  const users = await db.find(db.users, {});
  let sent = 0, skipped = 0;
  for (const u of users) {
    if (!u.email || !u.accountId) { skipped++; continue; }
    if (onlyAccountId && u.accountId !== onlyAccountId) continue;
    if (!force && u.weeklyReportSentAt && u.weeklyReportSentAt >= weekStart) { skipped++; continue; }

    try {
      const stats = await buildWeeklyStats(u.accountId);
      if (!force && !isWorthSending(stats)) { skipped++; continue; }

      const tpl = weeklyReportEmail({ name: u.name, email: u.email, stats });
      const r = await sendEmail({ to: u.email, subject: tpl.subject, html: tpl.html, userId: u._id, tag: 'weekly_report' });
      if (r.ok) {
        await db.update(db.users, { _id: u._id }, { weeklyReportSentAt: new Date().toISOString() });
        sent++;
      } else skipped++;
    } catch (e) {
      console.error(`weeklyReport ${u.email}:`, e.message);
      skipped++;
    }
  }
  if (sent) console.log(`📬 Reporte semanal: ${sent} enviados, ${skipped} omitidos`);
  return { sent, skipped };
}

module.exports = { sweepWeeklyReports, buildWeeklyStats, startOfWeek, isWorthSending };
