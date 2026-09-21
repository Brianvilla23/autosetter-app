/**
 * Atinov — Playbook de cita (vertical barberías y todo negocio con hora)
 *
 * La cadena que Brayan describió y que ninguna barbería alcanza a hacer a mano
 * (diseño en Desktop\ATINOV_VERTICAL_BARBERIAS.md):
 *
 *   cita creada ──08:00 del día──▶ "tienes hora hoy a las X, ¿la confirmas?"   (utility)
 *               ──2 h antes─────▶ "tu hora es en 2 horas"                      (utility)
 *   atendida    ──1 h después───▶ "¿cómo quedó?"                               (utility)
 *               ──21 días───────▶ "¿te agendo la próxima?"                     (marketing)
 *
 * Se monta sobre la agenda propia (services/agenda.js) y reusa el mismo motor
 * que el playbook post-compra: ventana de 24 h, plantillas aprobadas fuera de
 * ella, cap de marketing por contacto y cuota del plan. Es OPT-IN
 * (settings.agenda_playbook_enabled): sin eso, inerte.
 *
 * POR QUÉ IMPORTA: sin abono ni recordatorio, 15-30 % de las horas se pierden
 * por inasistencia; con confirmación + recordatorio baja a un dígito. Cada
 * hora perdida en una barbería es plata que no vuelve, porque el sillón no se
 * puede "vender después".
 *
 * DIFERENCIA CLAVE CON EL PLAYBOOK DE PEDIDOS: los tiempos NO se cuentan desde
 * ahora, se anclan a la fecha y hora de la cita en horario de Chile. Por eso
 * agendaCore.instanteChile() resuelve el cambio de hora (Chile cambia de
 * UTC-4 a UTC-3 en septiembre); calcularlo en UTC dejaba los recordatorios
 * corridos una hora media año.
 *
 * Contrato de plantillas: hasta 3 variables —
 *   {{1}} nombre · {{2}} hora de la cita · {{3}} servicio.
 */

const db = require('../db/database');
const core = require('./agendaCore');

// ── Tipos y defaults ─────────────────────────────────────────────────────────

const TIPOS = {
  // El atraso va primero que todo: es la única del lote que caduca sola — una
  // hora nueva avisada tarde no sirve de nada.
  atraso:        { categoria: 'utility',   prioridad: -1 },
  // Oferta de una hora que se liberó a alguien que la había pedido. Caduca
  // igual de rápido que el atraso: la hora sirve solo si alguien la toma ya.
  hueco:         { categoria: 'utility',   prioridad: -1 },
  confirmar_dia: { categoria: 'utility',   prioridad: 0 },
  recordar:      { categoria: 'utility',   prioridad: 0 },
  feedback:      { categoria: 'utility',   prioridad: 1 },
  volver:        { categoria: 'marketing', prioridad: 2 },
};

const DEFAULTS = {
  confirmar_hora:  '08:00',  // al abrir el día, cuando todavía se puede rellenar el hueco
  recordar_horas:  2,        // el aviso que de verdad evita la inasistencia
  feedback_horas:  1,        // después del fin de la cita, con el corte fresco
  volver_dias:     21,       // un corte de hombre dura entre 3 y 4 semanas
  atraso_min:      10,       // menos que esto no se avisa: es ruido
};

const VENTANA_HORAS = 23.5;      // misma ventana con margen que followup.js
const MAX_REINTENTOS_META = 2;   // 131049: casilla de marketing llena → +24 h
const LOTE_MAX = 30;             // backpressure por corrida del worker

/** Estados de cita en los que todavía tiene sentido escribirle a la persona. */
const VIVAS = ['agendada', 'confirmada'];

