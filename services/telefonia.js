/**
 * Atinov — Telefonía saliente (Twilio)
 *
 * El agente LLAMA POR TELÉFONO al lead caliente que aceptó la llamada en el
 * chat. El aviso previo no es un adorno: convierte un número desconocido en
 * una llamada esperada y captura el consentimiento — por eso la llamada se
 * marca DIAL_DELAY_SEG segundos después de que el mensaje de aviso sale,
 * nunca al instante.
 *
 * Contrato del marcador (mismo patrón que [PAGO:] y [AGENDAR:]):
 *   [LLAMAR: telefono | tema]
 *   - telefono: "whatsapp" (usar el número del chat — solo leads de WhatsApp)
 *               o un número chileno que el lead dictó ("+56 9 1234 5678").
 *   - tema: en qué quedó la conversación (para abrir la llamada retomando).
 *
 * CANDADOS (regla del repo: todo endpoint que gasta plata necesita cuatro;
 * este gasta DOBLE — Twilio y OpenAI):
 *   1. Consentimiento explícito del lead en el chat, registrado con hora.
 *   2. Tope diario de llamadas por cuenta (default 10).
 *   3. Una llamada por lead por día (cuenta también la que no contestó).
 *   4. Horario permitido por cuenta (default 09-21 hora Chile).
 *   5. Tope de duración por llamada (lo corta el bridge, default 10 min).
 *   6. FAIL-CLOSED: sin TWILIO_* en el entorno, la capacidad ni aparece en
 *      el prompt y cualquier marcador residual se elimina del texto.
 */

const crypto = require('crypto');
const axios  = require('axios');
const db     = require('../db/database');
const { normalizePhoneCL } = require('./shopify');

const APP_URL = () => process.env.APP_URL || 'https://atinov.com';

// La llamada se marca este tiempo DESPUÉS DE QUE EL AVISO SALE por el chat
// (no después de resolver el marcador). El aviso tiene su propio delay
// humanizador (5-15 s por defecto, 20-60 s en el preset Atinov) y lo mueve
// el worker cada 10 s: si se contara desde "ahora" con un número fijo chico,
// el teléfono sonaría ANTES de que llegue "te llamo al tiro" — y esa es la
// pieza clave del diseño. Anclado al envío real, 20 s es lo que tarda leer
// el aviso: la llamada llega esperada, sin ese vacío raro de casi un minuto.
const DIAL_DELAY_SEG = 20;
// Cuando no se conoce el momento del envío (vía WhatsApp tras el permiso, o
// llamadas creadas fuera del webhook) se usa este margen conservador.
const DIAL_DELAY_SIN_ANCLA_SEG = 30;

// Defaults de los candados configurables por cuenta (settings.llamadas_*).
const DEFAULT_MAX_DIA     = 10;   // llamadas por cuenta por día
const DEFAULT_HORA_INICIO = 9;    // hora Chile inclusive
const DEFAULT_HORA_FIN    = 21;   // hora Chile exclusive (hasta las 20:59)
const DEFAULT_MAX_MIN     = 10;   // tope de duración por llamada
const HARD_MAX_MIN        = 15;   // techo absoluto aunque la cuenta pida más

// Segundos que suena antes de cortar. 25s evita la mayoría de los buzones de
// voz (suelen saltar a los ~30s) — llamar a un buzón es plata perdida.
const RING_TIMEOUT_SEG = 25;

// Costos para la estimación (verificados 2026-08-10, Twilio pricing Chile).
const USD_MIN_TWILIO_MOVIL = 0.0746;
const USD_MIN_OPENAI_EST   = 0.04;   // punto medio del rango 0.02-0.06

const MARKER_RE = /\[LLAMAR:\s*([^|\]]{3,40})\s*\|\s*([^\]]{2,120})\]/gi;

// ── Fail-closed ───────────────────────────────────────────────────────────────

/** true solo si las TRES credenciales de Twilio están en el entorno. */
function telefoniaHabilitada() {
  return !!(process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_PHONE_NUMBER);
}

// ── Utilidades de hora Chile (sin dependencias) ───────────────────────────────

function horaChile(fecha = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', hour: 'numeric', hour12: false,
  }).formatToParts(fecha);
  return Number(parts.find(p => p.type === 'hour')?.value ?? -1);
}

function fechaChile(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(fecha);
}

/** Horario permitido de la cuenta. Fuera de horario NO se ofrece ni se marca. */
function dentroDeHorario(settings, fecha = new Date()) {
  const inicio = clampHora(settings?.llamadas_hora_inicio, DEFAULT_HORA_INICIO);
  const fin    = clampHora(settings?.llamadas_hora_fin,    DEFAULT_HORA_FIN);
  const h = horaChile(fecha);
  if (h < 0) return false;               // Intl falló: fail-closed
  if (inicio === fin) return false;      // ventana nula = apagado
  if (inicio < fin) return h >= inicio && h < fin;
  return h >= inicio || h < fin;         // ventana que cruza medianoche
}

