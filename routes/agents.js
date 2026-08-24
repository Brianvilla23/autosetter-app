const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const { enforceMaxAgents, enforceFollowupFeature } = require('../middleware/checkPlanLimits');
const { isValidRole, roleOf } = require('../config/agentRoles');
const { AGENT_CHANNELS } = require('../services/agents');
const { knowledgeForAgent } = require('../services/agents/knowledge');

// channels: [] o undefined = catch-all (todos los canales). Solo valores conocidos.
function sanitizeChannels(raw) {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(c => AGENT_CHANNELS.includes(c));
}

// ── Tenant isolation helper ─────────────────────────────────────────────────
// Verifica que el accountId del request matchee con el del JWT del usuario.
// Sin esto, un usuario con un token válido podría leer/escribir datos de
// CUALQUIER otra cuenta solo cambiando el accountId en query/body.
function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

// ── Helper: cargar agente y validar que pertenece al accountId del JWT ─────
async function loadOwnedAgent(req, res) {
  const agent = await db.findOne(db.agents, { _id: req.params.id });
  if (!agent) { res.status(404).json({ error: 'Not found' }); return null; }
  if (agent.account_id !== req.user.accountId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return agent;
}

// GET all agents for account
router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const agents = await db.find(db.agents, { account_id: accountId },
      (a, b) => a.createdAt.localeCompare(b.createdAt));
    // Attach link objects
    const links = await db.find(db.links, { account_id: accountId });
    const result = agents.map(a => ({
      ...a,
      id: a._id,
      links: (a.link_ids || []).map(lid => links.find(l => l._id === lid)).filter(Boolean).map(l => ({...l, id: l._id}))
    }));
    res.json(result);
  } catch (e) { next(e); }
});

// GET single agent
router.get('/:id', async (req, res, next) => {
  try {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;
    const links = await db.find(db.links, { account_id: agent.account_id });
    const agentLinks = (agent.link_ids || []).map(lid => links.find(l => l._id === lid)).filter(Boolean).map(l => ({...l, id: l._id}));
    res.json({ ...agent, id: agent._id, links: agentLinks });
  } catch (e) { next(e); }
});

// POST create agent
router.post('/', enforceMaxAgents, async (req, res, next) => {
  try {
    const {
      accountId, name, avatar = '🤖', instructions = '', role, channels,
      objetivo, cargo, p_contexto, p_limites, p_objeciones, p_escalacion, p_ejemplos,
    } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    // role: 'nurture' (default, comportamiento actual) o 'prospect' (asistente humano).
    const agentRole = isValidRole(role) ? role : 'nurture';
    // Campos del prompt estructurado (constructor guiado). Todos opcionales:
    // un agente clásico de texto libre sigue siendo válido.
    const { esObjetivoValido, sanearEjemplos } = require('../services/promptEstructurado');
    const agent = await db.insert(db.agents, {
      account_id: accountId, name, avatar, instructions, role: agentRole,
      enabled: true, link_ids: [],
      channels: sanitizeChannels(channels) || [],
      objetivo:     esObjetivoValido(objetivo) ? objetivo : null,
      cargo:        String(cargo || '').trim().slice(0, 80),
      p_contexto:   String(p_contexto || '').trim().slice(0, 4000),
      p_limites:    String(p_limites || '').trim().slice(0, 2000),
      p_objeciones: String(p_objeciones || '').trim().slice(0, 2000),
      p_escalacion: String(p_escalacion || '').trim().slice(0, 1500),
      p_ejemplos:   sanearEjemplos(p_ejemplos),
    });
    res.json({ ...agent, id: agent._id });
  } catch (e) { next(e); }
});

// PUT update agent
router.put('/:id', enforceFollowupFeature, async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    const {
      name, avatar, instructions, enabled, trigger_keywords, delay_min, delay_max,
      followup_enabled, followup_delay_hours, role, channels, comment_public_reply,
      calls_enabled,
      objetivo, cargo, p_contexto, p_limites, p_objeciones, p_escalacion, p_ejemplos,
    } = req.body;
    const upd = { name, avatar, instructions, enabled, trigger_keywords, delay_min, delay_max };
    // Prompt estructurado: cada campo se actualiza solo si viene en el body
    // (undefined = no tocar), y vacío = borrar. Así el panel puede guardar
    // una pestaña sin pisar las otras.
    {
      const { esObjetivoValido, sanearEjemplos } = require('../services/promptEstructurado');
      if (objetivo !== undefined)     upd.objetivo     = esObjetivoValido(objetivo) ? objetivo : null;
      if (cargo !== undefined)        upd.cargo        = String(cargo || '').trim().slice(0, 80);
      if (p_contexto !== undefined)   upd.p_contexto   = String(p_contexto || '').trim().slice(0, 4000);
      if (p_limites !== undefined)    upd.p_limites    = String(p_limites || '').trim().slice(0, 2000);
      if (p_objeciones !== undefined) upd.p_objeciones = String(p_objeciones || '').trim().slice(0, 2000);
      if (p_escalacion !== undefined) upd.p_escalacion = String(p_escalacion || '').trim().slice(0, 1500);
      if (p_ejemplos !== undefined)   upd.p_ejemplos   = sanearEjemplos(p_ejemplos);
    }
    // Respuesta pública al comentario ("te escribí al DM 📩"). Vacío = no responder.
    if (comment_public_reply !== undefined) {
      upd.comment_public_reply = String(comment_public_reply || '').trim().slice(0, 280);
    }
    if (isValidRole(role)) upd.role = role;
    const ch = sanitizeChannels(channels);
    if (ch !== undefined) upd.channels = ch;
    if (typeof followup_enabled === 'boolean') upd.followup_enabled = followup_enabled;
    if (followup_delay_hours !== undefined) {
      const h = Math.max(1, Math.min(23, Number(followup_delay_hours) || 3));
      upd.followup_delay_hours = h;
    }
    // Llamadas telefónicas: interruptor POR AGENTE (como followup_enabled).
    // Solo con este switch + el de la cuenta + Twilio configurado el agente
    // recibe la capacidad [LLAMAR] en su prompt.
    if (typeof calls_enabled === 'boolean') upd.calls_enabled = calls_enabled;
    await db.update(db.agents, { _id: req.params.id }, upd);
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    res.json({ ...agent, id: agent._id });
  } catch (e) { next(e); }
});

