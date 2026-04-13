/**
 * AutoSetter — Security Middleware
 * Protección contra: XSS, rate limiting, headers inseguros, payloads grandes
 */

const rateLimit = require('express-rate-limit');
const xss       = require('xss');

// ── Rate Limiters ─────────────────────────────────────────────────────────────

/** Login y registro: máx 10 intentos por 15 min por IP */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** API general: máx 100 peticiones por minuto por IP */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Webhook Meta: más permisivo (mensajes en ráfaga) */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Webhook rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── XSS Sanitizer ─────────────────────────────────────────────────────────────
/**
 * Sanitiza recursivamente strings en req.body para prevenir XSS
 */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj) {
  if (typeof obj === 'string') return xss(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj && typeof obj === 'object') {
    const clean = {};
    for (const key of Object.keys(obj)) {
      // No sanitizar el campo 'password' (bcrypt maneja su propio hashing)
      if (key === 'password') {
        clean[key] = obj[key];
      } else {
        clean[key] = sanitizeObject(obj[key]);
      }
    }
    return clean;
  }
  return obj;
}

// ── Prevent Parameter Pollution ───────────────────────────────────────────────
/**
 * Si algún query param tiene múltiples valores (array), quedarse con el último
 */
function preventParamPollution(req, res, next) {
  for (const key of Object.keys(req.query)) {
    if (Array.isArray(req.query[key])) {
      req.query[key] = req.query[key][req.query[key].length - 1];
    }
  }
  next();
}

// ── Block Suspicious User-Agents ──────────────────────────────────────────────
const BLOCKED_UA_PATTERNS = [
  /sqlmap/i, /nikto/i, /masscan/i, /nmap/i, /dirbuster/i,
  /zgrab/i, /python-requests\/2\.[0-4]/i, /go-http-client\/1\.1/i,
];

function blockSuspiciousAgents(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  for (const pattern of BLOCKED_UA_PATTERNS) {
    if (pattern.test(ua)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
}

// ── Block Common Attack Paths ──────────────────────────────────────────────────
const BLOCKED_PATHS = [
  '/wp-admin', '/wp-login', '/.env', '/config.php', '/phpmyadmin',
  '/admin.php', '/xmlrpc.php', '/.git', '/etc/passwd', '/shell',
  '/cmd', '/setup.php', '/install.php',
];

function blockAttackPaths(req, res, next) {
  const p = req.path.toLowerCase();
  for (const blocked of BLOCKED_PATHS) {
    if (p.startsWith(blocked)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }
  next();
}

module.exports = {
  authLimiter,
  apiLimiter,
  webhookLimiter,
  sanitizeBody,
  preventParamPollution,
  blockSuspiciousAgents,
  blockAttackPaths,
};
