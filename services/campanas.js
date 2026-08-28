/**
 * Atinov — Campañas de promociones segmentadas (broadcast por WhatsApp)
 *
 * El último eslabón del vertical tiendas: "repetir con promociones" del
 * cliente laboratorio, construido genérico. La regla comercial que lo
 * gobierna (evidencia en Desktop\ATINOV_CLIENTE_ROPA_PLAYBOOK.md §2.7):
 * promociones 2-3 veces AL MES por segmento, nunca volumen — Meta capea la
 * casilla de cada usuario (~2 marketing/día contando todas las marcas) y
 * degrada el número si la gente bloquea.
 *
 * Por eso el broadcast REUSA el mismo cap por contacto del playbook
 * post-compra (chequearCapMarketing/contarMarketing): un lead que ya recibió
 * su marketing de hoy o agotó su cupo del mes queda FUERA de la campaña y se
 * reporta como "bloqueado por cap" — visible en las estadísticas, no
 * silencioso. El 131049 de Meta (casilla llena por otras marcas) también se
 * cuenta aparte. Una campaña es un envío puntual: no persigue con reintentos
 * a quien no le pudo llegar — eso sería exactamente el spam que el cap evita.
 *
 * Broadcast = SIEMPRE plantilla aprobada (fuera de ventana casi por
 * definición). El throttle de envío es LOTE_ENVIO por corrida del worker
 * (~por minuto): una campaña de 300 personas tarda ~20 min a propósito —
 * pacing, no ráfaga.
 *
 * Ciclo: borrador no existe — se crea 'programada' → el worker la pasa a
 * 'enviando' (congela el SNAPSHOT de destinatarios: el segmento se evalúa UNA
 * vez) → avanza por cursor → 'completada'. 'pausada_cuota' si el plan se queda
 * sin conversaciones a mitad de camino (se retoma sola al mes siguiente si el
 * dueño la re-programa; no automático). 'cancelada' a mano.
 */

const db = require('../db/database');
const { chequearCapMarketing, contarMarketing, configDe } = require('./playbookPedido');

const LOTE_ENVIO = 15;              // envíos por corrida del worker (~por minuto)
const MAX_CAMPANAS_ACTIVAS = 2;     // programadas+enviando por cuenta a la vez
const MAX_DESTINATARIOS = 1000;     // techo duro por campaña

// ── Segmentos ────────────────────────────────────────────────────────────────

/**
 * Filtros del segmento. Todo broadcast parte de la base dura: leads de
 * WhatsApp con número, no demo, no en manejo humano, sin opt-out.
 *   compraron:    'si' | 'no' | 'todos'
 *   calificacion: 'hot' | 'warm' | 'cold' | 'todos'
 *   actividad:    'activos_30' | 'dormidos_30' | 'dormidos_60' | 'todos'
 *     (activos = con mensaje en los últimos N días; dormidos = sin mensaje hace más de N)
 */
function normalizarSegmento(s = {}) {
  const opt = (v, validos, def) => (validos.includes(v) ? v : def);
  return {
    compraron:    opt(s.compraron, ['si', 'no', 'todos'], 'todos'),
    calificacion: opt(s.calificacion, ['hot', 'warm', 'cold', 'todos'], 'todos'),
    actividad:    opt(s.actividad, ['activos_30', 'dormidos_30', 'dormidos_60', 'todos'], 'todos'),
  };
}

function cumpleSegmento(lead, seg) {
  // Base dura — no negociable por segmento.
  if (!lead.wa_id) return false;                                   // broadcast es solo WhatsApp
  if (lead.demo) return false;
  if (lead.is_bypassed) return false;
  if (lead.automation && lead.automation !== 'automated') return false;
  if (lead.mkt_opt_out === true) return false;                     // pidió no recibir marketing

  if (seg.compraron === 'si' && !(lead.is_converted || lead.pipeline_stage === 'ganado')) return false;
  if (seg.compraron === 'no' && (lead.is_converted || lead.pipeline_stage === 'ganado')) return false;

  if (seg.calificacion !== 'todos' && lead.qualification !== seg.calificacion) return false;

  if (seg.actividad !== 'todos') {
    const ultimo = lead.last_message_at ? new Date(lead.last_message_at).getTime() : 0;
    const dias = ultimo ? (Date.now() - ultimo) / 864e5 : Infinity;
    if (seg.actividad === 'activos_30' && dias > 30) return false;
    if (seg.actividad === 'dormidos_30' && dias <= 30) return false;
    if (seg.actividad === 'dormidos_60' && dias <= 60) return false;
  }
  return true;
}