function configDe(settings = {}) {
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const hora = String(settings.agenda_confirmar_hora || '').trim();
  return {
    activo:         settings.agenda_playbook_enabled === true,
    confirmarHora:  core.aMinutos(hora) !== null ? hora : DEFAULTS.confirmar_hora,
    recordarHoras:  num(settings.agenda_recordar_horas, DEFAULTS.recordar_horas),
    feedbackHoras:  num(settings.agenda_feedback_horas, DEFAULTS.feedback_horas),
    volverDias:     num(settings.agenda_volver_dias, DEFAULTS.volver_dias),
    // Bajo este atraso no se avisa. Escribirle a alguien por cinco minutos
    // molesta más de lo que ayuda.
    atrasoMin:      num(settings.agenda_atraso_min, DEFAULTS.atraso_min),
    // Igual que en el playbook de pedidos: el negocio decide si promete algo.
    // El modelo tiene prohibido inventar descuentos.
    incentivoVolver: String(settings.agenda_incentivo_volver || '').trim() || null,
    plantillas: {
      atraso:        settings.agenda_template_atraso    || null,
      hueco:         settings.agenda_template_hueco     || null,
      confirmar_dia: settings.agenda_template_confirmar || null,
      recordar:      settings.agenda_template_recordar  || null,
      feedback:      settings.agenda_template_feedback  || null,
      volver:        settings.agenda_template_volver    || null,
    },
    plantillaLang: settings.shopify_template_lang || 'es',
  };
}

/** Los pasos que quedarían mudos fuera de la ventana de 24 h. Para el copiloto. */
function plantillasFaltantes(settings = {}) {
  const cfg = configDe(settings);
  if (!cfg.activo) return [];
  return Object.entries(cfg.plantillas).filter(([, v]) => !v).map(([k]) => k);
}

// ── Agendamiento de los pasos ────────────────────────────────────────────────

/**
 * Crea la tarea si no hay ya una pendiente del mismo tipo para la misma cita.
 * Una cita que se reprograma vuelve a pasar por acá tras borrar las suyas.
 */
