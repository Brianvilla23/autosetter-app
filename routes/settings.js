const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
// Sanitización de secrets — módulo compartido + testeado (test/security.test.js).
// SEGURIDAD: nunca enviar tokens/keys crudos al cliente. Aunque el endpoint
// está protegido por auth + tenant isolation, un secret que viaja al browser
// queda en el Network tab, logs de CDN/proxy, y es robable vía XSS.
const { sanitizeAccount, sanitizeSettings } = require('../services/sanitize');

// ── Tenant isolation helper ─────────────────────────────────────────────────
function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

router.get('/', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    // Casos legacy: 'first'/'temp' caen al accountId del JWT, no a "el primer account de la DB".
    // (El comportamiento viejo era una vulnerabilidad: cualquier user veía datos del primer account.)
    const effectiveId = (!accountId || accountId === 'first' || accountId === 'temp')
      ? req.user.accountId
      : accountId;
    if (!assertOwnsAccount(req, effectiveId)) return res.status(403).json({ error: 'forbidden' });

    const account  = await db.findOne(db.accounts, { _id: effectiveId });
    const settings = await db.findOne(db.settings, { account_id: effectiveId });
    const stats    = await buildStats(effectiveId);
    res.json({
      account:  sanitizeAccount(account),
      settings: sanitizeSettings(settings),
      stats,
      // Solo el flag (nunca credenciales): la UI muestra "en preparación"
      // mientras la plataforma no tenga las TWILIO_* en el entorno.
      twilio_configurado: require('../services/telefonia').telefoniaHabilitada(),
    });
  } catch (e) { next(e); }
});

async function buildStats(accountId) {
  const [agents, leads, knowledge, links, converted] = await Promise.all([
    db.count(db.agents,    { account_id: accountId, enabled: true }),
    db.count(db.leads,     { account_id: accountId }),
    db.count(db.knowledge, { account_id: accountId }),
    db.count(db.links,     { account_id: accountId }),
    db.count(db.leads,     { account_id: accountId, is_converted: true }),
  ]);
  return { agents, leads, knowledge, links, converted };
}

