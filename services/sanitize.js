/**
 * Atinov — Sanitización de secrets antes de enviar al cliente
 *
 * SEGURIDAD: ninguna API key, token de acceso ni secret debe viajar al
 * browser. Estas funciones quitan/enmascaran esos campos antes de cualquier
 * res.json(). Están en un módulo aparte para poder testearlas aisladamente
 * (test/security.test.js) y reusarlas en cualquier endpoint que devuelva
 * un account o settings.
 *
 * Regla de oro: si agregás un campo sensible nuevo a `account` o `settings`
 * (ej un nuevo *_token o *_secret), agregalo a la lista de SENSITIVE_*.
 */

// Campos del account que NUNCA deben salir al cliente.
const SENSITIVE_ACCOUNT_FIELDS = [
  'access_token',       // token de Meta/Instagram (permite enviar DMs como el user)
  'wa_access_token',    // token de WhatsApp Cloud API
  'wa_business_token',  // por si se agrega
  'fb_page_token',      // Page Access Token de Messenger (permite enviar como la Página)
  'token_last_error',   // puede contener fragmentos del token en el mensaje de error
];

// Campos de settings que NUNCA deben salir crudos.
const SENSITIVE_SETTINGS_FIELDS = [
  'openai_key',         // API key de OpenAI del user (permite gastar su cuota)
];

/** Enmascara un secret dejando ver prefijo + últimos 4 (ej "sk-pr…wXyZ"). */
function maskSecret(s) {
  if (!s || typeof s !== 'string') return null;
  if (s.length <= 10) return '••••';
  return s.slice(0, 5) + '…' + s.slice(-4);
}

/**
 * Quita campos sensibles del account; expone solo flags de presencia.
 * El frontend solo necesita saber SI hay token (para mostrar "conectado").
 */
function sanitizeAccount(account) {
  if (!account) return null;
  const safe = {};
  for (const key of Object.keys(account)) {
    if (SENSITIVE_ACCOUNT_FIELDS.includes(key)) continue; // omitir
    safe[key] = account[key];
  }
  safe.id = account._id;
  safe.has_access_token    = !!account.access_token;
  safe.has_wa_access_token = !!account.wa_access_token;
  safe.has_fb_page_token   = !!account.fb_page_token;
  return safe;
}

/**
 * Quita la openai_key cruda; expone flag + masked para mostrar en UI.
 */
function sanitizeSettings(settings) {
  if (!settings) return null;
  const safe = {};
  for (const key of Object.keys(settings)) {
    if (SENSITIVE_SETTINGS_FIELDS.includes(key)) continue; // omitir
    safe[key] = settings[key];
  }
  safe.has_openai_key    = !!settings.openai_key;
  safe.openai_key_masked = maskSecret(settings.openai_key);
  return safe;
}

module.exports = {
  maskSecret,
  sanitizeAccount,
  sanitizeSettings,
  SENSITIVE_ACCOUNT_FIELDS,
  SENSITIVE_SETTINGS_FIELDS,
};
