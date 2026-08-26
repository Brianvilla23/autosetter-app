/**
 * Atinov — Margen real por cuenta y medición del costo LLM
 *
 * Dos preguntas que hasta ahora se respondían con constantes a ojo:
 *
 *  1. ¿Cuánto cuesta DE VERDAD el LLM por conversación? `COSTOS.llmPorConv`
 *     (config/plans.js) es un estimado y es el número que más pesa en los
 *     planes altos. Acá se mide contra db.aiUsage, que guarda tokens y modelo
 *     por llamada real.
 *
 *  2. ¿Qué margen deja CADA cliente este mes? La escalera garantiza margen si
 *     el cliente usa su cuota completa, pero el margen real depende del uso
 *     real. Este monitor es lo que hace exigible el objetivo de margen: si una
 *     cuenta cruza el umbral, se ve acá y no seis meses después en el banco.
 *
 * Ninguna función de acá corta ni cobra nada — es instrumento de medición.
 */

const db = require('../db/database');
const {
  getPlanFor, COSTOS, COSTO_CONV_WHATSAPP, COSTO_CONV_META, COSTO_MINUTO_LLAMADA,
} = require('../config/plans');
const { currentMonth } = require('./limits');

/** Bajo este margen (%) una cuenta pagada se marca en alerta. */
const UMBRAL_ALERTA_MARGEN = 20;

/**
 * db.aiUsage solo registra la llamada de chat principal (openai.js). Las
 * auxiliares — score, resumen, embeddings, transcripción — no se loguean, y
 * config/plans.js las estima como un x2 sobre el chat. Se usa el MISMO factor
 * acá para que la medición y el estimado hablen el mismo idioma; si algún día
 * se loguean las auxiliares, este factor baja a 1.
 */
const FACTOR_AUXILIAR = 2;

/**
 * US$ por 1M de tokens, por modelo. Rate card de OpenAI — actualizar a mano
 * si cambian precios o si OPENAI_FAST_MODEL / OPENAI_REASONING_MODEL apuntan
 * a un modelo que no está en la lista.
 *
 * Los reasoning tokens YA VIENEN dentro de completion_tokens (el campo
 * reasoningTokens de aiUsage es desglose informativo): no se suman aparte.
 */
const PRECIOS_MODELO = {
  'gpt-4o-mini':  { entrada: 0.15, salida: 0.60 },
  'gpt-4o':       { entrada: 2.50, salida: 10.00 },
  'gpt-4.1-mini': { entrada: 0.40, salida: 1.60 },
  'gpt-4.1':      { entrada: 2.00, salida: 8.00 },
  'o4-mini':      { entrada: 1.10, salida: 4.40 },
  'o3':           { entrada: 2.00, salida: 8.00 },
  'gpt-5-nano':   { entrada: 0.05, salida: 0.40 },
  'gpt-5-mini':   { entrada: 0.25, salida: 2.00 },
  'gpt-5':        { entrada: 1.25, salida: 10.00 },
};

/** Modelo fuera de la lista: se cobra como gpt-4o. Sobreestimar es el lado
 *  seguro para pricing — mejor creer que un plan pierde plata y revisarlo,
 *  que creer que gana y enterarse en la cuenta bancaria. */
const PRECIO_DESCONOCIDO = PRECIOS_MODELO['gpt-4o'];

/** US$ de una llamada registrada en aiUsage. */
function costoLlamadaLlm(uso) {
  const precio = PRECIOS_MODELO[uso.model] || PRECIO_DESCONOCIDO;
  const entrada = (Number(uso.promptTokens) || 0) / 1e6 * precio.entrada;
  const salida  = (Number(uso.completionTokens) || 0) / 1e6 * precio.salida;
  return entrada + salida;
}

/** [inicio, fin) del mes en ISO — createdAt es string ISO, compara lexicográfico. */
function rangoMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const fin = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { inicio: `${mes}-01`, fin };
}

