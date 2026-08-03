/**
 * Atinov — Agendamiento real en el chat (Google Calendar)
 *
 * El hueco documentado del Business Agent de Meta: conversa pero NO agenda.
 * Acá el agente ve la disponibilidad real del negocio y crea el evento en el
 * Google Calendar del dueño sin sacar al lead de la conversación:
 *   [AGENDAR: YYYY-MM-DD | HH:MM | nombre | motivo]           (30 min default)
 *   [AGENDAR: YYYY-MM-DD | HH:MM | nombre | motivo | minutos]
 * y este módulo lo reemplaza por la confirmación ANTES de guardar/encolar.
 *
 * FAIL-CLOSED en dos niveles (mismo patrón que payments.js):
 *  - Sin GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET en el entorno: todo el módulo
 *    es inerte — sin capacidad en el prompt, endpoints responden "no
 *    configurado", cero cambio de comportamiento.
 *  - Sin calendar conectado en la cuenta (o si freebusy falla): el agente ni
 *    siquiera recibe la capacidad ese turno, y cualquier marcador residual se
 *    elimina del texto en vez de romper el mensaje.
 *
 * OAuth: refresh_token por cuenta en settings.google_refresh_token. El state
 * del flujo va firmado con HMAC(JWT_SECRET) — el callback llega sin sesión y
 * esa firma es lo que impide conectar un calendar ajeno a otra cuenta.
 */

const axios  = require('axios');
const crypto = require('crypto');
const db     = require('../db/database');

const APP_URL       = () => process.env.APP_URL || 'https://atinov.com';
const CLIENT_ID     = () => process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI  = () => `${APP_URL()}/api/calendar/callback`;
const TZ = 'America/Santiago';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
].join(' ');

const MARKER_RE = /\[AGENDAR:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{1,2}:\d{2})\s*\|\s*([^|\]]{2,60})\s*\|\s*([^|\]]{2,80})(?:\s*\|\s*(\d{1,3}))?\s*\]/gi;

/** ¿Están las credenciales de app en el entorno? Sin esto, módulo inerte. */
function isConfigured() {
  return !!(CLIENT_ID() && CLIENT_SECRET());
}

// ── State firmado (anti-CSRF del callback) ────────────────────────────────────

function signState(accountId) {
  const exp = Date.now() + 10 * 60 * 1000; // 10 min para completar el consent
  const payload = `${accountId}.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret')
    .update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyState(state) {
  try {
    const raw = String(state);
    const [accountId, expStr, sig] = Buffer.from(raw, 'base64url').toString().split('.');
    if (!accountId || !expStr || !sig) return null;
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret')
      .update(`${accountId}.${expStr}`).digest('hex').slice(0, 32);
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Date.now() > Number(expStr)) return null;
    // Un solo uso: un state interceptado/reenviado no sirve dos veces.
    if (usedStates.has(raw)) return null;
    usedStates.add(raw);
    if (usedStates.size > 500) usedStates.clear(); // higiene; TTL real = expiry 10 min
    return accountId;
  } catch (e) { return null; }
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

function getAuthUrl(accountId) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID(),
    redirect_uri: REDIRECT_URI(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // fuerza refresh_token también en reconexiones
    state: signState(accountId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

async function exchangeCode(code) {
  const res = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    code,
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    redirect_uri: REDIRECT_URI(),
    grant_type: 'authorization_code',
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return res.data; // { access_token, refresh_token, expires_in, ... }
}

// Cache en memoria de access tokens por cuenta (expiran en ~1h)
const tokenCache = new Map(); // accountId → { token, exp }
// Cache corto del resumen de agenda (evita un freebusy por CADA mensaje)
const busyCache = new Map();  // accountId → { summary, exp }
// States de OAuth ya usados (un solo uso, TTL implícito 10 min por el expiry)
const usedStates = new Set();

/** Invalida los caches de una cuenta — OBLIGATORIO al conectar/desconectar:
 * sin esto, tras reconectar otro Google se seguiría leyendo/escribiendo el
 * calendario ANTERIOR hasta 1h. */
function clearAccountCache(accountId) {
  tokenCache.delete(accountId);
  busyCache.delete(accountId);
}

async function getAccessToken(settings, accountId) {
  const cached = tokenCache.get(accountId);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;

  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      refresh_token: settings.google_refresh_token,
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      grant_type: 'refresh_token',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const token = res.data.access_token;
    tokenCache.set(accountId, { token, exp: Date.now() + (res.data.expires_in || 3600) * 1000 });
    return token;
  } catch (e) {
    // Refresh token revocado (el dueño quitó el acceso desde Google): limpiar
    // para que la capacidad desaparezca del prompt en vez de fallar por siempre.
    if (e.response?.data?.error === 'invalid_grant') {
      console.warn('[agenda] refresh_token revocado — desconectando calendar de la cuenta', accountId);
      await db.update(db.settings, { account_id: accountId }, {
        google_refresh_token: null, google_connected_at: null,
      }).catch(() => null);
      tokenCache.delete(accountId);
    }
    throw e;
  }
}

// ── Fechas en hora de Chile ───────────────────────────────────────────────────

/** 'YYYY-MM-DD' de hoy en Santiago. */
function todayCL() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Texto humano: "hoy es domingo 3 de agosto de 2026, 15:42 hrs (Chile)". */
function nowLabelCL() {
  const d = new Date();
  const fecha = new Intl.DateTimeFormat('es-CL', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
  const hora = new Intl.DateTimeFormat('es-CL', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${fecha}, ${hora} hrs`;
}

