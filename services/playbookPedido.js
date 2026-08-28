/**
 * Atinov — Playbook post-compra (vertical tiendas)
 *
 * La secuencia que los referentes de e-commerce ejecutan SIEMPRE y casi ningún
 * negocio chico alcanza a hacer a mano (evidencia en
 * Desktop\ATINOV_CLIENTE_ROPA_PLAYBOOK.md):
 *
 *   confirmado ──2-3h──▶ upsell "agrégalo al MISMO envío"          (marketing)
 *   in_transit ────────▶ "va en camino" + tracking                 (utility)
 *   out_for_delivery ──▶ "llega HOY" (clave en contra-entrega)     (utility)
 *   delivered ──+1h───▶ "¿llegó todo bien?"                        (utility)
 *              ──10d───▶ reseña + video de prueba                  (marketing)
 *              ──21d───▶ invitación a la recompra                  (marketing)
 *
 * Los estados de envío vienen del webhook fulfillments/update de Shopify; los
 * tiempos son configurables por cuenta y el módulo es OPT-IN
 * (settings.playbook_pedido_enabled) — sin eso, inerte.
 *
 * FRECUENCIA — la parte que hace esto viable para cualquier tienda, no solo
 * una: Meta le pone a CADA usuario de WhatsApp un cupo de ~2 mensajes de
 * marketing por día contando TODAS las marcas juntas (error 131049 al
 * pasarse), y degrada la calidad del número si la gente bloquea. Por eso el
 * motor distingue utility (tracking/entrega: no gastan cupo y llegan siempre)
 * de marketing (upsell/reseña/winback), y a los marketing les aplica:
 *   1. cap mensual por contacto (default 3/mes, configurable),
 *   2. máximo 1 por día por contacto (si compiten, gana el de mayor prioridad
 *      porque se procesa primero y el resto se corre solo),
 *   3. reintento automático al día siguiente si Meta rechaza por 131049 —
 *      un mensaje que muere en silencio parece enviado y no lo fue.
 *
 * Ventana de 24h: dentro de ella el mensaje sale como texto libre (los
 * marketing se generan con el LLM y el catálogo; los utility son deterministas
 * — datos de envío no se dejan alucinar). Fuera de ella WhatsApp solo acepta
 * PLANTILLAS aprobadas: cada tipo usa la plantilla configurada en settings y,
 * si falta, la tarea se cancela dejando aviso en el hilo — fail-closed sin
 * romper nada.
 *
 * Contrato de plantillas (documentado en el preset): hasta 3 variables —
 * {{1}} nombre · {{2}} número de pedido · {{3}} dato extra (tracking/productos).
 */

const db = require('../db/database');

// ── Tipos y defaults ─────────────────────────────────────────────────────────

const TIPOS = {
  upsell:          { categoria: 'marketing', prioridad: 1 },
  resena:          { categoria: 'marketing', prioridad: 2 },
  winback:         { categoria: 'marketing', prioridad: 3 },
  tracking:        { categoria: 'utility',   prioridad: 0 },
  llega_hoy:       { categoria: 'utility',   prioridad: 0 },
  entregado_check: { categoria: 'utility',   prioridad: 0 },
};

const DEFAULTS = {
  upsell_horas:  2.5,   // "agrégalo al mismo envío": antes de que salga el paquete
  resena_dias:   10,    // en ropa la reseña se pide a los 7-14 días, no al llegar
  winback_dias:  21,    // mediana de recompra en ropa: 15-27 días
  mkt_cap_mes:   3,     // promos 2-3/mes por contacto — el techo del playbook
};

const VENTANA_HORAS = 23.5;      // misma ventana con margen que usa followup.js
const MAX_REINTENTOS_META = 2;   // 131049: casilla del usuario llena → +24h
const MAX_POSPUESTOS_CAP  = 5;   // marketing que no encuentra día libre, muere
const LOTE_MAX = 30;             // backpressure por corrida del worker

/** Estados de envío de Shopify que disparan pasos. El resto se ignora. */
const ESTADOS_ENVIO = ['in_transit', 'out_for_delivery', 'delivered', 'failure'];