router.put('/', async (req, res, next) => {
  try {
    const { accountId, openai_key } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    // SEGURIDAD: el frontend ya NO recibe la key cruda (solo masked). Por eso,
    // si el campo llega vacío o contiene el caracter del masked (…), NO pisamos
    // la key existente — el user simplemente no la cambió. Solo guardamos cuando
    // viene una key NUEVA real.
    const isMaskedOrEmpty = !openai_key || !openai_key.trim() || openai_key.includes('…');

    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (isMaskedOrEmpty) {
      // No tocar la openai_key. Si no existe el doc de settings, crearlo vacío.
      if (!exists) await db.insert(db.settings, { account_id: accountId, openai_key: '' });
      return res.json({ ok: true, unchanged: true });
    }

    const cleanKey = openai_key.trim();
    if (exists) {
      await db.update(db.settings, { account_id: accountId }, { openai_key: cleanKey, updatedAt: new Date().toISOString() });
    } else {
      await db.insert(db.settings, { account_id: accountId, openai_key: cleanKey });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.put('/account', async (req, res, next) => {
  try {
    const { accountId, ig_username, ig_user_id, access_token } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.accounts, { _id: accountId }, { ig_username, ig_user_id, access_token });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── PAUSAR / REANUDAR UN CANAL ──────────────────────────────────────────────
// PUT /api/settings/canal/:canal/pausa  body: { accountId, pausado }
//
// Pausar NO borra credenciales: apaga la atención automática de ese canal y
// deja todo guardado, para que reanudar sea un clic. Es la respuesta al
// problema real de que "desconectar" fuera un viaje de ida — recuperar un
// WhatsApp exigía generar un System User token de nuevo en Meta.
// Para borrar de verdad están los DELETE de cada canal ("olvidar credenciales").
router.put('/canal/:canal/pausa', async (req, res, next) => {
  try {
    const { canal } = req.params;
    const { accountId, pausado } = req.body || {};
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const { esPausable, flagPausa, PAUSABLES } = require('../services/channels/core');
    if (!esPausable(canal)) {
      return res.status(400).json({ error: `Canal desconocido: "${canal}". Válidos: ${Object.keys(PAUSABLES).join(', ')}.` });
    }

    const flag = flagPausa(canal);
    await db.update(db.accounts, { _id: accountId }, { [flag]: !!pausado });
    res.json({ ok: true, canal, pausado: !!pausado, label: PAUSABLES[canal].label });
  } catch (e) { next(e); }
});

// ── Instagram — olvidar credenciales de verdad ──────────────────────────────
// DELETE /api/settings/instagram?accountId=...
//
// Antes esto no existía: el panel "desconectaba" haciendo un PUT que escribía
// los valores de la semilla encima (ig_user_id: 'demo_ig_id', access_token:
// 'demo_token'). Eso dejaba credenciales inventadas que fallaban contra Meta y,
// peor, hacía que dos cuentas desconectadas compartieran el mismo ig_user_id
// — y el webhook busca la cuenta justamente por ese campo.
router.delete('/instagram', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.accounts, { _id: accountId }, {
      ig_user_id: null, ig_platform_id: null, ig_username: null, access_token: null,
      ig_pausado: false, needs_reauth: false,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── WhatsApp Cloud API — conectar / desconectar número ───────────────────────
// PUT body: { accountId, wa_phone_number_id, wa_business_account_id, wa_access_token }
// El cliente pega los 3 datos de su WABA (de Meta Business → API Setup).
// El wa_access_token NO se devuelve nunca al frontend (sanitizeAccount lo oculta).
router.put('/whatsapp', async (req, res, next) => {
  try {
    const { accountId, wa_phone_number_id, wa_business_account_id, wa_access_token } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const upd = {};
    if (wa_phone_number_id !== undefined)    upd.wa_phone_number_id    = String(wa_phone_number_id || '').trim();
    if (wa_business_account_id !== undefined) upd.wa_business_account_id = String(wa_business_account_id || '').trim();
    // El token solo se pisa si viene uno nuevo real (no el masked).
    if (wa_access_token && !wa_access_token.includes('…')) {
      upd.wa_access_token = String(wa_access_token).trim();
    }
    await db.update(db.accounts, { _id: accountId }, upd);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE — olvidar credenciales de WhatsApp (limpia los campos wa_*)
// Ojo: esto SÍ es irreversible — para volver hay que generar otro token de
// System User en Meta. Si lo que se quiere es apagar el canal un rato, va
// PUT /canal/whatsapp/pausa, que conserva todo.
router.delete('/whatsapp', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.accounts, { _id: accountId }, {
      wa_phone_number_id: null, wa_business_account_id: null, wa_access_token: null,
      wa_pausado: false,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── MERCADO PAGO (cobro dentro del chat) ────────────────────────────────────
// PUT body: { accountId, mp_access_token }
// Con el token guardado, el agente gana la capacidad de generar links de
// pago reales de Checkout Pro cuando el lead confirma la compra ([PAGO: ...]).
// El token vive en settings, NUNCA se devuelve al frontend, y se pisa solo
// si viene uno nuevo real (no el masked).
router.put('/mercadopago', async (req, res, next) => {
  try {
    const { accountId, mp_access_token } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    if (!mp_access_token || mp_access_token.includes('…')) {
      return res.json({ ok: true, unchanged: true });
    }
    const clean = String(mp_access_token).trim();
    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (exists) {
      await db.update(db.settings, { account_id: accountId }, { mp_access_token: clean, updatedAt: new Date().toISOString() });
    } else {
      await db.insert(db.settings, { account_id: accountId, openai_key: '', mp_access_token: clean });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE — desconectar Mercado Pago (el agente pierde la capacidad de cobro)
router.delete('/mercadopago', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.settings, { account_id: accountId }, { mp_access_token: null });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── SHOPIFY (confirmación de pedidos por WhatsApp) ──────────────────────────
// PUT body: { accountId, shopify_webhook_secret, shopify_template_name,
//             shopify_template_lang?, shopify_eta_dias? }
// Con el secret guardado, el webhook POST /webhook/shopify?acc=<id> empieza a
// aceptar pedidos: crea el lead, manda el template de confirmación y el agente
// conversa con el pedido en contexto. El secret NUNCA vuelve al frontend.
router.put('/shopify', async (req, res, next) => {
  try {
    const {
      accountId, shopify_webhook_secret, shopify_template_name,
      shopify_template_lang, shopify_eta_dias, shopify_topic,
    } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const upd = {};
    // Un solo topic por cuenta: escuchar create Y paid a la vez duplica el
    // mensaje al cliente (Shopify los dispara casi simultáneos).
    if (shopify_topic !== undefined) {
      upd.shopify_topic = shopify_topic === 'orders/paid' ? 'orders/paid' : 'orders/create';
    }
    // El secret solo se pisa si viene uno nuevo real (no el masked).
    if (shopify_webhook_secret && !shopify_webhook_secret.includes('…')) {
      upd.shopify_webhook_secret = String(shopify_webhook_secret).trim();
    }
    if (shopify_template_name !== undefined) {
      upd.shopify_template_name = String(shopify_template_name || '').trim();
    }
    if (shopify_template_lang !== undefined) {
      upd.shopify_template_lang = String(shopify_template_lang || 'es').trim() || 'es';
    }
    if (shopify_eta_dias !== undefined) {
      const n = parseInt(shopify_eta_dias, 10);
      upd.shopify_eta_dias = Number.isFinite(n) && n >= 1 && n <= 30 ? n : 3;
    }

    // ── Stock vivo (Admin API de la tienda) ─────────────────────────────────
    // El token solo se pisa si viene uno nuevo real (no el masked), igual que
    // el webhook secret. Es campo SENSIBLE: sanitize.js lo omite del frontend.
    if (req.body.shopify_admin_token && !String(req.body.shopify_admin_token).includes('…')) {
      upd.shopify_admin_token = String(req.body.shopify_admin_token).trim();
    }
    if (req.body.shopify_shop_domain !== undefined) {
      upd.shopify_shop_domain = String(req.body.shopify_shop_domain || '').trim().slice(0, 120);
    }

    // ── Playbook post-compra (opt-in) ────────────────────────────────────────
    // Tiempos con rangos sanos; plantillas por nombre plano (Meta las aprueba
    // aparte); el incentivo del video-reseña solo se promete si está escrito acá.
    const pb = req.body;
    if (pb.playbook_pedido_enabled !== undefined) {
      upd.playbook_pedido_enabled = pb.playbook_pedido_enabled === true;
    }
    for (const [campo, min, max] of [
      ['playbook_upsell_horas', 0.5, 24],
      ['playbook_resena_dias', 1, 60],
      ['playbook_winback_dias', 1, 90],
      ['playbook_mkt_cap_mes', 1, 8],
    ]) {
      if (pb[campo] !== undefined) {
        const n = Number(pb[campo]);
        if (Number.isFinite(n) && n >= min && n <= max) upd[campo] = n;
      }
    }
    if (pb.playbook_incentivo_video !== undefined) {
      upd.playbook_incentivo_video = String(pb.playbook_incentivo_video || '').trim().slice(0, 200);
    }
    for (const campo of [
      'playbook_template_tracking', 'playbook_template_llega_hoy',
      'playbook_template_entregado', 'playbook_template_upsell',
      'playbook_template_resena', 'playbook_template_winback',
    ]) {
      if (pb[campo] !== undefined) upd[campo] = String(pb[campo] || '').trim().slice(0, 120);
    }

    if (!Object.keys(upd).length) return res.json({ ok: true, unchanged: true });

    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (exists) {
      await db.update(db.settings, { account_id: accountId }, { ...upd, updatedAt: new Date().toISOString() });
    } else {
      await db.insert(db.settings, { account_id: accountId, openai_key: '', ...upd });
    }
    res.json({ ok: true, webhook_url: `${process.env.APP_URL || 'https://atinov.com'}/webhook/shopify?acc=${accountId}` });
  } catch (e) { next(e); }
});

// DELETE — desconectar Shopify (el webhook vuelve a rechazar todo)
router.delete('/shopify', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.settings, { account_id: accountId }, {
      shopify_webhook_secret: null, shopify_template_name: null,
      shopify_template_lang: null, shopify_eta_dias: null, shopify_topic: null,
      // El playbook y el stock vivo viven de la conexión Shopify: caen con ella.
      playbook_pedido_enabled: null,
      shopify_admin_token: null, shopify_shop_domain: null,
    });
    try { require('../services/shopifyStock').invalidar(accountId); } catch (e) { /* cache opcional */ }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── EMBEDDED SIGNUP v4 — conectar WhatsApp con UN botón ─────────────────────
// El cliente ya no extrae nada de su WABA: el popup de Meta hace todo y acá
// solo llega un código de un solo uso. Ver services/embeddedSignup.js.

/**
 * GET /api/settings/whatsapp/embedded-signup
 * Datos públicos para abrir el popup (app id y config id no son secretos).
 * Si devuelve enabled:false, el frontend muestra el alta manual de siempre.
 */
router.get('/whatsapp/embedded-signup', async (req, res, next) => {
  try {
    const { configPublica } = require('../services/embeddedSignup');
    res.json(configPublica());
  } catch (e) { next(e); }
});

/**
 * POST /api/settings/whatsapp/embedded-signup
 * Body: { accountId, code, waba_id, phone_number_id }
 *
 * `code` dura 30 segundos — se canjea al tiro. `waba_id` y `phone_number_id`
 * vienen del navegador del cliente y NO se creen: se validan contra Meta con
 * el token recién canjeado antes de guardar nada.
 */
router.post('/whatsapp/embedded-signup', async (req, res, next) => {
  try {
    const { accountId, code, waba_id, phone_number_id } = req.body || {};
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const es = require('../services/embeddedSignup');
    if (!es.estaHabilitado()) {
      return res.status(503).json({ error: 'La conexión con un clic todavía no está disponible. Usa el formulario manual.' });
    }
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Falta el código de autorización de Meta' });
    }
    if (!/^\d{5,25}$/.test(String(waba_id || '')) || !/^\d{5,25}$/.test(String(phone_number_id || ''))) {
      return res.status(400).json({ error: 'Meta no devolvió la cuenta o el número. Reintenta la conexión.' });
    }

    const r = await es.conectarCuenta({
      accountId, code,
      wabaId: String(waba_id),
      phoneNumberId: String(phone_number_id),
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    const es = require('../services/embeddedSignup');
    // Fallo de propiedad: es culpa del dato, no del servidor — se le dice al
    // cliente qué pasó (no filtra nada: solo confirma que ese WABA no es suyo).
    if (e instanceof es.PropiedadInvalida) {
      console.warn(`[embedded-signup] rechazado para cuenta ${req.body?.accountId}: ${e.message}`);
      return res.status(403).json({ error: `No se pudo conectar: ${e.message}.` });
    }
    // El error de Meta puede traer el app secret o fragmentos del token: al
    // log del servidor sí, al cliente NUNCA (middleware/errorResponse.js).
    console.error('[embedded-signup] error:', e.response?.data?.error?.message || e.message);
    res.status(500).json({ error: 'No se pudo completar la conexión con WhatsApp. Intenta de nuevo en un minuto.' });
  }
});

// ── LLAMADAS TELEFÓNICAS (Twilio) ────────────────────────────────────────────
// PUT body: { accountId, llamadas_enabled?, llamadas_hora_inicio?,
//             llamadas_hora_fin?, llamadas_max_dia?, llamadas_max_min? }
// Interruptor y candados POR CUENTA. Las credenciales de Twilio NO viven acá:
// son de la plataforma (env vars en Railway) — sin ellas todo esto queda
// inerte aunque el interruptor esté prendido (fail-closed en el servicio).
// Además cada agente tiene su propio interruptor (calls_enabled, como
// followup_enabled): los DOS deben estar prendidos para que el agente ofrezca.
router.put('/llamadas', async (req, res, next) => {
  try {
    const {
      accountId, llamadas_enabled, llamadas_hora_inicio, llamadas_hora_fin,
      llamadas_max_dia, llamadas_max_min,
    } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const upd = {};
    if (typeof llamadas_enabled === 'boolean') upd.llamadas_enabled = llamadas_enabled;
    const hora = (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : undefined;
    if (llamadas_hora_inicio !== undefined && hora(llamadas_hora_inicio) !== undefined) {
      upd.llamadas_hora_inicio = hora(llamadas_hora_inicio);
    }
    if (llamadas_hora_fin !== undefined && hora(llamadas_hora_fin) !== undefined) {
      upd.llamadas_hora_fin = hora(llamadas_hora_fin);
    }
    if (llamadas_max_dia !== undefined) {
      const n = parseInt(llamadas_max_dia, 10);
      upd.llamadas_max_dia = Number.isFinite(n) && n >= 1 && n <= 50 ? n : 10;
    }
    if (llamadas_max_min !== undefined) {
      const n = parseInt(llamadas_max_min, 10);
      upd.llamadas_max_min = Number.isFinite(n) && n >= 3 && n <= 15 ? n : 10;
    }
    if (!Object.keys(upd).length) return res.json({ ok: true, unchanged: true });

    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (exists) {
      await db.update(db.settings, { account_id: accountId }, { ...upd, updatedAt: new Date().toISOString() });
    } else {
      await db.insert(db.settings, { account_id: accountId, openai_key: '', ...upd });
    }
    const { telefoniaHabilitada } = require('../services/telefonia');
    res.json({ ok: true, twilio_configurado: telefoniaHabilitada() });
  } catch (e) { next(e); }
});

// DELETE — apagar llamadas en la cuenta (los candados de horario/tope quedan)
router.delete('/llamadas', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.settings, { account_id: accountId }, { llamadas_enabled: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── LLAMADAS DENTRO DE WHATSAPP (Meta Calling API vía SIP de Twilio) ────────
// POST: activa SIP en el número de WhatsApp de la cuenta apuntando al dominio
// SIP de la plataforma y guarda las credenciales digest que Meta genera (nunca
// vuelven al frontend). Exige: WhatsApp conectado + app en modo Live + Twilio.
// Fail-closed: sin TWILIO_SIP_DOMAIN el endpoint responde que no está
// disponible y no toca nada.
router.post('/llamadas/whatsapp', async (req, res, next) => {
  try {
    const { accountId } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    if (!process.env.TWILIO_SIP_DOMAIN || !process.env.TWILIO_ACCOUNT_SID) {
      return res.status(503).json({ error: 'Las llamadas por WhatsApp aún no están habilitadas en la plataforma.' });
    }
    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account?.wa_phone_number_id || !account?.wa_access_token) {
      return res.status(400).json({ error: 'Primero conecta tu WhatsApp (Configuración → WhatsApp Business).' });
    }
    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (!exists) await db.insert(db.settings, { account_id: accountId, openai_key: '' });

    const { activarSipEnNumero } = require('../services/whatsappCalling');
    const r = await activarSipEnNumero({ account, accountId });
    res.json({ ok: true, hostname: r.hostname });
  } catch (e) {
    // El error de Meta puede traer detalle interno: al log sí, al cliente un
    // mensaje útil. El caso típico es la app en modo desarrollo.
    const detalle = e.response?.data?.error?.message || e.message;
    console.error('[llamadas-wa] activar SIP falló:', detalle);
    const esLive = /live|development|mode|permission/i.test(String(detalle));
    res.status(400).json({
      error: esLive
        ? 'Meta rechazó la activación: las llamadas por WhatsApp exigen que la app esté en modo Live (App Review aprobado).'
        : 'No se pudo activar la llamada por WhatsApp en tu número. Intenta de nuevo o sigue con la llamada al celular, que ya funciona.',
    });
  }
});

router.delete('/llamadas/whatsapp', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    const account = await db.findOne(db.accounts, { _id: accountId });
    const { desactivarSipEnNumero } = require('../services/whatsappCalling');
    await desactivarSipEnNumero({ account, accountId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── MESSENGER (Página de Facebook / Marketplace) ────────────────────────────
// PUT body: { accountId, fb_page_id, fb_page_token, wa_display_number }
// El cliente pega el ID de su Página + el Page Access Token (de la Meta App,
// caso de uso Messenger). fb_page_token NUNCA se devuelve al frontend.
// wa_display_number es el número visible de WhatsApp al que el agente deriva
// los prospectos calificados desde Messenger (ej. "+56 9 8566 6043").
router.put('/messenger', async (req, res, next) => {
  try {
    const { accountId, fb_page_id, fb_page_token, wa_display_number } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const upd = {};
    if (fb_page_id !== undefined)       upd.fb_page_id       = String(fb_page_id || '').trim();
    if (wa_display_number !== undefined) upd.wa_display_number = String(wa_display_number || '').trim();
    // El token solo se pisa si viene uno nuevo real (no el masked).
    if (fb_page_token && !fb_page_token.includes('…')) {
      upd.fb_page_token = String(fb_page_token).trim();
    }
    await db.update(db.accounts, { _id: accountId }, upd);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE — olvidar credenciales de Messenger (limpia los campos fb_*)
// Para apagarlo sin perder el token: PUT /canal/messenger/pausa.
router.delete('/messenger', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.accounts, { _id: accountId }, {
      fb_page_id: null, fb_page_token: null, fb_pausado: false,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── ELIMINAR MI CUENTA Y TODOS MIS DATOS ────────────────────────────────────
// POST /api/settings/eliminar-cuenta   body: { confirm: "ELIMINAR MIS DATOS" }
//
// La página pública /data-deletion ya prometía esto ("También puedes pedirlo
// desde el panel: Ajustes → Eliminar cuenta") pero el botón no existía: la
// única cascada estaba detrás de requireAdmin. Meta revisa esa página en el
// App Review, y la Ley 21.719 exige que el titular pueda ejercer la supresión
// sin depender de que alguien le conteste un correo.
//
// Solo puede borrar SU propia cuenta: el accountId sale del JWT, no del body.
const FRASE_CONFIRMACION = 'ELIMINAR MIS DATOS';

router.post('/eliminar-cuenta', async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (String(confirm || '').trim().toUpperCase() !== FRASE_CONFIRMACION) {
      return res.status(400).json({ error: `Para confirmar, escribe exactamente: ${FRASE_CONFIRMACION}` });
    }

    const { userId, accountId, email, name, role } = req.user || {};
    if (!accountId || !userId) return res.status(400).json({ error: 'Tu sesión no tiene una cuenta asociada.' });

    // El admin es la cuenta de operación del servicio: si se borra a sí mismo
    // nadie puede volver a entrar al panel de administración.
    if (role === 'admin') {
      return res.status(403).json({ error: 'La cuenta de administrador no se elimina desde acá. Escribe a soporte@atinov.com.' });
    }

    // El rastro va ANTES: auditLog sobrevive a la supresión justamente para
    // poder demostrar que ocurrió, y después de borrar ya no hay de dónde
    // sacar el email ni la cuenta.
    try {
      await db.insert(db.auditLog, {
        adminId: userId, adminEmail: email || null,
        action: 'cuenta.autosupresion', target: accountId,
        detail: { nombre: name || null, via: 'panel' },
        ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
        userAgent: (req.headers['user-agent'] || '').slice(0, 200),
      });
    } catch (e) { console.warn('[eliminar-cuenta] audit skip:', e.message); }

    // El aviso también sale ANTES de borrar: así el registro que deja en
    // emailLog (que incluye la dirección, o sea dato personal) se va con la
    // misma cascada, en vez de quedar como resto de una cuenta ya eliminada.
    if (email) {
      try {
        const { sendEmail } = require('../services/email');
        await sendEmail({
          to: email,
          subject: 'Tus datos de Atinov fueron eliminados',
          userId,
          tag: 'account_deleted',
          html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:auto;padding:24px">
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px">
              <h1 style="font-size:20px;margin:0 0 12px">Listo: tus datos fueron eliminados</h1>
              <p style="color:#475569;line-height:1.6">Ejecutamos la eliminación que pediste desde el panel. Se borraron tus conversaciones, tus prospectos, tu configuración de agentes, tu base de conocimiento y los accesos a Instagram, WhatsApp y Messenger.</p>
              <p style="color:#475569;line-height:1.6">Conservamos únicamente los registros de facturación que exige la ley tributaria chilena, sin contenido de conversaciones, y el registro administrativo de esta misma eliminación.</p>
              <p style="color:#475569;line-height:1.6">Las copias de seguridad se purgan en un máximo de 90 días.</p>
              <p style="color:#94a3b8;font-size:13px;margin-top:20px">Si no fuiste tú, escríbenos a soporte@atinov.com de inmediato.</p>
            </div></div>`,
        });
      } catch (e) { console.warn('[eliminar-cuenta] email skip:', e.message); }
    }

    const { suprimirCuenta } = require('../services/supresion');
    const r = await suprimirCuenta({ accountId, userId, borrarUsuario: true });

    res.json({ ok: true, total: r.total, detalle: r.detalle, conservado: r.conservado });
  } catch (e) { next(e); }
});

// ── ONBOARDING STATUS ───────────────────────────────────────────────────────
// Devuelve el estado real del onboarding del usuario (qué pasos completó y cuál sigue).
// Se usa para renderizar el checklist dinámico del home del dashboard.
router.get('/onboarding', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });

    const [account, settings, agents, knowledge, links, messagesCount, leadsCount] = await Promise.all([
      db.findOne(db.accounts, { _id: accountId }),
      db.findOne(db.settings, { account_id: accountId }),
      db.find(db.agents, { account_id: accountId }),
      db.find(db.knowledge, { account_id: accountId }),
      db.count(db.links, { account_id: accountId }),
      db.count(db.messages, { account_id: accountId }),
      db.count(db.leads, { account_id: accountId }),
    ]);

    // Señal 1: Instagram conectado
    const hasIG = !!(account && account.ig_user_id);

    // Señal 2: OpenAI key configurada
    const hasOpenAI = !!(settings && settings.openai_key);

    // Señal 3: Agente personalizado (seedDemoAgent usa placeholders [Nombre] — si siguen ahí, no lo tocó)
    const activeAgent = agents.find(a => a.enabled) || agents[0];
    const hasAgent = !!(activeAgent && activeAgent.instructions &&
      !activeAgent.instructions.includes('[Nombre]') &&
      !activeAgent.instructions.includes('[Describe'));

    // Señal 4: Knowledge base real (el demo usa "[Describe tu servicio]" — si no cambió, no cuenta)
    const hasKnowledge = knowledge.some(k => k.content &&
      !k.content.includes('[Describe') &&
      !k.content.includes('[Tu precio]') &&
      k.content.length > 50);

    // Señal 5: Links reales (el demo pone https://calendly.com/tu-link — si sigue así, no cuenta)
    const realLinks = await db.find(db.links, { account_id: accountId });
    const hasLinks = realLinks.some(l => l.url &&
      !l.url.includes('tu-link') &&
      !l.url.includes('tu-sitio.com') &&
      l.url.startsWith('http'));

    // Señal 6: Probó el chat (al menos 1 mensaje en el tester o DM real recibido)
    const hasTested = messagesCount > 0 || leadsCount > 0;

    const steps = [
      {
        id: 'ig',
        icon: '📸',
        title: 'Conecta tu Instagram',
        description: 'Vincula tu cuenta Business/Creator para que el asistente pueda responder DMs por ti.',
        done: hasIG,
        cta: { label: hasIG ? `@${account.ig_username}` : 'Conectar Instagram', section: 'settings' },
      },
      {
        id: 'openai',
        icon: '🔑',
        title: 'Agrega tu OpenAI API Key',
        description: 'Necesitas una key de OpenAI para que el agente IA genere respuestas. Tardas 30 segundos en sacarla.',
        done: hasOpenAI,
        cta: { label: hasOpenAI ? 'Configurada' : 'Agregar API Key', section: 'settings' },
      },
      {
        id: 'agent',
        icon: '🤖',
        title: 'Personaliza tu agente',
        description: 'Edita las instrucciones del agente con tu tono, flujo de ventas y reglas de tu negocio.',
        done: hasAgent,
        cta: { label: hasAgent ? 'Personalizado' : 'Editar agente', section: 'agents' },
      },
      {
        id: 'knowledge',
        icon: '📚',
        title: 'Carga info de tu negocio',
        description: 'Servicios, precios, horarios, preguntas frecuentes. Todo lo que el asistente necesita saber para vender.',
        done: hasKnowledge,
        cta: { label: hasKnowledge ? 'Base cargada' : 'Cargar knowledge', section: 'knowledge' },
      },
      {
        id: 'links',
        icon: '🔗',
        title: 'Configura tus links',
        description: 'Agenda, checkout, PDF, VSL — los enlaces que el asistente comparte en el momento justo.',
        done: hasLinks,
        cta: { label: hasLinks ? 'Links listos' : 'Agregar links', section: 'links' },
      },
      {
        id: 'tester',
        icon: '💬',
        title: 'Prueba el agente',
        description: 'Hazle preguntas al asistente en el tester y ajusta las respuestas antes de ponerlo live.',
        done: hasTested,
        cta: { label: hasTested ? 'Ya probaste' : 'Abrir tester', section: 'tester' },
      },
    ];

    // La cuenta demo no es un cliente configurandose: es un escaparate. Sin
    // esto, el revisor de Meta abre el panel y lo primero que ve es
    // "Termina tu setup 3/6 - Proximo paso: Conecta tu Instagram", que lee
    // como producto a medio instalar. Nunca podra completarlo (la demo no
    // tiene un Instagram real que conectar), asi que se marca como listo y la
    // tarjeta no se muestra.
    if (account && account.demo === true) {
      return res.json({
        steps, completedSteps: steps.length, totalSteps: steps.length,
        percent: 100, allDone: true, nextStep: null, demo: true,
      });
    }

    const completedSteps = steps.filter(s => s.done).length;
    const totalSteps = steps.length;
    const percent = Math.round((completedSteps / totalSteps) * 100);
    const allDone = completedSteps === totalSteps;
    const nextStep = steps.find(s => !s.done) || null;

    res.json({ steps, completedSteps, totalSteps, percent, allDone, nextStep });
  } catch (e) { next(e); }
});

module.exports = router;