/**
 * Mide el costo LLM real por conversación de un mes y lo compara contra la
 * constante COSTOS.llmPorConv de config/plans.js.
 *
 * Conversación = lead (no demo) con al menos una respuesta del agente en el
 * mes — la misma definición que venden los planes. Se cuenta desde db.messages
 * y no desde los contadores del usuario porque los contadores solo viven el
 * mes corriente y esto debe poder mirar meses cerrados.
 */
async function medirLlmPorConv(mes = currentMonth()) {
  const { inicio, fin } = rangoMes(mes);

  // Leads demo fuera: inflarían justo el costo que decide los precios.
  const leads = await db.find(db.leads, {});
  const demoIds = new Set(leads.filter(l => l.demo).map(l => l._id));

  const respuestas = (await db.find(db.messages, {
    role: 'agent', createdAt: { $gte: inicio, $lt: fin },
  })).filter(m => m.lead_id && !demoIds.has(m.lead_id));
  const conversaciones = new Set(respuestas.map(m => m.lead_id)).size;

  const usos = await db.find(db.aiUsage, { createdAt: { $gte: inicio, $lt: fin } });

  let costoChat = 0;
  const porModelo = {};
  const desconocidos = new Set();
  for (const u of usos) {
    const c = costoLlamadaLlm(u);
    costoChat += c;
    const m = u.model || '(sin modelo)';
    const fila = (porModelo[m] ||= { llamadas: 0, promptTokens: 0, completionTokens: 0, costo_usd: 0 });
    fila.llamadas++;
    fila.promptTokens     += Number(u.promptTokens) || 0;
    fila.completionTokens += Number(u.completionTokens) || 0;
    fila.costo_usd = +(fila.costo_usd + c).toFixed(4);
    if (!PRECIOS_MODELO[u.model]) desconocidos.add(m);
  }

  const porConvChat  = conversaciones ? costoChat / conversaciones : null;
  const porConvTotal = porConvChat === null ? null : porConvChat * FACTOR_AUXILIAR;
  const constante    = COSTOS.llmPorConv;

  return {
    mes,
    llamadas_llm:  usos.length,
    conversaciones,
    costo_chat_usd: +costoChat.toFixed(4),
    // Lo medido (solo chat) y lo medido con el x2 de las auxiliares — este
    // último es el que se compara contra la constante de config/plans.js.
    llm_por_conv_chat_usd:  porConvChat  === null ? null : +porConvChat.toFixed(4),
    llm_por_conv_total_usd: porConvTotal === null ? null : +porConvTotal.toFixed(4),
    factor_auxiliar: FACTOR_AUXILIAR,
    constante_config_usd: constante,
    // >0: la constante se queda corta y los márgenes publicados son optimistas.
    desviacion_pct: porConvTotal === null ? null
      : +(((porConvTotal - constante) / constante) * 100).toFixed(1),
    por_modelo: porModelo,
    modelos_sin_precio: [...desconocidos],
  };
}

/**
 * Margen del mes CORRIENTE, cuenta por cuenta.
 *
 * Solo mes corriente a propósito: el uso sale de los contadores del usuario
 * (monthly_dm_count / monthly_wa_count / monthly_voice_seconds), que son la
 * fuente de verdad de las cuotas y se resetean lazy al cambiar el mes. No hay
 * registro histórico de esos contadores, y reconstruirlo desde messages daría
 * un número DISTINTO al que se cobró — mejor un monitor honesto de "cómo va
 * este mes" que un historiador impreciso.
 *
 * El costo por cuenta usa los mismos costos unitarios que la escalera
 * (COSTO_CONV_*, COSTO_MINUTO_LLAMADA, numeroMes), así que margen acá y
 * margen en costoPlan() son comparables. El LLM medido de aiUsage va en una
 * columna aparte SOLO para contraste — la componente LLM ya está dentro de
 * COSTO_CONV_* vía llmPorConv, sumarla de nuevo sería doble conteo.
 *
 * Mientras Twilio siga bloqueado, numeroMes (US$7) sobreestima el costo de
 * los planes con llamadas: lado seguro, igual que en costoPlan().
 */