function configDe(settings = {}) {
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    activo:       settings.playbook_pedido_enabled === true,
    upsellHoras:  num(settings.playbook_upsell_horas, DEFAULTS.upsell_horas),
    resenaDias:   num(settings.playbook_resena_dias, DEFAULTS.resena_dias),
    winbackDias:  num(settings.playbook_winback_dias, DEFAULTS.winback_dias),
    capMktMes:    num(settings.playbook_mkt_cap_mes, DEFAULTS.mkt_cap_mes),
    // Incentivo del video-reseña: se PROMETE solo si el dueño lo configuró.
    // El LLM tiene prohibido inventar descuentos.
    incentivoVideo: String(settings.playbook_incentivo_video || '').trim() || null,
    plantillas: {
      tracking:        settings.playbook_template_tracking || null,
      llega_hoy:       settings.playbook_template_llega_hoy || null,
      entregado_check: settings.playbook_template_entregado || null,
      upsell:          settings.playbook_template_upsell || null,
      resena:          settings.playbook_template_resena || null,
      winback:         settings.playbook_template_winback || null,
    },
    plantillaLang: settings.shopify_template_lang || 'es',
  };
}

// ── Agendamiento ─────────────────────────────────────────────────────────────

/**
 * Crea una tarea si no existe ya una pendiente del mismo tipo para el mismo
 * pedido (los webhooks de Shopify reintentan y los estados pueden repetirse).
 */
async function agendar({ accountId, leadId, orderId, tipo, cuandoIso, extra = {} }) {
  if (!TIPOS[tipo]) return null;
  const dup = await db.findOne(db.pedidoTasks, {
    account_id: accountId, order_id: orderId, tipo, sent_at: null, cancelled: false,
  });
  if (dup) return dup;
  const hecha = await db.findOne(db.pedidoTasks, {
    account_id: accountId, order_id: orderId, tipo, sent_at: { $ne: null },
  });
  if (hecha) return null; // ya se envió una vez para este pedido: no repetir
  return db.insert(db.pedidoTasks, {
    account_id: accountId,
    lead_id: leadId,
    order_id: orderId,
    tipo,
    categoria: TIPOS[tipo].categoria,
    prioridad: TIPOS[tipo].prioridad,
    scheduled_for: cuandoIso,
    sent_at: null,
    cancelled: false,
    reintentos_meta: 0,
    pospuestos_cap: 0,
    ...extra,
  });
}

const enMs = (h) => new Date(Date.now() + h * 3600e3).toISOString();

/** Al confirmarse el pedido ([PEDIDO: confirmado]) se arma el upsell. */
async function alConfirmarPedido({ lead, accountId }) {
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const cfg = configDe(settings || {});
  if (!cfg.activo) return { agendadas: 0 };
  const orderId = lead?.shopify_order?.orderId;
  if (!orderId) return { agendadas: 0 };
  const t = await agendar({
    accountId, leadId: lead._id, orderId,
    tipo: 'upsell', cuandoIso: enMs(cfg.upsellHoras),
  });
  return { agendadas: t ? 1 : 0 };
}

/**
 * Cambio de estado del envío (webhook fulfillments/update de Shopify).
 * Cada estado dispara una sola vez por pedido (marca en el lead), y
 * `delivered` funciona aunque el courier nunca haya reportado los anteriores.
 */