function clampHora(v, def) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : def;
}

// ── Normalización de teléfono ─────────────────────────────────────────────────

/**
 * Devuelve E.164 (+56XXXXXXXXX) o null. Reusa la normalización chilena de
 * Shopify — misma regla: mejor no llamar que llamar a un desconocido.
 */
function telefonoE164(raw) {
  const norm = normalizePhoneCL(raw);
  return norm ? `+${norm}` : null;
}

// ── Contadores de los candados ────────────────────────────────────────────────

// 'esperando_permiso' NO cuenta: no gastó nada ni sonó — solo se le mandó al
// lead el botón de Meta. Si acepta, pasa a 'programada' y ahí sí cuenta.
const ESTADOS_QUE_CUENTAN = ['programada', 'marcando', 'sonando', 'en_curso', 'terminada', 'no_contesto', 'fallida'];

// Una llamada esperando el permiso de WhatsApp que el lead nunca contesta no
// puede quedar viva para siempre: a las 6 horas se cancela y vuelve al chat.
const ESPERA_PERMISO_MAX_MS = 6 * 3600e3;

/** Llamadas de HOY (hora Chile) de la cuenta que cuentan contra los topes. */
async function llamadasHoy(accountId, leadId = null) {
  const hoy = fechaChile();
  const q = { account_id: accountId, fecha_chile: hoy };
  if (leadId) q.lead_id = leadId;
  const docs = await db.find(db.llamadas, q);
  // Las canceladas por candado ANTES de marcar no gastaron nada ni molestaron
  // al lead: no cuentan. Todo lo demás (incluso "no contestó") sí.
  return docs.filter(d => ESTADOS_QUE_CUENTAN.includes(d.status)).length;
}

async function topesOk({ settings, accountId, leadId }) {
  const maxDia = Number.isInteger(Number(settings?.llamadas_max_dia)) && Number(settings.llamadas_max_dia) > 0
    ? Math.min(Number(settings.llamadas_max_dia), 50)
    : DEFAULT_MAX_DIA;
  const [cuenta, lead] = await Promise.all([
    llamadasHoy(accountId),
    llamadasHoy(accountId, leadId),
  ]);
  if (cuenta >= maxDia) return { ok: false, motivo: `tope diario de la cuenta (${cuenta}/${maxDia})` };
  if (lead >= 1)        return { ok: false, motivo: 'este lead ya tuvo su llamada de hoy' };
  return { ok: true };
}

// ── Capacidad en el prompt (el disparador) ────────────────────────────────────

/**
 * Bloque de capacidad para el system prompt. Solo aparece si TODO está dado:
 * Twilio configurado + interruptor de la cuenta + interruptor del agente +
 * dentro de horario + topes con espacio + (lead CALIENTE o pidió la llamada).
 * Así el agente jamás ofrece algo que el sistema no va a cumplir.
 */
async function buildLlamadaContext({ settings, agent, lead, incomingText, account = null }) {
  if (!telefoniaHabilitada()) return null;
  if (settings?.llamadas_enabled !== true) return null;
  if (agent?.calls_enabled !== true) return null;
  if (!lead?._id) return null;
  if (!dentroDeHorario(settings)) return null;

  const esCaliente = lead.qualification === 'hot';
  const loPidio = /ll[aá]mame|ll[aá]menme|me pueden llamar|puedes llamarme|prefiero (una )?llamada|hablar por tel[eé]fono|hablemos por tel[eé]fono|una llamada mejor/i
    .test(String(incomingText || ''));
  if (!esCaliente && !loPidio) return null;

  const topes = await topesOk({ settings, accountId: lead.account_id, leadId: lead._id });
  if (!topes.ok) return null;

  const esWhatsapp = lead.channel === 'whatsapp' && !!lead.wa_id;
  let comoIndicarNumero = esWhatsapp
    ? 'Este lead escribe por WhatsApp: usa la palabra "whatsapp" como teléfono para llamarlo a ese mismo número.'
    : 'Este lead NO escribe por WhatsApp: solo puedes usar un número que el lead te haya dictado EN esta conversación (nunca lo inventes ni lo saques de otra parte).';

  // Vía WhatsApp (la llamada entra por la app, no por el celular): solo se
  // ofrece si la cuenta la tiene activa. Si no, el agente ni se entera.
  if (esWhatsapp) {
    try {
      const waCalling = require('./whatsappCalling');
      if (waCalling.llamadasWaHabilitadas(account, settings) && !waCalling.destinoBloqueado(lead.wa_id)) {
        const extra = waCalling.contextoLlamadaWhatsapp(lead);
        if (extra) comoIndicarNumero += `\n   ${extra}`;
      }
    } catch { /* vía WhatsApp opcional */ }
  }

  return [
    '--- CAPACIDAD DE LLAMADA TELEFÓNICA ---',
    'Puedes llamar POR TELÉFONO a este lead, con tu misma voz y todo el contexto de esta conversación. Úsala cuando una llamada cierre mejor que diez mensajes (dudas finales, coordinar detalles, cerrar).',
    'PROTOCOLO OBLIGATORIO, en este orden:',
    '1) OFRECE la llamada en un mensaje normal ("¿te acomoda si te llamo y lo vemos en 2 minutos?"). NUNCA llames sin ofrecer primero.',
    '2) Espera que el lead ACEPTE explícitamente ("sí", "ya", "llámame", "dale"). Si duda o no responde, no insistas.',
    '3) RECIÉN cuando aceptó, tu SIGUIENTE mensaje avisa que lo llamas en un par de minutos e incluye el marcador exacto:',
    '[LLAMAR: telefono | tema]',
    `   ${comoIndicarNumero}`,
    '   tema = en qué quedó la conversación, para retomarla al abrir la llamada (ej: "resolver si el plan le sirve para su clínica").',
    'Ejemplo: "perfecto, te llamo en un par de minutos y lo vemos altiro 👌 [LLAMAR: whatsapp | dudas del plan founder]"',
    'El sistema quita el marcador del mensaje y hace la llamada real un minuto después.',
    'Reglas: un solo marcador por mensaje · solo tras aceptación explícita EN esta conversación · si el lead da un número, repítelo en el marcador tal como lo dio · si te pide que lo llames más tarde a una hora puntual, NO uses el marcador (dile que le escribes a esa hora) · si ya ofreciste la llamada y no aceptó, no la vuelvas a ofrecer — sigue por el chat normal.',
  ].join('\n');
}

