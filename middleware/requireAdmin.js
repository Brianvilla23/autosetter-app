const jwt     = require('jsonwebtoken');
const { SECRET } = require('./authMiddleware');

/**
 * Middleware: solo admins pueden pasar.
 * Requiere Authorization: Bearer <token> con role === 'admin'.
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso restringido a administradores' });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = { requireAdmin };
