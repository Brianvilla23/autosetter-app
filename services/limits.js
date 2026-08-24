/**
 * Atinov — Servicio de límites y uso
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
  // El campo en users es account_id (snake_case) — con user.accountId el
  // lookup devolvía [] y los límites de recursos del plan nunca se aplicaban.
  const accounts = await db.find(db.accounts, { _id: user.account_id });
  // TODO multi-cuenta: cuando tengamos user.accountIds[], sumar todos
  const accountId = user.account_id;
  const agents  = accountId ? await db.find(db.agents,      { account_id: accountId }) : [];
  const magnets = accountId ? await db.find(db.magnetLinks, { account_id: accountId }) : [];

  // Contadores por canal y de voz. Comparten el reset mensual con los DMs:
  // si el mes cambió, `dms` ya se puso en cero arriba y estos van con él.
  const mismoMes = user.dm_count_month === month;
  const whatsapp = mismoMes ? Number(user.monthly_wa_count || 0) : 0;
  const vozSeg   = user.voice_count_month === month ? Number(user.monthly_voice_seconds || 0) : 0;

  const usage = {
    dms,
    whatsapp,
    minutosVoz: +(vozSeg / 60).toFixed(1),
    agents:   agents.length,
    accounts: accounts.length,
    magnets:  magnets.length,
    month,
  };

  // `max` puede venir sin tope real: UNLIMITED en admin, null en los planes
  // heredados (no tienen cuota de WhatsApp) y 0 en Inicial (no incluye voz).
  // Sin este guardia, null daba 100% y marcaba "pasado de límite" con cero
  // uso, porque `0 >= null` es true en JavaScript.
  const sinTope = (max) => max === UNLIMITED || max === null || max === undefined || !(Number(max) > 0);
  const pct  = (val, max) => sinTope(max) ? 0 : Math.min(100, Math.round((val / max) * 100));
  const over = (val, max) => !sinTope(max) && val >= max;

  // Calcular overage de DMs si aplica (solo Pro y Agency permiten overage)
  const extraDMs = plan.overagePerDM && usage.dms > plan.maxDMs ? usage.dms - plan.maxDMs : 0;
  const overageCost = +(extraDMs * (plan.overagePerDM || 0)).toFixed(2);

  return {
    plan: {
      id:           plan.id,
      name:         plan.name,
      price:        plan.price,
      priceCLP:     plan.priceCLP,
      maxDMs:       plan.maxDMs,
      maxDMsWhatsApp: plan.maxDMsWhatsApp,
      minutosLlamada: plan.minutosLlamada,
      maxAgents:    plan.maxAgents,
      maxAccounts:  plan.maxAccounts,
      maxMagnets:   plan.maxMagnets,
      followups:    plan.followups,
      webhook:      plan.webhook,
      overagePerDM: plan.overagePerDM,
      features:     plan.features,
    },
    usage,
    overage: {
      extraDMs,
      perDM:   plan.overagePerDM,
      costUSD: overageCost,
    },
    percent: {
      dms:        pct(usage.dms,        plan.maxDMs),
      whatsapp:   pct(usage.whatsapp,   plan.maxDMsWhatsApp),
      minutosVoz: pct(usage.minutosVoz, plan.minutosLlamada),
      agents:     pct(usage.agents,     plan.maxAgents),
      accounts:   pct(usage.accounts,   plan.maxAccounts),
      magnets:    pct(usage.magnets,    plan.maxMagnets),
    },
    overLimit: {
      dms:        over(usage.dms,        plan.maxDMs),
      whatsapp:   over(usage.whatsapp,   plan.maxDMsWhatsApp),
      minutosVoz: over(usage.minutosVoz, plan.minutosLlamada),
      agents:     over(usage.agents,     plan.maxAgents),
      accounts:   over(usage.accounts,   plan.maxAccounts),
      magnets:    over(usage.magnets,    plan.maxMagnets),
    },
  };
}

/**
 * Encuentra al dueño (user) de una cuenta dado su accountId.
 * Devuelve null si no hay (puede pasar en cuentas huérfanas).
 *
 * ⚠️ El campo en users es `account_id` (snake_case). Estuvo escrito como
 * `accountId` y por eso esta función devolvía SIEMPRE null: checkDMAllowance
 * dejaba pasar todo y incrementDMCount no contaba nada. O sea, el sistema de
 * cuotas entero estaba apagado sin que nadie lo notara. getUsage() ya tenía
 * el mismo bug corregido en su propio lookup (ver el comentario allá arriba);
 * acá había quedado sin arreglar.
 */