/** Los leads que hoy calzan con el segmento (para estimar y para el snapshot). */
async function leadsDeSegmento(accountId, segmento) {
  const seg = normalizarSegmento(segmento);
  const todos = await db.find(db.leads, { account_id: accountId });
  return todos.filter(l => cumpleSegmento(l, seg));
}

// ── Creación / cancelación ───────────────────────────────────────────────────

async function crearCampana({ accountId, nombre, templateName, templateLang, segmento, scheduledFor, conNombre }) {
  const template = String(templateName || '').trim();
  if (!template) return { ok: false, error: 'Falta el nombre de la plantilla aprobada en Meta.' };
  const nom = String(nombre || '').trim().slice(0, 80);
  if (!nom) return { ok: false, error: 'Ponle un nombre a la campaña (para reconocerla en la lista).' };

  // Anti-metralleta: máximo 2 campañas vivas a la vez por cuenta.
  const vivas = (await db.find(db.campanas, { account_id: accountId }))
    .filter(c => ['programada', 'enviando'].includes(c.estado));
  if (vivas.length >= MAX_CAMPANAS_ACTIVAS) {
    return { ok: false, error: `Ya tienes ${MAX_CAMPANAS_ACTIVAS} campañas activas. Espera a que terminen o cancela una.` };
  }

  const seg = normalizarSegmento(segmento);
  const destinatarios = await leadsDeSegmento(accountId, seg);
  if (!destinatarios.length) {
    return { ok: false, error: 'El segmento no tiene ningún destinatario hoy. Ajusta los filtros.' };
  }

  const cuando = scheduledFor && !isNaN(Date.parse(scheduledFor))
    ? new Date(scheduledFor).toISOString()
    : new Date().toISOString(); // "ahora"

  const campana = await db.insert(db.campanas, {
    account_id: accountId,
    nombre: nom,
    template_name: template.slice(0, 120),
    template_lang: String(templateLang || 'es').trim() || 'es',
    con_nombre: conNombre === true, // la plantilla usa {{1}} = primer nombre
    segmento: seg,
    estado: 'programada',
    scheduled_for: cuando,
    // El snapshot real se congela al pasar a 'enviando'; esto es el estimado.
    estimado: Math.min(destinatarios.length, MAX_DESTINATARIOS),
    destinatarios: null,
    cursor: 0,
    stats: { enviados: 0, bloqueados_cap: 0, casilla_llena: 0, fallidos: 0 },
  });
  return { ok: true, campana };
}

async function cancelarCampana(campanaId, accountId) {
  const c = await db.findOne(db.campanas, { _id: campanaId, account_id: accountId });
  if (!c) return { ok: false, error: 'campaña no encontrada' };
  if (['completada', 'cancelada'].includes(c.estado)) {
    return { ok: false, error: 'esa campaña ya terminó' };
  }
  await db.update(db.campanas, { _id: c._id }, {
    estado: 'cancelada', cancelada_at: new Date().toISOString(),
  });
  return { ok: true };
}

// ── Worker ───────────────────────────────────────────────────────────────────

/**
 * Avanza las campañas vencidas, LOTE_ENVIO envíos por corrida y por campaña.
 * `deps.enviarPlantilla` se inyecta en tests.
 */
