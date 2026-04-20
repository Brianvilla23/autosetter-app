const db = require('../db/database');

/**
 * Middleware that blocks expired trial/subscription users.
 * Admins always pass through.
 * Returns 402 with { error, expired: true } when access is denied.
 */
module.exports = async function checkSubscription(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });

    // Admins bypass subscription checks
    if (req.user.role === 'admin') return next();

    const user = await db.findOne(db.users, { _id: req.user.userId });
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    if (user.isActive === false) {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' });
    }

    if (user.membershipExpiresAt && new Date(user.membershipExpiresAt) < new Date()) {
      return res.status(402).json({
        error:   'Tu período de prueba ha expirado. Actualiza tu plan para continuar.',
        expired: true,
      });
    }

    next();
  } catch (e) {
    console.error('checkSubscription error:', e.message);
    next(); // Don't block on unexpected errors
  }
};
