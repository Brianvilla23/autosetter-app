require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();
const { requireAuth } = require('./middleware/authMiddleware');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── PUBLIC ROUTES (no auth needed) ───────────────────────────────────────────
app.use('/webhook',         require('./routes/webhook'));
app.use('/auth',            require('./routes/auth'));           // Instagram OAuth
app.use('/api/user',        require('./routes/userAuth'));       // login / register

// ── PROTECTED API ROUTES ──────────────────────────────────────────────────────
app.use('/api/agents',     requireAuth, require('./routes/agents'));
app.use('/api/knowledge',  requireAuth, require('./routes/knowledge'));
app.use('/api/leads',      requireAuth, require('./routes/leads'));
app.use('/api/links',      requireAuth, require('./routes/links'));
app.use('/api/settings',   requireAuth, require('./routes/settings'));

// Helper: account info from JWT (replaces /api/account/first)
app.get('/api/account/me', requireAuth, async (req, res) => {
  try {
    const db = require('./db/database');
    const account = await db.findOne(db.accounts, { _id: req.user.accountId });
    if (!account) return res.status(404).json({ error: 'No account' });
    res.json({ id: account._id, ig_username: account.ig_username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy: keep /api/account/first for backward compatibility (unprotected → protected)
app.get('/api/account/first', requireAuth, async (req, res) => {
  try {
    const db = require('./db/database');
    const account = await db.findOne(db.accounts, { _id: req.user.accountId });
    if (!account) return res.status(404).json({ error: 'No account' });
    res.json({ id: account._id, ig_username: account.ig_username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CATCH ALL → serve dashboard ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AutoSetter running → http://localhost:${PORT}`);
  console.log(`📡 Webhook URL        → http://localhost:${PORT}/webhook`);
  console.log(`🔐 Auth URL           → http://localhost:${PORT}/auth/instagram\n`);
});
