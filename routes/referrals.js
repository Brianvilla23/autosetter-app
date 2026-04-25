/**
 * DMCloser — Referrals
 *
 * Programa de referidos: cada usuario tiene un código único (ej "MARIA-K3X9")
 * y un link de invitación. Cuando alguien se registra con ese código y luego
 * paga (subscription activa por 7+ días para anti-abuso), el referidor recibe
 * crédito = 30 días extra agregados a su membershipExpiresAt.
 *
 * Endpoints:
 *   GET  /api/referrals/me                       — código + stats
 *   GET  /api/referrals/list                     — leads referidos del user actual
 *   POST /api/referrals/track-click  (público)   — incrementa visit count
 *
 * El registro de la asociación user-nuevo ↔ referidor se hace en userAuth.js
 * cuando llega el body con referralCode. La aplicación del crédito se hace
 * en los webhooks de billing cuando subscription_status pasa a 'active'.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

/**
 * Genera un código único para un usuario (ej: BRAYAN-A3K9).
 * Toma el primer nombre del user y agrega 4 chars random (anti-colisión simple).
 */
function generateCode(user) {
  const base = (user.name || user.email || 'user')
    .split(/[\s@]/)[0]
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin tildes
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toUpperCase() || 'USER';
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}-${suffix}`;
}

async function ensureUserCode(userId) {
  const user = await db.findOne(db.users, { _id: userId });
  if (!user) return null;
  if (user.referralCode) return user.referralCode;

  // Generar y reintentar si colisiona
  for (let i = 0; i < 5; i++) {
    const code = generateCode(user);
    const existing = await db.findOne(db.users, { referralCode: code });
    if (!existing) {
      await db.update(db.users, { _id: userId }, { referralCode: code });
      return code;
    }
  }
  // Fallback: usar parte del UUID
  const fallback = `USER-${userId.slice(0, 6).toUpperCase()}`;
  await db.update(db.users, { _id: userId }, { referralCode: fallback });
  return fallback;
}

/**
 * GET /api/referrals/me
 * Devuelve el código del user, su link de invitación, y stats agregadas.
 */
router.get('/me', async (req, res) => {
  try {
    const code = await ensureUserCode(req.user.userId);
    if (!code) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = await db.findOne(db.users, { _id: req.user.userId });
    const refs = await db.find(db.referrals, { referrer_id: req.user.userId });

    const stats = {
      clicks:     refs.filter(r => r.kind === 'click').length,
      registered: refs.filter(r => r.kind === 'registered' || r.kind === 'paid').length,
      paid:       refs.filter(r => r.kind === 'paid').length,
      creditDays: refs.filter(r => r.kind === 'paid').reduce((sum, r) => sum + (r.credit_days || 0), 0),
    };

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const inviteUrl = `${baseUrl}/?ref=${encodeURIComponent(code)}`;

    res.json({
      code,
      inviteUrl,
      stats,
      // Cuánto crédito da por cada referido pagado: 5 referidos = 15 días → 3 días por referido
      creditDaysPerReferral: 3,
      // Si el user ya recibió algún crédito y aún tiene tiempo, le mostramos hasta cuándo
      currentExpiresAt: user.membershipExpiresAt || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/referrals/list
 * Lista de personas que el user invitó, con su status.
 */
router.get('/list', async (req, res) => {
  try {
    const refs = await db.find(db.referrals, { referrer_id: req.user.userId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Hidratar con info del user referido (sin datos sensibles)
    const out = [];
    for (const r of refs) {
      let referredInfo = null;
      if (r.referred_user_id) {
        const u = await db.findOne(db.users, { _id: r.referred_user_id });
        if (u) {
          referredInfo = {
            name:  u.name || null,
            // Email parcialmente ofuscado para no exponer contactos del referido
            email: u.email ? u.email.replace(/^(.).+(.@.+)$/, '$1***$2') : null,
            plan:  u.membershipPlan,
            joinedAt: u.createdAt,
          };
        }
      }
      out.push({
        id:           r._id,
        kind:         r.kind,
        creditDays:   r.credit_days || 0,
        creditAppliedAt: r.credit_applied_at || null,
        referred:     referredInfo,
        createdAt:    r.createdAt,
      });
    }

    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/referrals/track-click  (público — montado fuera del auth)
 * Body: { code }
 * Incrementa el contador de clicks de un código. Idempotente por IP/sessión simple.
 */
async function trackClick(req, res) {
  try {
    const code = String(req.body.code || req.query.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code requerido' });

    const referrer = await db.findOne(db.users, { referralCode: code });
    if (!referrer) return res.status(404).json({ error: 'Código no válido' });

    // Para evitar inflar stats con bots: registramos máximo 1 click por IP cada 24h
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const recent = ip ? await db.findOne(db.referrals, {
      referrer_id: referrer._id,
      kind: 'click',
      ip,
      createdAt: { $gte: since },
    }).catch(() => null) : null;

    if (!recent) {
      await db.insert(db.referrals, {
        referrer_id: referrer._id,
        kind:        'click',
        ip,
        userAgent:   (req.headers['user-agent'] || '').slice(0, 200),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
router.post('/track-click', trackClick);

module.exports = router;
module.exports.ensureUserCode = ensureUserCode;
module.exports.trackClick = trackClick;
