require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');

const { requireAuth }      = require('./middleware/authMiddleware');
const { requireAdmin }     = require('./middleware/requireAdmin');
const checkSubscription    = require('./middleware/checkSubscription');
const {
  authLimiter,
  apiLimiter,
  webhookLimiter,
  sanitizeBody,
  preventParamPollution,
  blockSuspiciousAgents,
  blockAttackPaths,
} = require('./middleware/security');

const app = express();

// Trust Railway/Heroku proxy so rate-limiter reads real IPs from X-Forwarded-For
app.set('trust proxy', 1);

// ── SEGURIDAD GLOBAL ──────────────────────────────────────────────────────────

// 1. Helmet — headers HTTP seguros (XSS protection, HSTS, etc.)
// CSP mínima: inline permitido (la UI usa inline handlers), pero restringimos connect/frame.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],      // UI inline handlers
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", 'https://api.openai.com', 'https://graph.facebook.com', 'https://graph.instagram.com'],
      fontSrc:     ["'self'", 'data:'],
      frameAncestors: ["'none'"],                       // clickjacking
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      formAction:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// 2. CORS — solo orígenes conocidos en producción
const allowedOrigins = process.env.APP_URL
  ? [process.env.APP_URL, 'http://localhost:3000']
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (mobile apps, Postman, webhook de Meta)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─────────────────────────────────────────────────────────────────────────────
// LEMON SQUEEZY WEBHOOK (raw body — MUST be before express.json())
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/billing/ls-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.LS_WEBHOOK_SECRET;
  if (!secret) return res.status(400).json({ error: 'LS_WEBHOOK_SECRET no configurado' });

  // Verify HMAC-SHA256 signature
  const crypto = require('crypto');
  const hmac      = crypto.createHmac('sha256', secret);
  const digest    = Buffer.from(hmac.update(req.body).digest('hex'), 'utf8');
  const signature = Buffer.from(req.headers['x-signature'] || '', 'utf8');

  if (digest.length !== signature.length || !crypto.timingSafeEqual(digest, signature)) {
    console.error('❌ LS webhook: firma inválida');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try { event = JSON.parse(req.body.toString()); }
  catch (e) { return res.status(400).send('Invalid JSON'); }

  const dbW = require('./db/database');
  const now = new Date();
  const eventName    = event.meta?.event_name;
  const customData   = event.meta?.custom_data || {};
  const userId       = customData.userId;
  const plan         = customData.plan;
  const subId        = event.data?.id;
  const portalUrl    = event.data?.attributes?.urls?.customer_portal;

  try {
    switch (eventName) {

      case 'subscription_created': {
        if (userId && plan) {
          const exp = new Date(now); exp.setMonth(exp.getMonth() + 1);
          await dbW.update(dbW.users, { _id: userId }, {
            membershipPlan:         plan,
            membershipExpiresAt:    exp.toISOString(),
            subscriptionStatus:     'active',
            paymentProvider:        'ls',
            lsSubscriptionId:       subId,
            lsCustomerPortalUrl:    portalUrl || null,
          });
          console.log(`✅ LS: suscripción creada — usuario ${userId} (${plan})`);

          // Email de bienvenida al plan
          try {
            const user = await dbW.findOne(dbW.users, { _id: userId });
            if (user?.email) {
              const { sendEmail } = require('./services/email');
              const { subscriptionActivatedEmail } = require('./services/emailTemplates');
              const tpl = subscriptionActivatedEmail({ name: user.name, email: user.email, plan });
              sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, userId, tag: 'subscription_activated' }).catch(() => null);
            }
          } catch (e) { console.warn('subscription email skip:', e.message); }
        }
        break;
      }

      case 'subscription_payment_success': {
        // Renewal — find user by LS subscription ID
        const lsSubId = event.data?.attributes?.subscription_id || event.data?.id;
        const user = userId
          ? await dbW.findOne(dbW.users, { _id: userId })
          : await dbW.findOne(dbW.users, { lsSubscriptionId: String(lsSubId) });
        if (user) {
          const exp = new Date(now); exp.setMonth(exp.getMonth() + 1);
          await dbW.update(dbW.users, { _id: user._id }, {
            membershipExpiresAt: exp.toISOString(),
            subscriptionStatus:  'active',
          });
          console.log(`✅ LS: pago renovado — ${user.email}`);
        }
        break;
      }

      case 'subscription_payment_failed': {
        if (userId) {
          await dbW.update(dbW.users, { _id: userId }, { subscriptionStatus: 'past_due' });
          console.log(`⚠️ LS: pago fallido — usuario ${userId}`);

          // Email de recuperación
          try {
            const user = await dbW.findOne(dbW.users, { _id: userId });
            if (user?.email) {
              const { sendEmail } = require('./services/email');
              const { paymentFailedEmail } = require('./services/emailTemplates');
              const tpl = paymentFailedEmail({ name: user.name, email: user.email });
              sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, userId, tag: 'payment_failed' }).catch(() => null);
            }
          } catch (e) { console.warn('payment failed email skip:', e.message); }
        }
        break;
      }

      case 'subscription_cancelled':
      case 'subscription_expired': {
        if (userId) {
          await dbW.update(dbW.users, { _id: userId }, {
            subscriptionStatus:  'cancelled',
            membershipPlan:      'cancelled',
            membershipExpiresAt: now.toISOString(),
          });
          console.log(`❌ LS: suscripción ${eventName} — usuario ${userId}`);
        }
        break;
      }
    }
  } catch (e) {
    console.error('LS webhook handler error:', e.message);
  }

  res.json({ received: true });
});

