/**
 * Atinov — Llamadas DENTRO de WhatsApp (Meta Calling API vía SIP de Twilio)
 *
 * La misma llamada del agente, pero entra por WhatsApp: al lead le suena
 * como una llamada de WhatsApp desde el número del negocio que ya tiene en el
 * chat — no un teléfono desconocido. Es la mejor experiencia posible y la más
 * barata (Meta cobra por minuto de VoIP, no de telefonía).
 *
 * CÓMO SE ARMA (decisión de diseño):
 *  Meta exige que el negocio sea un extremo WebRTC o SIP. Railway no soporta
 *  UDP (WebRTC) y levantar un servidor SIP propio con TLS+digest es otro
 *  producto. La salida limpia: TWILIO YA ES UN SERVIDOR SIP. Se le pide a
 *  Twilio que marque `sip:+56...@wa.meta.vc;transport=tls` con las
 *  credenciales digest que Meta genera por número, y Twilio responde el 407
 *  por nosotros. Del lado de Twilio la llamada es idéntica a la telefónica:
 *  misma TwiML <Connect><Stream>, MISMO puente `llamadaBridge.js`, mismo
 *  registro y costo. Reuso total.
 *
 * LO QUE EXIGE META (verificado en la doc oficial, 2026-08-14):
 *  1. App en modo LIVE (no desarrollo) — hoy Atinov está en desarrollo.
 *     ⚠️ Por eso este módulo queda INERTE hasta el App Review. Fail-closed.
 *  2. Número con capacidad de mensajería ≥ 2.000/24h → la verificación de
 *     negocio del 10-08 lo destrabó.
 *  3. Suscripción al webhook `calls` (o `webhook_delivery` en la config SIP).
 *  4. PERMISO PREVIO DEL LEAD: el negocio no puede llamar sin que la persona
 *     acepte una "solicitud de llamada" (mensaje interactivo
 *     `call_permission_request`). Límites: 1 solicitud/24h y 2 por semana por
 *     lead; el permiso aprobado dura 7 días. Encaja perfecto con el diseño de
 *     Atinov: el consentimiento ya era la pieza clave — acá además lo aplica
 *     Meta por su cuenta.
 *  5. Salientes bloqueadas en USA, Canadá, Egipto, Vietnam y Nigeria. Chile OK.
 *
 * SIP en el número: POST /{phone_number_id}/settings con
 *   { calling: { sip: { status:'ENABLED', servers:[{hostname, port:5061}] } } }
 * y las credenciales se leen con ?include_sip_credentials=true. Eso lo hace
 * el endpoint de configuración de la cuenta (una vez por número).
 */

const axios = require('axios');
const db    = require('../db/database');

const GRAPH = 'https://graph.facebook.com/v23.0';

// Reglas de Meta (permiso de llamada), del lado del servidor por si el modelo
// insiste: el webhook de Meta rechazaría igual, pero acá no se gasta el tiro.
const PERMISO_MAX_24H   = 1;
const PERMISO_MAX_7D    = 2;
const PERMISO_VIGENCIA_DIAS = 7;

// Países donde Meta bloquea llamadas salientes del negocio (prefijos E.164).
const PREFIJOS_BLOQUEADOS = ['1', '20', '84', '234']; // USA/Canadá, Egipto, Vietnam, Nigeria

// ── Fail-closed ───────────────────────────────────────────────────────────────

/**
 * La cuenta puede llamar por WhatsApp solo si TODO está dado: Twilio
 * configurado, la cuenta declaró que su app está Live y activó SIP en el
 * número (guarda las credenciales digest de Meta), e interruptor prendido.
 */
function llamadasWaHabilitadas(account, settings) {
  return !!(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    && settings?.llamadas_enabled === true
    && settings?.wa_calling_enabled === true
    && account?.wa_phone_number_id && account?.wa_access_token
    && settings?.wa_sip_username && settings?.wa_sip_password
  );
}

function destinoBloqueado(waId) {
  const d = String(waId || '').replace(/\D/g, '');
  return PREFIJOS_BLOQUEADOS.some(p => d.startsWith(p) && !(p === '1' && false));
}

// ── Configuración del número (una vez, desde el panel) ────────────────────────

/**
 * Activa SIP en el número de WhatsApp de la cuenta apuntando al dominio SIP
 * de Twilio, y guarda las credenciales digest que Meta genera. Devuelve lo
 * que se guardó (sin la contraseña).
 *
 * `sipHostname` es el dominio SIP de la plataforma en Twilio (ej.
 * atinov.sip.twilio.com). Va en env TWILIO_SIP_DOMAIN para que sea uno solo.
 */