// ── Resolución del marcador (la ejecución) ────────────────────────────────────

/**
 * Reemplaza [LLAMAR: ...] por texto vacío y deja la llamada PROGRAMADA para
 * DIAL_DELAY_SEG después (el aviso del chat tiene que llegar antes que el
 * timbre). Re-valida TODOS los candados del lado del servidor: el modelo
 * propone, el servidor decide. Fail-closed en cada rama.
 */
async function resolveLlamadaMarkers(text, { settings, account, agent, lead, avisoSaleAt = null }) {
  if (!text || !/\[LLAMAR/i.test(text)) return { text, llamadas: [] };
  MARKER_RE.lastIndex = 0;

  const llamadas = [];
  let out = text;

  for (const m of [...text.matchAll(MARKER_RE)]) {
    const [full, telRaw, temaRaw] = m;
    let replacement = '';
    try {
      if (llamadas.length) throw new SinLlamada('segundo marcador en el mismo mensaje');
      const prep = await prepararLlamada({
        settings, account, agent, lead,
        telefonoPedido: telRaw.trim(),
        tema: temaRaw.trim().slice(0, 120),
        avisoSaleAt,
      });
      llamadas.push(prep);
    } catch (e) {
      // Nunca romper el mensaje por la llamada. El motivo queda en el log y,
      // si el lead había aceptado, en el hilo como nota de sistema.
      const motivo = e instanceof SinLlamada ? e.message : (e.message || 'error');
      console.warn(`[llamada] marcador descartado (@${lead?.ig_username || lead?.wa_name || lead?._id}): ${motivo}`);
      if (!(e instanceof SinLlamada) || e.avisarEnHilo) {
        await db.insert(db.messages, {
          lead_id: lead._id, account_id: lead.account_id, role: 'sistema',
          content: `⚠️ El agente quiso llamar pero no se pudo: ${motivo}. Si corresponde, llama tú manualmente.`,
        }).catch(() => null);
      }
    }
    out = out.replace(full, replacement);
  }

  // Scrub residual: marcadores truncados por max_tokens o mal formados NUNCA
  // llegan crudos al lead (mismo patrón que AGENDAR).
  out = out.replace(/\[LLAMAR[^\]]*\]?/gi, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
  return { text: out, llamadas };
}

/** Error de candado: se descarta el marcador sin tratarlo como bug. */
class SinLlamada extends Error {
  constructor(msg, avisarEnHilo = false) { super(msg); this.avisarEnHilo = avisarEnHilo; }
}

async function prepararLlamada({ settings, account, agent, lead, telefonoPedido, tema, avisoSaleAt = null }) {
  // Candado 6: fail-closed total.
  if (!telefoniaHabilitada())            throw new SinLlamada('Twilio no está configurado');
  if (settings?.llamadas_enabled !== true) throw new SinLlamada('las llamadas están apagadas en la cuenta');
  if (agent?.calls_enabled !== true)     throw new SinLlamada('las llamadas están apagadas en este agente');

  // Candado 4: horario.
  if (!dentroDeHorario(settings)) throw new SinLlamada('fuera del horario permitido de llamadas', true);

  // Candados 2 y 3: topes.
  const topes = await topesOk({ settings, accountId: lead.account_id, leadId: lead._id });
  if (!topes.ok) throw new SinLlamada(topes.motivo, true);

  // Teléfono: "whatsapp" = el número del chat (llamada al celular);
  // "whatsapp-app" = la misma persona pero la llamada ENTRA POR WHATSAPP
  // (Meta Calling API vía SIP de Twilio; exige permiso previo del lead);
  // si no, el número que dictó el lead.
  let telefono = null;
  let viaWhatsappApp = false;
  if (/^whatsapp[-_ ]?app$/i.test(telefonoPedido)) {
    if (lead.channel !== 'whatsapp' || !lead.wa_id) {
      throw new SinLlamada('el marcador dice "whatsapp-app" pero el lead no escribe por WhatsApp');
    }
    const waCalling = require('./whatsappCalling');
    if (!waCalling.llamadasWaHabilitadas(account, settings)) {
      // Degradación limpia: sin la vía WhatsApp activa, se llama al celular.
      console.warn('[llamada] "whatsapp-app" pedido pero la vía WhatsApp no está activa — se llama al celular');
    } else if (waCalling.destinoBloqueado(lead.wa_id)) {
      console.warn('[llamada] Meta bloquea llamadas salientes a ese país — se llama al celular');
    } else {
      viaWhatsappApp = true;
    }
    telefono = telefonoE164(lead.wa_id);
  } else if (/^(whatsapp|este|este n[uú]mero)$/i.test(telefonoPedido)) {
    if (lead.channel !== 'whatsapp' || !lead.wa_id) {
      throw new SinLlamada('el marcador dice "whatsapp" pero el lead no escribe por WhatsApp');
    }
    telefono = telefonoE164(lead.wa_id);
  } else {
    telefono = telefonoE164(telefonoPedido);
    // Anti-invención: un número que no aparece en la conversación no se marca.
    // (El lead lo dictó → está en algún mensaje suyo. El modelo no puede
    // llamar a un número que "recuerda" de otra parte.)
    if (telefono) {
      const soloDigitos = telefono.replace(/\D/g, '').slice(-8); // los 8 finales
      const mensajesLead = await db.find(db.messages, { lead_id: lead._id, role: 'user' });
      const dichoPorElLead = mensajesLead.some(msg =>
        String(msg.content || '').replace(/\D/g, '').includes(soloDigitos));
      if (!dichoPorElLead) throw new SinLlamada('el número del marcador no aparece dicho por el lead en la conversación');
    }
  }
  if (!telefono) throw new SinLlamada('no hay teléfono válido para llamar');

  // Candado 1: consentimiento. El mensaje que disparó esta respuesta ES la
  // aceptación del lead (el protocolo obliga a ofrecer → esperar el sí →
  // recién ahí el marcador). Se registra la cita textual con hora.
  const mensajes = await db.find(db.messages, { lead_id: lead._id },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const ultimoDelLead = [...mensajes].reverse().find(m => m.role === 'user');
  if (!ultimoDelLead) throw new SinLlamada('no hay ningún mensaje del lead que respalde el consentimiento');
  const edadMin = (Date.now() - new Date(ultimoDelLead.createdAt)) / 60000;
  if (!(edadMin >= 0 && edadMin <= 30)) {
    throw new SinLlamada('el último mensaje del lead es muy viejo para valer como consentimiento');
  }

  const maxMin = Math.min(
    Number.isInteger(Number(settings?.llamadas_max_min)) && Number(settings.llamadas_max_min) >= 3
      ? Number(settings.llamadas_max_min) : DEFAULT_MAX_MIN,
    HARD_MAX_MIN
  );

  // Vía WhatsApp: si el lead ya autorizó (permiso de Meta vigente) se programa
  // directo; si no, la llamada queda ESPERANDO y se le manda el botón oficial
  // de permiso — al aceptar, procesarRespuestaPermiso la pasa a 'programada'.
  let esperaPermiso = false;
  if (viaWhatsappApp) {
    const waCalling = require('./whatsappCalling');
    if (!waCalling.permisoVigente(lead)) {
      const check = waCalling.puedePedirPermiso(lead);
      if (!check.ok) {
        // Meta no dejaría pedirlo de nuevo: se degrada a celular sin drama.
        console.warn(`[llamada] ${check.motivo} — se llama al celular en vez de WhatsApp`);
        viaWhatsappApp = false;
      } else {
        esperaPermiso = true;
      }
    }
  }

  const ahora  = new Date();
  // Ancla: el momento en que el aviso SALE por el chat (lo calcula el webhook
  // con el delay humanizador del agente). Sin ancla, margen conservador.
  const anclaMs = avisoSaleAt && !isNaN(new Date(avisoSaleAt)) ? new Date(avisoSaleAt).getTime() : null;
  const dialAt = anclaMs
    ? new Date(Math.max(anclaMs, ahora.getTime()) + DIAL_DELAY_SEG * 1000)
    : new Date(ahora.getTime() + DIAL_DELAY_SIN_ANCLA_SEG * 1000);
  const doc = await db.insert(db.llamadas, {
    account_id:  lead.account_id,
    lead_id:     lead._id,
    agent_id:    agent._id,
    status:      esperaPermiso ? 'esperando_permiso' : 'programada',
    via:         viaWhatsappApp ? 'whatsapp' : 'telefono',
    telefono,                              // E.164, dato personal (Ley 21.719: cae con el lead)
    tema,
    fecha_chile: fechaChile(ahora),
    dial_at:     dialAt.toISOString(),
    max_min:     maxMin,
    consent_texto: String(ultimoDelLead.content || '').slice(0, 200),
    consent_at:    ultimoDelLead.createdAt,
    consent_message_id: ultimoDelLead._id,
    ws_lock:     null,
    finalized_at: null,
    transcript:  [],
  });

  if (esperaPermiso) {
    const waCalling = require('./whatsappCalling');
    try {
      await waCalling.pedirPermisoLlamada({ account, lead });
    } catch (e) {
      // Si Meta rechaza la solicitud (límite, país, app no Live), no dejar la
      // llamada colgada: pasa a celular al tiro.
      console.warn('[llamada] no se pudo pedir el permiso de WhatsApp — se llama al celular:', e.response?.data?.error?.message || e.message);
      await db.update(db.llamadas, { _id: doc._id }, { status: 'programada', via: 'telefono' }).catch(() => null);
      esperaPermiso = false;
      viaWhatsappApp = false;
    }
  }

  const horaAviso = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit',
  }).format(dialAt);
  const viaTxt = viaWhatsappApp ? 'por WhatsApp' : `al ${telefono}`;
  await db.insert(db.messages, {
    lead_id: lead._id, account_id: lead.account_id, role: 'sistema',
    content: esperaPermiso
      ? `📞 Llamada por WhatsApp lista — sale apenas el lead toque "Aceptar" en el botón de permiso. Consentimiento en el chat: "${doc.consent_texto}".`
      : `📞 Llamada programada a las ${horaAviso} ${viaTxt}. Consentimiento del lead: "${doc.consent_texto}" (${new Date(doc.consent_at).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' })}).`,
  }).catch(() => null);

  console.log(`📞 [llamada] ${esperaPermiso ? 'esperando permiso WA' : 'programada'} ${doc._id} → ${viaTxt} (cuenta ${lead.account_id})`);
  return { id: doc._id, telefono, dialAt: doc.dial_at, via: viaWhatsappApp ? 'whatsapp' : 'telefono', esperaPermiso };
}

