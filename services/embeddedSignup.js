/**
 * Atinov — Embedded Signup v4 (conectar WhatsApp con UN botón)
 *
 * Reemplaza el copiar-pegar de los 3 datos del WABA. El cliente aprieta un
 * botón, Meta abre un popup y ahí mismo se loguea, acepta términos, elige o
 * CREA su cuenta de WhatsApp Business, ingresa su número y lo verifica. Al
 * cerrar, el popup nos deja un código; este módulo lo convierte en una
 * conexión funcionando: token, webhook suscrito y número registrado.
 *
 * ⚠️ v4, no v2. Meta apaga v2 y v3 el 15-oct-2026. La diferencia práctica:
 * en v4 los permisos y activos se eligen en una "Configuración de Facebook
 * Login for Business" del panel, y el código solo pasa su `config_id`.
 *
 * LA REGLA DE SEGURIDAD QUE MANDA ACÁ: el popup corre en el navegador del
 * cliente, así que `waba_id` y `phone_number_id` llegan desde el cliente y
 * NO se pueden creer. Cualquiera podría mandar el WABA de otro negocio. Por
 * eso, después de canjear el código, se le pregunta a Meta —con el token
 * recién obtenido— si ese token realmente da acceso a ese WABA y si ese
 * número le pertenece. Si no calza, no se guarda nada.
 *
 * FAIL-CLOSED: sin META_APP_ID/META_APP_SECRET/META_ES_CONFIG_ID el botón ni
 * aparece, y la ruta responde 503. Mismo patrón que payments.js y calendar.js.
 */

const axios  = require('axios');
const crypto = require('crypto');
const db     = require('../db/database');

const GRAPH = 'https://graph.facebook.com/v21.0';

// Permisos que la Configuración del panel debe incluir. Se declaran acá solo
// para documentarlos junto al código que los usa — quien los concede es la
// Configuración de Meta, no esta constante.
const SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'];

// DOS apps de Meta conviven en este proyecto (lección vieja del repo):
// META_APP_ID/META_APP_SECRET son la SUB-APP de Instagram (login IGAA), pero
// la Configuración de Embedded Signup solo puede crearse en la app PRINCIPAL
// — la del caso de uso de WhatsApp. El popup y el canje del código tienen que
// correr con la app dueña de la configuración, o Meta rechaza el config_id.
// Por eso el ES usa credenciales propias (META_ES_APP_ID / META_ES_APP_SECRET)
// y cae a las viejas solo si no están: una instalación con una sola app sigue
// funcionando sin tocar nada.
const esAppId     = () => process.env.META_ES_APP_ID     || process.env.META_APP_ID;
const esAppSecret = () => process.env.META_ES_APP_SECRET || process.env.META_APP_SECRET;

/** true solo si están las tres piezas. Sin esto el botón no se muestra. */
function estaHabilitado() {
  return !!(esAppId() && esAppSecret() && process.env.META_ES_CONFIG_ID);
}

/** Lo que el frontend necesita para abrir el popup. Nada de esto es secreto. */
function configPublica() {
  return {
    enabled:      estaHabilitado(),
    appId:        esAppId() || null,
    configId:     process.env.META_ES_CONFIG_ID || null,
    graphVersion: 'v21.0',
  };
}

/**
 * Canjea el código del popup por un token de negocio.
 * ⏱️ El código vive 30 segundos: esto se llama apenas llega, sin pasos previos.
 *
 * Devuelve { token, expiraEnSeg }. `expires_in` llega solo a veces, y ese
 * "solo a veces" es justo lo peligroso: sin dato, un token que caduca parece
 * eterno. Ver VIDA_TOKEN_DEFAULT_DIAS.
 */
async function canjearCodigo(code) {
  const r = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      client_id:     esAppId(),
      client_secret: esAppSecret(),
      code,
    },
    timeout: 15000,
  });
  const token = r.data?.access_token;
  if (!token) throw new Error('Meta no devolvió access_token');
  const expiraEnSeg = Number(r.data?.expires_in) > 0 ? Number(r.data.expires_in) : null;
  return { token, expiraEnSeg };
}

/**
 * Cuándo se muere el token del cliente.
 *
 * ⚠️ EL DETALLE QUE ROMPE CUENTAS EN SILENCIO: la Configuración del panel de
 * Meta se creó desde la plantilla "Registro insertado de WhatsApp **con token
 * que caduca en 60 días**". Ese token es un *business integration system user
 * token* y Meta NO documenta ningún endpoint para refrescarlo: la única
 * recuperación es que el cliente vuelva a pasar por el botón. O sea, cada
 * cliente que entre por acá tiene una mecha de 60 días encendida.
 *
 * (La vía manual usa un System User token sin caducidad — por eso esto nunca
 * se notó: hoy TODOS los clientes entraron por ahí.)
 *
 * Si Meta no manda `expires_in`, se asume la vida de la plantilla. Errarle
 * hacia el lado corto solo adelanta un aviso; hacia el largo, deja al cliente
 * sin WhatsApp un martes cualquiera y sin saber por qué.
 *
 * 👉 Se arregla de raíz cambiando la Configuración a un token de usuario de
 * sistema SIN caducidad (Meta lo permite: el tipo y la caducidad se eligen al
 * crear la Configuración). Mientras eso no pase, este aviso es la red.
 */