async function margenPorCuenta() {
  const mes = currentMonth();
  const { inicio, fin } = rangoMes(mes);

  const usuarios = (await db.find(db.users, {}))
    .filter(u => u.role !== 'admin' && u.email !== 'demo@atinov.com');

  // LLM medido del mes por cuenta, para la columna de contraste.
  // (aiUsage usa accountId camel — así se escribe en openai.js, no unificar)
  const usos = await db.find(db.aiUsage, { createdAt: { $gte: inicio, $lt: fin } });
  const llmPorCuenta = {};
  for (const u of usos) {
    if (u.accountId) {
      llmPorCuenta[u.accountId] = (llmPorCuenta[u.accountId] || 0) + costoLlamadaLlm(u);
    }
  }

  const cuentasDb = await db.find(db.accounts, {});
  const nombreCuenta = (id) => {
    const c = cuentasDb.find(a => a._id === id);
    return c?.ig_username || c?.name || id || '(sin cuenta)';
  };

  const cuentas = usuarios.map(user => {
    const plan = getPlanFor(user);
    const precio = Number.isFinite(plan.price) ? plan.price : 0;

    // Contadores del mes corriente; si el usuario quedó en un mes viejo, su
    // uso de ESTE mes es cero (el reset lazy aún no corrió para él).
    const conv   = user.dm_count_month === mes ? Number(user.monthly_dm_count || 0) : 0;
    const convWa = user.dm_count_month === mes ? Number(user.monthly_wa_count || 0) : 0;
    const minVoz = user.voice_count_month === mes
      ? +(Number(user.monthly_voice_seconds || 0) / 60).toFixed(1) : 0;

    const costoWa   = convWa * COSTO_CONV_WHATSAPP;
    const costoMeta = Math.max(0, conv - convWa) * COSTO_CONV_META;
    const costoVoz  = minVoz * COSTO_MINUTO_LLAMADA;
    const costoNum  = plan.features?.llamadas ? COSTOS.numeroMes : 0;
    const costo     = costoWa + costoMeta + costoVoz + costoNum;

    const margen    = precio - costo;
    const margenPct = precio > 0 ? +((margen / precio) * 100).toFixed(1) : null;

    return {
      accountId: user.account_id || null,
      cuenta:    nombreCuenta(user.account_id),
      email:     user.email,
      plan:      plan.id,
      precio_usd: precio,
      conversaciones: conv,
      conversaciones_wa: convWa,
      minutos_voz: minVoz,
      costo_usd: +costo.toFixed(2),
      costo_desglose: {
        whatsapp: +costoWa.toFixed(2),
        meta:     +costoMeta.toFixed(2),
        voz:      +costoVoz.toFixed(2),
        numero:   +costoNum.toFixed(2),
      },
      llm_medido_usd: +((llmPorCuenta[user.account_id] || 0)).toFixed(4),
      margen_usd: +margen.toFixed(2),
      margen_pct: margenPct,
      // Solo alerta una cuenta que PAGA: el trial cuesta plata pero no tiene
      // margen que vigilar — aparece con margen null y se ve igual.
      alerta: precio > 0 && margenPct !== null && margenPct < UMBRAL_ALERTA_MARGEN,
    };
  })
  // Las peores primero: alertas arriba, después por margen ascendente.
  .sort((a, b) => (b.alerta - a.alerta)
    || ((a.margen_pct ?? Infinity) - (b.margen_pct ?? Infinity)));

  return {
    mes,
    umbral_alerta_pct: UMBRAL_ALERTA_MARGEN,
    alertas: cuentas.filter(c => c.alerta).length,
    cuentas,
  };
}

module.exports = {
  medirLlmPorConv,
  margenPorCuenta,
  costoLlamadaLlm,
  PRECIOS_MODELO,
  PRECIO_DESCONOCIDO,
  FACTOR_AUXILIAR,
  UMBRAL_ALERTA_MARGEN,
};