// 3. Limitar tamaño de payload (previene ataques de payload gigante)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 4. Bloquear bots y paths de ataque antes de procesar nada
app.use(blockSuspiciousAgents);
app.use(blockAttackPaths);

// 5. Prevenir HTTP Parameter Pollution
app.use(preventParamPollution);

// 6. Sanitizar body contra XSS
app.use(sanitizeBody);

// 7. Static files — SIN auto-index para que no sirva index.html en "/"
// (queremos landing pública en "/" y dashboard en "/app")
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── LANDING PÚBLICA ───────────────────────────────────────────────────────────
// "/" → home.html (marketing). Si el user ya está logueado, home.html lo
// redirige con JS a "/app" leyendo localStorage.autosetter_token.
// Excepción: si vuelve de OAuth/checkout (auth= o billing= en query),
// lo mandamos DIRECTO al /app conservando los params para que el SPA los procese.
app.get('/', (req, res) => {
  if (req.query.auth || req.query.billing) {
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect('/app?' + qs);
  }
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// "/app" → dashboard SPA (index.html)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── HEALTH ENDPOINTS ──────────────────────────────────────────────────────────
// /health        → liveness (proceso vivo). Railway lo usa como healthcheck.
// /health/ready  → readiness (DB + config). 503 si algo crítico falta.
// Públicos, sin auth, para uptime monitors y load balancers.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
  });
});

