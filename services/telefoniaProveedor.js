/**
 * Atinov — Proveedor de telefonía (Twilio | Telnyx)
 *
 * POR QUÉ EXISTE: el 2026-08-19 Twilio rechazó el perfil de cumplimiento con
 * el error 18603 ("no se pudo verificar la dirección") y su consola NO ofrece
 * un campo donde escribirla — el flujo individual salta directo a la
 * verificación de identidad. Con el perfil rechazado no se puede comprar
 * NINGÚN número, ni siquiera uno de EE.UU. Trece días y dos tickets después,
 * sin respuesta humana, quedó claro que un proveedor único de telefonía es un
 * punto único de falla, igual que Cloudflare para el dominio.
 *
 * Este módulo aísla TODO lo específico del proveedor detrás de una interfaz
 * chica. El resto del sistema (telefonía, bridge, webhooks, WhatsApp Calling)
 * no sabe con quién habla.
 *
 * CÓMO SE ELIGE:
 *   TELEFONIA_PROVEEDOR=telnyx|twilio  → manda esta variable.
 *   Sin ella: se autodetecta por las credenciales que haya en el entorno.
 *   Con ambas configuradas y sin variable, gana Twilio (el que ya estaba).
 *
 * LO QUE **NO** CAMBIA AL CAMBIAR DE PROVEEDOR:
 *   - El token HMAC por llamada (?ll & ?t) que firma nuestros webhooks.
 *   - La voz por WhatsApp: Meta acepta cualquier SIP server con TLS, así que
 *     el proveedor solo aporta el trunk. Las credenciales digest del número
 *     las sigue poniendo Meta.
 *   - El bridge de audio: ambos mandan PCMU 8k en base64. Las diferencias de
 *     formato del WebSocket se normalizan en llamadaBridge.js.
 */

const crypto = require('crypto');
const axios  = require('axios');

// ── Twilio ───────────────────────────────────────────────────────────────────

const twilio = {
  id: 'twilio',
  etiqueta: 'Twilio',

  configurado() {
    return !!(process.env.TWILIO_ACCOUNT_SID
      && process.env.TWILIO_AUTH_TOKEN
      && process.env.TWILIO_PHONE_NUMBER);
  },

  /** Variables que faltan, para decirlo claro en el arranque y en el panel. */
  faltantes() {
    return ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']
      .filter(v => !process.env[v]);
  },

  numeroPropio() { return process.env.TWILIO_PHONE_NUMBER || null; },

  /**
   * POST a la API de Twilio. `destino` ya trae To/From (llamada normal) o los
   * parámetros SIP de Meta (vía WhatsApp) — el proveedor no decide eso.
   */
  async crearLlamada({ destino, urlInstrucciones, statusCallback, timeoutSeg }) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    const params = new URLSearchParams({
      ...destino,
      Url:                  urlInstrucciones,
      Method:               'POST',
      StatusCallback:       statusCallback,
      StatusCallbackMethod: 'POST',
      Timeout:              String(timeoutSeg),
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
  },

  async colgar(callId) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callId)}.json`,
      new URLSearchParams({ Status: 'completed' }).toString(),
      {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );
  },

  /**
   * X-Twilio-Signature: Base64(HMAC-SHA1(authToken, url + params ordenados)).
   * Fail-closed: sin token de auth no se valida nada.
   */
  firmaValida(req) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return { ok: false, motivo: "sin TWILIO_AUTH_TOKEN" };
    const firma = req.headers["x-twilio-signature"];
    if (!firma) return { ok: false, motivo: "sin cabecera de firma" };

    // La URL se reconstruye desde APP_URL: detras del proxy de Railway,
    // req.protocol miente.
    const url = (process.env.APP_URL || "https://atinov.com").replace(/\/$/, "") + req.originalUrl;

    // Los params salen del RAW body cuando existe: el sanitizador XSS global
    // reescribe strings del body parseado (un "&" pasa a "&amp;") y con eso
    // una firma LEGITIMA dejaria de calzar.
    let params;
    if (req.rawBody && req.rawBody.length) {
      params = {};
      for (const [k, v] of new URLSearchParams(req.rawBody.toString("utf8"))) params[k] = v;
    } else {
      params = req.body && typeof req.body === "object" ? req.body : {};
    }

    const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
    const esperada = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
    const a = Buffer.from(String(firma));
    const b = Buffer.from(esperada);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, motivo: ok ? null : "firma no coincide" };
  },

  /**
   * En TwiML, <Connect><Stream> ya es bidireccional: Twilio manda el audio
   * entrante y acepta el saliente por el mismo WebSocket.
   */
  streamXml({ wsUrl, parametros }) {
    const params = Object.entries(parametros)
      .map(([n, v]) => `      <Parameter name="${xmlEscape(n)}" value="${xmlEscape(v)}"/>`)
      .join('\n');
    return `  <Connect>
    <Stream url="${xmlEscape(wsUrl)}">
