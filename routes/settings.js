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

// DELETE — desconectar WhatsApp (limpia los campos wa_*)
router.delete('/whatsapp', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.accounts, { _id: accountId }, {
      wa_phone_number_id: null, wa_business_account_id: null, wa_access_token: null,
    });
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

// DELETE — desconectar Messenger (limpia los campos fb_*)
router.delete('/messenger', async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.accounts, { _id: accountId }, {
      fb_page_id: null, fb_page_token: null,
    });
    res.json({ ok: true });
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
        title: 'Conectá tu Instagram',
        description: 'Linkeá tu cuenta Business/Creator para que el bot pueda responder DMs automáticamente.',
        done: hasIG,
        cta: { label: hasIG ? `@${account.ig_username}` : 'Conectar Instagram', section: 'settings' },
      },
      {
        id: 'openai',
        icon: '🔑',
        title: 'Agregá tu OpenAI API Key',
        description: 'Necesitás una key de OpenAI para que el agente IA genere respuestas. Tardás 30 segundos en sacarla.',
        done: hasOpenAI,
        cta: { label: hasOpenAI ? 'Configurada' : 'Agregar API Key', section: 'settings' },
      },
      {
        id: 'agent',
        icon: '🤖',
        title: 'Personalizá tu agente',
        description: 'Editá las instrucciones del agente con tu tono, flujo de ventas y reglas de tu negocio.',
        done: hasAgent,
        cta: { label: hasAgent ? 'Personalizado' : 'Editar agente', section: 'agents' },
      },
      {
        id: 'knowledge',
        icon: '📚',
        title: 'Cargá info de tu negocio',
        description: 'Servicios, precios, horarios, preguntas frecuentes. Todo lo que el bot necesita saber para vender.',
        done: hasKnowledge,
        cta: { label: hasKnowledge ? 'Base cargada' : 'Cargar knowledge', section: 'knowledge' },
      },
      {
        id: 'links',
        icon: '🔗',
        title: 'Configurá tus links',
        description: 'Agenda, checkout, PDF, VSL — los enlaces que el bot comparte en el momento justo.',
        done: hasLinks,
        cta: { label: hasLinks ? 'Links listos' : 'Agregar links', section: 'links' },
      },
      {
        id: 'tester',
        icon: '💬',
        title: 'Probá el agente',
        description: 'Hacele preguntas al bot en el tester y ajustá las respuestas antes de ponerlo live.',
        done: hasTested,
        cta: { label: hasTested ? 'Ya probaste' : 'Abrir tester', section: 'tester' },
      },
    ];

    const completedSteps = steps.filter(s => s.done).length;
    const totalSteps = steps.length;
    const percent = Math.round((completedSteps / totalSteps) * 100);
    const allDone = completedSteps === totalSteps;
    const nextStep = steps.find(s => !s.done) || null;

    res.json({ steps, completedSteps, totalSteps, percent, allDone, nextStep });
  } catch (e) { next(e); }
});

module.exports = router;
