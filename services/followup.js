/**
 * DMCloser — Follow-Up Automático
 *
 * ESTRATEGIA: el bot le escribe al lead si lleva >N horas sin responder,
 * siempre DENTRO de la ventana 24h de Instagram (requisito de la API),
 * máximo 2 intentos por lead. 100% compliant con ToS de Meta.
 *
 * Flujo:
 *  1. scheduleFollowUps(): recorre leads elegibles → crea una entrada en
 *     `followups` con scheduled_for calculado (último msg user + delay)
 *  2. processFollowUps(): envía los follow-ups cuya scheduled_for ya pasó
 *
 * Dos workers independientes (agendamiento + envío) corren cada 60s.
 */

const db                     = require('../db/database');
const { generateReply }      = require('./openai');
const { sendMessage }        = require('./meta');

// Config por defecto (puede sobreescribirse por agente)
const DEFAULT_DELAY_HOURS    = 3;
const MAX_ATTEMPTS           = 2;
const WINDOW_HOURS           = 23.5;   // dentro de ventana 24h IG con margen
const SECOND_DELAY_HOURS     = 20;     // segundo follow-up 20h después del primero

// ─────────────────────────────────────────────────────────────────────────────
// AGENDAMIENTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recorre leads activos y crea tareas de follow-up para los elegibles.
 * Elegibilidad:
 *  - lead no está bypassed ni convertido
 *  - agent tiene follow-up habilitado
 *  - último mensaje fue del agente (o sistema) y hay al menos 1 msg del user antes
 *  - pasaron >= delay horas desde el último mensaje del USER
 *  - todavía estamos dentro de la ventana de 24h del último msg del user
 *  - no hay otro follow-up pendiente para este lead
 *  - no se excedió MAX_ATTEMPTS
 */