async function procesarCampanas(deps = {}) {
  const enviarPlantilla = deps.enviarPlantilla || enviarPlantillaReal;
  const ahora = new Date().toISOString();

  const todas = await db.find(db.campanas, {});
  const activas = todas.filter(c =>
    (c.estado === 'programada' && c.scheduled_for <= ahora) || c.estado === 'enviando'
  );

  for (const campana of activas) {
    try {
      let c = campana;

      // Programada → enviando: congelar el snapshot de destinatarios AHORA.
      if (c.estado === 'programada') {
        const leads = await leadsDeSegmento(c.account_id, c.segmento);
        const ids = leads.slice(0, MAX_DESTINATARIOS).map(l => l._id);
        if (!ids.length) {
          await db.update(db.campanas, { _id: c._id }, {
            estado: 'completada', completed_at: ahora,
            nota: 'el segmento quedó vacío al momento del envío',
          });
          continue;
        }
        await db.update(db.campanas, { _id: c._id }, {
          estado: 'enviando', destinatarios: ids, cursor: 0, started_at: ahora,
        });
        c = { ...c, estado: 'enviando', destinatarios: ids, cursor: 0 };
      }

      const account = await db.findOne(db.accounts, { _id: c.account_id });
      const settings = await db.findOne(db.settings, { account_id: c.account_id });
      if (!account?.wa_phone_number_id || !account?.wa_access_token) {
        await db.update(db.campanas, { _id: c._id }, {
          estado: 'cancelada', nota: 'la cuenta no tiene WhatsApp conectado',
        });
        continue;
      }
      const cfg = configDe(settings || {}); // capMktMes vale aunque el playbook esté apagado

      const { checkCuotaCanal, incrementDMCount } = require('./limits');
      const stats = { ...c.stats };
      let cursor = c.cursor || 0;
      let enviadosEnLote = 0;

      while (cursor < c.destinatarios.length && enviadosEnLote < LOTE_ENVIO) {
        const leadId = c.destinatarios[cursor];
        cursor++;

        const lead = await db.findOne(db.leads, { _id: leadId });
        // Releer condiciones al momento del envío: el snapshot puede tener
        // horas y el lead pudo comprar, pedir humano u optar por salir.
        if (!lead || !lead.wa_id || lead.mkt_opt_out === true || lead.is_bypassed
            || (lead.automation && lead.automation !== 'automated')) {
          continue;
        }

        // El MISMO cap por contacto del playbook: campañas y playbook comparten
        // el presupuesto de marketing de cada persona.
        const cap = chequearCapMarketing(lead, cfg);
        if (!cap.ok) { stats.bloqueados_cap++; continue; }

        // Cuota del plan: si se acabó, la campaña se PAUSA visible (no muere).
        // OJO: el overage existe para no cortar la ATENCIÓN de gente que
        // escribe — un broadcast masivo en overage sería US$0,50 × cientos de
        // promos como sorpresa en la factura. Las campañas respetan el tope
        // DURO del plan, sin overage.
        const permiso = await checkCuotaCanal(c.account_id, 'whatsapp').catch(() => ({ allowed: true }));
        if (permiso && (permiso.allowed === false || permiso.overage === true)) {
          await db.update(db.campanas, { _id: c._id }, {
            estado: 'pausada_cuota', cursor: cursor - 1, stats,
            nota: 'la cuenta alcanzó el límite de conversaciones del plan',
          });
          cursor = -1; // señal de que ya persistimos
          break;
        }

        try {
          await enviarPlantilla({ account, campana: c, lead });
          stats.enviados++;
          enviadosEnLote++;
          await contarMarketing(lead._id, lead);
          await incrementDMCount(c.account_id, 1).catch(() => null);
          await db.insert(db.messages, {
            lead_id: lead._id, role: 'agent',
            content: `[campaña "${c.nombre}"] plantilla ${c.template_name}`,
            is_template: true, is_campana: true, campana_id: c._id,
          }).catch(() => null);
        } catch (e) {
          if (e?.response?.data?.error?.code === 131049) {
            // Casilla de marketing de ESA persona llena (todas las marcas
            // suman). Una campaña no persigue: se cuenta y se sigue.
            stats.casilla_llena++;
          } else {
            stats.fallidos++;
            console.warn(`[campañas] envío falló (${c.nombre} → lead ${leadId}):`,
              e?.response?.data?.error?.message || e.message);
          }
        }
      }

      if (cursor === -1) continue; // pausada por cuota, ya persistida

      const terminada = cursor >= c.destinatarios.length;
      await db.update(db.campanas, { _id: c._id }, {
        cursor, stats,
        ...(terminada ? { estado: 'completada', completed_at: new Date().toISOString() } : {}),
      });
      if (terminada) {
        console.log(`📣 [campañas] "${c.nombre}" completada — ${stats.enviados} enviados, ${stats.bloqueados_cap} por cap, ${stats.casilla_llena} casilla llena, ${stats.fallidos} fallidos`);
      }
    } catch (e) {
      console.error(`[campañas] ${campana._id} falló:`, e.message);
      await db.update(db.campanas, { _id: campana._id }, {
        estado: 'cancelada', nota: 'error: ' + e.message,
      }).catch(() => null);
    }
  }
}

async function enviarPlantillaReal({ account, campana, lead }) {
  const wa = require('./whatsapp');
  const components = campana.con_nombre
    ? [{
        type: 'body',
        parameters: [{ type: 'text', text: String((lead.wa_name || lead.ig_username || 'Hola').split(' ')[0]).slice(0, 60) }],
      }]
    : [];
  await wa.sendTemplate({
    phoneNumberId: account.wa_phone_number_id,
    recipient: lead.wa_id,
    templateName: campana.template_name,
    languageCode: campana.template_lang,
    components,
    accessToken: account.wa_access_token,
  });
}

module.exports = {
  normalizarSegmento, cumpleSegmento, leadsDeSegmento,
  crearCampana, cancelarCampana, procesarCampanas,
  LOTE_ENVIO, MAX_CAMPANAS_ACTIVAS, MAX_DESTINATARIOS,
};