app.get('/health/ready', async (req, res) => {
  const checks = {};
  let allOk = true;

  // 1. DB reachable — un find rápido sobre una colección liviana
  try {
    const dbHealth = require('./db/database');
    await dbHealth.find(dbHealth.users, {});
    checks.db = 'ok';
  } catch (e) {
    checks.db = 'fail: ' + e.message;
    allOk = false;
  }

  // 2. Config crítica presente (no exponemos valores, solo booleans)
  checks.config = {
    openai_key:     !!process.env.OPENAI_API_KEY,
    meta_app_id:    !!process.env.META_APP_ID,
    jwt_secret:     !!process.env.JWT_SECRET,
    ls_api_key:     !!process.env.LS_API_KEY,      // opcional
    mp_token:       !!process.env.MP_ACCESS_TOKEN, // opcional
  };
  if (!checks.config.openai_key || !checks.config.meta_app_id || !checks.config.jwt_secret) {
    allOk = false;
  }

  // 3. Cantidad de cuentas activas (señal de vida del producto)
  try {
    const dbM = require('./db/database');
    const accounts = await dbM.find(dbM.accounts, {});
    checks.accounts_count = accounts.length;
  } catch {
    checks.accounts_count = null;
  }

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'degraded',
    checks,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.use('/webhook',  webhookLimiter, require('./routes/webhook'));
app.use('/auth',                     require('./routes/auth'));        // Instagram OAuth
app.use('/api/user', authLimiter,    require('./routes/userAuth'));    // login / register

// ─────────────────────────────────────────────────────────────────────────────
// MERCADO PAGO WEBHOOK (standard JSON, no raw body needed)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/billing/mp-webhook', async (req, res) => {
  try {
    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) return res.status(400).json({ error: 'MP_ACCESS_TOKEN no configurado' });

    const eventType = req.body?.type || req.query?.type;
    const dataId    = req.body?.data?.id || req.query?.['data.id'];

    if (!dataId) { res.sendStatus(200); return; } // ack empty notifications

    // Only handle subscription events
    if (eventType !== 'subscription_preapproval' && eventType !== 'subscription_authorized_payment') {
      res.sendStatus(200); return;
    }

    const axios = require('axios');
    const dbW   = require('./db/database');
    const now   = new Date();

    // Fetch the subscription from MP to get authoritative status
    const endpoint = eventType === 'subscription_authorized_payment'
      ? `https://api.mercadopago.com/authorized_payments/${dataId}`
      : `https://api.mercadopago.com/preapproval/${dataId}`;

    const { data } = await axios.get(endpoint, {
      headers: { 'Authorization': `Bearer ${mpToken}` },
    });

    const subscriptionId = data.preapproval_id || data.id;
    const userId         = data.external_reference;
    const status         = data.status; // 'authorized', 'pending', 'paused', 'cancelled'
    const planReason     = (data.reason || '').toLowerCase();
    const planGuess      = planReason.includes('starter') ? 'starter'
                         : planReason.includes('agency')  ? 'agency'
                         : planReason.includes('pro')     ? 'pro'
                         : null;

    if (!userId) { res.sendStatus(200); return; }

    if (status === 'authorized' || eventType === 'subscription_authorized_payment') {
      // Detectar si es la PRIMERA activación (para mandar welcome email una sola vez)
      const userBefore = await dbW.findOne(dbW.users, { _id: userId });
      const isFirstActivation = userBefore && userBefore.subscriptionStatus !== 'active';

      const exp = new Date(now); exp.setMonth(exp.getMonth() + 1);
      const update = {
        membershipExpiresAt: exp.toISOString(),
        subscriptionStatus:  'active',
        paymentProvider:     'mp',
        mpSubscriptionId:    String(subscriptionId),
      };
      if (planGuess) update.membershipPlan = planGuess;
      await dbW.update(dbW.users, { _id: userId }, update);
      console.log(`✅ MP: suscripción activa — usuario ${userId} (${planGuess || 'n/a'})`);

      // Welcome-to-plan email solo en la primera activación
      if (isFirstActivation && userBefore.email) {
        try {
          const { sendEmail } = require('./services/email');
          const { subscriptionActivatedEmail } = require('./services/emailTemplates');
          const tpl = subscriptionActivatedEmail({ name: userBefore.name, email: userBefore.email, plan: planGuess || userBefore.membershipPlan });
          sendEmail({ to: userBefore.email, subject: tpl.subject, html: tpl.html, userId, tag: 'subscription_activated_mp' }).catch(() => null);
        } catch (e) { console.warn('MP activation email skip:', e.message); }
      }
    } else if (status === 'cancelled' || status === 'paused') {
      await dbW.update(dbW.users, { _id: userId }, {
        subscriptionStatus:  status,
        membershipPlan:      status === 'cancelled' ? 'cancelled' : undefined,
        membershipExpiresAt: status === 'cancelled' ? now.toISOString() : undefined,
      });
      console.log(`❌ MP: suscripción ${status} — usuario ${userId}`);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('MP webhook error:', e.response?.data || e.message);
    res.sendStatus(200); // always 200 so MP doesn't retry indefinitely
  }
});

// ── BILLING ROUTES ────────────────────────────────────────────────────────────
app.use('/api/billing', apiLimiter, require('./routes/billing'));

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.use('/api/admin', apiLimiter, requireAdmin, require('./routes/admin'));

