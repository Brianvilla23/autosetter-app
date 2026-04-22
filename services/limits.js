/**
 * DMCloser — Servicio de límites y uso
 *
 * Centraliza:
 *   • Contador mensual de DMs enviados
 *   • Reset automático del contador al cambiar de mes
 *   • Cálculo de uso actual vs límites del plan
 *   • Chequeo de si una acción supera el límite
 *
 * El contador se resetea cuando `dm_count_month` (YYYY-MM) del usuario
 * no coincide con el mes actual. Así evitamos depender de un cron job.
 */

const db = require('../db/database');
const { getPlanFor, UNLIMITED } = require('../config/plans');

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Devuelve el uso actual del usuario + plan. Si el mes cambió, resetea el contador.
 * Estructura devuelta:
 *   {
 *     plan: {id, name, maxDMs, maxAgents, maxAccounts, ...},
 *     usage: { dms, agents, accounts, magnets, month },
 *     percent: { dms, agents, accounts },  // 0-100
 *     overLimit: { dms, agents, accounts }, // boolean
 *   }
 */
async function getUsage(userId) {
  const user = await db.findOne(db.users, { _id: userId });
  if (!user) throw new Error('user not found');
  const plan = getPlanFor(user);

  // Reset mensual lazy
  const month = currentMonth();
  let dms = Number(user.monthly_dm_count || 0);
  if (user.dm_count_month !== month) {
    dms = 0;
    await db.update(db.users, { _id: userId }, {
      monthly_dm_count: 0,
      dm_count_month:   month,
    }).catch(() => null);
  }

  // Contar recursos reales del usuario (sus accounts + agentes + magnets)
  const accounts = await db.find(db.accounts, { _id: user.accountId });
  // TODO multi-cuenta: cuando tengamos user.accountIds[], sumar todos
  const accountId = user.accountId;
  const agents  = accountId ? await db.find(db.agents,      { account_id: accountId }) : [];
  const magnets = accountId ? await db.find(db.magnetLinks, { account_id: accountId }) : [];

  const usage = {
    dms,
    agents:   agents.length,
    accounts: accounts.length,
    magnets:  magnets.length,
    month,
  };

  const pct = (val, max) => max === UNLIMITED ? 0 : Math.min(100, Math.round((val / max) * 100));
  const over = (val, max) => max !== UNLIMITED && val >= max;

  return {
    plan: {
      id:          plan.id,
      name:        plan.name,
      price:       plan.price,
      maxDMs:      plan.maxDMs,
      maxAgents:   plan.maxAgents,
      maxAccounts: plan.maxAccounts,
      maxMagnets:  plan.maxMagnets,
      followups:   plan.followups,
      webhook:     plan.webhook,
    },
    usage,
    percent: {
      dms:      pct(usage.dms,      plan.maxDMs),
      agents:   pct(usage.agents,   plan.maxAgents),
      accounts: pct(usage.accounts, plan.maxAccounts),
      magnets:  pct(usage.magnets,  plan.maxMagnets),
    },
    overLimit: {
      dms:      over(usage.dms,      plan.maxDMs),
      agents:   over(usage.agents,   plan.maxAgents),
      accounts: over(usage.accounts, plan.maxAccounts),
      magnets:  over(usage.magnets,  plan.maxMagnets),
    },
  };
}

/**
 * Encuentra al dueño (user) de una cuenta IG dado su accountId.
 * Devuelve null si no hay (puede pasar en cuentas huérfanas).
 */
async function findOwnerByAccount(accountId) {
  if (!accountId) return null;
  return db.findOne(db.users, { accountId });
}

/**
 * Chequea si el dueño de la cuenta puede enviar un DM más en el mes.
 * Si supera el límite → { allowed: false, reason }.
 * Si no → { allowed: true, user, plan }.
 */
async function checkDMAllowance(accountId) {
  const user = await findOwnerByAccount(accountId);
  if (!user) return { allowed: true }; // Cuenta sin dueño → no bloqueamos (admin/legacy)
  if (user.role === 'admin') return { allowed: true, user };

  const plan  = getPlanFor(user);
  const month = currentMonth();

  // Lazy reset
  let dms = Number(user.monthly_dm_count || 0);
  if (user.dm_count_month !== month) {
    dms = 0;
    await db.update(db.users, { _id: user._id }, {
      monthly_dm_count: 0,
      dm_count_month:   month,
    }).catch(() => null);
  }

  if (plan.maxDMs !== UNLIMITED && dms >= plan.maxDMs) {
    return {
      allowed: false,
      reason:  `Límite mensual de ${plan.maxDMs} DMs alcanzado en plan ${plan.name}.`,
      user, plan, dms,
    };
  }
  return { allowed: true, user, plan, dms };
}

/**
 * Incrementa el contador de DMs del dueño de la cuenta.
 * Llamar DESPUÉS de un envío exitoso.
 */
async function incrementDMCount(accountId, count = 1) {
  const user = await findOwnerByAccount(accountId);
  if (!user || user.role === 'admin') return;

  const month = currentMonth();
  const prev  = user.dm_count_month === month ? Number(user.monthly_dm_count || 0) : 0;
  await db.update(db.users, { _id: user._id }, {
    monthly_dm_count: prev + count,
    dm_count_month:   month,
  }).catch(e => console.error('incrementDMCount error:', e.message));
}

module.exports = {
  getUsage,
  checkDMAllowance,
  incrementDMCount,
  findOwnerByAccount,
  currentMonth,
};