async function scheduleFollowUps() {
  const now = new Date();

  const agents = await db.find(db.agents, { enabled: true });
  const agentsWithFollowup = agents.filter(a => a.followup_enabled === true);
  if (agentsWithFollowup.length === 0) return;

  for (const agent of agentsWithFollowup) {
    const delayHours = Number(agent.followup_delay_hours) || DEFAULT_DELAY_HOURS;

    // Leads candidatos: de esta cuenta, no bypassed, no converted
    const leads = await db.find(db.leads, { account_id: agent.account_id });
    const eligibleLeads = leads.filter(l =>
      !l.is_bypassed && !l.is_converted && l.automation !== 'paused'
    );

    for (const lead of eligibleLeads) {
      // ¿Excedió max attempts?
      const previousFollowups = await db.find(db.followups, {
        lead_id: lead._id, cancelled: { $ne: true }
      });
      if (previousFollowups.length >= MAX_ATTEMPTS) continue;

      // ¿Ya hay uno pendiente de enviar?
      const pending = previousFollowups.find(f => !f.sent_at && !f.cancelled);
      if (pending) continue;

      // Buscar último mensaje del lead (user)
      const messages = await db.find(db.messages, { lead_id: lead._id },
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      if (messages.length === 0) continue;

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role !== 'agent' && lastMsg.role !== 'manual') continue; // solo si bot habló último

      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (!lastUserMsg) continue; // nunca respondió el user

      const lastUserAt = new Date(lastUserMsg.createdAt);
      const hoursSinceUser = (now - lastUserAt) / (1000 * 60 * 60);

      // Fuera de ventana 24h IG → nada que hacer
      if (hoursSinceUser >= WINDOW_HOURS) continue;

      // Calcular cuándo agendar
      const nthAttempt = previousFollowups.length + 1;
      const targetDelay = nthAttempt === 1 ? delayHours : (delayHours + SECOND_DELAY_HOURS);

      // ¿Ya es hora?
      if (hoursSinceUser < targetDelay) continue;

      // Si ya estamos muy cerca de 24h (menos de 30 min), agendar AHORA para no perder ventana
      const timeLeftInWindow = WINDOW_HOURS - hoursSinceUser;
      if (timeLeftInWindow < 0.5) continue; // no alcanza

      // Agendar para ya (o con pequeña aleatoriedad humana 30s-90s)
      const humanJitterMs = (30 + Math.random() * 60) * 1000;
      const scheduledFor = new Date(now.getTime() + humanJitterMs).toISOString();

      await db.insert(db.followups, {
        lead_id:       lead._id,
        account_id:    lead.account_id,
        agent_id:      agent._id,
        attempt_num:   nthAttempt,
        scheduled_for: scheduledFor,
        sent_at:       null,
        cancelled:     false,
      });
      console.log(`📅 Follow-up #${nthAttempt} agendado @${lead.ig_username} → ${scheduledFor}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENVÍO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa follow-ups agendados cuya fecha ya llegó.
 * Genera el mensaje con IA (contexto del lead) y lo manda.
 */
async function processFollowUps() {
  const now = new Date().toISOString();

  const allFollowups = await db.find(db.followups, {});
  const due = allFollowups.filter(f =>
    !f.sent_at && !f.cancelled && f.scheduled_for <= now
  );
  if (due.length === 0) return;

  for (const fu of due) {
    try {
      const lead    = await db.findOne(db.leads,    { _id: fu.lead_id });
      const agent   = await db.findOne(db.agents,   { _id: fu.agent_id });
      const account = await db.findOne(db.accounts, { _id: fu.account_id });
      if (!lead || !agent || !account) {
        await db.update(db.followups, { _id: fu._id }, { cancelled: true, reason: 'entidades faltantes' });
        continue;
      }

      // Cancelar si ya respondió el lead entre que se agendó y ahora
      const messages = await db.find(db.messages, { lead_id: lead._id },
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'user') {
        await db.update(db.followups, { _id: fu._id }, { cancelled: true, reason: 'lead respondió' });
        console.log(`🚫 Follow-up cancelado @${lead.ig_username} — lead respondió`);
        continue;
      }

      // Cancelar si se bypassó/convirtió mientras tanto
      if (lead.is_bypassed || lead.is_converted) {
        await db.update(db.followups, { _id: fu._id }, { cancelled: true, reason: 'lead bypassed/converted' });
        continue;
      }

      // Cancelar si salimos de ventana 24h
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        const hoursSince = (Date.now() - new Date(lastUserMsg.createdAt)) / 3600000;
        if (hoursSince >= WINDOW_HOURS) {
          await db.update(db.followups, { _id: fu._id }, { cancelled: true, reason: 'fuera de ventana 24h' });
          console.log(`🚫 Follow-up cancelado @${lead.ig_username} — fuera de ventana 24h`);
          continue;
        }
      }

      // Generar mensaje de follow-up contextual
      const allKnowledge = await db.find(db.knowledge, { account_id: account._id });
      const knowledge    = allKnowledge.filter(k => k.is_main || (k.agent_ids || []).includes(agent._id));
      const allLinks     = await db.find(db.links, { account_id: account._id });
      const links        = (agent.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);
      const settings     = await db.findOne(db.settings, { account_id: account._id });
      const apiKey       = process.env.OPENAI_API_KEY || settings?.openai_key;

      const followupHint = fu.attempt_num === 1
        ? `FOLLOW-UP 1/2: El prospecto no ha respondido en las últimas horas. Envía un mensaje corto y cálido que le recuerde suavemente que estás ahí. NO seas agresivo. Ejemplos: "Oye, ¿pudiste ver mi mensaje? sin presión 😊", "¿Quedaste con alguna duda?", "¿Cómo vas con eso que me contaste?". Máximo 1 pregunta. Adapta al contexto de la última conversación.`
        : `FOLLOW-UP 2/2 (ÚLTIMO): Es el segundo y último intento. Haz un cierre suave y empático — dale una salida digna. Algo como: "Hey, entiendo si no es el momento, si alguna vez quieres retomar aquí estaré 😊". NO pidas nada. Es despedida amable.`;

      const history = messages;
      const reply = await generateReply({
        agent,
        knowledge,
        links,
        conversationHistory: history,
        newMessage: '[FOLLOW-UP AUTOMÁTICO — generar mensaje proactivo sin responder a un mensaje del prospecto]',
        accountId: account._id,
        apiKey,
        extraContext: followupHint,
      });

      // Guardar el mensaje como 'agent' (marcado como followup)
      await db.insert(db.messages, {
        lead_id: lead._id,
        role:    'agent',
        content: reply,
        is_followup: true,
        followup_num: fu.attempt_num,
      });
      await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() });

      // Enviar por IG
      const igUserId = account.ig_platform_id || account.ig_user_id;
      await sendMessage({
        recipientId: lead.ig_user_id,
        text:        reply,
        accessToken: account.access_token,
        igUserId,
        accountId:   account._id,
      });

      await db.update(db.followups, { _id: fu._id }, { sent_at: new Date().toISOString() });
      console.log(`🔔 Follow-up #${fu.attempt_num} → @${lead.ig_username}: ${reply.substring(0, 70)}...`);
    } catch (e) {
      console.error(`❌ Follow-up error (id ${fu._id}):`, e.response?.data || e.message);
      // Marcar como cancelado con error para no reintentar eternamente
      await db.update(db.followups, { _id: fu._id }, { cancelled: true, reason: 'error: ' + e.message });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELAR FOLLOWUPS PENDIENTES cuando el lead responde
// Se llama desde el webhook cuando entra mensaje user.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelPendingForLead(leadId, reason = 'lead respondió') {
  const pending = await db.find(db.followups, { lead_id: leadId });
  for (const fu of pending) {
    if (!fu.sent_at && !fu.cancelled) {
      await db.update(db.followups, { _id: fu._id }, { cancelled: true, reason });
    }
  }
}

module.exports = {
  scheduleFollowUps,
  processFollowUps,
  cancelPendingForLead,
};
