/**
 * DMCloser — Error Tracker (sin dependencias externas)
 *
 * Sistema homebrew para capturar errores 5xx + uncaughtException +
 * unhandledRejection. Persiste a db.errorLog (NeDB) y los expone al
 * panel admin. No depende de Sentry ni servicios externos: para un SaaS
 * de este tamaño, es más simple operacionalmente.
 *
 * Uso:
 *   const { errorTracker, captureError, installProcessHandlers } = require('./middleware/errorTracker');
 *   installProcessHandlers();          // una vez al boot
 *   // ... rutas ...
 *   app.use(errorTracker);             // último middleware
 */

const db = require('../db/database');

// Limita el growth descontrolado del log: max 5000 errores, se rota.
const MAX_LOG_SIZE = 5000;
const LOG_TRIM_TARGET = 4000;

let lastTrimAt = 0;

async function captureError({ err, req = null, kind = 'request', extra = {} }) {
  try {
    const safeMsg = String(err?.message || err || 'unknown error').slice(0, 1000);
    const stack = String(err?.stack || '').slice(0, 4000);
    const code  = err?.code || err?.status || null;

    const doc = {
      kind,                                    // 'request' | 'uncaught' | 'rejection' | 'manual'
      message: safeMsg,
      stack,
      code,
      method:    req?.method  || null,
      url:       req?.originalUrl || req?.url || null,
      userId:    req?.user?.userId  || null,
      userEmail: req?.user?.email   || null,
      accountId: req?.user?.accountId || null,
      ip:        req?.ip || (req?.headers?.['x-forwarded-for'] || '').split(',')[0] || null,
      userAgent: (req?.headers?.['user-agent'] || '').slice(0, 200),
      extra:     extra && typeof extra === 'object' ? JSON.stringify(extra).slice(0, 1000) : null,
    };

    await db.insert(db.errorLog, doc);

    // Trim periódico (no en cada error, máximo cada 10 min)
    const now = Date.now();
    if (now - lastTrimAt > 10 * 60 * 1000) {
      lastTrimAt = now;
      trimErrorLog().catch(() => null);
    }
  } catch (e) {
    // Si falla el log, no podemos hacer nada — no queremos cascadas
    console.error('[errorTracker] failed to persist:', e.message);
  }
}

async function trimErrorLog() {
  const all = await db.find(db.errorLog, {});
  if (all.length <= MAX_LOG_SIZE) return;
  const sorted = all.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const toDelete = sorted.slice(0, all.length - LOG_TRIM_TARGET);
  for (const d of toDelete) {
    await db.remove(db.errorLog, { _id: d._id }).catch(() => null);
  }
  console.log(`[errorTracker] trimmed ${toDelete.length} old errors`);
}

/**
 * Express middleware (4 args = error handler).
 * Loguea + responde JSON. Si la respuesta ya fue enviada, delega al default.
 */
function errorTracker(err, req, res, next) {
  // Solo persistimos errores serios (5xx). Los 4xx ya son del cliente.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    captureError({ err, req, kind: 'request' }).catch(() => null);
    console.error(`[5xx] ${req.method} ${req.originalUrl}:`, err.message);
  }

  if (res.headersSent) return next(err);

  res.status(status).json({
    error: status >= 500 ? 'Error interno del servidor' : (err.message || 'Error'),
    ...(process.env.NODE_ENV !== 'production' ? { detail: err.message, stack: err.stack } : {}),
  });
}

/**
 * Captura crashes que no pasan por Express (workers, async sin handler, etc).
 * Llamar UNA sola vez al boot. NO mata el proceso — preferimos seguir corriendo
 * con un error logueado que un crash silencioso que reinicie Railway.
 */
function installProcessHandlers() {
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    captureError({ err, kind: 'uncaught' }).catch(() => null);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureError({ err, kind: 'rejection' }).catch(() => null);
  });

  console.log('🛡️  Error tracker: process handlers installed');
}

module.exports = { errorTracker, captureError, installProcessHandlers };