// ── Worker: marcar las llamadas programadas ───────────────────────────────────

let _marcando = false;

/**
 * Corre cada 10s desde server.js (mismo patrón que processPendingSends).
 * Toma las llamadas 'programada' vencidas, re-chequea los candados que pueden
 * haber cambiado desde que se programó, y pide la llamada a Twilio.
 */
async function procesarLlamadasProgramadas() {
  if (!telefoniaHabilitada()) return;    // sin credenciales, ni mirar la cola
  if (_marcando) return;                 // sin solaparse si Twilio se pone lento
  _marcando = true;
  try {
    const ahora = new Date().toISOString();

    // Caducar las que esperan permiso de WhatsApp desde hace demasiado.
    const esperando = await db.find(db.llamadas, { status: 'esperando_permiso' });
    for (const ll of esperando) {
      if (Date.now() - new Date(ll.createdAt).getTime() > ESPERA_PERMISO_MAX_MS) {
        await db.update(db.llamadas, { _id: ll._id, status: 'esperando_permiso' }, {
          status: 'cancelada', error: 'el lead no respondió el permiso de WhatsApp',
        }).catch(() => null);
      }
    }

    const programadas = await db.find(db.llamadas, { status: 'programada' });
    for (const ll of programadas.filter(l => l.dial_at <= ahora)) {
      // Lock optimista: si dos ticks compiten, solo uno pasa a 'marcando'.
      const gane = await db.update(db.llamadas, { _id: ll._id, status: 'programada' }, {
        status: 'marcando', dialing_started_at: new Date().toISOString(),
      });
      if (!gane) continue;
      try {
        const settings = await db.findOne(db.settings, { account_id: ll.account_id });
        if (settings?.llamadas_enabled !== true) throw new SinLlamada('cuenta apagó las llamadas');
        if (!dentroDeHorario(settings))          throw new SinLlamada('quedó fuera de horario');

        // Recheck de topes EN el momento del gasto: dos llamadas programadas
        // casi juntas pasan el chequeo al programarse (ambas ven N-1); acá,
        // con esta ya en 'marcando', el conteo la incluye y el que sobra cae.
        const maxDia = Number.isInteger(Number(settings?.llamadas_max_dia)) && Number(settings.llamadas_max_dia) > 0
          ? Math.min(Number(settings.llamadas_max_dia), 50)
          : DEFAULT_MAX_DIA;
        const [deLaCuenta, delLead] = await Promise.all([
          llamadasHoy(ll.account_id),
          llamadasHoy(ll.account_id, ll.lead_id),
        ]);
        if (deLaCuenta > maxDia) throw new SinLlamada(`tope diario de la cuenta al momento de marcar (${deLaCuenta}/${maxDia})`);
        if (delLead > 1)         throw new SinLlamada('el lead ya tiene otra llamada hoy');

        // Vía WhatsApp: Twilio marca al SIP de Meta con las credenciales del
        // número. Si al momento de marcar la vía WA se apagó o el permiso
        // venció, se degrada a celular — la persona ya dijo que sí.
        let viaWa = ll.via === 'whatsapp';
        if (viaWa) {
          const waCalling = require('./whatsappCalling');
          const account = await db.findOne(db.accounts, { _id: ll.account_id });
          const lead    = await db.findOne(db.leads,    { _id: ll.lead_id });
          if (!waCalling.llamadasWaHabilitadas(account, settings) || !waCalling.permisoVigente(lead)) {
            console.warn(`[llamada] ${ll._id}: vía WhatsApp no disponible al marcar — se llama al celular`);
            viaWa = false;
            await db.update(db.llamadas, { _id: ll._id }, { via: 'telefono' }).catch(() => null);
          }
        }
        const sid = await crearLlamadaTwilio(ll, viaWa ? settings : null);
        await db.update(db.llamadas, { _id: ll._id }, { twilio_call_sid: sid });
        console.log(`📞 [llamada] marcando ${ll._id} → ${viaWa ? 'WhatsApp de ' : ''}${ll.telefono} (CallSid ${sid})`);
      } catch (e) {
        const motivo = e.response?.data?.message || e.message || 'error';
        console.error(`❌ [llamada] no se pudo marcar ${ll._id}: ${motivo}`);
        await db.update(db.llamadas, { _id: ll._id }, {
          status: 'cancelada', error: String(motivo).slice(0, 200),
        }).catch(() => null);
        await db.insert(db.messages, {
          lead_id: ll.lead_id, account_id: ll.account_id, role: 'sistema',
          content: `⚠️ La llamada programada no se pudo hacer (${String(motivo).slice(0, 120)}). Si corresponde, llama tú manualmente.`,
        }).catch(() => null);
      }
    }
  } catch (e) {
    console.error('procesarLlamadasProgramadas error:', e.message);
  } finally {
    _marcando = false;
  }
}