// PATCH agent followup settings (atajo solo para configuración follow-up)
router.patch('/:id/followup', async (req, res, next) => {
  // Si están tratando de activar, validar plan
  if (req.body?.enabled === true) {
    req.body.followup_enabled = true;
    return enforceFollowupFeature(req, res, next);
  }
  next();
}, async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    const { enabled, delay_hours } = req.body;
    const upd = {};
    if (typeof enabled === 'boolean') upd.followup_enabled = enabled;
    if (delay_hours !== undefined) {
      upd.followup_delay_hours = Math.max(1, Math.min(23, Number(delay_hours) || 3));
    }
    await db.update(db.agents, { _id: req.params.id }, upd);
    const agent = await db.findOne(db.agents, { _id: req.params.id });
    res.json({
      followup_enabled:     agent.followup_enabled || false,
      followup_delay_hours: agent.followup_delay_hours || 3,
    });
  } catch (e) { next(e); }
});

// PATCH toggle
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const agent = await loadOwnedAgent(req, res);
    if (!agent) return;
    await db.update(db.agents, { _id: req.params.id }, { enabled: !agent.enabled });
    res.json({ enabled: !agent.enabled });
  } catch (e) { next(e); }
});

// DELETE agent
router.delete('/:id', async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    await db.remove(db.agents, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT update agent links
router.put('/:id/links', async (req, res, next) => {
  try {
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;
    const { linkIds = [] } = req.body;
    await db.update(db.agents, { _id: req.params.id }, { link_ids: linkIds });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST test agent
router.post('/:id/test', async (req, res, next) => {
  try {
    const { message, history = [], accountId } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;

    const knowledgeDocs = await db.find(db.knowledge, { account_id: accountId });
    const knowledge = knowledgeForAgent(knowledgeDocs, owned);
    const allLinks = await db.find(db.links, { account_id: accountId });
    const links = (owned.link_ids || []).map(lid => allLinks.find(l => l._id === lid)).filter(Boolean);

    const { generateReply, classifyLead } = require('../services/openai');
    const reply = await generateReply({ agent: owned, knowledge, links, conversationHistory: history, newMessage: message, accountId });

    // Classify lead based on full conversation (including new exchange)
    const fullHistory = [...history, { role: 'user', content: message }, { role: 'agent', content: reply }];
    const classification = await classifyLead({ conversationHistory: fullHistory, accountId }).catch(() => null);

    res.json({ reply, classification });
  } catch (e) { next(e); }
});

// ── POST /:id/prospect-draft — genera un borrador para prospección en frío ───
// El agente role='prospect' NO envía: solo redacta para que el humano revise.
// Body: { accountId, mode: 'opener'|'reply', lastLeadMessage?, history?, leadInfo? }
router.post('/:id/prospect-draft', async (req, res, next) => {
  try {
    const { accountId, mode = 'reply', lastLeadMessage = '', history = [], leadInfo } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const owned = await loadOwnedAgent(req, res);
    if (!owned) return;

    // Solo agentes de prospección generan drafts (un nurture no tiene sentido acá).
    if (roleOf(owned) !== 'prospect') {
      return res.status(400).json({ error: 'Este agente no es de prospección. Cambia su rol a "prospect" o usa /test.' });
    }

    const knowledgeDocs = await db.find(db.knowledge, { account_id: accountId });
    const knowledge = knowledgeForAgent(knowledgeDocs, owned);

    const settings = await db.findOne(db.settings, { account_id: accountId });
    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;

    const { generateProspectDraft } = require('../services/agents/prospectAgent');
    const result = await generateProspectDraft({
      agent: owned, knowledge, mode,
      lastLeadMessage, conversationHistory: history, leadInfo, apiKey,
    });
    res.json(result); // { draft, ready_for_handoff }
  } catch (e) { next(e); }
});

module.exports = router;
