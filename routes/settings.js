const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

router.get('/', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId || accountId === 'first' || accountId === 'temp') {
      const account = await db.findOne(db.accounts, {});
      if (!account) return res.status(404).json({ error: 'No account' });
      const settings = await db.findOne(db.settings, { account_id: account._id });
      const stats = await buildStats(account._id);
      return res.json({ account: { ...account, id: account._id }, settings, stats });
    }
    const account  = await db.findOne(db.accounts, { _id: accountId });
    const settings = await db.findOne(db.settings, { account_id: accountId });
    const stats    = await buildStats(accountId);
    res.json({ account: account ? { ...account, id: account._id } : null, settings, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

router.put('/', async (req, res) => {
  try {
    const { accountId, openai_key } = req.body;
    const exists = await db.findOne(db.settings, { account_id: accountId });
    if (exists) {
      await db.update(db.settings, { account_id: accountId }, { openai_key, updatedAt: new Date().toISOString() });
    } else {
      await db.insert(db.settings, { account_id: accountId, openai_key });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/account', async (req, res) => {
  try {
    const { accountId, ig_username, ig_user_id, access_token } = req.body;
    await db.update(db.accounts, { _id: accountId }, { ig_username, ig_user_id, access_token });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ONBOARDING STATUS ───────────────────────────────────────────────────────
// Devuelve el estado real del onboarding del usuario (qué pasos completó y cuál sigue).
// Se usa para renderizar el checklist dinámico del home del dashboard.
router.get('/onboarding', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