/**
 * POST a la API de Twilio para iniciar la llamada. Devuelve el CallSid.
 * Con `settingsWa` (vía WhatsApp), el destino es el SIP de Meta y van las
 * credenciales digest del número — el resto (TwiML, stream, bridge) es
 * IDÉNTICO a la llamada telefónica: por eso la vía WhatsApp reusa todo.
 */
async function crearLlamadaTwilio(llamada, settingsWa = null) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const t     = tokenLlamada(llamada._id);
  const base  = APP_URL();

  const destino = settingsWa
    ? require('./whatsappCalling').paramsTwilioParaWhatsapp({ telefonoE164: llamada.telefono, settings: settingsWa })
    : { To: llamada.telefono, From: process.env.TWILIO_PHONE_NUMBER };

  const params = new URLSearchParams({
    ...destino,
    Url:            `${base}/webhook/twilio/twiml?ll=${encodeURIComponent(llamada._id)}&t=${t}`,
    Method:         'POST',
    StatusCallback: `${base}/webhook/twilio/status?ll=${encodeURIComponent(llamada._id)}&t=${t}`,
    StatusCallbackMethod: 'POST',
    Timeout: String(RING_TIMEOUT_SEG),
  });
  ['initiated', 'ringing', 'answered', 'completed'].forEach(ev =>
    params.append('StatusCallbackEvent', ev));

  const r = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
    params.toString(),
    {
      auth: { username: sid, password: token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    }
  );
  if (!r.data?.sid) throw new Error('Twilio no devolvió CallSid');
  return r.data.sid;
}