async function activarSipEnNumero({ account, accountId }) {
  const hostname = process.env.TWILIO_SIP_DOMAIN;
  if (!hostname) throw new Error('TWILIO_SIP_DOMAIN no configurado');
  if (!account?.wa_phone_number_id || !account?.wa_access_token) {
    throw new Error('la cuenta no tiene WhatsApp conectado');
  }
  const headers = { Authorization: `Bearer ${account.wa_access_token}`, 'Content-Type': 'application/json' };

  await axios.post(`${GRAPH}/${account.wa_phone_number_id}/settings`, {
    calling: {
      status: 'ENABLED',
      sip: {
        status: 'ENABLED',
        servers: [{ hostname, port: 5061 }],
        // Meta avisa por webhook el ciclo de vida aunque el audio vaya por SIP:
        // sirve para registrar "no contestó" sin depender solo de Twilio.
        webhook_delivery: 'ENABLED',
      },
      // Que el lead también pueda llamar AL negocio desde el chat: entra por
      // el mismo SIP y el agente contesta. Sin costo de permiso.
      call_icon_visibility: 'DEFAULT',
    },
  }, { headers, timeout: 15000 });

  const r = await axios.get(`${GRAPH}/${account.wa_phone_number_id}/settings`, {
    params: { include_sip_credentials: true }, headers, timeout: 15000,
  });
  const sip = r.data?.calling?.sip || {};
  const cred = Array.isArray(sip.servers) ? sip.servers[0] : sip.servers || sip;
  const username = cred?.sip_user_password?.username || cred?.username || sip.username || null;
  const password = cred?.sip_user_password?.password || cred?.password || sip.password || null;
  if (!username || !password) {
    throw new Error('Meta no devolvió credenciales SIP — ¿la app está en modo Live?');
  }

  await db.update(db.settings, { account_id: accountId }, {
    wa_sip_username: username,
    wa_sip_password: password,          // secreto: sanitize.js lo oculta al frontend
    wa_sip_hostname: hostname,
    wa_calling_enabled: true,
    wa_calling_activated_at: new Date().toISOString(),
  });
  return { hostname, username };
}

