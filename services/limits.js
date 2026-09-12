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

// Mes y día en hora de CHILE, igual que telefonia/calendar/shopify. Con la
// hora del servidor (UTC) el reset de cuotas caía 3-4 h antes de la
// medianoche real (auditoría 12-09).
const TZ_CL = 'America/Santiago';
function hoyChile(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_CL }).format(fecha);   // YYYY-MM-DD
}
function currentMonth(fecha = new Date()) {
  return hoyChile(fecha).slice(0, 7);
}

/**
 * Reset perezoso ATÓMICO del mes: solo el primero que ve el mes nuevo pone
 * los contadores en cero (condición "mes distinto"); los demás no encuentran
 * el documento y no tocan nada. Antes cada llamador leía el contador, sumaba
 * y escribía: dos a la vez perdían un incremento.
 */
async function resetearMesUsuario(userId, month) {
  await db.updateRaw(db.users, { _id: userId, dm_count_month: { $ne: month } }, {
    $set: { monthly_dm_count: 0, monthly_wa_count: 0, dm_count_month: month },
  }).catch(() => null);
}

/**
 * Cupo DIARIO por cuenta guardado en settings (sesiones de voz, entrenamientos…),
 * ATÓMICO: se reserva ANTES de gastar con una sola operación condicional
 * (fecha de hoy y contador < máximo). Si la acción cara falla después, se
 * libera con liberarCupoDiario. Devuelve { ok, usados } (usados incluye la reserva).
 */
async function reservarCupoDiario({ accountId, campo, max }) {
  const hoy = hoyChile();
  const fecha = `${campo}_date`, cont = `${campo}_count`;
  // Upsert y no find+insert: NeDB serializa las operaciones, así que treinta
  // reservas simultáneas de una cuenta SIN settings crean UN documento (con
  // find+insert creaban treinta, cada uno con su propio contador).
  await db.updateRaw(db.settings, { account_id: accountId }, { $set: { account_id: accountId } }, { upsert: true }).catch(() => null);
  const settings = await db.findOne(db.settings, { account_id: accountId });
  if (!settings) return { ok: false, usados: 0, hoy, settings: null };
  await db.updateRaw(db.settings, { _id: settings._id, [fecha]: { $ne: hoy } }, { $set: { [fecha]: hoy, [cont]: 0 } }).catch(() => null);
  const gane = await db.updateRaw(db.settings, { _id: settings._id, [fecha]: hoy, [cont]: { $lt: max } }, { $inc: { [cont]: 1 } }).catch(() => 0);
  const fresco = await db.findOne(db.settings, { _id: settings._id }).catch(() => null);
  return { ok: gane > 0, usados: Number((fresco || settings)[cont] || 0), hoy, settings: fresco || settings };
}
async function liberarCupoDiario({ accountId, campo }) {
  const hoy = hoyChile();
  await db.updateRaw(db.settings,
    { account_id: accountId, [`${campo}_date`]: hoy, [`${campo}_count`]: { $gt: 0 } },
    { $inc: { [`${campo}_count`]: -1 } }).catch(() => null);
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
  await resetearMesUsuario(user._id, month);
  await db.updateRaw(db.users, { _id: user._id, dm_count_month: month }, { $inc: { monthly_dm_count: count } })
    .catch(e => console.error('incrementDMCount error:', e.message));
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

  // La marca en el lead es el candado de idempotencia Y de concurrencia: solo
  // UNA escritura gana por lead y mes (para las demás la condición "todavía
  // no marcado" falla). Antes se leía el lead y se escribía después: dos
  // mensajes casi simultáneos del mismo lead contaban dos veces.
  const ganeTotal = await db.updateRaw(db.leads, { _id: lead._id, contado_mes: { $ne: month } }, { $set: { contado_mes: month } })
    .catch(e => { console.error('registrarConversacion (lead):', e.message); return 0; });
  const ganeWa = esWhatsApp
    ? await db.updateRaw(db.leads, { _id: lead._id, contado_mes_wa: { $ne: month } }, { $set: { contado_mes_wa: month } })
        .catch(e => { console.error('registrarConversacion (lead wa):', e.message); return 0; })
    : 0;
  if (!ganeTotal && !ganeWa) return { contada: false };

  await resetearMesUsuario(user._id, month);
  const inc = {};
  if (ganeTotal) inc.monthly_dm_count = 1;
  if (ganeWa)    inc.monthly_wa_count = 1;
  await db.updateRaw(db.users, { _id: user._id, dm_count_month: month }, { $inc: inc })
    .catch(e => console.error('registrarConversacion (user):', e.message));

  const fresco = await db.findOne(db.users, { _id: user._id }).catch(() => null);
  return {
    contada:  true,
    total:    Number(fresco?.monthly_dm_count || 0),
    whatsapp: Number(fresco?.monthly_wa_count || 0),
    canal:    lead.channel || 'instagram',
  };
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
  return ajustarSegundosVoz(accountId, s);
}

/**
 * Suma (o resta, con delta negativo) segundos de voz del mes, atómico. La
 * resta existe para cuando Twilio manda la duración OFICIAL después de que el
 * puente ya descontó la estimada: se aplica la diferencia, no el total.
 */
async function ajustarSegundosVoz(accountId, delta) {
  const d = Math.round(Number(delta) || 0);
  if (!d) return;
  const user = await findOwnerByAccount(accountId);
  if (!user || user.role === 'admin') return;

  const month = currentMonth();
  await db.updateRaw(db.users, { _id: user._id, voice_count_month: { $ne: month } }, {
    $set: { monthly_voice_seconds: 0, voice_count_month: month },
  }).catch(() => null);
  await db.updateRaw(db.users, { _id: user._id, voice_count_month: month }, { $inc: { monthly_voice_seconds: d } })
    .catch(e => console.error('ajustarSegundosVoz:', e.message));
}

module.exports = {
  getUsage,
  checkDMAllowance,
  incrementDMCount,
  findOwnerByAccount,
  currentMonth,
  hoyChile,
  resetearMesUsuario,
  ajustarSegundosVoz,
  reservarCupoDiario,
  liberarCupoDiario,
  registrarConversacion,
  checkCuotaCanal,
  checkMinutosVoz,
  registrarSegundosVoz,
  FACTOR_CORTE_VOZ,
};
