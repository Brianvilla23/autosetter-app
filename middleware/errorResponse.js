/**
 * DMCloser — Error Response Middleware
 *
 * Sanitiza errores antes de devolverlos al cliente. En producción nunca
 * exponemos `err.message` ni stack — solo "Internal error" + status code.
 * En dev devolvemos todo para facilitar debugging.
 *
 * Se registra DESPUÉS de errorTracker (que persiste el error en DB) para
 * que ambos hagan su trabajo. errorTracker ya hace `res.status().json(...)`
 * con sanitización, por eso este middleware actúa como fallback /
 * compatibilidad cuando rutas hacen `next(e)` y queremos sanitización
 * explícita y centralizada.
 */
module.exports = function errorResponse(err, req, res, next) {
  // Si la respuesta ya fue enviada (errorTracker la mandó), no tocamos.
  if (res.headersSent) return next(err);

  console.error('[ERROR]', req.method, req.path, err?.message || err);

  const status = err?.status || err?.statusCode || 500;

  if (process.env.NODE_ENV === 'production') {
    return res.status(status).json({
      error: status >= 500 ? 'Internal error' : (err.message || 'Error'),
    });
  }
  return res.status(status).json({
    error: err?.message || 'Error',
    stack: err?.stack,
  });
};