// ── PROTECTED API ROUTES ──────────────────────────────────────────────────────
app.use('/api/agents',    apiLimiter, requireAuth, checkSubscription, require('./routes/agents'));
app.use('/api/knowledge', apiLimiter, requireAuth, checkSubscription, require('./routes/knowledge'));
app.use('/api/leads',     apiLimiter, requireAuth, checkSubscription, require('./routes/leads'));
app.use('/api/links',     apiLimiter, requireAuth, checkSubscription, require('./routes/links'));
app.use('/api/settings',  apiLimiter, requireAuth, require('./routes/settings'));
app.use('/api/growth',    apiLimiter, requireAuth, checkSubscription, require('./routes/growth'));
app.use('/api/notifications', apiLimiter, requireAuth, require('./routes/notifications'));
app.use('/api/usage',         apiLimiter, requireAuth, require('./routes/usage'));

// Helper: account info from JWT
app.get('/api/account/me', requireAuth, async (req, res) => {
  try {
    const db = require('./db/database');
    const account = await db.findOne(db.accounts, { _id: req.user.accountId });
    if (!account) return res.status(404).json({ error: 'No account' });
    res.json({ id: account._id, ig_username: account.ig_username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy backward compat
app.get('/api/account/first', requireAuth, async (req, res) => {
  try {
    const db = require('./db/database');
    const account = await db.findOne(db.accounts, { _id: req.user.accountId });
    if (!account) return res.status(404).json({ error: 'No account' });
    res.json({ id: account._id, ig_username: account.ig_username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MAGNET LINK REDIRECT (público, con tracking) ──────────────────────────────
// /go/:slug → registra click y redirige a ig.me/m/USERNAME?text=PRESET
app.get('/go/:slug', async (req, res) => {
  try {
    const dbW = require('./db/database');
    const slug = String(req.params.slug).replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
    if (!slug) return res.redirect(302, '/');

    const link = await dbW.findOne(dbW.magnetLinks, { slug });
    if (!link) return res.redirect(302, '/');

    // Registrar click (best-effort, sin bloquear redirect)
    dbW.insert(dbW.linkClicks, {
      slug,
      account_id: link.account_id,
      source:     link.source,
      referer:    (req.headers['referer'] || '').slice(0, 200),
      userAgent:  (req.headers['user-agent'] || '').slice(0, 200),
      ip:         (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
    }).catch(() => {});

    const username = encodeURIComponent(link.ig_username.replace(/^@/, ''));
    let target = `https://ig.me/m/${username}`;
    if (link.preset_text) target += `?text=${encodeURIComponent(link.preset_text)}`;
    return res.redirect(302, target);
  } catch (e) {
    console.error('magnet redirect error:', e.message);
    return res.redirect(302, '/');
  }
});

// ── ERROR HANDLER GLOBAL ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // No exponer stack traces en producción
  console.error('[ERROR]', err.message);
  if (err.message?.includes('CORS')) {
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── CATCH ALL → serve dashboard ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── PENDING SENDS WORKER ──────────────────────────────────────────────────────
// Procesa replies pendientes cada 10s. Sobrevive reinicios de Railway.
const { sendMessage } = require('./services/meta');
const { incrementDMCount } = require('./services/limits');
const dbW = require('./db/database');

async function processPendingSends() {
  try {
    const now = new Date().toISOString();
    const pending = await dbW.find(dbW.pendingSends, {});
    const due = pending.filter(p => p.sendAt <= now);
    for (const item of due) {
      let sentOk = false;
      try {
        await sendMessage({
          recipientId:  item.recipientId,
          text:         item.text,
          accessToken:  item.accessToken,
          igUserId:     item.igUserId,
          accountId:    item.accountId,
        });
        sentOk = true;
        console.log(`✅ [${item.agentName}] → @${item.leadUsername}: ${item.text.substring(0, 60)}...`);
      } catch (e) {
        console.error(`❌ pendingSend error para @${item.leadUsername}:`, e.response?.data || e.message);
      }
      // Contabilizar solo envíos exitosos contra el límite del plan
      if (sentOk && item.accountId) {
        await incrementDMCount(item.accountId, 1).catch(() => null);
      }
      // Eliminar siempre (éxito o error) para no reintentar indefinidamente
      await dbW.remove(dbW.pendingSends, { _id: item._id });
    }
  } catch (e) {
    console.error('processPendingSends error:', e.message);
  }
}

setInterval(processPendingSends, 10000); // cada 10 segundos

// ── META TOKEN REFRESH WORKER ────────────────────────────────────────────────
// Renueva tokens de Instagram antes de que caduquen (60 días).
// Corre al arranque + cada 6 horas. Los clientes nunca tienen que re-loguearse.
const { refreshAllExpiring } = require('./services/metaRefresh');

// Primera pasada 30s después del arranque (dar tiempo a estabilizarse)
setTimeout(() => {
  refreshAllExpiring().catch(e => console.error('metaRefresh initial sweep:', e.message));
}, 30_000);

// Barrido periódico cada 6 horas
setInterval(() => {
  refreshAllExpiring().catch(e => console.error('metaRefresh periodic sweep:', e.message));
}, 6 * 60 * 60 * 1000);

// ── FOLLOW-UP WORKERS ─────────────────────────────────────────────────────────
// Dos loops separados: agendar nuevos follow-ups y enviar los que están agendados.
const { scheduleFollowUps, processFollowUps } = require('./services/followup');

// Agenda cada 2 minutos
setInterval(() => {
  scheduleFollowUps().catch(e => console.error('scheduleFollowUps:', e.message));
}, 120000);

// Envía cada 30 segundos los que están listos
setInterval(() => {
  processFollowUps().catch(e => console.error('processFollowUps:', e.message));
}, 30000);

// ── TRIAL LIFECYCLE EMAILS WORKER ─────────────────────────────────────────────
// Cada 6h recorre users con plan=trial y manda:
//  - trialEndingEmail cuando falta 2 días (o menos) para que venza
//  - trialEndedEmail el día que ya venció
// Guarda flags en el user (trialEndingEmailSent / trialEndedEmailSent) para no spammear.
async function sweepTrialEmails() {
  try {
    const dbTE = require('./db/database');
    const { sendEmail } = require('./services/email');
    const { trialEndingEmail, trialEndedEmail } = require('./services/emailTemplates');
    const users = await dbTE.find(dbTE.users, { membershipPlan: 'trial' });
    const now = Date.now();

    for (const u of users) {
      if (!u.email || !u.membershipExpiresAt) continue;
      const expMs    = new Date(u.membershipExpiresAt).getTime();
      const hoursLeft = (expMs - now) / 3_600_000;

      // Trial ending (48h a 0h antes del vencimiento) — mandar una sola vez
      if (hoursLeft > 0 && hoursLeft <= 48 && !u.trialEndingEmailSent) {
        const daysLeft = Math.max(1, Math.round(hoursLeft / 24));
        const tpl = trialEndingEmail({ name: u.name, email: u.email, daysLeft });
        const r = await sendEmail({ to: u.email, subject: tpl.subject, html: tpl.html, userId: u._id, tag: 'trial_ending' });
        if (r.ok) await dbTE.update(dbTE.users, { _id: u._id }, { trialEndingEmailSent: new Date().toISOString() });
      }

      // Trial ended (0 a -48h después del vencimiento) — mandar una sola vez
      if (hoursLeft <= 0 && hoursLeft > -48 && !u.trialEndedEmailSent) {
        const tpl = trialEndedEmail({ name: u.name, email: u.email });
        const r = await sendEmail({ to: u.email, subject: tpl.subject, html: tpl.html, userId: u._id, tag: 'trial_ended' });
        if (r.ok) await dbTE.update(dbTE.users, { _id: u._id }, { trialEndedEmailSent: new Date().toISOString() });
      }
    }
  } catch (e) {
    console.error('sweepTrialEmails error:', e.message);
  }
}

// Primer barrido a los 60s, luego cada 6h
setTimeout(() => sweepTrialEmails(), 60_000);
setInterval(sweepTrialEmails, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 DMCloser running   → http://localhost:${PORT}`);
  console.log(`📡 Webhook URL        → http://localhost:${PORT}/webhook`);
  console.log(`🔐 Auth URL           → http://localhost:${PORT}/auth/instagram`);
  console.log(`👑 Admin Panel        → http://localhost:${PORT}/admin`);
  console.log(`🛡️  Security           → Helmet + Rate Limit + XSS Protection ON`);
  console.log(`💳 LS Webhook         → http://localhost:${PORT}/api/billing/ls-webhook`);
  console.log(`💳 MP Webhook         → http://localhost:${PORT}/api/billing/mp-webhook\n`);
});