async function findOwnerByAccount(accountId) {
  if (!accountId) return null;
  return db.findOne(db.users, { account_id: accountId });
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
    // Si el plan permite overage (Pro, Agency) → seguir respondiendo, se cobra extra
    if (plan.overagePerDM) {
      return { allowed: true, user, plan, dms, overage: true };
    }
    // Plan sin overage (Starter, Trial) → bloquear y avisar
    return {
      allowed: false,
      reason:  `Límite mensual de ${plan.maxDMs} DMs alcanzado en plan ${plan.name}. Upgradea a Pro para continuar respondiendo.`,
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

// ── CONVERSACIONES: EL CONTADOR QUE LOS PLANES PROMETEN ──────────────────────
//
// Los planes se venden por CONVERSACIONES, no por mensajes. Una conversación
// es un lead atendido en el mes: la primera vez que el agente le responde
// cuenta 1, y todo lo que siga en ese mismo mes ya está pagado.
//
// Se marca en el propio lead (`contado_mes`) en vez de llevar un set aparte,
// así el conteo es idempotente: si el mismo lead escribe veinte veces, o si
// el proceso reintenta, sigue contando 1.
//
// WhatsApp lleva su PROPIA marca (`contado_mes_wa`) porque tiene su propia
// cuota: Meta cobra ese canal y los otros no. Un lead que habla por Instagram
// y después por WhatsApp cuenta 1 en el total y 1 en WhatsApp — que es
// exactamente lo que cuesta.

/** Suma 1 conversación del mes si este lead todavía no fue contado. */
async function registrarConversacion({ accountId, lead }) {
  if (!accountId || !lead?._id) return { contada: false };

  const user = await findOwnerByAccount(accountId);
  if (!user || user.role === 'admin') return { contada: false };

  const month = currentMonth();
  const esWhatsApp = String(lead.channel || '').toLowerCase() === 'whatsapp';

  const nuevaTotal = lead.contado_mes !== month;
  const nuevaWa    = esWhatsApp && lead.contado_mes_wa !== month;
  if (!nuevaTotal && !nuevaWa) return { contada: false };

  // Reset perezoso: si cambió el mes, los contadores parten de cero.
  const mismoMes = user.dm_count_month === month;
  const total = (mismoMes ? Number(user.monthly_dm_count || 0) : 0) + (nuevaTotal ? 1 : 0);
  const wa    = (mismoMes ? Number(user.monthly_wa_count || 0) : 0) + (nuevaWa ? 1 : 0);

  await db.update(db.users, { _id: user._id }, {
    monthly_dm_count: total,
    monthly_wa_count: wa,
    dm_count_month:   month,
  }).catch(e => console.error('registrarConversacion (user):', e.message));

  const marca = {};
  if (nuevaTotal) marca.contado_mes = month;
  if (nuevaWa)    marca.contado_mes_wa = month;
  await db.update(db.leads, { _id: lead._id }, marca)
    .catch(e => console.error('registrarConversacion (lead):', e.message));

  return { contada: true, total, whatsapp: wa, canal: lead.channel || 'instagram' };
}

/**
 * ¿Puede este canal atender una conversación más?
 *
 * Dos topes distintos: el total del plan y el de WhatsApp. El de WhatsApp es
 * el que protege el margen — cada conversación de ese canal cuesta ~US$0,27
 * contra ~US$0,013 de Instagram o Messenger.
 *
 * Pasado el tope NO se corta la atención si el plan permite overage: dejar
 * mudo el negocio de un cliente que está vendiendo es peor que cobrarle el
 * excedente. Se devuelve `overage: true` para poder avisarle.
 */
async function checkCuotaCanal(accountId, canal = 'instagram') {
  const user = await findOwnerByAccount(accountId);
  if (!user) return { allowed: true };                 // cuenta huérfana: no bloquear
  if (user.role === 'admin') return { allowed: true, user };

  const plan  = getPlanFor(user);
  const month = currentMonth();
  const mismoMes = user.dm_count_month === month;
  const total = mismoMes ? Number(user.monthly_dm_count || 0) : 0;
  const wa    = mismoMes ? Number(user.monthly_wa_count || 0) : 0;

  const esWhatsApp = String(canal || '').toLowerCase() === 'whatsapp';
  const topeWa = plan.maxDMsWhatsApp;

  // Tope de canal primero: es el que cuesta plata de verdad.
  if (esWhatsApp && Number.isFinite(topeWa) && wa >= topeWa) {
    if (plan.overagePerDM) {
      return { allowed: true, user, plan, total, whatsapp: wa, overage: true, motivo: 'whatsapp' };
    }
    return {
      allowed: false, user, plan, total, whatsapp: wa, motivo: 'whatsapp',
      reason: `Cuota de ${topeWa} conversaciones de WhatsApp alcanzada en el plan ${plan.name}.`,
    };
  }

  if (plan.maxDMs !== UNLIMITED && total >= plan.maxDMs) {
    if (plan.overagePerDM) {
      return { allowed: true, user, plan, total, whatsapp: wa, overage: true, motivo: 'total' };
    }
    return {
      allowed: false, user, plan, total, whatsapp: wa, motivo: 'total',
      reason: `Límite de ${plan.maxDMs} conversaciones alcanzado en el plan ${plan.name}.`,
    };
  }

  return { allowed: true, user, plan, total, whatsapp: wa };
}

// ── MINUTOS DE VOZ ───────────────────────────────────────────────────────────
// La bolsa de minutos es del plan (Inicial 0, Crecimiento 150, Escala 400).
// Se guardan SEGUNDOS porque las llamadas son cortas y redondear a minutos por
// llamada regalaría casi un minuto en cada una.

/** Tope duro: pasado el doble de la bolsa se corta. Un bucle de llamadas es plata real. */
const FACTOR_CORTE_VOZ = 2;

async function checkMinutosVoz(accountId) {
  const user = await findOwnerByAccount(accountId);
  if (!user) return { allowed: false, reason: 'la cuenta no tiene dueño' };
  if (user.role === 'admin') return { allowed: true, user };

  const plan = getPlanFor(user);
  const bolsa = Number(plan.minutosLlamada) || 0;
  if (!bolsa) {
    return { allowed: false, user, plan, reason: `El plan ${plan.name} no incluye llamadas.` };
  }

  const month = currentMonth();
  const seg = user.voice_count_month === month ? Number(user.monthly_voice_seconds || 0) : 0;
  const usados = seg / 60;

  if (usados >= bolsa * FACTOR_CORTE_VOZ) {
    return {
      allowed: false, user, plan, usados, bolsa,
      reason: `Se superó el doble de la bolsa de ${bolsa} minutos del plan ${plan.name}.`,
    };
  }
  return {
    allowed: true, user, plan, usados, bolsa,
    restantes: Math.max(0, bolsa - usados),
    overage:   usados >= bolsa,
  };
}

/** Suma los segundos de una llamada terminada. Llamar al colgar, no al marcar. */
async function registrarSegundosVoz(accountId, segundos) {
  const s = Math.max(0, Number(segundos) || 0);
  if (!s) return;
  const user = await findOwnerByAccount(accountId);
  if (!user || user.role === 'admin') return;

  const month = currentMonth();
  const prev = user.voice_count_month === month ? Number(user.monthly_voice_seconds || 0) : 0;
  await db.update(db.users, { _id: user._id }, {
    monthly_voice_seconds: prev + s,
    voice_count_month:     month,
  }).catch(e => console.error('registrarSegundosVoz:', e.message));
}

module.exports = {
  getUsage,
  checkDMAllowance,
  incrementDMCount,
  findOwnerByAccount,
  currentMonth,
  registrarConversacion,
  checkCuotaCanal,
  checkMinutosVoz,
  registrarSegundosVoz,
  FACTOR_CORTE_VOZ,
};
