/**
 * DMCloser — Chat público de la landing
 *
 * Endpoint sin auth para que visitantes de la landing puedan chatear con el
 * agente "DMCloser Sales" (Brian, cofundador). Demo viva del producto:
 * el bot responde dudas sobre DMCloser usando la knowledge real cargada
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
    // Buscar el primer agente con name="DMCloser Sales" — preset dogfooding
    let agent = await db.findOne(db.agents, { name: 'DMCloser Sales', enabled: true });
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
        greeting: 'Hola 👋 Soy Brian, cofundador de DMCloser. ¿En qué te puedo ayudar?',
      });
    }
    res.json({
      configured: true,
      name: agent.name === 'DMCloser Sales' ? 'Brian' : agent.name,
      avatar: agent.avatar || '⚡',
      greeting: '¡Hey! 👋 Soy el bot de DMCloser. Probame: preguntame cualquier cosa sobre cómo funciona, precios, integración. Voy a responderte exactamente como respondería al DM de un lead tuyo.',
    });
  } catch (e) {
    res.json({ configured: false, name: 'Brian', avatar: '⚡', greeting: 'Hola 👋 ¿en qué te ayudo?' });
  }
});

/**
 * POST /api/public/chat
 * Body: { message, history?: [{role, content}, ...] }
 *
 * No persiste nada en DB. El historial vive en el localStorage del visitante.
 */
router.post('/', async (req, res) => {
  try {
    const message = String(req.body.message || '').slice(0, 500).trim();
    if (!message) return res.status(400).json({ error: 'Mensaje vacío' });

    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];

    // Buscar el agente "DMCloser Sales" del founder admin
    const adminUser = await db.findOne(db.users, { role: 'admin' });
    if (!adminUser?.account_id) {
      return res.json({
        reply: 'El chat de demo no está configurado todavía. Probá la app gratis y experimentá la IA con tu propia cuenta.',
        configured: false,
      });
    }

    let agent = await db.findOne(db.agents, { account_id: adminUser.account_id, name: 'DMCloser Sales', enabled: true });
    if (!agent) {
      agent = await db.findOne(db.agents, { account_id: adminUser.account_id, enabled: true });
    }
    if (!agent) {
      return res.json({
        reply: 'El bot demo está en mantenimiento. Probá DMCloser gratis 3 días y te respondemos personalmente cualquier duda.',
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

    const reply = await generateReply({
      agent,
      knowledge,
      links,
      conversationHistory,
      newMessage: message,
      accountId: adminUser.account_id,
      apiKey,
      extraContext: 'NOTA INTERNA: Este es el chat público de demo en la landing de DMCloser. El visitante NO está logueado. Si pregunta cómo arrancar o quiere probar, dirígilo a hacer click en "Probar gratis" en la página o registrarse en /app?register=1. No le pidas que comparta su Instagram en este chat — eso es después en el panel.',
    });

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
