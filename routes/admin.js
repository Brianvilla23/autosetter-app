/**
 * DMCloser — Admin Routes
 * Gestión de usuarios, membresías y códigos de invitación.
 * Todas las rutas requieren rol admin.
 */

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/database');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Registra una acción admin en auditLog (best-effort, nunca bloquea). */
async function audit(req, action, target, detail) {
  try {
    await db.insert(db.auditLog, {
      adminId:    req.user?.userId || null,
      adminEmail: req.user?.email  || null,
      action,
      target,
      detail:     detail || null,
      ip:         (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      userAgent:  (req.headers['user-agent'] || '').slice(0, 200),
    });
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn('audit log skip:', e.message);
  }
}

/** No-cache para todas las respuestas admin (evita caching de datos sensibles). */
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/** Genera un código de invitación legible: DMC-TRIAL-A3X9K2 */
function generateCode(type) {
  const prefix = type === 'trial' ? 'TRIAL' : type === 'monthly' ? 'PRO' : 'ANUAL';
  const rand = Math.random().toString(36).toUpperCase().slice(2, 8);
  return `DMC-${prefix}-${rand}`;
}

/** Calcula fecha de vencimiento a partir de hoy + N días */
function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** Retorna días de acceso según plan */
function daysForPlan(type) {
  return type === 'trial' ? 3 : type === 'monthly' ? 30 : 365;
}

// ── USUARIOS ──────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/users
 * Lista todos los usuarios con datos de membresía.
 */
router.get('/users', async (req, res) => {
  try {
    const users = await db.find(db.users, {});
    const safe  = users.map(u => ({
      id:                   u._id,
      email:                u.email,
      name:                 u.name,
      role:                 u.role,
      isActive:             u.isActive !== false, // default true si no existe
      membershipDate:       u.membershipDate       || null,
      membershipExpiresAt:  u.membershipExpiresAt  || null,
      membershipPlan:       u.membershipPlan        || 'admin',
      inviteCode:           u.inviteCode            || null,
      createdAt:            u.createdAt,
    }));
    // Ordenar: admin primero, luego por fecha desc
    safe.sort((a, b) => {
      if (a.role === 'admin') return -1;
      if (b.role === 'admin') return  1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/admin/users/:id/status
 * Activa o desactiva el acceso de un usuario.
 * Body: { isActive: boolean }
 */
router.patch('/users/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive debe ser boolean' });

    const user = await db.findOne(db.users, { _id: id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.role === 'admin') return res.status(403).json({ error: 'No puedes desactivar al administrador' });

    await db.update(db.users, { _id: id }, { isActive });
    await audit(req, 'user.status_change', id, { email: user.email, isActive });
    res.json({ ok: true, isActive });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/admin/users/:id/membership
 * Actualiza los datos de membresía de un usuario.
 * Body: { membershipDate, membershipExpiresAt, membershipPlan, isActive }
 */
router.patch('/users/:id/membership', async (req, res) => {
  try {
    const { id } = req.params;
    const { membershipDate, membershipExpiresAt, membershipPlan, isActive } = req.body;

    const user = await db.findOne(db.users, { _id: id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const upd = {};
    if (membershipDate)      upd.membershipDate      = membershipDate;
    if (membershipExpiresAt) upd.membershipExpiresAt = membershipExpiresAt;
    if (membershipPlan)      upd.membershipPlan      = membershipPlan;
    if (typeof isActive === 'boolean') upd.isActive  = isActive;

    await db.update(db.users, { _id: id }, upd);
    await audit(req, 'user.membership_update', id, { email: user.email, ...upd });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/admin/users/:id
 * Elimina un usuario (no admin).
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await db.findOne(db.users, { _id: id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.role === 'admin') return res.status(403).json({ error: 'No puedes eliminar al administrador' });
    await db.remove(db.users, { _id: id });
    await audit(req, 'user.delete', id, { email: user.email, name: user.name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CÓDIGOS DE INVITACIÓN ─────────────────────────────────────────────────────

/**
 * GET /api/admin/codes
 * Lista todos los códigos de invitación.
 */
router.get('/codes', async (req, res) => {
  try {
    const codes = await db.find(db.inviteCodes, {});
    codes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(codes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/codes
 * Crea un nuevo código de invitación.
 * Body: { type: 'trial'|'monthly'|'annual', maxUses?: number, note?: string, codeExpiresInDays?: number }
 */
router.post('/codes', async (req, res) => {
  try {
    const { type = 'trial', maxUses = 1, note = '', codeExpiresInDays = 30 } = req.body;
    if (!['trial', 'monthly', 'annual'].includes(type)) {
      return res.status(400).json({ error: 'Tipo inválido. Usa: trial, monthly, annual' });
    }

    const code = await db.insert(db.inviteCodes, {
      code:             generateCode(type),
      type,
      daysAccess:       daysForPlan(type),
      maxUses:          Number(maxUses),
      uses:             0,
      usedBy:           [],
      isActive:         true,
      codeExpiresAt:    addDays(Number(codeExpiresInDays)),
      note,
      createdBy:        req.user.userId,
    });

    await audit(req, 'code.create', code._id, { code: code.code, type, maxUses, note });
    res.json(code);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/admin/codes/:id/toggle
 * Activa o desactiva un código.
 */
router.patch('/codes/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const code = await db.findOne(db.inviteCodes, { _id: id });
    if (!code) return res.status(404).json({ error: 'Código no encontrado' });
    await db.update(db.inviteCodes, { _id: id }, { isActive: !code.isActive });
    await audit(req, 'code.toggle', id, { code: code.code, newState: !code.isActive });
    res.json({ ok: true, isActive: !code.isActive });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/admin/codes/:id
 * Elimina un código de invitación.
 */
router.delete('/codes/:id', async (req, res) => {
  try {
    const existing = await db.findOne(db.inviteCodes, { _id: req.params.id });
    await db.remove(db.inviteCodes, { _id: req.params.id });
    await audit(req, 'code.delete', req.params.id, { code: existing?.code || null });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/stats
 * Resumen rápido para el dashboard del admin.
 */
router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, activeUsers, totalCodes, usedCodes] = await Promise.all([
      db.count(db.users, {}),
      db.count(db.users, { isActive: true }),
      db.count(db.inviteCodes, {}),
      db.count(db.inviteCodes, { uses: { $gt: 0 } }),
    ]);

    // Membresías vencidas
    const now = new Date().toISOString();
    const allUsers = await db.find(db.users, {});
    const expired  = allUsers.filter(u =>
      u.membershipExpiresAt && u.membershipExpiresAt < now && u.role !== 'admin'
    ).length;

    res.json({ totalUsers, activeUsers, totalCodes, usedCodes, expired });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/admin/accounts/:id/ig-user-id
 * Actualiza el ig_user_id de una cuenta (webhook-compatible ID).
 * Body: { ig_user_id: string }
 */
router.patch('/accounts/:id/ig-user-id', async (req, res) => {
  try {
    const { ig_user_id, ig_platform_id } = req.body;
    if (!ig_user_id && !ig_platform_id) return res.status(400).json({ error: 'ig_user_id o ig_platform_id requerido' });
    const account = await db.findOne(db.accounts, { _id: req.params.id });
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const updates = {};
    if (ig_user_id)    updates.ig_user_id    = ig_user_id;
    if (ig_platform_id) updates.ig_platform_id = ig_platform_id;
    await db.update(db.accounts, { _id: req.params.id }, updates);
    res.json({ ok: true, accountId: req.params.id, ...updates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MÉTRICAS — agregados para dashboard del admin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/metrics
 * Resumen completo: mensajes/día, leads por estado, revenue estimado, top usuarios
 */
router.get('/metrics', async (req, res) => {
  try {
    const now = new Date();
    const since7  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString();
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [allMessages, allLeads, allUsers, allUsage] = await Promise.all([
      db.find(db.messages, {}),
      db.find(db.leads, {}),
      db.find(db.users, {}),
      db.find(db.aiUsage, {}),
    ]);

    // Mensajes por día (últimos 7)
    const messagesByDay = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      messagesByDay[key] = 0;
    }
    allMessages.forEach(m => {
      const key = (m.created_at || m.createdAt || '').slice(0, 10);
      if (messagesByDay[key] !== undefined) messagesByDay[key]++;
    });

    // Leads por calificación
    const leadsByQualification = { hot: 0, warm: 0, cold: 0, unclassified: 0 };
    allLeads.forEach(l => {
      const q = l.qualification || 'unclassified';
      leadsByQualification[q] = (leadsByQualification[q] || 0) + 1;
    });

    // Leads convertidos vs bypassed
    const leadsStatus = {
      total:     allLeads.length,
      converted: allLeads.filter(l => l.is_converted).length,
      bypassed:  allLeads.filter(l => l.is_bypassed).length,
      active:    allLeads.filter(l => !l.is_converted && !l.is_bypassed).length,
    };

    // Revenue estimado (MRR) por plan USD
    const PLAN_USD = { starter: 197, pro: 297, agency: 497, monthly: 0, annual: 0 };
    let mrr = 0;
    allUsers.forEach(u => {
      if (u.role === 'admin') return;
      if (u.subscriptionStatus !== 'active') return;
      const p = u.membershipPlan;
      mrr += PLAN_USD[p] || 0;
    });

    // Uso de IA últimos 30 días
    const recentUsage = allUsage.filter(u => (u.createdAt || '') >= since30);
    const aiStats = {
      totalCalls:      recentUsage.length,
      reasoningCalls:  recentUsage.filter(u => u.reasoning).length,
      fastCalls:       recentUsage.filter(u => !u.reasoning).length,
      totalTokens:     recentUsage.reduce((s, u) => s + (u.totalTokens || 0), 0),
      reasoningTokens: recentUsage.reduce((s, u) => s + (u.reasoningTokens || 0), 0),
    };
    // Costo estimado (asumiendo precios OpenAI 2026): gpt-4o-mini $0.15/M input, $0.60/M output
    // o4-mini $1.10/M input, $4.40/M output
    aiStats.estimatedCostUSD = 0;
    recentUsage.forEach(u => {
      const inCost  = (u.promptTokens     || 0) / 1_000_000;
      const outCost = (u.completionTokens || 0) / 1_000_000;
      if (u.reasoning) aiStats.estimatedCostUSD += inCost * 1.10 + outCost * 4.40;
      else             aiStats.estimatedCostUSD += inCost * 0.15 + outCost * 0.60;
    });
    aiStats.estimatedCostUSD = Math.round(aiStats.estimatedCostUSD * 100) / 100;

    // Top 5 usuarios por leads
    const leadsByUser = {};
    for (const lead of allLeads) {
      leadsByUser[lead.account_id] = (leadsByUser[lead.account_id] || 0) + 1;
    }
    const accounts = await db.find(db.accounts, {});
    const accountByUser = {};
    for (const u of allUsers) {
      const acc = accounts.find(a => a._id === u.accountId);
      accountByUser[u._id] = acc?._id;
    }
    const topUsers = allUsers
      .filter(u => u.role !== 'admin')
      .map(u => ({
        id:         u._id,
        name:       u.name,
        email:      u.email,
        plan:       u.membershipPlan || 'trial',
        leadsCount: leadsByUser[accountByUser[u._id]] || 0,
      }))
      .sort((a, b) => b.leadsCount - a.leadsCount)
      .slice(0, 5);

    // New users últimos 7 días
    const newUsersLast7 = allUsers.filter(u => (u.createdAt || '') >= since7).length;

    res.json({
      messagesByDay,
      leadsByQualification,
      leadsStatus,
      mrr,
      aiStats,
      topUsers,
      newUsersLast7,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/users/:id/detail
 * Detalle de un usuario: account, agentes, leads recientes, mensajes totales
 */
router.get('/users/:id/detail', async (req, res) => {
  try {
    const user = await db.findOne(db.users, { _id: req.params.id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const account = user.accountId ? await db.findOne(db.accounts, { _id: user.accountId }) : null;
    const agents  = account  ? await db.find(db.agents, { account_id: account._id })  : [];
    const leads   = account  ? await db.find(db.leads,  { account_id: account._id })  : [];
    const messages = [];
    if (account) {
      for (const lead of leads.slice(0, 20)) {
        const leadMsgs = await db.find(db.messages, { lead_id: lead._id });
        messages.push(...leadMsgs);
      }
    }

    // Resumen
    const summary = {
      user: {
        id:                   user._id,
        name:                 user.name,
        email:                user.email,
        role:                 user.role,
        isActive:             user.isActive !== false,
        plan:                 user.membershipPlan,
        expiresAt:            user.membershipExpiresAt,
        paymentProvider:      user.paymentProvider || null,
        subscriptionStatus:   user.subscriptionStatus || null,
        createdAt:            user.createdAt,
      },
      account: account ? {
        id:           account._id,
        ig_username:  account.ig_username,
        ig_user_id:   account.ig_user_id,
        connectedAt:  account.createdAt,
      } : null,
      agents: agents.map(a => ({ id: a._id, name: a.name, enabled: a.enabled })),
      leads: {
        total:     leads.length,
        converted: leads.filter(l => l.is_converted).length,
        bypassed:  leads.filter(l => l.is_bypassed).length,
        hot:       leads.filter(l => l.qualification === 'hot').length,
        warm:      leads.filter(l => l.qualification === 'warm').length,
        cold:      leads.filter(l => l.qualification === 'cold').length,
        recent:    leads.slice(0, 10).map(l => ({
          id: l._id, ig_username: l.ig_username, qualification: l.qualification,
          is_converted: l.is_converted, is_bypassed: l.is_bypassed,
          last_message_at: l.last_message_at,
        })),
      },
      messageCount: messages.length,
    };

    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/health
 * Estado del sistema: DB, OpenAI, webhooks, cola pendiente
 */
router.get('/health', async (req, res) => {
  try {
    const checks = {};

    // DB OK (si find() funcionó)
    checks.database = { status: 'ok', message: 'NeDB responsive' };

    // OpenAI configurado?
    const anyOpenai = !!process.env.OPENAI_API_KEY
      || !!(await db.findOne(db.settings, { openai_key: { $exists: true, $ne: '' } }));
    checks.openai = {
      status: anyOpenai ? 'ok' : 'warn',
      message: anyOpenai ? 'API key configurada' : 'Sin OPENAI_API_KEY global ni por cuenta',
    };

    // Meta webhook token?
    checks.metaWebhook = {
      status: process.env.META_VERIFY_TOKEN ? 'ok' : 'warn',
      message: process.env.META_VERIFY_TOKEN ? 'Verify token configurado' : 'Sin META_VERIFY_TOKEN',
    };

    // Billing providers
    const hasLS = !!(process.env.LS_API_KEY && process.env.LS_WEBHOOK_SECRET && process.env.LS_STORE_ID);
    const hasMP = !!process.env.MP_ACCESS_TOKEN;
    checks.lemonSqueezy = { status: hasLS ? 'ok' : 'warn', message: hasLS ? 'Lemon Squeezy configurado' : 'Variables LS_* faltantes' };
    checks.mercadoPago  = { status: hasMP ? 'ok' : 'warn', message: hasMP ? 'Mercado Pago configurado' : 'MP_ACCESS_TOKEN faltante' };

    // JWT secret fuerte?
    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET || '';
    const jwtOk = jwtSecret.length >= 32 && jwtSecret !== 'cambiar_esto_en_produccion';
    checks.jwtSecret = {
      status: jwtOk ? 'ok' : 'error',
      message: jwtOk ? 'Secret >= 32 chars' : '⚠️ JWT_SECRET débil o default. CÁMBIALO en Railway',
    };

    // Cola pendiente (señal de salud del worker)
    const pendingCount = await db.count(db.pendingSends, {});
    checks.pendingQueue = {
      status: pendingCount < 50 ? 'ok' : 'warn',
      message: `${pendingCount} mensajes pendientes`,
      count: pendingCount,
    };

    // Uptime
    const uptimeSec = Math.floor(process.uptime());

    res.json({
      checks,
      uptime: {
        seconds: uptimeSec,
        human: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
      },
      version: process.env.npm_package_version || '1.0.0',
      env:     process.env.NODE_ENV || 'development',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/ai-usage
 * Últimas N llamadas a OpenAI (para debugging de costos/reasoning)
 */
router.get('/ai-usage', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const all = await db.find(db.aiUsage, {});
    const sorted = all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/audit-log
 * Últimas acciones administrativas
 */
router.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = await db.find(db.auditLog, {});
    const sorted = all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
