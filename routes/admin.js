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
    res.json({ ok: true, isActive: !code.isActive });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/admin/codes/:id
 * Elimina un código de invitación.
 */
router.delete('/codes/:id', async (req, res) => {
  try {
    await db.remove(db.inviteCodes, { _id: req.params.id });
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
    const { ig_user_id } = req.body;
    if (!ig_user_id) return res.status(400).json({ error: 'ig_user_id requerido' });
    const account = await db.findOne(db.accounts, { _id: req.params.id });
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' });
    await db.update(db.accounts, { _id: req.params.id }, { ig_user_id });
    res.json({ ok: true, accountId: req.params.id, ig_user_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