async function alCambioEnvio({ lead, accountId, fulfillment }) {
  const settings = await db.findOne(db.settings, { account_id: accountId });
  const cfg = configDe(settings || {});
  if (!cfg.activo) return { agendadas: 0, ignorado: 'playbook apagado' };

  const estado = fulfillment.status;
  if (!ESTADOS_ENVIO.includes(estado)) return { agendadas: 0, ignorado: `estado ${estado}` };

  // Dedup por estado: los webhooks de Shopify reintentan y algunos couriers
  // reportan el mismo estado varias veces.
  const vistos = lead?.shopify_order?.envio_estados || {};
  if (vistos[estado]) return { agendadas: 0, ignorado: 'estado ya procesado' };
  await db.update(db.leads, { _id: lead._id }, {
    shopify_order: {
      ...lead.shopify_order,
      envio_estados: { ...vistos, [estado]: new Date().toISOString() },
      ...(fulfillment.trackingUrl ? { tracking_url: fulfillment.trackingUrl } : {}),
      ...(fulfillment.trackingNumber ? { tracking_number: fulfillment.trackingNumber } : {}),
      ...(fulfillment.empresa ? { courier: fulfillment.empresa } : {}),
    },
  }).catch(() => null);

  const orderId = lead?.shopify_order?.orderId || fulfillment.orderId;
  const ahora = new Date().toISOString();
  let agendadas = 0;
  const add = async (tipo, cuandoIso) => {
    const t = await agendar({ accountId, leadId: lead._id, orderId, tipo, cuandoIso });
    if (t) agendadas++;
  };

  if (estado === 'in_transit') {
    await add('tracking', ahora);
  } else if (estado === 'out_for_delivery') {
    await add('llega_hoy', ahora);
  } else if (estado === 'delivered') {
    await add('entregado_check', enMs(1));
    await add('resena', enMs(cfg.resenaDias * 24));
    await add('winback', enMs(cfg.winbackDias * 24));
  } else if (estado === 'failure') {
    // Entrega fallida = acción humana urgente, no mensaje automático.
    await db.insert(db.messages, {
      lead_id: lead._id, role: 'sistema',
      content: `🚨 El courier reportó ENTREGA FALLIDA del pedido ${lead?.shopify_order?.numero || orderId}. Contacta a la clienta y coordina un reintento.`,
    }).catch(() => null);
  }
  return { agendadas };
}

// ── Frecuencia de marketing por contacto ─────────────────────────────────────

const mesActual = () => new Date().toISOString().slice(0, 7);
const diaActual = () => new Date().toISOString().slice(0, 10);

/**
 * ¿Puede este lead recibir un mensaje de MARKETING ahora?
 * Devuelve { ok } o { ok:false, motivo: 'cap_mes' | 'cap_dia' }.
 */
function chequearCapMarketing(lead, cfg) {
  const mes = mesActual();
  const enviadosMes = lead.mkt_month === mes ? Number(lead.mkt_count_month || 0) : 0;
  if (enviadosMes >= cfg.capMktMes) return { ok: false, motivo: 'cap_mes' };
  if (lead.mkt_last_day === diaActual()) return { ok: false, motivo: 'cap_dia' };
  return { ok: true };
}

/** Registra un marketing enviado en los contadores del lead. */
async function contarMarketing(leadId, lead) {
  const mes = mesActual();
  const prev = lead.mkt_month === mes ? Number(lead.mkt_count_month || 0) : 0;
  await db.update(db.leads, { _id: leadId }, {
    mkt_month: mes,
    mkt_count_month: prev + 1,
    mkt_last_day: diaActual(),
  }).catch(() => null);
}

// ── Textos deterministas (utility) ───────────────────────────────────────────
// Los datos de envío no se dejan en manos del LLM: acá no se alucina.

function textoUtility(tipo, lead) {
  const o = lead.shopify_order || {};
  const nombre = (lead.wa_name || lead.ig_username || 'Hola').split(' ')[0];
  const numero = o.numero || 'tu pedido';
  if (tipo === 'tracking') {
    const url = o.tracking_url ? ` Puedes seguirlo aquí: ${o.tracking_url}` : '';
    const courier = o.courier ? ` con ${o.courier}` : '';
    return `¡${nombre}, buenas noticias! Tu pedido ${numero} ya va en camino${courier} 🚚${url}`;
  }
  if (tipo === 'llega_hoy') {
    const cod = o.pago_contra_entrega
      ? ' Como es pago contra entrega, te avisamos para que tengas el pago a mano y haya alguien para recibirlo.'
      : ' Ojalá haya alguien para recibirlo 🙌';
    return `¡${nombre}! Tu pedido ${numero} salió a reparto y llega HOY.${cod}`;
  }
  if (tipo === 'entregado_check') {
    return `${nombre}, ¿te llegó bien tu pedido ${numero}? Cualquier detalle me cuentas por aquí y lo resolvemos al tiro 🙌`;
  }
  return null;
}

// ── Hints para el LLM (marketing dentro de ventana) ──────────────────────────