${params}
    </Stream>
  </Connect>`;
  },
};

// ── Telnyx ───────────────────────────────────────────────────────────────────

const telnyx = {
  id: 'telnyx',
  etiqueta: 'Telnyx',

  configurado() {
    return !!(process.env.TELNYX_API_KEY
      && process.env.TELNYX_ACCOUNT_SID
      && process.env.TELNYX_APP_SID
      && process.env.TELNYX_PHONE_NUMBER);
  },

  faltantes() {
    return ['TELNYX_API_KEY', 'TELNYX_ACCOUNT_SID', 'TELNYX_APP_SID', 'TELNYX_PHONE_NUMBER']
      .filter(v => !process.env[v]);
  },

  numeroPropio() { return process.env.TELNYX_PHONE_NUMBER || null; },

  /**
   * TeXML es la capa compatible con Twilio de Telnyx: mismo endpoint con
   * forma /Accounts/{sid}/Calls, mismos parámetros en CamelCase, form-encoded.
   * Las dos diferencias reales: autenticación Bearer en vez de Basic, y
   * ApplicationSid obligatorio (la TeXML Application que apunta a nuestra URL).
   */
  async crearLlamada({ destino, urlInstrucciones, statusCallback, timeoutSeg }) {
    const apiKey     = process.env.TELNYX_API_KEY;
    const accountSid = process.env.TELNYX_ACCOUNT_SID;

    const params = new URLSearchParams({
      ...destino,
      ApplicationSid:       process.env.TELNYX_APP_SID,
      Url:                  urlInstrucciones,
      Method:               'POST',
      StatusCallback:       statusCallback,
      StatusCallbackMethod: 'POST',
      Timeout:              String(timeoutSeg),
    });
    ['initiated', 'ringing', 'answered', 'completed'].forEach(ev =>
      params.append('StatusCallbackEvent', ev));

    const r = await axios.post(
      `https://api.telnyx.com/v2/texml/Accounts/${accountSid}/Calls`,
      params.toString(),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );
    const id = r.data?.sid || r.data?.data?.sid;
    if (!id) throw new Error('Telnyx no devolvió CallSid');
    return id;
  },

  async colgar(callId) {
    const apiKey     = process.env.TELNYX_API_KEY;
    const accountSid = process.env.TELNYX_ACCOUNT_SID;
    await axios.post(
      `https://api.telnyx.com/v2/texml/Accounts/${accountSid}/Calls/${encodeURIComponent(callId)}`,
      new URLSearchParams({ Status: 'completed' }).toString(),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
  },

  /**
   * Telnyx firma con Ed25519: cabeceras `telnyx-signature-ed25519` (base64) y
   * `telnyx-timestamp`, sobre `${timestamp}|${cuerpo crudo}`.
   *
   * DECISIÓN CONSCIENTE, no un hueco: si TELNYX_PUBLIC_KEY no está puesta, la
   * firma no se verifica y el candado que queda es el token HMAC por llamada
   * (?t=), que es HMAC-SHA256 con JWT_SECRET, distinto en cada llamada e
   * imposible de forjar sin el secreto. La firma del proveedor es defensa en
   * profundidad, no el candado principal. Poner la llave pública la agrega.
   */
  firmaValida(req) {
    const pub = process.env.TELNYX_PUBLIC_KEY;
    if (!pub) return { ok: true, motivo: 'sin TELNYX_PUBLIC_KEY: vale el token HMAC por llamada', sinVerificar: true };

    const firma = req.headers['telnyx-signature-ed25519'];
    const ts    = req.headers['telnyx-timestamp'];
    if (!firma || !ts) return { ok: false, motivo: 'faltan cabeceras de firma' };

    // Ventana anti-replay de 5 minutos.
    const edadSeg = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(edadSeg) || edadSeg > 300) return { ok: false, motivo: 'timestamp fuera de ventana' };

    try {
      const cuerpo = req.rawBody !== undefined && req.rawBody !== null
        ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
        : JSON.stringify(req.body || {});
      const firmado = Buffer.from(`${ts}|${cuerpo}`, 'utf8');
      const llave = crypto.createPublicKey({
        key: Buffer.concat([
          // Prefijo DER de una clave pública Ed25519 cruda de 32 bytes.
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(pub, 'base64'),
        ]),
        format: 'der',
        type: 'spki',
      });
      const ok = crypto.verify(null, firmado, llave, Buffer.from(String(firma), 'base64'));
      return { ok, motivo: ok ? null : 'firma Ed25519 no coincide' };
    } catch (e) {
      return { ok: false, motivo: `error verificando firma: ${e.message}` };
    }
  },

  /**
   * TeXML usa los mismos verbos, pero el audio de vuelta NO es implícito: hay
   * que pedirlo con bidirectionalMode="rtp". Sin eso el agente escucharía al
   * lead y el lead no escucharía al agente — el fallo más silencioso posible.
   * PCMU 8k a propósito: es lo que acepta OpenAI Realtime nativo, igual que
   * con Twilio, así que el bridge no transcodifica en ningún caso.
   */
  streamXml({ wsUrl, parametros }) {
    const params = Object.entries(parametros)
      .map(([n, v]) => `      <Parameter name="${xmlEscape(n)}" value="${xmlEscape(v)}"/>`)
      .join('\n');
    return `  <Connect>
    <Stream url="${xmlEscape(wsUrl)}" track="inbound_track" codec="PCMU"
            bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000">
${params}
    </Stream>
  </Connect>`;
  },
};

