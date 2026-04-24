/**
 * Meta / Instagram Access Token Refresh
 *
 * Los long-lived tokens de Instagram Business Login duran ~60 días.
 * Meta permite extenderlos vía /refresh_access_token si tienen al menos 24h
 * de vida — el token nuevo dura otros 60 días desde el refresh.
 *
 * Este worker revisa periódicamente todas las cuentas y renueva aquellas
 * con tokens que vencen en menos de `REFRESH_THRESHOLD_DAYS` días.
 *
 * Así los clientes NUNCA tienen que re-loguearse, siempre que la app corra
 * al menos una vez cada ~50 días (muy holgado vs el límite de 60).
 *
 * Referencia:
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#refresh-a-long-lived-token
 */

const axios = require('axios');
const db    = require('../db/database');

const IG_BASE = 'https://graph.instagram.com';

// Renovar cuando falten <= N días para caducar
const REFRESH_THRESHOLD_DAYS = parseInt(process.env.META_REFRESH_THRESHOLD_DAYS || '10', 10);

// No intentar refresh si el token fue renovado hace < N horas (evita spam a la API)
const REFRESH_COOLDOWN_HOURS = 20;

/**
 * Intenta renovar el token de una cuenta puntual.
 * Devuelve { ok, token?, expiresAt?, error? }.
 */
async function refreshAccountToken(account) {
  try {
    if (!account.access_token) {
      return { ok: false, error: 'no_token' };
    }

    // Cooldown: no refrescar si ya se renovó hace poco
    if (account.token_refreshed_at) {
      const hoursSinceRefresh = (Date.now() - new Date(account.token_refreshed_at).getTime()) / 3_600_000;
      if (hoursSinceRefresh < REFRESH_COOLDOWN_HOURS) {
        return { ok: false, error: 'cooldown' };
      }
    }

    const resp = await axios.get(`${IG_BASE}/refresh_access_token`, {
      params: {
        grant_type:   'ig_refresh_token',
        access_token: account.access_token,
      },
      timeout: 15_000,
    });

    const newToken     = resp.data.access_token;
    const expiresInSec = resp.data.expires_in || 60 * 24 * 3600; // default 60d
    const newExpiry    = new Date(Date.now() + expiresInSec * 1000).toISOString();

    await db.update(db.accounts, { _id: account._id }, {
      access_token:       newToken,
      token_expires_at:   newExpiry,
      token_refreshed_at: new Date().toISOString(),
      token_last_error:   null,
    });

    const daysLeft = Math.round(expiresInSec / 86400);
    console.log(`🔄 META token renovado — @${account.ig_username || account._id} (caduca en ${daysLeft}d)`);
    return { ok: true, token: newToken, expiresAt: newExpiry };
  } catch (e) {
    const apiErr = e.response?.data?.error;
    const msg    = apiErr?.message || e.message;
    const code   = apiErr?.code;

    // Guardar último error para diagnóstico desde admin
    await db.update(db.accounts, { _id: account._id }, {
      token_last_error:    `${code || 'net'}: ${String(msg).slice(0, 200)}`,
      token_last_error_at: new Date().toISOString(),
    }).catch(() => null);

    // Code 190 = token inválido/expirado (ya no refrescable). El cliente debe re-autenticar.
    // Code 100 = parámetro inválido. Código 10 = permiso faltante.
    console.error(`⚠️  META refresh fallido — @${account.ig_username || account._id}: [${code || 'net'}] ${msg}`);
    return { ok: false, error: msg, code };
  }
}

/**
 * Recorre todas las cuentas y renueva las que estén cerca de caducar.
 * Corre cada N horas desde el server.js.
 */
async function refreshAllExpiring() {
  try {
    const accounts = await db.find(db.accounts, {});
    if (!accounts.length) return { checked: 0, refreshed: 0, failed: 0 };

    const thresholdMs = REFRESH_THRESHOLD_DAYS * 24 * 3_600_000;
    const now         = Date.now();
    let refreshed = 0, failed = 0, skipped = 0, backfilled = 0;

    // Backfill: cuentas con token pero sin expires_at conocido.
    // Asumimos que si el token funciona hoy, dura al menos 30d más
    // (estimación conservadora; el próximo refresh lo ajusta al valor real).
    for (const acc of accounts) {
      if (acc.access_token && !acc.token_expires_at) {
        const estimated = new Date(now + 30 * 24 * 3_600_000).toISOString();
        await db.update(db.accounts, { _id: acc._id }, {
          token_expires_at: estimated,
        }).catch(() => null);
        acc.token_expires_at = estimated;
        backfilled++;
        console.log(`ℹ️  Backfill token_expires_at para @${acc.ig_username || acc._id} → ${estimated}`);
      }
    }

    for (const acc of accounts) {
      if (!acc.access_token) { skipped++; continue; }

      // Si no tenemos expiry registrado, asumir que puede estar cerca y refrescar
      // (modo seguro para cuentas viejas creadas antes de este worker).
      const expiresAt = acc.token_expires_at ? new Date(acc.token_expires_at).getTime() : 0;
      const msLeft    = expiresAt - now;
      const needsRefresh = !acc.token_expires_at || msLeft < thresholdMs;

      if (!needsRefresh) { skipped++; continue; }

      const result = await refreshAccountToken(acc);
      if (result.ok) refreshed++;
      else if (result.error !== 'cooldown') failed++;
      else skipped++;
    }

    if (refreshed || failed || backfilled) {
      console.log(`🔄 META refresh sweep: ${refreshed} renovados, ${failed} fallidos, ${skipped} omitidos, ${backfilled} backfilled (de ${accounts.length} cuentas)`);
    }
    return { checked: accounts.length, refreshed, failed, skipped, backfilled };
  } catch (e) {
    console.error('refreshAllExpiring error:', e.message);
    return { error: e.message };
  }
}

/**
 * Si un envío falla con OAuth error code 190, intentar refresh inmediato
 * y reintentar una vez. Se llama desde meta.js ante errores 190.
 */
async function tryRefreshOnOAuthError(account) {
  console.log(`⚠️  Token OAuth error para @${account.ig_username} — intentando refresh inmediato`);
  const result = await refreshAccountToken(account);
  if (result.ok) {
    console.log(`✅ Token refrescado en caliente — @${account.ig_username}`);
    return result.token;
  }
  console.error(`❌ Refresh en caliente falló — @${account.ig_username}. Cliente debe re-autenticar.`);
  return null;
}

module.exports = {
  refreshAccountToken,
  refreshAllExpiring,
  tryRefreshOnOAuthError,
};
