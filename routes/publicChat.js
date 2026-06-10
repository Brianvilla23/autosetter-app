/**
 * Atinov — Chat público de la landing
 *
 * Endpoint sin auth para que visitantes de la landing puedan chatear con el
 * agente "Atinov Sales" (Brian, cofundador). Demo viva del producto:
 * el bot responde dudas sobre Atinov usando la knowledge real cargada
 * por el founder.
 *
 * Seguridad:
 * - Rate limit por IP (10 req / minuto, 30 / hora) para no quemar tokens
 * - Mensajes máximo 500 chars
 * - Historial corto (últimos 8 turnos) en el body, no persistimos en DB
 * - Si OpenAI falla o no hay agente configurado → mensaje genérico
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const rateLimit = require('express-rate-limit');

// Rate limit estricto: 10/min y 30/h por IP
const minuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá un minuto y volvé a intentar.' },
});
const hourLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Has alcanzado el límite de mensajes. Volvé en una hora o registrate gratis para usar el bot completo.' },
});

router.use(minuteLimiter);
router.use(hourLimiter);

/**
 * GET /api/public/chat/agent
 * Devuelve info básica del agente del demo (nombre, avatar, mensaje de bienvenida).
 */
router.get('/agent', async (req, res) => {
  try {
    // Buscar el primer agente con name="Atinov Sales" — preset dogfooding
    let agent = await db.findOne(db.agents, { name: 'Atinov Sales', enabled: true });
    // Fallback: cualquier agente del owner admin
    if (!agent) {
      const adminUser = await db.findOne(db.users, { role: 'admin' });
      if (adminUser?.account_id) {
        agent = await db.findOne(db.agents, { account_id: adminUser.account_id, enabled: true });
      }
    }
    if (!agent) {
      return res.json({
        configured: false,
        name: 'Brian',
        avatar: '⚡',
        greeting: 'Hola 👋 Soy Brian, cofundador de Atinov. ¿En qué te puedo ayudar?',
      });
    }
    res.json({
      configured: true,
      name: agent.name === 'Atinov Sales' ? 'Brian' : agent.name,
      avatar: agent.avatar || '⚡',
      greeting: '¡Hey! 👋 Soy el bot de Atinov. Probame: preguntame cualquier cosa sobre cómo funciona, precios, integración. Voy a responderte exactamente como respondería al DM de un lead tuyo.',
    });
  } catch (e) {
    res.json({ configured: false, name: 'Brian', avatar: '⚡', greeting: 'Hola 👋 ¿en qué te ayudo?' });
  }
});

// ── Captura automática de contacto en texto libre ────────────────────────────
function extractContact(text) {
  const t = String(text || '');
  const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/) || [])[0] || null;
  // Teléfono: 8+ dígitos con separadores comunes (evita falsos positivos cortos)
  const phoneRaw = (t.match(/\+?\d[\d\s().-]{7,}\d/) || [])[0] || null;
  const phone = phoneRaw && phoneRaw.replace(/[^\d+]/g, '').length >= 8 ? phoneRaw.trim() : null;
  const ig = (t.match(/@([a-z0-9._]{3,30})\b/i) || [])[1] || null;
  return { email, phone, ig };
}

/**
 * POST /api/public/chat
 * Body: { message, history?: [{role, content}, ...], visitorId? }
 *
 * RECOLECCIÓN AUTOMÁTICA: las conversaciones con engagement real (2+ mensajes
 * del visitante) o que dejan un contacto se persisten como LEADS del canal
 * 'landing' en la cuenta del founder — aparecen en su CRM, alimentan el RAG
 * (Inteligencia: objeciones/huecos de la landing) y se puntúan. El chat de
 * demo ES Atinov funcionando: dogfooding completo.
 */