/** Corta una llamada en curso vía REST (el tope de duración manda). */
async function colgarLlamadaTwilio(callSid) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}.json`,
    new URLSearchParams({ Status: 'completed' }).toString(),
    {
      auth: { username: sid, password: token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    }
  );
}

// ── Seguridad de los webhooks ─────────────────────────────────────────────────

/** Token HMAC propio por llamada: nadie forja un twiml/status sin conocerlo. */
function tokenLlamada(llamadaId) {
  const secret = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', secret).update(`llamada:${llamadaId}`).digest('hex').slice(0, 32);
}

function tokenValido(llamadaId, t) {
  const esperado = tokenLlamada(llamadaId);
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Valida X-Twilio-Signature: Base64(HMAC-SHA1(authToken, url + params
 * ordenados)). Dos detalles que importan:
 *  - La URL se reconstruye desde APP_URL (no de req.protocol: detrás del
 *    proxy de Railway eso miente).
 *  - Los params se sacan del RAW body cuando existe (req.rawBody): el
 *    sanitizador XSS global reescribe strings del body parseado (un "&" en
 *    un valor pasa a "&amp;") y con eso una firma LEGÍTIMA dejaría de calzar.
 */
function firmaTwilioValida(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const firma = req.headers['x-twilio-signature'];
  if (!firma) return false;

  const url = APP_URL().replace(/\/$/, '') + req.originalUrl;

  let params;
  if (req.rawBody && req.rawBody.length) {
    params = {};
    for (const [k, v] of new URLSearchParams(req.rawBody.toString('utf8'))) params[k] = v;
  } else {
    params = req.body && typeof req.body === 'object' ? req.body : {};
  }

  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const esperada = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');

  const a = Buffer.from(String(firma));
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── TwiML ─────────────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * TwiML que conecta el audio de la llamada al WebSocket del puente.
 * El token viaja como <Parameter> (llega en el evento `start` del stream),
 * no en la URL del wss — las URLs quedan en logs de Twilio, los Parameter no.
 */
function twimlParaLlamada(llamadaId) {
  const wsUrl = APP_URL().replace(/^http/, 'ws').replace(/\/$/, '') + '/twilio-media';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(wsUrl)}">
      <Parameter name="ll" value="${xmlEscape(llamadaId)}"/>
      <Parameter name="t" value="${xmlEscape(tokenLlamada(llamadaId))}"/>
    </Stream>
  </Connect>
</Response>`;
}

