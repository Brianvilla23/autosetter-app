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

// 7. Static files
app.use(express.static(path.join(__dirname, 'public')));

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
const dbW = require('./db/database');

async function processPendingSends() {
  try {
    const now = new Date().toISOString();
    const pending = await dbW.find(dbW.pendingSends, {});
    const due = pending.filter(p => p.sendAt <= now);
    for (const item of due) {
      try {
        await sendMessage({
          recipientId:  item.recipientId,
          text:         item.text,
          accessToken:  item.accessToken,
          igUserId:     item.igUserId,
        });
        console.log(`✅ [${item.agentName}] → @${item.leadUsername}: ${item.text.substring(0, 60)}...`);
      } catch (e) {
        console.error(`❌ pendingSend error para @${item.leadUsername}:`, e.response?.data || e.message);
      }
      // Eliminar siempre (éxito o error) para no reintentar indefinidamente
      await dbW.remove(dbW.pendingSends, { _id: item._id });
    }
  } catch (e) {
    console.error('processPendingSends error:', e.message);
  }
}

setInterval(processPendingSends, 10000); // cada 10 segundos

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