function fechaLegible(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  }).format(d);
}

// ── FreeBusy → resumen para el prompt ─────────────────────────────────────────

/**
 * Rangos ocupados de los próximos `days` días, agrupados por día en hora de
 * Chile. El agente los usa para ofrecer horarios que NO choquen; el horario
 * de atención sale de la Knowledge Base del negocio.
 */
async function getBusySummary(settings, accountId, days = 7) {
  const cached = busyCache.get(accountId);
  if (cached && cached.exp > Date.now()) return cached.summary;
  const token = await getAccessToken(settings, accountId);
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + days * 24 * 3600 * 1000);
  const res = await axios.post('https://www.googleapis.com/calendar/v3/freeBusy', {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    timeZone: TZ,
    items: [{ id: settings.google_calendar_id || 'primary' }],
  }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  const calId = settings.google_calendar_id || 'primary';
  const busy = res.data?.calendars?.[calId]?.busy
    || Object.values(res.data?.calendars || {})[0]?.busy || [];

  const porDia = {};
  const fmtDia  = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
  const fmtHora = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtKey  = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  for (const b of busy) {
    const ini = new Date(b.start), fin = new Date(b.end);
    const key = fmtKey.format(ini);
    (porDia[key] ||= { label: fmtDia.format(ini), rangos: [] })
      .rangos.push(`${fmtHora.format(ini)}-${fmtHora.format(fin)}`);
  }
  const lineas = Object.keys(porDia).sort().slice(0, 10)
    .map(k => `- ${porDia[k].label}: ocupado ${porDia[k].rangos.join(', ')}`);
  const summary = lineas.length ? lineas.join('\n') : '- (sin eventos: agenda libre estos días)';
  // 90s de cache: le quita el freebusy al hot path (un lead conversando
  // manda varios mensajes seguidos) sin arriesgar disponibilidad vieja.
  busyCache.set(accountId, { summary, exp: Date.now() + 90 * 1000 });
  return summary;
}

// ── Capacidad para el system prompt ───────────────────────────────────────────

/**
 * Bloque de capacidad de agendamiento — solo si el entorno está configurado Y
 * la cuenta conectó su Google Calendar. Async porque consulta la
 * disponibilidad real; si esa consulta falla, devuelve null (fail-closed: sin
 * disponibilidad real el agente no debe ofrecer horas).
 */
async function buildCalendarContext(settings, accountId) {
  if (!isConfigured() || !settings?.google_refresh_token) return null;
  let busy;
  try {
    busy = await getBusySummary(settings, accountId, 7);
  } catch (e) {
    console.warn('[agenda] freebusy falló — capacidad omitida este turno:', e.response?.data?.error?.message || e.message);
    return null;
  }
  return [
    '--- CAPACIDAD DE AGENDAMIENTO (Google Calendar) ---',
    `Hoy es ${nowLabelCL()} (Chile). Puedes agendar citas REALES en el calendario del negocio.`,
    'Agenda de los próximos 7 días:',
    busy,
    'Cuando el lead CONFIRME día y hora explícitos (dentro del horario de atención de la Knowledge Base y sin chocar con lo ocupado), tu mensaje debe ser MUY BREVE (una línea) seguida del marcador exacto:',
    '[AGENDAR: YYYY-MM-DD | HH:MM | nombre del lead | motivo]',
    'Ejemplo: "quedamos así entonces 😊 [AGENDAR: 2026-08-05 | 15:30 | Carla | Evaluación dental]"',
    'El sistema reemplaza el marcador por la confirmación real de la cita.',
    'Reglas: solo con día Y hora confirmados por el lead (nunca supongas), fechas futuras, un solo marcador por mensaje, y nunca ofrezcas horas que aparezcan ocupadas arriba.',
  ].join('\n');
}

// ── Crear evento + resolver marcadores ────────────────────────────────────────

