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

/**
 * Voz (OpenAI Realtime): cada sesión cuesta plata REAL de la key de la
 * plataforma y no tiene tope natural de duración. El límite general de 100/min
 * es absurdo acá: 100 sesiones concurrentes de audio arruinan la factura.
 * Máx 8 sesiones por hora por IP.
 */
const voiceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: { error: 'Alcanzaste el límite de sesiones de voz por hora. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Análisis LLM bajo demanda (subir conversaciones al mejorador de prompts):
 * cada análisis manda ~14k caracteres a OpenAI con la key de la plataforma.
 * El límite general de 100/min dejaría quemar 100 análisis en un minuto.
 * Máx 6 por hora por IP; el tope diario por cuenta vive en la ruta.
 */
const analysisLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: { error: 'Alcanzaste el límite de análisis por hora. Intenta más tarde.' },
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
      // No sanitizar campos de credenciales: xss() escaparía < > & y el
      // valor guardado/comparado ya no sería el que el usuario escribió
      // (ej: reset-password hashearía "Pass&lt;word" y el login con
      // "Pass<word" fallaría para siempre — lockout).
      if (key === 'password' || key === 'newPassword' || key === 'currentPassword' || key === 'token' || key === 'secret' || key === 'shopify_webhook_secret') {
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
  voiceLimiter,
  analysisLimiter,
  webhookLimiter,
  sanitizeBody,
  preventParamPollution,
  blockSuspiciousAgents,
  blockAttackPaths,
};