// ── Costos y cierre ───────────────────────────────────────────────────────────

/** Twilio factura por minuto redondeado hacia arriba. */
function costoEstimadoUSD(duracionSeg) {
  const min = Math.max(1, Math.ceil(Number(duracionSeg || 0) / 60));
  const twilio = min * USD_MIN_TWILIO_MOVIL;
  const openai = min * USD_MIN_OPENAI_EST;
  return {
    minutos: min,
    twilio: Number(twilio.toFixed(4)),
    openai_est: Number(openai.toFixed(4)),
    total_est: Number((twilio + openai).toFixed(4)),
  };
}

/**
 * Cierre ÚNICO de la llamada: registra duración/resultado/costo, deja la nota
 * en el hilo y el billableEvent. Lo intentan tanto el bridge (al cerrar el
 * WS) como el status callback de Twilio (completed) — el lock finalized_at
 * garantiza que solo el primero escribe.
 */
async function finalizarLlamada(llamadaId, { resultado, duracionSeg, motivo = null }) {
  const gane = await db.update(db.llamadas, { _id: llamadaId, finalized_at: null }, {
    finalized_at: new Date().toISOString(),
  });
  if (!gane) return false;

  const ll = await db.findOne(db.llamadas, { _id: llamadaId });
  if (!ll) return false;

  const conectada = resultado === 'terminada';
  const dur = Math.max(0, Math.round(Number(duracionSeg || 0)));
  const costo = conectada ? costoEstimadoUSD(dur) : { minutos: 0, twilio: 0, openai_est: 0, total_est: 0 };

  // Regla de Meta para la vía WhatsApp: 2 llamadas seguidas sin contestar →
  // aviso al lead; 4 seguidas → Meta REVOCA el permiso solo. Se lleva el
  // contador en el lead y se corta antes: a las 2 sin contestar, el agente
  // deja de ofrecer llamadas por WhatsApp hasta que el lead vuelva a escribir
  // o a llamar (una llamada conectada reinicia el contador).
  if (ll.via === 'whatsapp') {
    try {
      const lead = await db.findOne(db.leads, { _id: ll.lead_id });
      if (lead) {
        const prev = Number(lead.wa_call_sin_contestar || 0);
        const nuevo = conectada ? 0 : prev + 1;
        const upd = { wa_call_sin_contestar: nuevo };
        if (nuevo >= 4 && lead.wa_call_permission?.status === 'accepted') {
          // Meta ya lo revocó por su lado; reflejarlo para no intentar en vano.
          upd.wa_call_permission = { ...lead.wa_call_permission, status: 'revoked', revoked_at: new Date().toISOString(), motivo: '4 llamadas sin contestar' };
        }
        await db.update(db.leads, { _id: lead._id }, upd).catch(() => null);
      }
    } catch { /* contador best-effort */ }
  }

  await db.update(db.llamadas, { _id: llamadaId }, {
    status: resultado,
    duracion_seg: dur,
    costo_usd: costo,
    error: motivo ? String(motivo).slice(0, 200) : (ll.error || null),
    ended_at: new Date().toISOString(),
  }).catch(() => null);

  // Nota en el hilo: el dueño ve el resultado en el inbox, y el agente de
  // chat retoma con ese contexto en el próximo mensaje.
  const minTxt = `${Math.floor(dur / 60)}m ${String(dur % 60).padStart(2, '0')}s`;
  let nota;
  if (conectada) {
    const colita = resumenTranscript(ll.transcript, 700);
    nota = `📞 Llamada realizada (${minTxt}, ~US$${costo.total_est.toFixed(2)}).${colita ? `\nÚltimo tramo de la conversación:\n${colita}` : ''}`;
  } else if (resultado === 'no_contesto') {
    nota = '📞 Se llamó al lead pero no contestó. El agente retoma por el chat sin insistir.';
  } else {
    nota = `⚠️ La llamada no se completó (${motivo || resultado}).`;
  }
  await db.insert(db.messages, {
    lead_id: ll.lead_id, account_id: ll.account_id, role: 'sistema', content: nota,
  }).catch(() => null);

  // Evento facturable con el costo adentro: sobrevive a la supresión 21.719
  // (retención legítima), así el histórico de gasto no se pierde con el lead.
  if (conectada) {
    const dup = await db.findOne(db.billableEvents, { type: 'llamada_realizada', llamada_id: llamadaId }).catch(() => null);
    if (!dup) {
      await db.insert(db.billableEvents, {
        account_id: ll.account_id,
        lead_id: ll.lead_id,
        type: 'llamada_realizada',
        llamada_id: llamadaId,
        duracion_seg: dur,
        costo_usd_est: costo.total_est,
      }).catch(() => null);
    }
  }

  console.log(`📞 [llamada] ${llamadaId} finalizada: ${resultado} (${minTxt}, ~US$${costo.total_est})`);
  return true;
}