async function createEvent(settings, accountId, { date, time, minutes, nombre, motivo }) {
  const token = await getAccessToken(settings, accountId);
  const dur = Number.isFinite(minutes) && minutes >= 10 && minutes <= 240 ? minutes : 30;
  const start = `${date}T${time.padStart(5, '0')}:00`;
  const [h, m] = time.split(':').map(Number);
  const endMin = h * 60 + m + dur;
  // Cruce de medianoche: sin esto, 23:50+30min daría un end ANTERIOR al start
  // (mismo día 00:20) y Google rechaza el evento.
  let endDate = date;
  if (endMin >= 1440) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }
  const end = `${endDate}T${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00`;
  const res = await axios.post(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.google_calendar_id || 'primary')}/events`,
    {
      summary: `${motivo} — ${nombre}`,
      description: 'Agendado por el asistente Atinov durante la conversación.',
      start: { dateTime: start, timeZone: TZ },
      end:   { dateTime: end,   timeZone: TZ },
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  return res.data; // { id, htmlLink, ... }
}

/**
 * Reemplaza los marcadores [AGENDAR: ...] del reply por la confirmación real.
 * Sin conexión o ante cualquier error: elimina el marcador y avisa por log —
 * el mensaje sale igual, nunca se rompe la conversación por la agenda.
 */
async function resolveCalendarMarkers(text, { settings, accountId, leadId, leadName }) {
  // Gate AMPLIO a propósito: un marcador truncado por max_tokens o una
  // variante mal formada no matchean MARKER_RE pero igual deben entrar,
  // para que el scrub residual del final los elimine antes de enviar.
  if (!text || !/\[AGENDAR/i.test(text)) return { text, events: [] };
  MARKER_RE.lastIndex = 0;

  const events = [];
  let out = text;
  const hoy = todayCL();
  const maxFecha = new Intl.DateTimeFormat('en-CA', { timeZone: TZ })
    .format(new Date(Date.now() + 60 * 24 * 3600 * 1000));

  for (const m of [...text.matchAll(MARKER_RE)]) {
    const [full, date, timeRaw, nombreRaw, motivoRaw, minStr] = m;
    const time = timeRaw.padStart(5, '0');
    const nombre = nombreRaw.trim() || leadName || 'Cliente';
    const motivo = motivoRaw.trim();
    let replacement = '';

    const valida = isConfigured() && settings?.google_refresh_token
      && date >= hoy && date <= maxFecha
      && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

    if (valida) {
      const when = `${fechaLegible(date)} a las ${time} hrs`;
      try {
        // Dedup ANTES de crear: si este lead ya tiene cita en este slot (doble
        // marcador, o el lead re-confirmando), no se duplica el evento en el
        // calendario — se repite la confirmación, idempotente.
        const dup = await db.findOne(db.billableEvents, {
          type: 'cita_agendada', lead_id: leadId, fecha_cita: `${date} ${time}`,
        }).catch(() => null);
        if (dup) {
          replacement = `📅 ${when} — confirmado`;
        } else {
          const ev = await createEvent(settings, accountId, {
            date, time, minutes: minStr ? parseInt(minStr, 10) : 30, nombre, motivo,
          });
          replacement = `📅 ${when} — confirmado`;
          events.push({ when, date, time, eventId: ev.id });

          await db.insert(db.messages, {
            lead_id: leadId,
            role: 'sistema',
            content: `📅 Cita agendada en Google Calendar: ${motivo} — ${nombre}, ${when}`,
          }).catch(() => null);

          await db.insert(db.billableEvents, {
            account_id: accountId,
            lead_id: leadId,
            type: 'cita_agendada',
            fecha_cita: `${date} ${time}`,
            google_event_id: ev.id,
          }).catch(() => null);
        }
      } catch (e) {
        console.warn('[agenda] no se pudo crear el evento:', e.response?.data?.error?.message || e.message);
        // Cita fantasma es peor que cita fallida: el texto del agente afirma la
        // cita y el evento no existe. Se deja rastro visible en el hilo para que
        // el dueño lo vea en el inbox y agende a mano.
        await db.insert(db.messages, {
          lead_id: leadId,
          role: 'sistema',
          content: `⚠️ NO se pudo crear la cita en Google Calendar (${motivo} — ${nombre}, ${when}). Agéndala manualmente o pide otra hora.`,
        }).catch(() => null);
      }
    } else if (!settings?.google_refresh_token) {
      console.warn('[agenda] marcador AGENDAR en reply pero la cuenta no tiene calendar conectado — se elimina');
    } else {
      console.warn(`[agenda] marcador AGENDAR inválido (fecha ${date} / hora ${time}) — se elimina`);
    }
    out = out.replace(full, replacement);
  }
  // Scrub residual: marcadores truncados por max_tokens o variantes que no
  // matchean el formato completo NUNCA deben llegar crudos al lead.
  out = out.replace(/\[AGENDAR[^\]]*\]?/gi, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
  return { text: out, events };
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  verifyState,
  clearAccountCache,
  buildCalendarContext,
  resolveCalendarMarkers,
  getBusySummary,
};
