const jwt = require('jsonwebtoken');

// ── JWT SECRET ────────────────────────────────────────────────────────────────
// En producción, JWT_SECRET DEBE estar configurado y ser fuerte (>=32 chars).
// En dev permitimos fallback con warning ruidoso.
const DEFAULT_DEV_SECRET = 'autosetter_jwt_secret_2024';
const isProd = process.env.NODE_ENV === 'production';
const envSecret = process.env.JWT_SECRET || '';

if (isProd) {
  if (!envSecret) {
    console.error('❌ FATAL: JWT_SECRET no está definido en producción. Configúralo en Railway/Vercel.');
    process.exit(1);
  }
  if (envSecret.length < 32) {
    console.error('❌ FATAL: JWT_SECRET debe tener al menos 32 caracteres en producción.');
    process.exit(1);
  }
  if (envSecret === DEFAULT_DEV_SECRET) {
    console.error('❌ FATAL: JWT_SECRET no puede ser el valor por defecto en producción.');
    process.exit(1);
  }
}

const SECRET = envSecret || DEFAULT_DEV_SECRET;

if (!envSecret) {
  console.warn('⚠️  JWT_SECRET no configurado — usando default DEV. NO USAR EN PRODUCCIÓN.');
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = { requireAuth, SECRET };