function hintMarketing(tipo, lead, cfg) {
  const o = lead.shopify_order || {};
  const productos = o.productos || 'su compra';
  if (tipo === 'upsell') {
    return `POST-COMPRA (upsell de consolidación): la clienta acaba de comprar ${productos} y el paquete AÚN NO SALE. Sugiérele UN solo producto del catálogo que complemente lo que compró, con el ángulo de agregarlo al MISMO envío sin pagar despacho extra. Mensaje corto, natural, sin presión. Si el catálogo no tiene un complemento claro para esa compra, solo agradece la compra con calidez y no fuerces ninguna venta. PROHIBIDO inventar descuentos o productos que no estén en el catálogo.`;
  }
  if (tipo === 'resena') {
    const incentivo = cfg.incentivoVideo
      ? `Ofrécele EXACTAMENTE este incentivo por mandar un video corto usando el producto: "${cfg.incentivoVideo}". No prometas nada distinto.`
      : 'NO ofrezcas descuentos ni premios (no hay ninguno configurado): pide la reseña apelando a que ayuda a otros compradores.';
    return `POST-ENTREGA (reseña): la clienta recibió ${productos} hace unos días. Pregúntale cómo le ha ido con su compra y pídele una reseña breve. ${incentivo} Mensaje cálido y corto, máximo una pregunta.`;
  }
  if (tipo === 'winback') {
    return `RECOMPRA: han pasado unas 3 semanas desde que compró ${productos}. Invítala a volver: sugiérele UN complemento o novedad real del catálogo que calce con lo que ya compró. Si no hay nada que calce, un saludo cálido de la marca sin vender. PROHIBIDO inventar promociones, precios o productos.`;
  }
  return null;
}

// ── Worker ───────────────────────────────────────────────────────────────────

/** Ventana de 24h de WhatsApp: abierta si el último mensaje del USER es reciente. */
async function ventanaAbierta(leadId) {
  const msgs = await db.find(db.messages, { lead_id: leadId });
  const ultimo = msgs
    .filter(m => m.role === 'user')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  if (!ultimo) return false;
  return (Date.now() - new Date(ultimo.createdAt).getTime()) / 3600e3 < VENTANA_HORAS;
}

async function cancelar(tarea, reason) {
  await db.update(db.pedidoTasks, { _id: tarea._id }, { cancelled: true, reason })
    .catch(() => null);
}

async function posponer(tarea, horas, campos = {}) {
  await db.update(db.pedidoTasks, { _id: tarea._id }, {
    scheduled_for: enMs(horas), ...campos,
  }).catch(() => null);
}

/**
 * Procesa las tareas vencidas. `deps` permite inyectar transporte en tests;
 * en producción se usa tal cual.
 */
