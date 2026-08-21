/**
 * Atinov — Planes y límites
 *
 * Fuente única de verdad para lo que cada plan puede hacer.
 * Cambiar AQUÍ = cambia en toda la app.
 *
 * Estructura:
 * - maxDMs: límite mensual de DMs procesados por el bot. Si lo pasa,
 *   se cobra overage por DM extra ($overagePerDM USD).
 * - features: dict de booleans que apaga/prende secciones específicas.
 *   El frontend lo lee desde /api/usage para mostrar el lock UI.
 *
 * UNLIMITED ya no existe como concepto — siempre hay un techo, y arriba
 * del techo se cobra overage. Es más honesto y sostenible.
 */

const PLANS = {
  trial: {
    id:          'trial',
    name:        'Trial',
    price:       0,
    priceCLP:    0,
    maxAccounts: 1,
    maxAgents:   1,
    maxDMs:      200,       // Conservador durante trial
    maxMagnets:  1,
    overagePerDM: null,     // No hay overage en trial: si llega al tope, se corta
    features: {
      followups:        false,
      leadMagnets:      false,
      qualification:    false,   // HOT/WARM/COLD automático
      webhook:          false,
      inboxTakeControl: true,    // tomar control sí (es básico)
      multiAccount:     false,
      whiteLabel:       false,
      multiUser:        false,
      apiAccess:        false,
      prioritySupport:  false,
    },
  },
  // ── EL PLAN QUE SE VENDE HOY ──────────────────────────────────────────────
  // Founder es el único plan comercial vigente: $148 USD / $135.000 CLP, 20
  // cupos con precio congelado. Lo que trae acá es exactamente lo que promete
  // la landing y lo que el agente dice en services/atinovPreset.js.
  //
  // Faltaba en esta lista, y eso NO era teórico: la migración post-Lemon
  // Squeezy de db/database.js ya dejó cuentas reales con
  // membershipPlan='founder' desde el 2026-05-03. Como getPlanFor() hace
  // `PLANS[key] || PLANS.trial`, esas cuentas caían a TRIAL — 200 DMs, sin
  // calificación, sin follow-ups, sin lead magnets. Es decir: el plan que se
  // cobra entregaba los límites del plan gratis.
  //
  // starter/pro/agency de más abajo son LEGACY: no se venden desde el rebrand
  // (2026-05-09). Se dejan para no romper cuentas viejas que aún los tengan.
  founder: {
    id:          'founder',
    name:        'Founder',
    price:       148,           // USD/mes — precio fundador, congelado de por vida
    priceCLP:    135000,        // debe calzar con MP_PRICE_FOUNDER_CLP (routes/billing.js)
    maxAccounts: 3,
    maxAgents:   5,
    maxDMs:      6000,          // "6.000 conversaciones/mes" de la landing
    maxMagnets:  10,
    overagePerDM: 0.025,        // sobre el tope se cobra, no se corta la atención
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       false,  // el white-label es del plan de agencias
      multiUser:        true,
      apiAccess:        true,
      prioritySupport:  true,   // "contacto directo con el fundador" es parte de la oferta
    },
  },
  starter: {
    id:          'starter',
    name:        'Starter',
    price:       197,           // USD/mes
    priceCLP:    180000,
    maxAccounts: 1,
    maxAgents:   1,             // 1 agente — diferenciador claro vs Pro
    maxDMs:      1500,
    maxMagnets:  1,
    overagePerDM: null,         // Starter no permite overage, sube de plan
    features: {
      followups:        false,  // BLOQUEADO — upgrade a Pro
      leadMagnets:      false,  // BLOQUEADO — upgrade a Pro
      qualification:    false,  // BLOQUEADO — upgrade a Pro
      webhook:          false,  // BLOQUEADO
      inboxTakeControl: true,
      multiAccount:     false,
      whiteLabel:       false,
      multiUser:        false,
      apiAccess:        false,
      prioritySupport:  false,
    },
  },
  pro: {
    id:          'pro',
    name:        'Pro',
    price:       297,           // USD/mes
    priceCLP:    270000,
    maxAccounts: 3,
    maxAgents:   5,             // 5 agentes (no ilimitado)
    maxDMs:      6000,          // 6,000 DMs/mes (NO ilimitado)
    maxMagnets:  10,
    overagePerDM: 0.025,        // $0.025 por DM extra ($25 / 1000 DMs)
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       false,  // BLOQUEADO — upgrade a Agency
      multiUser:        false,  // BLOQUEADO — upgrade a Agency
      apiAccess:        false,  // BLOQUEADO — upgrade a Agency
      prioritySupport:  true,
    },
  },
  agency: {
    id:          'agency',
    name:        'Agency',
    price:       497,           // USD/mes
    priceCLP:    450000,
    maxAccounts: 10,
    maxAgents:   20,            // 20 agentes
    maxDMs:      25000,         // 25,000 DMs/mes (NO ilimitado)
    maxMagnets:  50,
    overagePerDM: 0.015,        // $0.015 por DM extra (más barato que Pro)
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       true,
      multiUser:        true,
      apiAccess:        true,
      prioritySupport:  true,
    },
  },
  // Admins tienen acceso total y sin límites — sólo equipo interno
  admin: {
    id:          'admin',
    name:        'Admin',
    price:       0,
    priceCLP:    0,
    maxAccounts: Infinity,
    maxAgents:   Infinity,
    maxDMs:      Infinity,
    maxMagnets:  Infinity,
    overagePerDM: 0,
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       true,
      multiUser:        true,
      apiAccess:        true,
      prioritySupport:  true,
    },
  },
};

/**
 * Devuelve el plan efectivo de un usuario.
 * Fallback: si no hay plan o no está en la lista → trial.
 *
 * Retorna el plan con shim retrocompat: `followups` y `webhook` directos
 * (codigo viejo) reflejan `features.followups` / `features.webhook`.
 */
function getPlanFor(user) {
  let plan;
  if (!user)                     plan = PLANS.trial;
  else if (user.role === 'admin') plan = PLANS.admin;
  else {
    const key = (user.membershipPlan || 'trial').toLowerCase();
    plan = PLANS[key] || PLANS.trial;
  }
  // Backward compat: plan.followups / plan.webhook como flags top-level
  return {
    ...plan,
    followups: !!plan.features?.followups,
    webhook:   !!plan.features?.webhook,
  };
}

/**
 * Verifica si una feature específica está disponible en el plan del user.
 * Uso: hasFeature(user, 'followups') → true/false
 */
function hasFeature(user, featureKey) {
  const plan = getPlanFor(user);
  return !!(plan.features && plan.features[featureKey]);
}

/**
 * Calcula el costo de overage para un usuario que pasó su límite de DMs.
 * Devuelve { extraDMs, costUSD, perDM } o null si su plan no permite overage.
 */
function calculateOverage(user, currentDMs) {
  const plan = getPlanFor(user);
  if (!plan.overagePerDM) return null;
  const extraDMs = Math.max(0, currentDMs - plan.maxDMs);
  return {
    extraDMs,
    perDM:   plan.overagePerDM,
    costUSD: +(extraDMs * plan.overagePerDM).toFixed(2),
  };
}

module.exports = { PLANS, getPlanFor, hasFeature, calculateOverage, UNLIMITED: Infinity };