async function desactivarSipEnNumero({ account, accountId }) {
  if (account?.wa_phone_number_id && account?.wa_access_token) {
    await axios.post(`${GRAPH}/${account.wa_phone_number_id}/settings`, {
      calling: { sip: { status: 'DISABLED' } },
    }, {
      headers: { Authorization: `Bearer ${account.wa_access_token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }).catch(() => null);
  }
  await db.update(db.settings, { account_id: accountId }, {
    wa_sip_username: null, wa_sip_password: null, wa_sip_hostname: null, wa_calling_enabled: false,
  });
}

// ── Permiso de llamada (el consentimiento que Meta exige) ─────────────────────

/** Permiso vigente (aceptado y no vencido) del lead, si existe. */
function permisoVigente(lead) {
  const p = lead?.wa_call_permission;
  if (!p || p.status !== 'accepted') return null;
  if (p.expires_at && new Date(p.expires_at) < new Date()) return null;
  return p;
}

/** Cuenta solicitudes recientes para respetar 1/24h y 2/7d por lead. */
function puedePedirPermiso(lead) {
  const hist = Array.isArray(lead?.wa_call_permission_requests) ? lead.wa_call_permission_requests : [];
  const ahora = Date.now();
  const en24h = hist.filter(t => ahora - new Date(t).getTime() < 24 * 3600e3).length;
  const en7d  = hist.filter(t => ahora - new Date(t).getTime() < 7 * 24 * 3600e3).length;
  if (en24h >= PERMISO_MAX_24H) return { ok: false, motivo: 'ya se le pidió permiso de llamada hoy' };
  if (en7d  >= PERMISO_MAX_7D)  return { ok: false, motivo: 'ya se le pidió permiso 2 veces esta semana' };
  return { ok: true };
}

/**
 * Manda la solicitud de permiso de llamada (mensaje interactivo de Meta).
 * El lead ve un botón para aceptar. La respuesta llega por webhook como
 * `interactive.call_permission_reply` — la procesa `procesarRespuestaPermiso`.
 */
async function pedirPermisoLlamada({ account, lead, texto }) {
  const check = puedePedirPermiso(lead);
  if (!check.ok) throw new Error(check.motivo);
  if (destinoBloqueado(lead.wa_id)) throw new Error('Meta bloquea llamadas salientes a ese país');

  await axios.post(`${GRAPH}/${account.wa_phone_number_id}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: lead.wa_id,
    type: 'interactive',
    interactive: {
      type: 'call_permission_request',
      action: { name: 'call_permission_request' },
      body: { text: String(texto || '¿Te acomoda si te llamo por acá mismo un minuto y lo vemos hablando?').slice(0, 1024) },
    },
  }, {
    headers: { Authorization: `Bearer ${account.wa_access_token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  const hist = Array.isArray(lead.wa_call_permission_requests) ? lead.wa_call_permission_requests : [];
  await db.update(db.leads, { _id: lead._id }, {
    wa_call_permission_requests: [...hist.slice(-9), new Date().toISOString()],
    wa_call_permission: { status: 'pending', requested_at: new Date().toISOString() },
  });
  await db.insert(db.messages, {
    lead_id: lead._id, account_id: account._id, role: 'sistema',
    content: '📲 Se le envió al lead la solicitud de permiso para llamarlo por WhatsApp (botón de Meta). Si acepta, el agente lo llama por WhatsApp.',
  }).catch(() => null);
}

/**
 * Webhook: el lead aceptó o rechazó. Meta lo manda como mensaje interactivo
 * `call_permission_reply` con `response: "accept" | "reject"` y una
 * `expiration_timestamp` (7 días). Se guarda en el lead. Si aceptó y había
 * una llamada esperando ese permiso, se programa al tiro.
 */
async function procesarRespuestaPermiso({ account, lead, interactive }) {
  const reply = interactive?.call_permission_reply || {};
  const acepto = String(reply.response || '').toLowerCase() === 'accept';
  const expira = reply.expiration_timestamp
    ? new Date(Number(reply.expiration_timestamp) * 1000).toISOString()
    : new Date(Date.now() + PERMISO_VIGENCIA_DIAS * 24 * 3600e3).toISOString();

  await db.update(db.leads, { _id: lead._id }, {
    wa_call_permission: {
      status: acepto ? 'accepted' : 'rejected',
      replied_at: new Date().toISOString(),
      expires_at: acepto ? expira : null,
    },
  });
  await db.insert(db.messages, {
    lead_id: lead._id, account_id: account._id, role: 'sistema',
    content: acepto
      ? `✅ El lead ACEPTÓ recibir llamadas por WhatsApp (permiso vigente hasta ${new Date(expira).toLocaleDateString('es-CL')}).`
      : '❌ El lead rechazó la llamada por WhatsApp. El agente sigue por el chat, sin insistir.',
  }).catch(() => null);

  if (!acepto) {
    // Si había una llamada esperando este permiso, se cancela limpia.
    await db.update(db.llamadas, { lead_id: lead._id, status: 'esperando_permiso' }, {
      status: 'cancelada', error: 'el lead rechazó el permiso de WhatsApp',
    }).catch(() => null);
    return { acepto: false };
  }

  // Aceptó: la llamada que estaba esperando pasa a 'programada' y el worker
  // de telefonia.js la marca en el próximo tick (con su DIAL_DELAY normal).
  const { DIAL_DELAY_SEG } = require('./telefonia');
  const dialAt = new Date(Date.now() + DIAL_DELAY_SEG * 1000).toISOString();
  await db.update(db.llamadas, { lead_id: lead._id, status: 'esperando_permiso' }, {
    status: 'programada', dial_at: dialAt, permiso_aceptado_at: new Date().toISOString(),
  }).catch(() => null);
  return { acepto: true };
}

// ── Cómo marca Twilio hacia WhatsApp ──────────────────────────────────────────

/**
 * Parámetros extra para la llamada de Twilio cuando el destino es WhatsApp:
 * el `To` es un URI SIP hacia Meta y van las credenciales digest del número.
 * `telefonia.crearLlamadaTwilio` los agrega al POST /Calls.json.
 */
function paramsTwilioParaWhatsapp({ telefonoE164, settings }) {
  const num = String(telefonoE164 || '').replace(/[^\d+]/g, '');
  return {
    To: `sip:${num}@wa.meta.vc;transport=tls`,
    // Twilio contesta el 407 de Meta con estas credenciales (RFC 3261).
    SipAuthUsername: settings.wa_sip_username,
    SipAuthPassword: settings.wa_sip_password,
    // Meta ignora el caller-id telefónico: la llamada se identifica por las
    // credenciales del número. Igual se manda el From SIP correcto.
    From: `sip:${settings.wa_sip_username}@${settings.wa_sip_hostname}`,
  };
}

/** Bloque para el prompt: le dice al agente cómo funciona el permiso por WA. */
function contextoLlamadaWhatsapp(lead) {
  const vigente = permisoVigente(lead);
  if (vigente) {
    return 'Este lead YA autorizó llamadas por WhatsApp (permiso vigente): si acepta que lo llames, usa "whatsapp-app" como teléfono en el marcador y la llamada le entra por WhatsApp, no por celular.';
  }
  const check = puedePedirPermiso(lead);
  if (!check.ok) return null;
  return 'Si el lead acepta que lo llames, puedes usar "whatsapp-app" como teléfono en el marcador: el sistema le manda primero un botón oficial de WhatsApp para autorizar la llamada y, cuando lo toca, lo llamas por WhatsApp mismo (más cómodo para él que un número desconocido). Si prefieres seguro y directo, usa "whatsapp" (llamada normal a su celular).';
}

module.exports = {
  llamadasWaHabilitadas,
  destinoBloqueado,
  activarSipEnNumero,
  desactivarSipEnNumero,
  permisoVigente,
  puedePedirPermiso,
  pedirPermisoLlamada,
  procesarRespuestaPermiso,
  paramsTwilioParaWhatsapp,
  contextoLlamadaWhatsapp,
  PERMISO_MAX_24H,
  PERMISO_MAX_7D,
  PERMISO_VIGENCIA_DIAS,
};