/** Últimas líneas de la transcripción, para la nota del hilo. */
function resumenTranscript(transcript, maxChars) {
  if (!Array.isArray(transcript) || !transcript.length) return '';
  const lineas = transcript.map(t => `${t.quien === 'lead' ? 'LEAD' : 'AGENTE'}: ${t.texto}`);
  let out = [];
  let largo = 0;
  for (let i = lineas.length - 1; i >= 0; i--) {
    largo += lineas[i].length + 1;
    if (largo > maxChars) break;
    out.unshift(lineas[i]);
  }
  return out.join('\n');
}

/** Mensaje natural al chat cuando no contestó (decisión del batch doc). */
async function encolarMensajeNoContesto(llamada) {
  try {
    const lead    = await db.findOne(db.leads, { _id: llamada.lead_id });
    const account = await db.findOne(db.accounts, { _id: llamada.account_id });
    const agent   = llamada.agent_id ? await db.findOne(db.agents, { _id: llamada.agent_id }) : null;
    if (!lead || !account) return;

    const texto = 'te llamé recién pero no alcanzamos a conectar 🙂 sin apuro — cuando puedas seguimos por acá, o me dices y te llamo de nuevo';
    const ch = lead.channel === 'whatsapp' ? 'whatsapp'
             : lead.channel === 'messenger' ? 'messenger'
             : 'instagram';
    const item = {
      channel: ch,
      recipientId: lead.channel === 'whatsapp' ? lead.wa_id : lead.ig_user_id,
      text: texto,
      accessToken: ch === 'whatsapp' ? (account.wa_access_token || account.access_token)
                 : ch === 'messenger' ? account.fb_page_token
                 : account.access_token,
      accountId: llamada.account_id,
      lead_id: lead._id,
      sendAt: new Date().toISOString(),
      leadUsername: lead.ig_username || lead.wa_name || lead.wa_id || 'lead',
      agentName: agent?.name || 'Agente',
    };
    if (ch === 'whatsapp')       item.phoneNumberId = account.wa_phone_number_id;
    else if (ch === 'messenger') item.pageId = account.fb_page_id;
    else                         item.igUserId = account.ig_platform_id || account.ig_user_id;

    if (!item.recipientId || !item.accessToken) return;
    await db.insert(db.pendingSends, item);
    await db.insert(db.messages, {
      lead_id: lead._id, account_id: llamada.account_id, role: 'agent', content: texto,
    }).catch(() => null);
  } catch (e) {
    console.warn('[llamada] no se pudo encolar el mensaje de no-contesto:', e.message);
  }
}

module.exports = {
  telefoniaHabilitada,
  dentroDeHorario,
  telefonoE164,
  buildLlamadaContext,
  resolveLlamadaMarkers,
  procesarLlamadasProgramadas,
  colgarLlamadaTwilio,
  tokenLlamada,
  tokenValido,
  firmaTwilioValida,
  twimlParaLlamada,
  costoEstimadoUSD,
  finalizarLlamada,
  encolarMensajeNoContesto,
  resumenTranscript,
  // constantes exportadas para tests y para el bridge
  MARKER_RE,
  DIAL_DELAY_SEG,
  DIAL_DELAY_SIN_ANCLA_SEG,
  DEFAULT_MAX_DIA,
  DEFAULT_MAX_MIN,
  HARD_MAX_MIN,
  USD_MIN_TWILIO_MOVIL,
  USD_MIN_OPENAI_EST,
};