async function agendarPaso({ accountId, leadId, citaId, tipo, cuandoIso, extra = {} }) {
  if (!TIPOS[tipo] || !cuandoIso) return null;
  // El dedupe va por persona además de por cita: la oferta de una hora
  // liberada ("hueco") sale a varios candidatos para la MISMA cita. Para el
  // resto de los pasos la persona es siempre la dueña de la cita, así que
  // agregarla no cambia nada.
  const dup = await db.findOne(db.pedidoTasks, {
    account_id: accountId, cita_id: citaId, lead_id: leadId || null, tipo, sent_at: null, cancelled: false,
  });
  if (dup) return dup;
  const hecha = await db.findOne(db.pedidoTasks, {
    account_id: accountId, cita_id: citaId, lead_id: leadId || null, tipo, sent_at: { $ne: null },
  });
  if (hecha) return null;  // ya salió una vez para esta cita: no se repite
  return db.insert(db.pedidoTasks, {
    account_id: accountId,
    lead_id: leadId || null,
    cita_id: citaId,
    order_id: null,
    origen: 'cita',
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

/** Todas las tareas pendientes de una cita (para cancelarlas o recalcularlas). */
async function pendientesDe(citaId) {
  const todas = await db.find(db.pedidoTasks, { cita_id: citaId });
  return todas.filter(t => !t.sent_at && !t.cancelled);
}

async function cancelarPendientes(citaId, motivo) {
  const ps = await pendientesDe(citaId);
  for (const t of ps) {
    await db.update(db.pedidoTasks, { _id: t._id }, { cancelled: true, reason: motivo })
      .catch(() => null);
  }
  return ps.length;
}

const masHoras = (iso, h) => new Date(new Date(iso).getTime() + h * 3600e3).toISOString();

/**
 * Cita recién creada o reprogramada: arma confirmación del día y recordatorio.
 * Un paso cuyo momento ya pasó no se agenda (agendar a las 19:00 del mismo día
 * no puede disparar la confirmación de las 08:00 de esa mañana).
 */
async function alCrearCita(cita, settings, ahora = new Date()) {
  const cfg = configDe(settings || {});
  if (!cfg.activo || !cita || !VIVAS.includes(cita.estado)) return { agendadas: 0 };
  if (!cita.lead_id) return { agendadas: 0, ignorado: 'cita sin conversación asociada' };

  const inicio = core.instanteChile(cita.fecha, cita.hora);
  if (!inicio) return { agendadas: 0, ignorado: 'fecha u hora inválida' };
  const ahoraIso = ahora.toISOString();
  let agendadas = 0;

  const add = async (tipo, cuandoIso) => {
    if (!cuandoIso || cuandoIso <= ahoraIso) return;   // ya pasó: no se agenda
    const t = await agendarPaso({
      accountId: cita.account_id, leadId: cita.lead_id, citaId: cita._id, tipo, cuandoIso,
    });
    if (t) agendadas++;
  };

  await add('confirmar_dia', core.instanteChile(cita.fecha, cfg.confirmarHora));
  await add('recordar', masHoras(inicio, -cfg.recordarHoras));
  return { agendadas };
}

/**
 * Cambio de estado de la cita.
 *   atendida             → feedback y, más adelante, la invitación a volver
 *   cancelada / no_vino  → se cancela todo lo pendiente (escribirle a quien ya
 *                          canceló es la forma más rápida de que te bloqueen)
 */
async function alCambiarEstado(cita, settings, ahora = new Date()) {
  const cfg = configDe(settings || {});
  if (!cita) return { agendadas: 0 };

  if (['cancelada', 'no_vino'].includes(cita.estado)) {
    const n = await cancelarPendientes(cita._id, `cita ${cita.estado}`);
    return { agendadas: 0, canceladas: n };
  }
  if (cita.estado !== 'atendida') return { agendadas: 0 };

  // Ya no corresponde recordar una cita que ya ocurrió.
  await cancelarPendientes(cita._id, 'cita atendida');
  if (!cfg.activo || !cita.lead_id) return { agendadas: 0 };

  const inicio = core.instanteChile(cita.fecha, cita.hora);
  if (!inicio) return { agendadas: 0 };
  const fin = masHoras(inicio, (Number(cita.duracion_min) || 30) / 60);
  const ahoraIso = ahora.toISOString();
  let agendadas = 0;

  const add = async (tipo, cuandoIso) => {
    // El feedback de una cita vieja que recién se marca atendida sale altiro;
    // la invitación a volver, en cambio, no tiene sentido en el pasado.
    const cuando = cuandoIso > ahoraIso ? cuandoIso : (tipo === 'feedback' ? ahoraIso : null);
    if (!cuando) return;
    const t = await agendarPaso({
      accountId: cita.account_id, leadId: cita.lead_id, citaId: cita._id, tipo, cuandoIso: cuando,
    });
    if (t) agendadas++;
  };

  await add('feedback', masHoras(fin, cfg.feedbackHoras));
  await add('volver',   masHoras(fin, cfg.volverDias * 24));
  return { agendadas };
}

/** Reprogramada: se bota lo pendiente y se recalcula sobre la hora nueva. */
async function alReprogramar(cita, settings, ahora = new Date()) {
  await cancelarPendientes(cita._id, 'cita reprogramada');
  return alCrearCita(cita, settings, ahora);
}

/**
 * El profesional va atrasado: los recordatorios pendientes del día se corren
 * los mismos minutos. Si el recordatorio ya salió no se manda otro — para eso
 * está el aviso de atraso, que es otra cosa.
 */
async function alRegistrarAtraso(accountId, minutos, citasAfectadas = [], settings = null) {
  const min = Number(minutos);
  if (!Number.isFinite(min) || min === 0 || !citasAfectadas.length) return { corridas: 0, avisadas: 0 };
  const cfg = configDe(settings || {});
  const avisar = cfg.activo && min >= cfg.atrasoMin;
  const ahora = new Date().toISOString();
  let corridas = 0, avisadas = 0;

  for (const cita of citasAfectadas) {
    const ps = await pendientesDe(cita._id);

    // El recordatorio pendiente se corre los mismos minutos: avisar la hora
    // vieja sería peor que no avisar.
    for (const t of ps.filter(x => x.tipo === 'recordar')) {
      await db.update(db.pedidoTasks, { _id: t._id }, {
        scheduled_for: masHoras(t.scheduled_for, min / 60),
        corrida_por_atraso: min,
      }).catch(() => null);
      corridas++;
    }

    if (!avisar || !cita.lead_id) continue;

    // Un solo aviso por cita: si el barbero aplica otro atraso antes de que
    // salga, se actualiza la hora en vez de mandar dos mensajes seguidos.
    const previo = ps.find(x => x.tipo === 'atraso');
    if (previo) {
      await db.update(db.pedidoTasks, { _id: previo._id }, {
        hora_estimada: cita.hora_estimada || null,
        minutos: min,
      }).catch(() => null);
      continue;
    }
    const t = await agendarPaso({
      accountId, leadId: cita.lead_id, citaId: cita._id,
      tipo: 'atraso', cuandoIso: ahora,
      extra: { hora_estimada: cita.hora_estimada || null, minutos: min },
    });
    if (t) avisadas++;
  }
  return { corridas, avisadas };
}

/**
 * Una cita futura se canceló o se movió: su hora queda libre. Se le ofrece a
 * quienes la habían pedido ese día (lista de espera), los más cercanos primero.
 *
 * @param {object} liberada  la cita tal como estaba (fecha y hora de la hora LIBRE)
 */
async function alLiberarHora(liberada, settings, ahora = new Date()) {
  const cfg = configDe(settings || {});
  if (!cfg.activo || !liberada) return { ofrecidas: 0 };
  const inicio = core.instanteChile(liberada.fecha, liberada.hora);
  // Una hora que ya pasó, o que empieza en menos de 20 minutos, no la alcanza
  // a tomar nadie: ofrecerla solo genera un "¿y ahora?" del cliente.
  if (!inicio || new Date(inicio).getTime() - ahora.getTime() < 20 * 60000) {
    return { ofrecidas: 0, ignorado: 'hora demasiado cerca o pasada' };
  }

  const espera = require('./listaEspera');
  const ecfg = espera.configDe(settings || {});
  const candidatos = (await espera.candidatosPara({
    accountId: liberada.account_id, fecha: liberada.fecha, hora: liberada.hora,
    excluirLead: liberada.lead_id, ventanaMin: ecfg.ventanaMin,
  })).slice(0, ecfg.ofrecerA);

  let ofrecidas = 0;
  for (const c of candidatos) {
    const t = await agendarPaso({
      accountId: liberada.account_id, leadId: c.lead_id, citaId: liberada._id,
      tipo: 'hueco', cuandoIso: ahora.toISOString(),
      extra: {
        espera_id: c._id, nombre: c.nombre,
        fecha: liberada.fecha, hora: liberada.hora,
        servicio: liberada.servicio || c.servicio || null,
        duracion_min: liberada.duracion_min || 30,
      },
    });
    if (t) { await espera.marcarOfrecido(c._id, liberada._id); ofrecidas++; }
  }
  return { ofrecidas };
}

/**
 * ¿La hora ofrecida sigue libre? Otro candidato pudo haberla tomado entre que
 * se agendó la oferta y que el worker la manda.
 */
async function huecoSigueLibre(tarea) {
  const ag = require('./agenda');
  const citas = await ag.citasDelDia(tarea.account_id, tarea.fecha);
  const ini = core.aMinutos(tarea.hora);
  const fin = ini + (Number(tarea.duracion_min) || 30);
  return !citas.some(c => {
    if (!ag.ACTIVAS.includes(c.estado)) return false;
    const a = core.aMinutos(c.hora);
    const b = a + Math.max(10, Number(c.duracion_min) || 30);
    return ini < b && fin > a;
  });
}

// ── Textos deterministas ─────────────────────────────────────────────────────

const soloNombre = (n) => String(n || 'hola').trim().split(/\s+/)[0];

/**
 * Los tres pasos utility se escriben con los datos de la cita, no con el
 * modelo: una hora inventada le cuesta un cliente al negocio.
 */
function textoDe(tipo, cita, cfg, tarea = null) {
  const n = soloNombre(cita.nombre);
  const hora = cita.hora;
  const serv = (cita.servicio || 'tu hora').toLowerCase();
  const cuando = core.fechaLegible(cita.fecha);
  if (tipo === 'hueco') {
    const quien = soloNombre((tarea && tarea.nombre) || 'hola');
    const dia = core.fechaLegible((tarea && tarea.fecha) || cita.fecha);
    const h = (tarea && tarea.hora) || hora;
    return `Hola ${quien}, se me liberó una hora el ${dia} a las ${h}, que era la que buscabas. ¿Te la reservo? Si me dices que sí, queda a tu nombre.`;
  }
  if (tipo === 'atraso') {
    // La hora estimada se guarda en la tarea cuando se agenda: si el atraso
    // cambia después, el texto sale con el número que corresponde.
    const nueva = tarea && tarea.hora_estimada ? tarea.hora_estimada : hora;
    const min = tarea && tarea.minutos ? tarea.minutos : 0;
    return `${n}, disculpa, vengo ${min} minutos atrasado. Tu hora de las ${hora} queda cerca de las ${nueva}. Si no te acomoda, avísame y la movemos.`;
  }
  if (tipo === 'confirmar_dia') {
    return `Hola ${n}, te esperamos hoy a las ${hora} para ${serv}. ¿Me confirmas que vienes? Si no puedes, avísame y liberamos la hora para otra persona.`;
  }
  if (tipo === 'recordar') {
    const h = cfg.recordarHoras === 1 ? 'en una hora' : `en ${cfg.recordarHoras} horas`;
    return `${n}, te recuerdo tu hora de hoy: ${hora}, ${h}. Nos vemos.`;
  }
  if (tipo === 'feedback') {
    return `${n}, ¿cómo quedaste con ${serv}? Cuéntame cualquier cosa, así lo hacemos mejor la próxima.`;
  }
  if (tipo === 'volver') {
    const extra = cfg.incentivoVolver ? ` ${cfg.incentivoVolver}` : '';
    return `Hola ${n}, ya pasaron unas semanas desde tu última visita del ${cuando}. ¿Te agendo la próxima?${extra}`;
  }
  return null;
}

// ── Worker ───────────────────────────────────────────────────────────────────

async function ventanaAbierta(leadId) {
  const msgs = await db.find(db.messages, { lead_id: leadId, role: 'user' });
  const ultimo = (msgs || [])
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
    scheduled_for: new Date(Date.now() + horas * 3600e3).toISOString(), ...campos,
  }).catch(() => null);
}

/**
 * Procesa los pasos de cita vencidos. `deps` permite inyectar transporte en
 * los tests; en producción se usa tal cual.
 */
async function procesarCitas(deps = {}) {
  const enviarTexto = deps.enviarTexto || enviarTextoReal;
  const enviarPlantilla = deps.enviarPlantilla || enviarPlantillaReal;

  const ahora = new Date().toISOString();
  const todas = await db.find(db.pedidoTasks, { origen: 'cita' });
  const due = todas
    .filter(t => !t.sent_at && !t.cancelled && t.scheduled_for <= ahora)
    .sort((a, b) => (a.prioridad - b.prioridad) || a.scheduled_for.localeCompare(b.scheduled_for))
    .slice(0, LOTE_MAX);

  let enviadas = 0;
  for (const tarea of due) {
    try {
      const cita = await db.findOne(db.citas, { _id: tarea.cita_id });
      const lead = await db.findOne(db.leads, { _id: tarea.lead_id });
      const account = await db.findOne(db.accounts, { _id: tarea.account_id });
      const settings = await db.findOne(db.settings, { account_id: tarea.account_id });
      const cfg = configDe(settings || {});

      if (!cita || !lead || !account) { await cancelar(tarea, 'entidades faltantes'); continue; }
      if (!cfg.activo) { await cancelar(tarea, 'playbook de cita apagado'); continue; }

      // La cita cambió después de agendar el paso: nada que recordar.
      // El hueco es la excepción: su cita es la que se canceló, y lo que
      // importa es que la hora siga libre.
      const esPosterior = ['feedback', 'volver'].includes(tarea.tipo);
      if (tarea.tipo === 'hueco') {
        if (!(await huecoSigueLibre(tarea))) {
          await cancelar(tarea, 'la hora ya se tomó'); continue;
        }
      } else if (!esPosterior && !VIVAS.includes(cita.estado)) {
        await cancelar(tarea, `cita ${cita.estado}`); continue;
      }
      if (esPosterior && cita.estado !== 'atendida') {
        await cancelar(tarea, `cita ${cita.estado}`); continue;
      }
      if (lead.is_bypassed || (lead.automation && lead.automation !== 'automated')) {
        await cancelar(tarea, 'lead en manejo humano'); continue;
      }
      if (!lead.wa_id || !account.wa_phone_number_id || !account.wa_access_token) {
        await cancelar(tarea, 'sin WhatsApp utilizable'); continue;
      }

      const esMarketing = tarea.categoria === 'marketing';
      const playbook = require('./playbookPedido');

      if (esMarketing) {
        const cap = playbook.chequearCapMarketing(lead, { capMktMes: 3 });
        if (!cap.ok) { await cancelar(tarea, `cap de marketing (${cap.motivo})`); continue; }
      }

      const { checkCuotaCanal, incrementDMCount } = require('./limits');
      const permiso = await checkCuotaCanal(tarea.account_id, 'whatsapp').catch(() => ({ allowed: true }));
      if (permiso && permiso.allowed === false) {
        await cancelar(tarea, 'cuota del plan alcanzada'); continue;
      }

      // Dentro de la ventana de 24 h sale como texto; fuera, solo plantilla.
      const abierta = await ventanaAbierta(lead._id);
      const texto = textoDe(tarea.tipo, cita, cfg, tarea);
      let porPlantilla = false;

      if (!abierta) {
        const nombrePlantilla = cfg.plantillas[tarea.tipo];
        if (!nombrePlantilla) {
          await db.insert(db.messages, {
            lead_id: lead._id, role: 'sistema',
            content: `Paso "${tarea.tipo}" de la cita sin enviar: la ventana de 24 horas está cerrada y no hay plantilla configurada (Agenda → Recordatorios).`,
          }).catch(() => null);
          await cancelar(tarea, 'sin plantilla y fuera de ventana');
          continue;
        }
        porPlantilla = true;
      }

      if (esMarketing) {
        const reserva = await playbook.reservarMarketing(lead._id, lead, { capMktMes: 3 });
        if (!reserva.ok) { await posponer(tarea, 24); continue; }
      }

      try {
        if (porPlantilla) {
          await enviarPlantilla({ account, lead, cita, cfg, tarea });
        } else {
          await enviarTexto({ account, lead, texto });
        }
      } catch (e) {
        if (esMarketing) await playbook.liberarMarketing(lead._id).catch(() => null);
        const codigo = e?.response?.data?.error?.code;
        if (codigo === 131049 && (tarea.reintentos_meta || 0) < MAX_REINTENTOS_META) {
          await posponer(tarea, 24, { reintentos_meta: (tarea.reintentos_meta || 0) + 1 });
          continue;
        }
        throw e;
      }

      await db.insert(db.messages, {
        lead_id: lead._id, role: 'agent', content: texto,
        is_playbook: true, playbook_tipo: `cita_${tarea.tipo}`,
        ...(porPlantilla ? { is_template: true } : {}),
      }).catch(() => null);
      await db.update(db.leads, { _id: lead._id }, { last_message_at: new Date().toISOString() })
        .catch(() => null);

      await incrementDMCount(tarea.account_id, 1).catch(() => null);
      await db.update(db.pedidoTasks, { _id: tarea._id }, { sent_at: new Date().toISOString() });
      enviadas++;
      console.log(`📅 [cita] ${tarea.tipo} enviado — ${cita.nombre} ${cita.fecha} ${cita.hora}`);
    } catch (e) {
      console.error(`[cita] tarea ${tarea._id} (${tarea.tipo}) falló:`,
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
  });
}

async function enviarPlantillaReal({ account, lead, cita, cfg, tarea }) {
  const wa = require('./whatsapp');
  const hora = tarea.tipo === 'atraso' && tarea.hora_estimada ? tarea.hora_estimada
             : tarea.tipo === 'hueco' ? `${core.fechaLegible(tarea.fecha)} ${tarea.hora}`
             : cita.hora;
  const quien = tarea.tipo === 'hueco' ? tarea.nombre : cita.nombre;
  const params = [soloNombre(quien), hora, (tarea.tipo === 'hueco' ? tarea.servicio : cita.servicio) || 'tu hora']
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

module.exports = {
  TIPOS, DEFAULTS, VIVAS, configDe, plantillasFaltantes,
  agendarPaso, pendientesDe, cancelarPendientes,
  alCrearCita, alCambiarEstado, alReprogramar, alRegistrarAtraso, alLiberarHora, huecoSigueLibre,
  textoDe, procesarCitas,
};
