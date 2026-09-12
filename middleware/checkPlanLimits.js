const PLANS_CFG = require('../config/plans').PLANS;
/**
 * Atinov — Middleware de límites por plan
 *
 * Genera middlewares Express que bloquean acciones que superan los límites
 * del plan del usuario. Uso:
 *
 *   const { enforceMaxAgents } = require('../middleware/checkPlanLimits');
 *   router.post('/', enforceMaxAgents, async (req, res) => {...});
 *
 * Devuelven 403 con { error, upgrade: true, plan } si se supera.
 */

const db = require('../db/database');
const { getPlanFor, hasFeature, UNLIMITED } = require('../config/plans');

/**
 * Helper: genera un middleware que bloquea si el plan no tiene la feature.
 * Uso: enforceFeature('leadMagnets', 'Lead magnets automáticos')
 */
function enforceFeature(featureKey, displayName) {
  return async (req, res, next) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      if (user.role === 'admin') return next();
      if (hasFeature(user, featureKey)) return next();
      const plan = getPlanFor(user);
      // Planes REALES de la escalera (config/plans.js). Antes decía "Pro" /
      // "Agency": planes heredados que ya no existen ni se pueden comprar —
      // el cliente veía "Upgradear a Agency" y no había dónde (auditoría 12-09).
      const requiredId   = featureKey === 'whiteLabel' ? 'escala' : 'crecimiento';
      const requiredName = (PLANS_CFG[requiredId] && PLANS_CFG[requiredId].name) || requiredId;
      return res.status(403).json({
        error:   `${displayName} está disponible desde el plan ${requiredName}. Tu plan actual: ${plan.name}.`,
        upgrade: true,
        limit:   featureKey,
        plan:    plan.id,
        required: requiredId,
        required_name: requiredName,
      });
    } catch (e) {
      console.error(`enforceFeature(${featureKey}) error:`, e.message);
      next();
    }
  };
}

/** Busca el user actual de req.user.userId */
async function getCurrentUser(req) {
  if (!req.user?.userId) return null;
  return db.findOne(db.users, { _id: req.user.userId });
}

/** Bloqueo al crear un nuevo agente si se supera maxAgents */
async function enforceMaxAgents(req, res, next) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    if (user.role === 'admin') return next();

    const plan = getPlanFor(user);
    if (plan.maxAgents === UNLIMITED) return next();

    // user es el DOC de la DB → el campo es account_id (snake_case). SOLO la
    // cuenta del usuario autenticado: con req.body.accountId se podía sondear
    // cuántos agentes tiene OTRA cuenta antes del check de propiedad del
    // handler (pentest 06-09-2026).
    const accountId = user.account_id;
    if (!accountId) return next();

    const agents = await db.find(db.agents, { account_id: accountId });
    if (agents.length >= plan.maxAgents) {
      return res.status(403).json({
        error:   `Tu plan ${plan.name} permite máximo ${plan.maxAgents} agente(s). Upgradea para crear más.`,
        upgrade: true,
        limit:   'agents',
        plan:    plan.id,
        max:     plan.maxAgents,
      });
    }
    next();
  } catch (e) {
    console.error('enforceMaxAgents error:', e.message);
    next();
  }
}

/** Bloqueo al conectar una nueva cuenta IG si se supera maxAccounts */
async function enforceMaxAccounts(req, res, next) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    if (user.role === 'admin') return next();

    const plan = getPlanFor(user);
    if (plan.maxAccounts === UNLIMITED) return next();

    // Hoy cada usuario tiene UNA cuenta (user.account_id). Si el pedido viene
    // para otra y el plan no permite varias, se corta acá — antes esto siempre
    // pasaba y el límite que se vende (multiAccount) no existía.
    const pedida = req.body?.accountId || req.query?.accountId || null;
    const propia = user.account_id || user.accountId || null;
    if (pedida && propia && pedida !== propia && Number(plan.maxAccounts || 1) <= 1) {
      return res.status(403).json({
        error: `Tu plan ${plan.name} incluye una sola cuenta. Sube de plan para conectar más.`,
        upgrade: true, limit: 'maxAccounts', plan: plan.id, required: 'crecimiento', required_name: 'Crecimiento',
      });
    }
    next();
  } catch (e) {
    console.error('enforceMaxAccounts error:', e.message);
    next();
  }
}

/** Bloqueo al crear un nuevo magnet link si se supera maxMagnets */
async function enforceMaxMagnets(req, res, next) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    if (user.role === 'admin') return next();

    const plan = getPlanFor(user);
    if (plan.maxMagnets === UNLIMITED) return next();

    // Mismo criterio que enforceMaxAgents: solo la cuenta del usuario autenticado.
    const accountId = user.account_id;
    if (!accountId) return next();

    const magnets = await db.find(db.magnetLinks, { account_id: accountId });
    if (magnets.length >= plan.maxMagnets) {
      return res.status(403).json({
        error:   `Tu plan ${plan.name} permite máximo ${plan.maxMagnets} magnet link(s). Upgradea para crear más.`,
        upgrade: true,
        limit:   'magnets',
        plan:    plan.id,
        max:     plan.maxMagnets,
      });
    }
    next();
  } catch (e) {
    console.error('enforceMaxMagnets error:', e.message);
    next();
  }
}

/** Bloqueo al habilitar follow-ups si el plan no los permite */
async function enforceFollowupFeature(req, res, next) {
  try {
    // Si el body quiere activar followup_enabled, validamos
    const wants = req.body?.followup_enabled === true;
    if (!wants) return next();

    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    if (user.role === 'admin') return next();

    const plan = getPlanFor(user);
    if (plan.followups) return next();

    return res.status(403).json({
      error:   `Los follow-ups automáticos requieren plan Pro o superior.`,
      upgrade: true,
      limit:   'followups',
      plan:    plan.id,
    });
  } catch (e) {
    console.error('enforceFollowupFeature error:', e.message);
    next();
  }
}

module.exports = {
  enforceMaxAgents,
  enforceMaxAccounts,
  enforceMaxMagnets,
  enforceFollowupFeature,
  enforceFeature,
  // Atajos pre-armados para las features mas usadas
  enforceLeadMagnets:   enforceFeature('leadMagnets',   'Lead magnets automáticos'),
  enforceQualification: enforceFeature('qualification', 'Calificación HOT/WARM/COLD automática'),
  enforceWebhook:       enforceFeature('webhook',       'Webhooks personalizados'),
  enforceWhiteLabel:    enforceFeature('whiteLabel',    'White-label'),
  enforceApiAccess:     enforceFeature('apiAccess',     'API access'),
};