const VIDA_TOKEN_DEFAULT_DIAS = 60;

function caducidadToken(expiraEnSeg) {
  const seg = expiraEnSeg || VIDA_TOKEN_DEFAULT_DIAS * 24 * 3600;
  return {
    expiraEn:  new Date(Date.now() + seg * 1000).toISOString(),
    estimada:  !expiraEnSeg,     // true = lo pusimos nosotros, Meta no dijo
  };
}

/**
 * Verifica que el token REALMENTE dé acceso a ese WABA y que el número sea
 * de ese WABA. Es la defensa contra un cliente que manda el WABA de otro:
 * las dos consultas se hacen con el token del que pide, así que si no es
 * suyo, Meta responde error y acá se corta.
 *
 * Devuelve los datos reales que dice Meta (nombre del negocio y del número),
 * que además sirven para mostrar en el panel qué quedó conectado.
 */
async function verificarPropiedad({ token, wabaId, phoneNumberId }) {
  let waba;
  try {
    const r = await axios.get(`${GRAPH}/${encodeURIComponent(wabaId)}`, {
      params: { fields: 'id,name,currency,timezone_id' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    waba = r.data;
  } catch (e) {
    throw new PropiedadInvalida('el token no da acceso a esa cuenta de WhatsApp');
  }
  if (String(waba?.id) !== String(wabaId)) {
    throw new PropiedadInvalida('la cuenta de WhatsApp no coincide con la autorizada');
  }

  let numeros = [];
  try {
    const r = await axios.get(`${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers`, {
      params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    numeros = r.data?.data || [];
  } catch (e) {
    throw new PropiedadInvalida('no se pudo leer los números de esa cuenta de WhatsApp');
  }

  const numero = numeros.find(n => String(n.id) === String(phoneNumberId));
  if (!numero) {
    throw new PropiedadInvalida('ese número no pertenece a la cuenta de WhatsApp autorizada');
  }

  return { waba, numero };
}

/** Error de validación de propiedad — se le muestra al cliente tal cual. */
class PropiedadInvalida extends Error {}

/**
 * Suscribe NUESTRA app a los webhooks del WABA del cliente. Sin esto la
 * conexión existe pero los mensajes entrantes nunca llegan — el bug más
 * silencioso posible: todo se ve conectado y el agente jamás responde.
 */
async function suscribirWebhooks({ token, wabaId }) {
  await axios.post(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, null, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}

/**
 * Registra el número en la Cloud API. Meta exige un PIN de 6 dígitos
 * (verificación en dos pasos). Se genera acá y se guarda: si algún día hay
 * que volver a registrar el mismo número, Meta pide ESE pin y sin él el
 * cliente queda trabado.
 *
 * No es fatal si falla: hay números que ya vienen registrados de antes, y
 * ahí Meta responde error aunque todo esté bien. Se reporta y se sigue.
 */
async function registrarNumero({ token, phoneNumberId, pin }) {
  await axios.post(`${GRAPH}/${encodeURIComponent(phoneNumberId)}/register`,
    { messaging_product: 'whatsapp', pin },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
}

function generarPin() {
  // 6 dígitos con crypto (no Math.random): es una credencial de recuperación.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Orquesta todo el alta y deja la cuenta conectada.
 * Devuelve lo que el panel muestra — nunca el token.
 */
async function conectarCuenta({ accountId, code, wabaId, phoneNumberId }) {
  if (!estaHabilitado()) throw new Error('Embedded Signup no está configurado en el servidor');

  // 1. Código → token (lo primero, el código expira en 30 s)
  const { token, expiraEnSeg } = await canjearCodigo(code);
  const caducidad = caducidadToken(expiraEnSeg);

  // 2. ¿Es realmente suyo? (defensa contra WABA ajeno)
  const { waba, numero } = await verificarPropiedad({ token, wabaId, phoneNumberId });

  // 3. Webhooks: sin esto no entra ningún mensaje
  await suscribirWebhooks({ token, wabaId });

  // 4. Registro del número (best-effort — ver comentario de registrarNumero)
  const pin = generarPin();
  let registrado = true;
  let avisoRegistro = null;
  try {
    await registrarNumero({ token, phoneNumberId, pin });
  } catch (e) {
    registrado = false;
    avisoRegistro = e.response?.data?.error?.message || e.message;
    console.warn(`[embedded-signup] register falló para ${phoneNumberId}: ${avisoRegistro}`);
  }

  // 5. Guardar. El token va al account igual que en el alta manual, así todo
  //    el resto del sistema (worker de envío, audio, webhook) funciona sin
  //    enterarse de por dónde entró.
  await db.update(db.accounts, { _id: accountId }, {
    wa_phone_number_id:     String(phoneNumberId),
    wa_business_account_id: String(wabaId),
    wa_access_token:        token,
    wa_display_number:      numero.display_phone_number || null,
    wa_verified_name:       numero.verified_name || waba.name || null,
    wa_register_pin:        registrado ? pin : null,
    wa_conectado_via:       'embedded_signup',
    wa_conectado_at:        new Date().toISOString(),
    // La mecha. Sin esto nadie sabe que este token se muere.
    wa_token_expires_at:      caducidad.expiraEn,
    wa_token_expira_estimada: caducidad.estimada,
    wa_token_aviso_at:        null,
    wa_reconectar:            false,
  });

  console.log(`✅ [embedded-signup] cuenta ${accountId} conectó WhatsApp ${numero.display_phone_number || phoneNumberId} (WABA ${wabaId}) · token hasta ${caducidad.expiraEn.slice(0, 10)}${caducidad.estimada ? ' (estimado)' : ''}`);

  return {
    numero:       numero.display_phone_number || null,
    nombre:       numero.verified_name || waba.name || null,
    calidad:      numero.quality_rating || null,
    registrado,
    avisoRegistro,
    expiraEn:     caducidad.expiraEn,
  };
}

// ── La mecha de 60 días ──────────────────────────────────────────────────────

/** Días de anticipación con que se avisa al dueño. */
const AVISO_DIAS = parseInt(process.env.WA_TOKEN_AVISO_DIAS || '10', 10);
/** No repetir el correo más seguido que esto (el barrido corre cada pocas horas). */
const AVISO_COOLDOWN_H = 72;

/** Días que le quedan al token de WhatsApp, o null si no aplica. */
function diasParaCaducar(account, ahora = Date.now()) {
  if (!account?.wa_token_expires_at) return null;
  const ms = new Date(account.wa_token_expires_at).getTime() - ahora;
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

/**
 * Recorre las cuentas conectadas por el botón y avisa antes de que el token
 * muera. NO intenta refrescar: Meta no publica cómo, y fingir un refresh que
 * no existe sería peor que avisar.
 *
 * Corre desde server.js junto al barrido de Instagram.
 */
async function barridoCaducidadWa() {
  const ahora = Date.now();
  let avisadas = 0, vencidas = 0;
  try {
    const cuentas = await db.find(db.accounts, {});
    for (const acc of cuentas) {
      // Solo las del botón: el alta manual usa un System User token que no caduca.
      if (acc.wa_conectado_via !== 'embedded_signup') continue;
      if (!acc.wa_access_token) continue;

      const dias = diasParaCaducar(acc, ahora);
      if (dias === null || dias > AVISO_DIAS) continue;

      // Ya caducado: el canal no puede operar hasta que el cliente reconecte.
      if (dias < 0 && !acc.wa_reconectar) {
        await db.update(db.accounts, { _id: acc._id }, { wa_reconectar: true }).catch(() => null);
        vencidas++;
      }

      const ultimo = acc.wa_token_aviso_at ? new Date(acc.wa_token_aviso_at).getTime() : 0;
      if ((ahora - ultimo) / 3_600_000 < AVISO_COOLDOWN_H) continue;

      const owner = await db.findOne(db.users, { account_id: acc._id });
      if (!owner?.email) {
        console.warn(`⚠️  [wa-token] cuenta ${acc._id} vence en ${dias}d y no tiene a quién avisarle`);
        continue;
      }
      try {
        const { sendEmail } = require('./email');
        const { whatsappTokenPorVencerEmail } = require('./emailTemplates');
        const { subject, html } = whatsappTokenPorVencerEmail({
          name: owner.name, email: owner.email,
          dias, numero: acc.wa_display_number || null,
        });
        const r = await sendEmail({ to: owner.email, subject, html, tag: 'wa_token_vence', userId: owner._id });
        if (r?.ok) {
          await db.update(db.accounts, { _id: acc._id },
            { wa_token_aviso_at: new Date().toISOString() }).catch(() => null);
          avisadas++;
        }
      } catch (e) {
        console.error('[wa-token] no se pudo avisar:', e.message);
      }
    }
    if (avisadas || vencidas) {
      console.log(`🔑 [wa-token] ${avisadas} aviso(s) enviado(s), ${vencidas} cuenta(s) con el token ya vencido`);
    }
  } catch (e) {
    console.error('barridoCaducidadWa error:', e.message);
  }
  return { avisadas, vencidas };
}

module.exports = {
  estaHabilitado,
  configPublica,
  canjearCodigo,
  caducidadToken,
  diasParaCaducar,
  barridoCaducidadWa,
  VIDA_TOKEN_DEFAULT_DIAS,
  AVISO_DIAS,
  verificarPropiedad,
  suscribirWebhooks,
  registrarNumero,
  generarPin,
  conectarCuenta,
  PropiedadInvalida,
  SCOPES,
  GRAPH,
};