async function procesarTareas(deps = {}) {
  const enviarTexto = deps.enviarTexto || enviarTextoReal;
  const enviarPlantilla = deps.enviarPlantilla || enviarPlantillaReal;
  const generarLlm = deps.generarLlm || generarLlmReal;

  const ahora = new Date().toISOString();
  const todas = await db.find(db.pedidoTasks, {});
  const due = todas
    .filter(t => !t.sent_at && !t.cancelled && t.scheduled_for <= ahora)
    // Prioridad primero: si un upsell y un winback del mismo lead vencen juntos,
    // el upsell se procesa antes y el cap diario corre al winback a mañana.
    .sort((a, b) => (a.prioridad - b.prioridad) || a.scheduled_for.localeCompare(b.scheduled_for))
    .slice(0, LOTE_MAX);

  let enviadas = 0;
  for (const tarea of due) {
    try {
      const lead = await db.findOne(db.leads, { _id: tarea.lead_id });
      const account = await db.findOne(db.accounts, { _id: tarea.account_id });
      const settings = await db.findOne(db.settings, { account_id: tarea.account_id });
      const cfg = configDe(settings || {});

      if (!lead || !account) { await cancelar(tarea, 'entidades faltantes'); continue; }
      if (!cfg.activo) { await cancelar(tarea, 'playbook apagado'); continue; }
      // Manejo humano o automatización apagada: no meterse en la conversación.
      if (lead.is_bypassed || (lead.automation && lead.automation !== 'automated')) {
        await cancelar(tarea, 'lead en manejo humano'); continue;
      }
      if (!lead.wa_id || !account.wa_phone_number_id || !account.wa_access_token) {
        await cancelar(tarea, 'sin WhatsApp utilizable'); continue;
      }
      // Pedido cancelado: nada que dar seguimiento (el upsell de un pedido
      // cancelado es un bochorno).
      if (lead.shopify_order?.estado === 'cancelado' && tarea.tipo !== 'winback') {
        await cancelar(tarea, 'pedido cancelado'); continue;
      }

      const esMarketing = tarea.categoria === 'marketing';

      // Cap de marketing por contacto — la regla que protege el número.
      if (esMarketing) {
        const cap = chequearCapMarketing(lead, cfg);
        if (!cap.ok) {
          if (cap.motivo === 'cap_mes' || tarea.pospuestos_cap >= MAX_POSPUESTOS_CAP) {
            await cancelar(tarea, `cap de marketing (${cap.motivo})`);
          } else {
            await posponer(tarea, 24, { pospuestos_cap: (tarea.pospuestos_cap || 0) + 1 });
          }
          continue;
        }
      }

      // Cuota del plan: estos mensajes consumen igual que cualquier DM.
      const { checkCuotaCanal, incrementDMCount } = require('./limits');
      const permiso = await checkCuotaCanal(tarea.account_id, 'whatsapp').catch(() => ({ allowed: true }));
      if (permiso && permiso.allowed === false) {
        await cancelar(tarea, 'cuota del plan alcanzada');
        continue;
      }

      // ¿Ventana de 24h abierta? → texto libre. ¿Cerrada? → plantilla aprobada.
      const abierta = await ventanaAbierta(lead._id);
      let texto = null;
      let porPlantilla = false;

      if (abierta) {
        if (esMarketing) {
          texto = await generarLlm({ lead, account, settings, tarea, cfg });
          if (!texto) { await cancelar(tarea, 'LLM no generó mensaje'); continue; }
        } else {
          texto = textoUtility(tarea.tipo, lead);
        }
      } else {
        const nombrePlantilla = cfg.plantillas[tarea.tipo];
        if (!nombrePlantilla) {
          await db.insert(db.messages, {
            lead_id: lead._id, role: 'sistema',
            content: `⚠️ Paso "${tarea.tipo}" del playbook sin enviar: la ventana de 24h está cerrada y no hay plantilla configurada (Configuración → Tienda → Playbook).`,
          }).catch(() => null);
          await cancelar(tarea, 'sin plantilla y fuera de ventana');
          continue;
        }
        porPlantilla = true;
        texto = textoUtility(tarea.tipo, lead)
          || `[plantilla ${nombrePlantilla}] paso ${tarea.tipo} del pedido ${lead.shopify_order?.numero || ''}`;
      }

      try {
        if (porPlantilla) {
          await enviarPlantilla({ account, lead, cfg, tarea });
        } else {
          await enviarTexto({ account, lead, texto });
        }
      } catch (e) {
        const codigo = e?.response?.data?.error?.code;
        // 131049: la casilla de marketing de ESA persona está llena por hoy
        // (todas las marcas suman). Mañana a esta hora suele estar libre.
        if (codigo === 131049 && (tarea.reintentos_meta || 0) < MAX_REINTENTOS_META) {
          await posponer(tarea, 24, { reintentos_meta: (tarea.reintentos_meta || 0) + 1 });
          console.warn(`📮 [playbook] casilla llena (131049) — ${tarea.tipo} reprogramado para mañana`);
          continue;
        }
        throw e;
      }

      // Registro en el hilo: la clienta responde a ESTO y el LLM debe verlo.
      await db.insert(db.messages, {
        lead_id: lead._id, role: 'agent', content: texto,
        is_playbook: true, playbook_tipo: tarea.tipo,
        ...(porPlantilla ? { is_template: true } : {}),
      }).catch(() => null);
      await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() })
        .catch(() => null);

      if (esMarketing) await contarMarketing(lead._id, lead);
      await incrementDMCount(tarea.account_id, 1).catch(() => null);
      await db.update(db.pedidoTasks, { _id: tarea._id }, { sent_at: new Date().toISOString() });
      enviadas++;
      console.log(`📦 [playbook] ${tarea.tipo} enviado — pedido ${lead.shopify_order?.numero || tarea.order_id}`);
    } catch (e) {
      console.error(`[playbook] tarea ${tarea._id} (${tarea.tipo}) falló:`,
        e?.response?.data?.error?.message || e.message);
      await cancelar(tarea, 'error: ' + (e?.response?.data?.error?.message || e.message));
    }
  }
  return { procesadas: due.length, enviadas };
}

