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
 * Lista todos los usuarios con datos de membresía + IG conectada + actividad.
 * Query opcional: ?onlyConnected=1 para filtrar solo con IG conectada.
 */
router.get('/users', async (req, res) => {
  try {
    const onlyConnected = req.query.onlyConnected === '1' || req.query.onlyConnected === 'true';
    const [users, accounts, leads] = await Promise.all([
      db.find(db.users, {}),
      db.find(db.accounts, {}),
      db.find(db.leads, {}),
    ]);

    // Index acounts por _id (accountId del user apunta a accounts._id)
    const accountById = new Map();
    for (const a of accounts) accountById.set(a._id, a);

    // Leads agrupados por account_id
    const leadsByAcc = new Map();
    const lastActByAcc = new Map();
    for (const l of leads) {
      if (!l.account_id) continue;
      leadsByAcc.set(l.account_id, (leadsByAcc.get(l.account_id) || 0) + 1);
      const last = l.last_message_at || l.updated_at || l.created_at;
      if (last) {
        const prev = lastActByAcc.get(l.account_id);
        if (!prev || last > prev) lastActByAcc.set(l.account_id, last);
      }
    }

    const safe  = users.map(u => {
      const acc = u.accountId ? accountById.get(u.accountId) : null;
      const igConnected = !!(acc && (acc.ig_username || acc.ig_user_id));
      return {
        id:                   u._id,
        email:                u.email,
        name:                 u.name,
        role:                 u.role,
        isActive:             u.isActive !== false,
        membershipDate:       u.membershipDate       || null,
        membershipExpiresAt:  u.membershipExpiresAt  || null,
        membershipPlan:       u.membershipPlan        || 'admin',
        inviteCode:           u.inviteCode            || null,
        createdAt:            u.createdAt,
        // Nuevos campos para seguimiento
        ig_connected:         igConnected,
        ig_username:          acc?.ig_username || null,
        ig_user_id:           acc?.ig_user_id  || null,
        accountId:            u.accountId      || null,
        leadsCount:           acc ? (leadsByAcc.get(acc._id) || 0) : 0,
        lastActivityAt:       acc ? (lastActByAcc.get(acc._id) || null) : null,
        adminNotes:           u.adminNotes     || '',
      };
    });

    const filtered = onlyConnected ? safe.filter(u => u.ig_connected) : safe;

    filtered.sort((a, b) => {
      if (a.role === 'admin') return -1;
      if (b.role === 'admin') return  1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/admin/users/:id/notes
 * Guarda notas internas del admin sobre un cliente (para seguimiento / CRM).
 * Body: { notes: string }
 */
router.patch('/users/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const notes = String(req.body?.notes || '').slice(0, 5000);
    const user = await db.findOne(db.users, { _id: id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    await db.update(db.users, { _id: id }, { adminNotes: notes });
    await audit(req, 'user.notes_update', id, { email: user.email, length: notes.length });
    res.json({ ok: true });
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
    let activeSubscribers = 0;
    allUsers.forEach(u => {
      if (u.role === 'admin') return;
      if (u.subscriptionStatus !== 'active') return;
      const p = u.membershipPlan;
      mrr += PLAN_USD[p] || 0;
      activeSubscribers++;
    });

    // Churn rate (últimos 30 días)
    //   cancelados_en_los_30d / (activos_hoy + cancelados_en_los_30d)
    // Aproximación razonable para SaaS chico sin snapshot diario.
    const cancelledLast30 = allUsers.filter(u =>
      u.role !== 'admin' &&
      u.subscriptionStatus === 'cancelled' &&
      (u.membershipExpiresAt || '') >= since30
    ).length;
    const churnBase = activeSubscribers + cancelledLast30;
    const churnRate = churnBase > 0 ? +(cancelledLast30 / churnBase * 100).toFixed(1) : 0;

    // Nuevas suscripciones en los últimos 30d (para growth tracking)
    const newSubscribers30d = allUsers.filter(u =>
      u.role !== 'admin' &&
      u.subscriptionStatus === 'active' &&
      (u.membershipDate || u.createdAt || '') >= since30
    ).length;

    // Usuarios en trial ahora
    const trialUsers = allUsers.filter(u =>
      u.role !== 'admin' && u.membershipPlan === 'trial'
    ).length;

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
      activeSubscribers,
      cancelledLast30,
      churnRate,
      newSubscribers30d,
      trialUsers,
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
        adminNotes:           user.adminNotes || '',
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
    const meta = db._meta || {};
    checks.database = {
      status:  meta.isPersistent ? 'ok' : 'error',
      message: meta.isPersistent
        ? `NeDB persistente en ${meta.dir}`
        : `⚠️ DB en path EFÍMERO (${meta.dir || '?'}) — CONFIGURÁ DB_PATH a un Railway Volume YA, sino vas a perder datos en cada deploy`,
    };

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

/**
 * POST /api/admin/users/:id/extend-trial
 * Extiende el trial de un usuario por N días (default 7).
 * Funciona tanto para usuarios en trial como para extender membresía expirada.
 * Body: { days?: number }  — por defecto 7
 */
router.post('/users/:id/extend-trial', async (req, res) => {
  try {
    const { id } = req.params;
    const days = Math.min(Math.max(parseInt(req.body.days) || 7, 1), 365);

    const user = await db.findOne(db.users, { _id: id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.role === 'admin') return res.status(400).json({ error: 'No tiene sentido extender trial de admin' });

    // Si la membresía ya venció → extender desde HOY. Si todavía está viva → sumar.
    const now     = Date.now();
    const current = user.membershipExpiresAt ? new Date(user.membershipExpiresAt).getTime() : 0;
    const base    = current > now ? current : now;
    const newExp  = new Date(base + days * 24 * 3_600_000).toISOString();

    const upd = {
      membershipExpiresAt: newExp,
      isActive: true,
      // Si estaba cancelado/expirado, lo volvemos a trial para que vuelva a tener acceso
      ...(user.subscriptionStatus !== 'active' ? { membershipPlan: 'trial', subscriptionStatus: 'trial' } : {}),
      // Resetear flags de emails de trial para que pueda recibir el reminder si vuelve a estar cerca del vencimiento
      trialEndingEmailSent: null,
      trialEndedEmailSent:  null,
    };
    await db.update(db.users, { _id: id }, upd);
    await audit(req, 'user.extend_trial', id, { email: user.email, days, newExpiresAt: newExp });

    res.json({ ok: true, newExpiresAt: newExp, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/emails
 * Últimos emails transaccionales enviados (o intentados). Útil para diagnosticar
 * "por qué no le llegó el welcome a fulano?" sin entrar a Resend.
 */
router.get('/emails', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = await db.find(db.emailLog, {});
    const sorted = all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
    // stats quick
    const stats = {
      total:    all.length,
      ok:       all.filter(e => e.ok).length,
      failed:   all.filter(e => !e.ok).length,
      logOnly:  all.filter(e => e.mode === 'log').length,
      sent:     all.filter(e => e.mode === 'resend' && e.ok).length,
    };
    res.json({ emails: sorted, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/meta-tokens
 * Estado de todos los Meta/Instagram tokens: expira, último refresh, último error.
 * Útil para monitorear salud de integraciones.
 */
router.get('/meta-tokens', async (req, res) => {
  try {
    const accounts = await db.find(db.accounts, {});
    const now = Date.now();
    const report = accounts.map(a => {
      const expiresAt = a.token_expires_at ? new Date(a.token_expires_at) : null;
      const daysLeft  = expiresAt ? Math.ceil((expiresAt.getTime() - now) / 86_400_000) : null;
      return {
        accountId:       a._id,
        ig_username:     a.ig_username || null,
        has_token:       !!a.access_token,
        expires_at:      a.token_expires_at || null,
        days_left:       daysLeft,
        refreshed_at:    a.token_refreshed_at || null,
        last_error:      a.token_last_error || null,
        last_error_at:   a.token_last_error_at || null,
        status:          !a.access_token ? 'no_token'
                         : daysLeft === null ? 'unknown'
                         : daysLeft <= 0 ? 'expired'
                         : daysLeft <= 7 ? 'expiring_soon'
                         : 'healthy',
      };
    });
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/meta-tokens/:accountId/refresh
 * Fuerza un refresh inmediato del token de una cuenta.
 */
router.post('/meta-tokens/:accountId/refresh', async (req, res) => {
  try {
    const account = await db.findOne(db.accounts, { _id: req.params.accountId });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { refreshAccountToken } = require('../services/metaRefresh');
    const result = await refreshAccountToken(account);
    await audit(req, 'meta_token_refresh', account._id, JSON.stringify({ ok: result.ok, error: result.error }));

    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, expiresAt: result.expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/meta-tokens/refresh-all
 * Dispara el sweep completo de refresh.
 */
router.post('/meta-tokens/refresh-all', async (req, res) => {
  try {
    const { refreshAllExpiring } = require('../services/metaRefresh');
    const result = await refreshAllExpiring();
    await audit(req, 'meta_token_sweep', null, JSON.stringify(result));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DISCOUNTS / CUPONES (Lemon Squeezy) ─────────────────────────────────────
// Permite al admin crear, listar y eliminar codigos de descuento via LS API.
// Mercado Pago no tiene API equivalente (su modelo es de planes con precio
// fijo); para descuentos en MP hay que crear un plan alternativo con precio
// reducido manualmente desde su dashboard.

function lsHeaders() {
  const key = process.env.LS_API_KEY;
  if (!key) throw new Error('LS_API_KEY no configurado en Railway');
  return {
    'Authorization':  `Bearer ${key}`,
    'Accept':         'application/vnd.api+json',
    'Content-Type':   'application/vnd.api+json',
  };
}

/**
 * GET /api/admin/discounts
 * Lista los discount codes del store en Lemon Squeezy con stats.
 */
router.get('/discounts', async (req, res) => {
  try {
    if (!process.env.LS_API_KEY) return res.status(400).json({ error: 'LS_API_KEY no configurado' });
    if (!process.env.LS_STORE_ID) return res.status(400).json({ error: 'LS_STORE_ID no configurado' });
    const axios = require('axios');
    const r = await axios.get(
      `https://api.lemonsqueezy.com/v1/discounts?filter[store_id]=${process.env.LS_STORE_ID}&page[size]=100`,
      { headers: lsHeaders() }
    );
    const items = (r.data.data || []).map(d => ({
      id:          d.id,
      name:        d.attributes.name,
      code:        d.attributes.code,
      amount:      d.attributes.amount,
      amount_type: d.attributes.amount_type, // 'percent' | 'fixed'
      duration:    d.attributes.duration,    // 'once' | 'repeating' | 'forever'
      duration_in_months: d.attributes.duration_in_months,
      max_redemptions:    d.attributes.max_redemptions,
      is_limited_redemptions: d.attributes.is_limited_redemptions,
      times_used:  d.attributes.times_used || 0,
      starts_at:   d.attributes.starts_at,
      expires_at:  d.attributes.expires_at,
      status:      d.attributes.status,
    }));
    res.json(items);
  } catch (e) {
    const detail = e.response?.data?.errors?.[0]?.detail || e.response?.data || e.message;
    res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

/**
 * POST /api/admin/discounts
 * Body: { name, code, amount, amount_type: 'percent'|'fixed', duration: 'once'|'repeating'|'forever',
 *         duration_in_months?, max_redemptions?, expires_at? }
 *
 * Si amount_type === 'fixed', amount es en CENTAVOS (LS lo pide así).
 * Ej: 5000 = $50.00 USD off.
 */
router.post('/discounts', async (req, res) => {
  try {
    if (!process.env.LS_API_KEY)  return res.status(400).json({ error: 'LS_API_KEY no configurado' });
    if (!process.env.LS_STORE_ID) return res.status(400).json({ error: 'LS_STORE_ID no configurado' });

    const { name, code, amount, amount_type, duration, duration_in_months, max_redemptions, expires_at } = req.body;
    if (!name || !code || !amount || !amount_type) {
      return res.status(400).json({ error: 'name, code, amount y amount_type requeridos' });
    }
    if (!['percent', 'fixed'].includes(amount_type)) return res.status(400).json({ error: 'amount_type debe ser percent o fixed' });
    if (!['once', 'repeating', 'forever'].includes(duration || 'once')) {
      return res.status(400).json({ error: 'duration debe ser once|repeating|forever' });
    }

    const axios = require('axios');
    const attributes = {
      name:        String(name).slice(0, 80),
      code:        String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24),
      amount:      parseInt(amount),
      amount_type,
      duration:    duration || 'once',
    };
    if (duration === 'repeating' && duration_in_months) {
      attributes.duration_in_months = parseInt(duration_in_months);
    }
    if (max_redemptions) {
      attributes.is_limited_redemptions = true;
      attributes.max_redemptions = parseInt(max_redemptions);
    }
    if (expires_at) attributes.expires_at = new Date(expires_at).toISOString();

    const r = await axios.post(
      'https://api.lemonsqueezy.com/v1/discounts',
      {
        data: {
          type: 'discounts',
          attributes,
          relationships: {
            store: { data: { type: 'stores', id: process.env.LS_STORE_ID } },
          },
        },
      },
      { headers: lsHeaders() }
    );
    await audit(req, 'discount.create', r.data.data.id, { code: attributes.code, amount, amount_type, duration });
    res.json({ ok: true, id: r.data.data.id, code: attributes.code });
  } catch (e) {
    const detail = e.response?.data?.errors?.[0]?.detail || e.response?.data || e.message;
    res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

/**
 * DELETE /api/admin/discounts/:id
 */
router.delete('/discounts/:id', async (req, res) => {
  try {
    if (!process.env.LS_API_KEY) return res.status(400).json({ error: 'LS_API_KEY no configurado' });
    const axios = require('axios');
    await axios.delete(`https://api.lemonsqueezy.com/v1/discounts/${req.params.id}`, { headers: lsHeaders() });
    await audit(req, 'discount.delete', req.params.id, {});
    res.json({ ok: true });
  } catch (e) {
    const detail = e.response?.data?.errors?.[0]?.detail || e.response?.data || e.message;
    res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

/**
 * GET /api/admin/errors?limit=100&kind=request|uncaught|rejection
 * Últimos errores capturados por el errorTracker.
 */
router.get('/errors', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const kind  = req.query.kind || null;
    const all   = await db.find(db.errorLog, {});
    const filtered = kind ? all.filter(e => e.kind === kind) : all;
    const sorted = filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const sliced = sorted.slice(0, limit);

    // Stats agregadas
    const stats = {
      total:      all.length,
      requests:   all.filter(e => e.kind === 'request').length,
      uncaught:   all.filter(e => e.kind === 'uncaught').length,
      rejections: all.filter(e => e.kind === 'rejection').length,
      last24h:    all.filter(e => {
        const t = new Date(e.createdAt || 0).getTime();
        return Date.now() - t < 24 * 3_600_000;
      }).length,
    };

    res.json({ errors: sliced, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/admin/errors
 * Vacía el log de errores (útil después de resolver un incidente).
 */
router.delete('/errors', async (req, res) => {
  try {
    await db.remove(db.errorLog, {});
    await audit(req, 'errors.clear', null, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/funnel
 * Funnel de activación: visitante → registrado → IG → agente personalizado →
 * recibió DM → generó lead HOT → pagando.
 * Sirve para ver donde se pierde la gente y cuanto optimizar cada paso.
 * Con window opcional: ?days=30 (default 30).
 */
router.get('/funnel', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [users, accounts, agents, messages, leads] = await Promise.all([
      db.find(db.users, {}),
      db.find(db.accounts, {}),
      db.find(db.agents, {}),
      db.find(db.messages, {}),
      db.find(db.leads, {}),
    ]);

    // Filtrar solo users no-admin registrados dentro de la ventana
    const cohort = users.filter(u =>
      u.role !== 'admin' &&
      (u.createdAt || '') >= since
    );

    // Indexar por accountId para lookups rápidos
    const accountsById = {};
    for (const a of accounts) accountsById[a._id] = a;

    const agentsByAccount = {};
    for (const a of agents) {
      (agentsByAccount[a.account_id] = agentsByAccount[a.account_id] || []).push(a);
    }

    const messagesCountByAccount = {};
    for (const m of messages) {
      messagesCountByAccount[m.account_id] = (messagesCountByAccount[m.account_id] || 0) + 1;
    }

    const hotLeadsByAccount = {};
    for (const l of leads) {
      if (l.qualification === 'hot') {
        hotLeadsByAccount[l.account_id] = (hotLeadsByAccount[l.account_id] || 0) + 1;
      }
    }

    // Calcular cada etapa
    let registered = 0, connectedIG = 0, customizedAgent = 0, receivedDM = 0, gotHotLead = 0, paying = 0;

    for (const u of cohort) {
      registered++;
      const acc = u.account_id ? accountsById[u.account_id] : null;
      if (!acc) continue;
      if (!acc.ig_user_id) continue;
      connectedIG++;

      // Agente personalizado: tiene algún agente cuya instructions NO sean el placeholder del seed
      const userAgents = agentsByAccount[acc._id] || [];
      const hasCustomAgent = userAgents.some(a =>
        a.instructions &&
        !a.instructions.includes('[Nombre]') &&
        !a.instructions.includes('[Describe')
      );
      if (!hasCustomAgent) continue;
      customizedAgent++;

      if ((messagesCountByAccount[acc._id] || 0) < 1) continue;
      receivedDM++;

      if ((hotLeadsByAccount[acc._id] || 0) < 1) continue;
      gotHotLead++;

      if (u.subscriptionStatus === 'active') paying++;
    }

    const stages = [
      { id: 'registered',       icon: '📝', label: 'Registrados',             count: registered },
      { id: 'connected_ig',     icon: '📸', label: 'Conectaron Instagram',    count: connectedIG },
      { id: 'customized_agent', icon: '🤖', label: 'Personalizaron el agente', count: customizedAgent },
      { id: 'received_dm',      icon: '💬', label: 'Recibieron ≥1 DM',         count: receivedDM },
      { id: 'got_hot_lead',     icon: '🔥', label: 'Generaron un lead HOT',    count: gotHotLead },
      { id: 'paying',           icon: '💰', label: 'Suscripción activa',       count: paying },
    ];

    // Porcentajes: vs top (registrados) y vs paso previo
    const top = registered || 1;
    for (let i = 0; i < stages.length; i++) {
      stages[i].pctOfTop = +((stages[i].count / top) * 100).toFixed(1);
      if (i > 0) {
        const prev = stages[i - 1].count || 1;
        stages[i].pctOfPrev = +((stages[i].count / prev) * 100).toFixed(1);
        stages[i].dropOff = stages[i - 1].count - stages[i].count;
      } else {
        stages[i].pctOfPrev = 100;
        stages[i].dropOff = 0;
      }
    }

    // Identificar el peor cuello de botella (mayor drop-off absoluto)
    const bottleneck = stages.slice(1).reduce((worst, s) =>
      (s.dropOff > (worst?.dropOff || 0) ? s : worst), null);

    const overallConversion = registered > 0
      ? +((paying / registered) * 100).toFixed(2)
      : 0;

    res.json({
      windowDays: days,
      cohortSize: registered,
      stages,
      bottleneck,
      overallConversion,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/seed-sales-preset
 * Body: { accountId }
 * Instala el preset "DMCloser Sales Agent" en la cuenta indicada:
 * agente + knowledge + links + lead magnets para vender el propio SaaS.
 * Dogfooding: que el bot venda a DMCloser para demostrar que vende cualquier cosa.
 * NO pisa lo que ya existe — agrega encima. Si ya aplicaste antes, se duplica,
 * así que hacelo una sola vez por cuenta.
 */
router.post('/seed-sales-preset', async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });

    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' });

    // Anti-duplicado: si ya hay un agente llamado "DMCloser Sales", no volvemos a aplicar
    const existing = await db.findOne(db.agents, { account_id: accountId, name: 'DMCloser Sales' });
    if (existing) return res.status(409).json({
      error: 'El preset ya fue aplicado a esta cuenta',
      agentId: existing._id,
    });

    const { applyDmcloserPreset } = require('../services/dmcloserPreset');
    const result = await applyDmcloserPreset(db, accountId);

    await audit(req, 'seed_sales_preset', accountId, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/reset-and-apply-preset
 * Body: { accountId, confirm: 'YES' }
 *
 * Variante DESTRUCTIVA del seed-sales-preset: borra TODOS los agents,
 * knowledge, links y leadMagnets de la cuenta y luego aplica el preset
 * DMCloser limpio. Útil para cuentas que tenían datos de proyectos
 * viejos (ej: la cuenta de motoniveladora) y querés dejarla 100% como
 * la cuenta de venta de DMCloser sin duplicados.
 *
 * NO toca leads ni mensajes (eso es historia de conversaciones reales).
 *
 * Requiere confirm=YES en el body para evitar accidentes.
 */
router.post('/reset-and-apply-preset', async (req, res) => {
  try {
    const { accountId, confirm } = req.body;
    if (!accountId)        return res.status(400).json({ error: 'accountId requerido' });
    if (confirm !== 'YES') return res.status(400).json({ error: 'Tenés que pasar confirm:"YES" en el body. Esto borra agents, knowledge, links y magnets de la cuenta.' });

    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' });

    // Contar antes para reportar
    const before = {
      agents:    await db.count(db.agents,    { account_id: accountId }),
      knowledge: await db.count(db.knowledge, { account_id: accountId }),
      links:     await db.count(db.links,     { account_id: accountId }),
      magnets:   await db.count(db.leadMagnets,{ account_id: accountId }),
    };

    // Wipe (mantiene leads + messages + cuenta IG + settings)
    await db.remove(db.agents,      { account_id: accountId });
    await db.remove(db.knowledge,   { account_id: accountId });
    await db.remove(db.links,       { account_id: accountId });
    await db.remove(db.leadMagnets, { account_id: accountId });

    const { applyDmcloserPreset } = require('../services/dmcloserPreset');
    const result = await applyDmcloserPreset(db, accountId);

    await audit(req, 'reset_and_apply_preset', accountId, { before, applied: result.created });
    res.json({ ok: true, removed: before, applied: result.created, agentId: result.agentId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/admin/backup
 * Descarga TODOS los datos de la app como JSON (un objeto con cada colección).
 * Útil para:
 *  - Hacer backup manual antes de un cambio crítico
 *  - Migrar entre entornos (dev → prod, prod → otro Railway)
 *  - Auditoría / cumplimiento
 *
 * Devuelve un archivo descargable con timestamp en el nombre.
 */
router.get('/backup', async (req, res) => {
  try {
    const collections = [
      'accounts','agents','knowledge','links','leads','messages','bypassed',
      'settings','users','inviteCodes','aiUsage','auditLog','followups',
      'magnetLinks','linkClicks','emailLog','leadMagnets','magnetDeliveries',
      'errorLog','referrals','quickReplies',
    ];
    const out = { _meta: { exportedAt: new Date().toISOString(), version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0,7) || 'unknown' } };
    for (const name of collections) {
      if (!db[name]) continue;
      out[name] = await db.find(db[name], {});
    }
    await audit(req, 'db.backup', null, { collections: collections.length });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dmcloser-backup-${stamp}.json"`);
    res.send(JSON.stringify(out, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/restore
 * Body: el JSON producido por /backup, más { confirm: 'YES' }.
 *
 * DESTRUCTIVO: borra el contenido actual de cada colección y carga lo del JSON.
 * Saltea colecciones que no estén en el JSON (no las toca).
 */
router.post('/restore', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (body.confirm !== 'YES') {
      return res.status(400).json({ error: 'Pasá { confirm: "YES" } en el body. Esto sobreescribe la DB.' });
    }
    const collections = Object.keys(body).filter(k => k !== 'confirm' && k !== '_meta');
    const stats = {};
    for (const name of collections) {
      if (!db[name] || !Array.isArray(body[name])) continue;
      await db.remove(db[name], {});
      let inserted = 0;
      for (const doc of body[name]) {
        // Preservamos _id original
        await new Promise((res, rej) => db[name].insert(doc, (e) => e ? rej(e) : res()));
        inserted++;
      }
      stats[name] = inserted;
    }
    await audit(req, 'db.restore', null, { stats });
    res.json({ ok: true, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