router.post('/', async (req, res) => {
  try {
    const message = String(req.body.message || '').slice(0, 500).trim();
    if (!message) return res.status(400).json({ error: 'Mensaje vacío' });

    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    // visitorId: uuid generado por el frontend (localStorage). Sin él no persistimos.
    const visitorId = /^[a-z0-9-]{8,40}$/i.test(String(req.body.visitorId || ''))
      ? String(req.body.visitorId) : null;

    // Buscar el agente "Atinov Sales" del founder admin
    const adminUser = await db.findOne(db.users, { role: 'admin' });
    if (!adminUser?.account_id) {
      return res.json({
        reply: 'El chat de demo no está configurado todavía. Probá la app gratis y experimentá la IA con tu propia cuenta.',
        configured: false,
      });
    }

    let agent = await db.findOne(db.agents, { account_id: adminUser.account_id, name: 'Atinov Sales', enabled: true });
    if (!agent) {
      agent = await db.findOne(db.agents, { account_id: adminUser.account_id, enabled: true });
    }
    if (!agent) {
      return res.json({
        reply: 'El bot demo está en mantenimiento. Probá Atinov gratis 3 días y te respondemos personalmente cualquier duda.',
        configured: false,
      });
    }

    // Cargar knowledge + links del agente
    const allKnowledge = await db.find(db.knowledge, { account_id: adminUser.account_id });
    const knowledge    = allKnowledge.filter(k => k.is_main || (k.agent_ids || []).includes(agent._id));
    const allLinks     = await db.find(db.links, { account_id: adminUser.account_id });
    const links        = (agent.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);

    // API Key: usar OPENAI_API_KEY global (no la del usuario)
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.json({
        reply: 'El demo del bot está temporalmente sin servicio. Empezá tu prueba gratis y vas a poder usar el bot real.',
        configured: false,
      });
    }

    const { generateReply } = require('../services/openai');
    const conversationHistory = history.map(m => ({
      role:    m.role === 'user' ? 'user' : 'agent',
      content: String(m.content || '').slice(0, 500),
    }));

    // RAG: el demo usa el aprendizaje real del founder (objeciones ya
    // manejadas, mensajes que funcionan). Best-effort como en el webhook.
    let ragContext = null;
    try {
      const { retrieveContext } = require('../services/rag/retrieve');
      ragContext = await retrieveContext({ accountId: adminUser.account_id, message, apiKey });
    } catch (e) { /* RAG opcional */ }

    const baseNote = 'NOTA INTERNA: Este es el chat público de demo en la landing de Atinov. El visitante NO está logueado. Si pregunta cómo arrancar o quiere probar, dirígilo a "Probar gratis" (/app?register=1). RECOLECCIÓN: cuando notes interés real (preguntó precio, integración, "cómo empiezo"), pedí de forma natural UN dato de contacto — email o Instagram — por ej: "si querés te mando una mini guía de setup, ¿a qué mail te la mando?" o "¿cuál es tu IG así te veo el caso?". Una sola vez, sin insistir.';
    const extraContext = [baseNote, ragContext].filter(Boolean).join('\n\n');

    const reply = await generateReply({
      agent,
      knowledge,
      links,
      conversationHistory,
      newMessage: message,
      accountId: adminUser.account_id,
      apiKey,
      extraContext,
    });

    // ── Recolección automática → lead del canal 'landing' ────────────────────
    // Persistimos si hay engagement real (2+ mensajes del visitante) o si dejó
    // contacto. Async best-effort: nunca demora la respuesta al visitante.
    if (visitorId) {
      (async () => {
        try {
          const userMsgCount = conversationHistory.filter(m => m.role === 'user').length + 1;
          const contact = extractContact(message);
          const hasContact = !!(contact.email || contact.phone || contact.ig);

          let lead = await db.findOne(db.leads, { account_id: adminUser.account_id, visitor_id: visitorId });
          if (!lead && (userMsgCount >= 2 || hasContact)) {
            lead = await db.insert(db.leads, {
              account_id: adminUser.account_id,
              visitor_id: visitorId,
              ig_username: `web-${visitorId.slice(0, 8)}`,
              channel: 'landing',
              status: 'active',
              tags: ['landing'],
              pipeline_stage: 'nuevo',
              qualification: null,
              last_message_at: new Date().toISOString(),
            });
            // Primera persistencia: guardar el historial previo para no perderlo
            for (const m of conversationHistory) {
              await db.insert(db.messages, { lead_id: lead._id, role: m.role, content: m.content });
            }
          }
          if (!lead) return;

          await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: message });
          await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: reply });

          const upd = { last_message_at: new Date().toISOString() };
          if (contact.email && !lead.email) upd.email = contact.email;
          if (contact.phone && !lead.phone) upd.phone = contact.phone;
          if (contact.ig && !lead.contact_name) { upd.contact_name = '@' + contact.ig; }
          // Dejó contacto = interés real → warm (el founder lo ve arriba en el CRM)
          if (hasContact && !lead.qualification) {
            upd.qualification = 'warm';
            upd.qualification_reason = 'Dejó contacto en el chat de la landing';
          }
          await db.update(db.leads, { _id: lead._id }, upd);

          // Score de cierre (RAG) — mismo flujo que el webhook
          try {
            const { scoreLead } = require('../services/rag/score');
            scoreLead({ ...lead, ...upd }, apiKey).catch(() => {});
          } catch (e) { /* opcional */ }
        } catch (e) {
          console.warn('[publicChat] persistencia skip:', e.message);
        }
      })();
    }

    res.json({ reply, configured: true });
  } catch (e) {
    console.error('[publicChat] error:', e.message);
    res.json({
      reply: 'Hubo un problema procesando tu mensaje. Probá de nuevo en un momento o registrate gratis para usar el bot completo.',
      error: true,
    });
  }
});

module.exports = router;
