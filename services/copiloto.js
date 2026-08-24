/**
 * Atinov — Copiloto del panel (el chat interno del dueño)
 *
 * Lee el estado real de la cuenta, se lo pasa al módulo de conocimiento —que
 * saca el diagnóstico sin alucinar— y le pide al modelo que lo redacte.
 *
 * Este chat NO consume la cuota de conversaciones del plan: esas se venden
 * para atender clientes, no para que el dueño pida ayuda. Pero sí tiene tope
 * diario propio, porque cada consulta cuesta tokens.
 */

const OpenAI = require('openai');
const db = require('../db/database');
const { getPlanFor } = require('../config/plans');
const { estaPausado } = require('./channels/core');
const { construirPrompt } = require('./copilotoConocimiento');

/** Consultas por cuenta y por día. Generoso para un humano, techo ante un bucle. */
const TOPE_DIARIO = 40;

/** Tope de historial que viaja al modelo. Más que esto es pagar por ruido. */
const MAX_TURNOS = 12;

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Estado real de la cuenta, normalizado para el módulo de conocimiento.
 * Solo datos de configuración y uso — nunca tokens ni credenciales.
 */
async function estadoDeCuenta(accountId) {
  const account = await db.findOne(db.accounts, { _id: accountId });
  if (!account) return null;

  const user = await db.findOne(db.users, { account_id: accountId });
  const plan = getPlanFor(user);

  const mes = new Date().toISOString().slice(0, 7);
  const mismoMes = user?.dm_count_month === mes;
  const vozMismoMes = user?.voice_count_month === mes;

  const agentes = await db.find(db.agents, { account_id: accountId });

  return {
    negocio: account.ig_username || account.nombre_negocio || null,
    canales: {
      instagram: {
        conectado: !!(account.ig_user_id && account.ig_user_id !== 'demo_ig_id'),
        pausado:   estaPausado(account, 'instagram'),
        detalle:   account.ig_username ? `@${account.ig_username}` : null,
      },
      whatsapp: {
        conectado: !!account.wa_phone_number_id,
        pausado:   estaPausado(account, 'whatsapp'),
        detalle:   account.wa_display_number || null,
      },
      messenger: {
        conectado: !!account.fb_page_id,
        pausado:   estaPausado(account, 'messenger'),
        detalle:   null,
      },
    },
    plan: {
      name:  plan.name,
      price: plan.price,
      maxDMs: plan.maxDMs,
      maxDMsWhatsApp: plan.maxDMsWhatsApp,
      minutosLlamada: plan.minutosLlamada,
      llamadas: !!plan.features?.llamadas,
    },
    uso: {
      dms:        mismoMes ? Number(user?.monthly_dm_count || 0) : 0,
      whatsapp:   mismoMes ? Number(user?.monthly_wa_count || 0) : 0,
      minutosVoz: vozMismoMes ? Number(user?.monthly_voice_seconds || 0) / 60 : 0,
    },
    agentes: {
      total:   agentes.length,
      activos: agentes.filter(a => a.enabled).length,
      nombres: agentes.slice(0, 6).map(a => a.name).filter(Boolean),
    },
    // Se informa si la telefonía está lista, sin exponer una sola credencial.
    twilioListo: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
  };
}

/** Cuota diaria del copiloto. Devuelve {ok, usadas, tope}. */
async function consumirCuota(accountId) {
  const hoy = hoyISO();
  const user = await db.findOne(db.users, { account_id: accountId });
  if (!user) return { ok: true, usadas: 0, tope: TOPE_DIARIO };
  if (user.role === 'admin') return { ok: true, usadas: 0, tope: Infinity };

  const usadas = user.copiloto_dia === hoy ? Number(user.copiloto_usos || 0) : 0;
  if (usadas >= TOPE_DIARIO) return { ok: false, usadas, tope: TOPE_DIARIO };

  await db.update(db.users, { _id: user._id }, {
    copiloto_usos: usadas + 1,
    copiloto_dia:  hoy,
  }).catch(() => null);
  return { ok: true, usadas: usadas + 1, tope: TOPE_DIARIO };
}

/**
 * Responde una consulta del dueño.
 *
 * @param {object} p
 * @param {string} p.accountId
 * @param {string} p.mensaje       lo que preguntó
 * @param {Array}  [p.historial]   [{role:'user'|'assistant', content}]
 * @returns {Promise<{ok:boolean, respuesta?:string, error?:string, usadas?:number}>}
 */
async function responder({ accountId, mensaje, historial = [] }) {
  const texto = String(mensaje || '').trim().slice(0, 2000);
  if (!texto) return { ok: false, error: 'Escribe una pregunta.' };

  const cuota = await consumirCuota(accountId);
  if (!cuota.ok) {
    return { ok: false, error: `Llegaste al tope de ${cuota.tope} consultas por hoy. Mañana se renueva.` };
  }

  const settings = await db.findOne(db.settings, { account_id: accountId });
  const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
  if (!apiKey) return { ok: false, error: 'Falta configurar la API key de OpenAI en Ajustes.' };

  const estado = await estadoDeCuenta(accountId);
  const system = construirPrompt(estado);

  // Solo turnos bien formados, y los últimos: el historial viejo no aporta y
  // se paga en tokens.
  const previos = (Array.isArray(historial) ? historial : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNOS)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  try {
    const client = new OpenAI({ apiKey });
    const r = await client.chat.completions.create({
      model: process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...previos, { role: 'user', content: texto }],
      temperature: 0.3,   // es soporte técnico: se premia la precisión, no la creatividad
      max_tokens: 500,
    });

    const respuesta = r.choices?.[0]?.message?.content?.trim();
    if (!respuesta) return { ok: false, error: 'No se pudo generar la respuesta. Reintenta.' };

    // Registro de consumo, igual que el resto de las llamadas al modelo.
    try {
      await db.insert(db.aiUsage, {
        accountId, model: r.model, origen: 'copiloto',
        promptTokens: r.usage?.prompt_tokens || 0,
        completionTokens: r.usage?.completion_tokens || 0,
      });
    } catch { /* el log no puede tumbar la respuesta */ }

    return { ok: true, respuesta, usadas: cuota.usadas, tope: cuota.tope };
  } catch (e) {
    console.error('[copiloto]', e.message);
    return { ok: false, error: 'El asistente no está disponible en este momento.' };
  }
}

module.exports = { responder, estadoDeCuenta, TOPE_DIARIO, MAX_TURNOS };
