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
const { construirPrompt, diagnosticar } = require('./copilotoConocimiento');
const crypto = require('crypto');

/** Consultas por cuenta y por día. Generoso para un humano, techo ante un bucle. */
const TOPE_DIARIO = 40;

/** Tope de historial que viaja al modelo. Más que esto es pagar por ruido. */
const MAX_TURNOS = 12;

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Señales que el libro de fallas sabe leer (services/copilotoRunbook.js):
 * reconexiones pendientes, caducidad del token, entregas fallidas de WhatsApp
 * por código, agenda, playbook, pagos, control humano y errores recientes.
 * Cada consulta es barata y falla en silencio: una pregunta de soporte no
 * puede caerse porque una colección secundaria no respondió.
 */
async function senalesExtra(account, agentes) {
  const accountId = account._id;
  const seguro = (p, dflt) => Promise.resolve(p).catch(() => dflt);
  const ahora = Date.now();
  const hace7d  = new Date(ahora - 7 * 86_400_000).toISOString();
  const hace24h = new Date(ahora - 86_400_000).toISOString();

  const [settings, fallos, errores, bypass] = await Promise.all([
    seguro(db.findOne(db.settings, { account_id: accountId }), null),
    seguro(db.find(db.waEstados, { account_id: accountId, estado: 'failed', ts: { $gte: hace7d } }), []),
    seguro(db.count(db.errorLog, { accountId, createdAt: { $gte: hace24h } }), 0),
    seguro(db.count(db.bypassed, { account_id: accountId }), 0),
  ]);

  const fallos7d = {};
  let ultimoFallo = null;
  for (const f of fallos || []) {
    const c = String(f.codigo || 'otro');
    fallos7d[c] = (fallos7d[c] || 0) + 1;
    if (!ultimoFallo || String(f.ts || '') > String(ultimoFallo.ts || '')) {
      ultimoFallo = { codigo: f.codigo || null, detalle: f.detalle || f.titulo || null, ts: f.ts || null };
    }
  }

  let diasToken = null;
  if (account.wa_token_expires_at) {
    const ms = new Date(account.wa_token_expires_at).getTime() - ahora;
    if (Number.isFinite(ms)) diasToken = Math.floor(ms / 86_400_000);
  }

  const agenda = { activa: false, diasConHorario: 0, servicios: 0, citasHoy: 0 };
  try {
    const ag = require('./agenda');
    const cfg = ag.configDe(settings);
    agenda.activa = !!cfg.activa;
    agenda.diasConHorario = Object.values(cfg.horario || {}).filter(v => Array.isArray(v) && v.length).length;
    agenda.servicios = (cfg.servicios || []).length;
    if (agenda.activa) {
      const citas = await seguro(ag.citasDelDia(accountId, ag.hoyChile()), []);
      agenda.citasHoy = (citas || []).filter(c => ag.ACTIVAS.includes(c.estado)).length;
    }
  } catch { /* sin agenda no hay señal */ }

  const playbook = { activo: false, faltan: [] };
  try {
    const cfg = require('./playbookPedido').configDe(settings || {});
    playbook.activo = !!cfg.activo;
    playbook.faltan = Object.entries(cfg.plantillas || {}).filter(([, v]) => !v).map(([k]) => k);
  } catch { /* idem */ }

  const citas = { activo: false, faltan: [] };
  try {
    const ct = require('./citaTasks');
    citas.activo = !!ct.configDe(settings || {}).activo;
    citas.faltan = ct.plantillasFaltantes(settings || {});
  } catch { /* idem */ }

  const agentesUsanPago = (agentes || []).some(a => a.enabled && /\[PAGO\b|link de pago|mercado ?pago/i.test(String(a.instructions || '')));

  return {
    wa: { reconectar: !!account.wa_reconectar, diasToken, fallos7d, totalFallos7d: (fallos || []).length, ultimoFallo },
    fb: { reconectar: !!account.fb_reconectar, motivo: account.fb_reconectar_motivo || null },
    agenda,
    playbook,
    citas,
    pagos: { mp: !!(settings && settings.mp_access_token) },
    shopify: !!(settings && (settings.shopify_admin_token || settings.shopify_webhook_secret)),
    leads: { bypass: Number(bypass) || 0 },
    errores24h: Number(errores) || 0,
    agentesUsanPago,
  };
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
  const extra = await senalesExtra(account, agentes).catch(() => ({}));

  return {
    ...extra,
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

    // Se guarda la consulta: lo que el dueño pregunta y lo que se le contestó es
    // la materia prima del libro de fallas (admin → Sistema → "Lo que preguntan").
    const consultaId = await registrarConsulta({
      accountId, pregunta: texto, respuesta, hallazgos: diagnosticar(estado), modelo: r.model,
    });

    return { ok: true, respuesta, usadas: cuota.usadas, tope: cuota.tope, consultaId };
  } catch (e) {
    console.error('[copiloto]', e.message);
    return { ok: false, error: 'El asistente no está disponible en este momento.' };
  }
}

// ── Lo que preguntan (el ciclo de aprendizaje del soporte) ───────────────────
// Cada consulta queda guardada; el dueño la califica ("me sirvió" / "no me
// sirvió") y soporte revisa las que no sirvieron. Lo que se aprende se escribe
// en services/copilotoRunbook.js, que es lo que el copiloto lee en TODAS las
// cuentas. Ver docs/SOPORTE_QUE_APRENDE.md.

/** Guarda la consulta. Nunca tumba la respuesta: si falla, devuelve null. */
async function registrarConsulta({ accountId, pregunta, respuesta, hallazgos, modelo }) {
  try {
    const _id = crypto.randomUUID();
    await db.insert(db.copilotoConsultas, {
      _id,
      account_id: accountId,
      pregunta:  String(pregunta || '').slice(0, 2000),
      respuesta: String(respuesta || '').slice(0, 4000),
      hallazgos: Array.isArray(hallazgos) ? hallazgos.slice(0, 12) : [],
      modelo:    modelo || null,
      util:      null,     // true/false cuando el dueño califica
      revisada:  false,    // true cuando soporte la leyó y la volcó al runbook
      nota_soporte: null,
    });
    return _id;
  } catch { return null; }
}

/** El dueño califica SU consulta. Devuelve false si no existe o no es suya. */
async function calificarConsulta({ accountId, id, util, comentario }) {
  if (!id || typeof util !== 'boolean') return false;
  const c = await db.findOne(db.copilotoConsultas, { _id: String(id), account_id: accountId });
  if (!c) return false;
  await db.update(db.copilotoConsultas, { _id: c._id }, {
    util,
    comentario: String(comentario || '').slice(0, 500) || null,
    calificada_at: new Date().toISOString(),
  });
  return true;
}

/**
 * Para el admin: consultas recientes con lo que hace falta para aprender.
 * filtro: 'todas' | 'no_utiles' | 'sin_revisar' (no sirvió y nadie la revisó).
 */
async function resumenConsultas({ limit = 100, filtro = 'todas' } = {}) {
  const todas = await db.find(db.copilotoConsultas, {});
  const orden = todas.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const noUtil = c => c.util === false;
  const stats = {
    total:         todas.length,
    utiles:        todas.filter(c => c.util === true).length,
    no_utiles:     todas.filter(noUtil).length,
    sin_calificar: todas.filter(c => c.util === null || c.util === undefined).length,
    sin_revisar:   todas.filter(c => noUtil(c) && !c.revisada).length,
  };
  let lista = orden;
  if (filtro === 'no_utiles')   lista = orden.filter(noUtil);
  if (filtro === 'sin_revisar') lista = orden.filter(c => noUtil(c) && !c.revisada);
  lista = lista.slice(0, Math.min(Number(limit) || 100, 500));

  // Nombre del negocio para saber a quién le pasó sin abrir cada cuenta.
  const cuentas = {};
  for (const id of [...new Set(lista.map(c => c.account_id).filter(Boolean))]) {
    const a = await db.findOne(db.accounts, { _id: id }).catch(() => null);
    cuentas[id] = a
      ? (a.nombre_negocio || (a.ig_username ? `@${a.ig_username}` : null) || a.wa_display_number || String(id).slice(0, 8))
      : String(id).slice(0, 8);
  }
  return {
    stats,
    consultas: lista.map(c => ({
      id: c._id, fecha: c.createdAt, account_id: c.account_id, negocio: cuentas[c.account_id] || '—',
      pregunta: c.pregunta, respuesta: c.respuesta, hallazgos: c.hallazgos || [],
      util: c.util === undefined ? null : c.util, comentario: c.comentario || null,
      revisada: !!c.revisada, nota_soporte: c.nota_soporte || null,
    })),
  };
}

/** Soporte marca que ya la leyó. La nota es memoria corta; lo definitivo va al runbook. */
async function marcarRevisada(id, nota) {
  const c = await db.findOne(db.copilotoConsultas, { _id: String(id || '') });
  if (!c) return null;
  await db.update(db.copilotoConsultas, { _id: c._id }, {
    revisada: true,
    nota_soporte: String(nota || '').slice(0, 500) || null,
    revisada_at: new Date().toISOString(),
  });
  return { ...c, revisada: true };
}

module.exports = {
  responder, estadoDeCuenta, TOPE_DIARIO, MAX_TURNOS,
  registrarConsulta, calificarConsulta, resumenConsultas, marcarRevisada,
};
