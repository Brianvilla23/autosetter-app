/**
 * Atinov — Bandeja unificada (Tarea 3)
 *
 * Un lead que llega por Instagram y sigue por WhatsApp hoy serían dos leads
 * separados. Este módulo los unifica en UNO solo con múltiples identidades
 * (`lead.identities[]`) y un único hilo de mensajes, sin perder contexto.
 *
 * Estrategia de matching:
 *  - Manual: el humano vincula dos leads desde el inbox (botón "es el mismo").
 *  - Automática (sugerencia): mismo email o teléfono capturado → candidato.
 *
 * El merge es conservador: NO borra datos, mueve mensajes y combina campos.
 */

const db = require('../../db/database');
const { identityOf } = require('./core');

/** Normaliza teléfono/email para comparar. */
function normPhone(p) { return String(p || '').replace(/[^0-9]/g, ''); }
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

/**
 * Fusiona dos leads en uno. `primaryId` se queda; `secondaryId` se absorbe.
 * Mueve mensajes, combina identities + campos, borra el secundario.
 * Valida que ambos pertenezcan al mismo account.
 *
 * @returns {{ ok: boolean, primary?: Object, error?: string }}
 */
async function mergeLeads(accountId, primaryId, secondaryId) {
  if (primaryId === secondaryId) return { ok: false, error: 'same_lead' };
  const primary   = await db.findOne(db.leads, { _id: primaryId });
  const secondary = await db.findOne(db.leads, { _id: secondaryId });
  if (!primary || !secondary) return { ok: false, error: 'not_found' };
  if (primary.account_id !== accountId || secondary.account_id !== accountId) {
    return { ok: false, error: 'forbidden' };
  }

  // 1) Mover mensajes del secundario al primario
  const secMsgs = await db.find(db.messages, { lead_id: secondaryId });
  for (const m of secMsgs) {
    await db.update(db.messages, { _id: m._id }, { lead_id: primaryId });
  }

  // 2) Combinar identities (sin duplicar canal)
  const identities = Array.isArray(primary.identities) && primary.identities.length
    ? primary.identities.slice()
    : [identityOf(primary)];
  const secIdentity = identityOf(secondary);
  if (!identities.some(i => i.channel === secIdentity.channel && i.id === secIdentity.id)) {
    identities.push(secIdentity);
  }

  // 3) Combinar campos: el primario gana, pero rellena huecos con el secundario
  const upd = {
    identities,
    email:        primary.email || secondary.email || undefined,
    phone:        primary.phone || secondary.phone || undefined,
    contact_name: primary.contact_name || secondary.contact_name || undefined,
    wa_id:        primary.wa_id || secondary.wa_id || undefined,
    wa_name:      primary.wa_name || secondary.wa_name || undefined,
    tags:         Array.from(new Set([...(primary.tags || []), ...(secondary.tags || [])])).slice(0, 20),
    // si alguno tiene mayor deal_value, conservar el mayor
    deal_value:   Math.max(Number(primary.deal_value || 0), Number(secondary.deal_value || 0)) || undefined,
    last_message_at: [primary.last_message_at, secondary.last_message_at].filter(Boolean).sort().pop(),
  };
  // Limpiar undefined (NeDB no debería guardar undefined)
  Object.keys(upd).forEach(k => upd[k] === undefined && delete upd[k]);
  await db.update(db.leads, { _id: primaryId }, upd);

  // 4) Borrar el secundario (sus mensajes ya se movieron)
  await db.remove(db.leads, { _id: secondaryId });

  const merged = await db.findOne(db.leads, { _id: primaryId });
  return { ok: true, primary: merged };
}

/**
 * Sugiere candidatos a fusión: leads del mismo account, distinto canal, que
 * comparten email o teléfono. No fusiona — solo propone (el humano confirma).
 * @returns {Array<{ a: string, b: string, reason: string }>}
 */
async function suggestMerges(accountId) {
  const leads = await db.find(db.leads, { account_id: accountId });
  const suggestions = [];
  for (let i = 0; i < leads.length; i++) {
    for (let j = i + 1; j < leads.length; j++) {
      const a = leads[i], b = leads[j];
      if ((a.channel || 'instagram') === (b.channel || 'instagram')) continue; // distinto canal
      let reason = null;
      if (a.email && b.email && normEmail(a.email) === normEmail(b.email)) reason = 'mismo email';
      else if (a.phone && b.phone && normPhone(a.phone) === normPhone(b.phone) && normPhone(a.phone).length >= 8) reason = 'mismo teléfono';
      else if (a.wa_id && normPhone(a.wa_id) === normPhone(b.phone)) reason = 'wa_id = teléfono';
      else if (b.wa_id && normPhone(b.wa_id) === normPhone(a.phone)) reason = 'wa_id = teléfono';
      if (reason) suggestions.push({ a: a._id, b: b._id, reason });
    }
  }
  return suggestions.slice(0, 50);
}

module.exports = { mergeLeads, suggestMerges, identityOf };
