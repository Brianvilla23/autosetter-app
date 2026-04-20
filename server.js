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
app.use(helmet({
  contentSecurityPolicy: false, // Lo desactivamos para no romper la UI inline
  crossOriginEmbedderPolicy: false,
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

// ── STRIPE WEBHOOK (raw body — MUST be before express.json()) ─────────────────
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(400).json({ error: 'Stripe no configurado' });
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const dbW = require('./db/database');
  const now = new Date();

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.userId;
        const plan    = session.metadata?.plan;
        if (userId && plan) {
          const exp = new Date(now);
          exp.setMonth(exp.getMonth() + 1);
          await dbW.update(dbW.users, { _id: userId }, {
            membershipPlan:       plan,
            membershipExpiresAt:  exp.toISOString(),
            stripeSubscriptionId: session.subscription,
            subscriptionStatus:   'active',
          });
          console.log(`✅ Stripe: suscripción activada — usuario ${userId} (${plan})`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        // skip the initial charge (already handled by checkout.session.completed)
        if (invoice.billing_reason === 'subscription_create') break;
        const user = await dbW.findOne(dbW.users, { stripeCustomerId: invoice.customer });
        if (user) {
          const exp = new Date(now);
          exp.setMonth(exp.getMonth() + 1);
          await dbW.update(dbW.users, { _id: user._id }, {
            membershipExpiresAt: exp.toISOString(),
            subscriptionStatus:  'active',
          });
          console.log(`✅ Stripe: pago renovado — ${user.email}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = await dbW.findOne(dbW.users, { stripeCustomerId: invoice.customer });
        if (user) {
          await dbW.update(dbW.users, { _id: user._id }, { subscriptionStatus: 'past_due' });
          console.log(`⚠️ Stripe: pago fallido — ${user.email}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub  = event.data.object;
        const user = await dbW.findOne(dbW.users, { stripeCustomerId: sub.customer });
        if (user) {
          await dbW.update(dbW.users, { _id: user._id }, {
            subscriptionStatus:  'cancelled',
            membershipPlan:      'cancelled',
            membershipExpiresAt: now.toISOString(),
          });
          console.log(`❌ Stripe: suscripción cancelada — ${user.email}`);
        }
        break;
      }

    }
  } catch (e) {
    console.error('Stripe webhook handler error:', e.message);
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
  console.log(`🛡️  Security           → Helmet + Rate Limit + XSS Protection ON\n`);
});
