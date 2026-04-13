require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');

const { requireAuth } = require('./middleware/authMiddleware');
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

// ── PROTECTED API ROUTES ──────────────────────────────────────────────────────
app.use('/api/agents',    apiLimiter, requireAuth, require('./routes/agents'));
app.use('/api/knowledge', apiLimiter, requireAuth, require('./routes/knowledge'));
app.use('/api/leads',     apiLimiter, requireAuth, require('./routes/leads'));
app.use('/api/links',     apiLimiter, requireAuth, require('./routes/links'));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AutoSetter running → http://localhost:${PORT}`);
  console.log(`📡 Webhook URL        → http://localhost:${PORT}/webhook`);
  console.log(`🔐 Auth URL           → http://localhost:${PORT}/auth/instagram`);
  console.log(`🛡️  Security           → Helmet + Rate Limit + XSS Protection ON\n`);
});
