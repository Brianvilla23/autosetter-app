/**
 * DMCloser — Planes y límites
 *
 * Fuente única de verdad para lo que cada plan puede hacer.
 * Cambiar AQUÍ = cambia en toda la app.
 *
 * UNLIMITED = Infinity (se compara con < Infinity)
 */

const UNLIMITED = Infinity;

const PLANS = {
  trial: {
    id:          'trial',
    name:        'Trial',
    price:       0,
    maxAccounts: 1,
    maxAgents:   1,
    maxDMs:      200,       // Conservador durante trial
    maxMagnets:  1,
    followups:   false,
    webhook:     false,
  },
  starter: {
    id:          'starter',
    name:        'Starter',
    price:       197,                // USD/mes (~CLP 180.000)
    maxAccounts: 1,
    maxAgents:   3,
    maxDMs:      500,
    maxMagnets:  3,
    followups:   false,
    webhook:     false,
  },
  pro: {
    id:          'pro',
    name:        'Pro',
    price:       297,                // USD/mes (~CLP 270.000)
    maxAccounts: 3,
    maxAgents:   UNLIMITED,
    maxDMs:      UNLIMITED,          // conversaciones ilimitadas
    maxMagnets:  UNLIMITED,
    followups:   true,
    webhook:     true,
  },
  agency: {
    id:          'agency',
    name:        'Agency',
    price:       497,                // USD/mes (~CLP 450.000)
    maxAccounts: 10,
    maxAgents:   UNLIMITED,
    maxDMs:      UNLIMITED,
    maxMagnets:  UNLIMITED,
    followups:   true,
    webhook:     true,
  },
  // Admins tienen acceso total
  admin: {
    id:          'admin',
    name:        'Admin',
    price:       0,
    maxAccounts: UNLIMITED,
    maxAgents:   UNLIMITED,
    maxDMs:      UNLIMITED,
    maxMagnets:  UNLIMITED,
    followups:   true,
    webhook:     true,
  },
};

/**
 * Devuelve el plan efectivo de un usuario.
 * Fallback: si no hay plan o no está en la lista → trial.
 */
function getPlanFor(user) {
  if (!user) return PLANS.trial;
  if (user.role === 'admin') return PLANS.admin;
  const key = (user.membershipPlan || 'trial').toLowerCase();
  return PLANS[key] || PLANS.trial;
}

module.exports = { PLANS, getPlanFor, UNLIMITED };