// ── Selección ────────────────────────────────────────────────────────────────

const PROVEEDORES = { twilio, telnyx };

/**
 * El proveedor activo. La variable manda; si no está, se autodetecta por las
 * credenciales presentes. Con ambos configurados gana Twilio, que es el que ya
 * estaba corriendo — cambiar de proveedor tiene que ser una decisión escrita,
 * nunca un efecto secundario de agregar credenciales.
 */
function proveedorActivo() {
  const pedido = String(process.env.TELEFONIA_PROVEEDOR || '').trim().toLowerCase();
  if (pedido && PROVEEDORES[pedido]) return PROVEEDORES[pedido];
  if (pedido) {
    console.warn(`[telefonia] TELEFONIA_PROVEEDOR="${pedido}" no existe. Válidos: ${Object.keys(PROVEEDORES).join(', ')}. Autodetectando.`);
  }
  if (twilio.configurado()) return twilio;
  if (telnyx.configurado()) return telnyx;

  // Ninguno completo: igual hay que elegir a QUIEN reportarle las variables
  // que faltan. Se toma el que este a medio configurar — es el que alguien
  // esta montando ahora mismo. Decirle "te falta TWILIO_AUTH_TOKEN" a quien
  // esta poniendo Telnyx es peor que no decir nada.
  const twP = twilio.faltantes().length;
  const txP = telnyx.faltantes().length;
  if (txP < twP) return telnyx;
  return twilio; // empate (o nada puesto): el que ya estaba
}

/** ¿Hay telefonía utilizable? Fail-closed: sin credenciales completas, no. */
function telefoniaHabilitada() {
  return proveedorActivo().configurado();
}

/** Línea para el arranque y para el diagnóstico del panel admin. */
function estadoTelefonia() {
  const p = proveedorActivo();
  const ok = p.configurado();
  return {
    proveedor: p.id,
    etiqueta: p.etiqueta,
    configurado: ok,
    faltantes: ok ? [] : p.faltantes(),
    numero: ok ? p.numeroPropio() : null,
    forzado: !!(process.env.TELEFONIA_PROVEEDOR && PROVEEDORES[String(process.env.TELEFONIA_PROVEEDOR).toLowerCase()]),
  };
}

/**
 * US$ por minuto saliente a móvil chileno, para la estimación de costo y el
 * margen de los planes (config/plans.js → COSTOS.twilioMinuto).
 *
 * ⚠️ El 0,0746 es la tarifa VERIFICADA de Twilio (2026-08-10). Telnyx no
 * publica su tarifa a Chile en la web: sale del rate sheet de la cuenta. Hasta
 * medirla se usa la de Twilio, que es la conservadora — subestimar el costo
 * infla el margen en el papel, y ese es justo el error que el monitor de
 * margen existe para no cometer. Al tener la real: TELEFONIA_USD_MIN.
 */
function costoMinutoUSD() {
  const v = Number(process.env.TELEFONIA_USD_MIN);
  return Number.isFinite(v) && v > 0 ? v : 0.0746;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = {
  PROVEEDORES,
  proveedorActivo,
  telefoniaHabilitada,
  estadoTelefonia,
  costoMinutoUSD,
  xmlEscape,
};