// ── Transporte real ──────────────────────────────────────────────────────────

async function enviarTextoReal({ account, lead, texto }) {
  const wa = require('./whatsapp');
  await wa.sendMessage({
    phoneNumberId: account.wa_phone_number_id,
    recipient: lead.wa_id,
    text: texto,
    accessToken: account.wa_access_token,
    accountId: account._id,
  });
}

async function enviarPlantillaReal({ account, lead, cfg, tarea }) {
  const wa = require('./whatsapp');
  const o = lead.shopify_order || {};
  const nombre = (lead.wa_name || lead.ig_username || 'cliente').split(' ')[0];
  const extra = tarea.tipo === 'tracking' ? (o.tracking_url || o.courier || '-')
              : (o.productos || '-');
  const params = [nombre, o.numero || '-', extra]
    .map(t => ({ type: 'text', text: String(t).slice(0, 250) }));
  await wa.sendTemplate({
    phoneNumberId: account.wa_phone_number_id,
    recipient: lead.wa_id,
    templateName: cfg.plantillas[tarea.tipo],
    languageCode: cfg.plantillaLang,
    components: [{ type: 'body', parameters: params }],
    accessToken: account.wa_access_token,
  });
}

async function generarLlmReal({ lead, account, settings, tarea, cfg }) {
  const { generateReply } = require('./openai');
  const { knowledgeForAgent } = require('./agents/knowledge');
  const agent = await db.findOne(db.agents, { _id: lead.agent_id })
    || await db.findOne(db.agents, { account_id: account._id, enabled: true });
  if (!agent) return null;
  const allKnowledge = await db.find(db.knowledge, { account_id: account._id });
  const historial = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
  if (!apiKey) return null;

  let reply = await generateReply({
    agent,
    knowledge: knowledgeForAgent(allKnowledge, agent),
    links: [],
    conversationHistory: historial.filter(m => m.role !== 'sistema'),
    newMessage: '[MENSAJE PROACTIVO DEL PLAYBOOK POST-COMPRA — no respondas a un mensaje del cliente]',
    accountId: account._id,
    apiKey,
    extraContext: hintMarketing(tarea.tipo, lead, cfg),
    qualification: lead.qualification || null,
    leadPhone: lead.wa_id || null,
    leadChannel: 'whatsapp',
  });

  // Mismo scrub que los follow-ups: un mensaje proactivo no puede disparar
  // pagos, citas ni llamadas por imitación de marcadores del historial.
  reply = (reply || '')
    .replace(/\[PAGO[^\]]*\]?/gi, '')
    .replace(/\[AGENDAR[^\]]*\]?/gi, '')
    .replace(/\[PEDIDO[^\]]*\]?/gi, '')
    .replace(/\[LLAMAR[^\]]*\]?/gi, '')
    .replace(/[ \t]{2,}/g, ' ').trim();
  return reply || null;
}

// ── Supresión ────────────────────────────────────────────────────────────────

/** Cancela lo pendiente de un lead (p. ej. cuando su pedido se cancela). */
async function cancelarPorLead(leadId, reason = 'lead eliminado') {
  const tareas = await db.find(db.pedidoTasks, { lead_id: leadId });
  for (const t of tareas) {
    if (!t.sent_at && !t.cancelled) await cancelar(t, reason);
  }
}

module.exports = {
  TIPOS, DEFAULTS, VENTANA_HORAS,
  configDe, agendar, alConfirmarPedido, alCambioEnvio,
  chequearCapMarketing, contarMarketing,
  textoUtility, hintMarketing,
  procesarTareas, cancelarPorLead,
};
