const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const crypto  = require('crypto');
const db      = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');

// ─────────────────────────────────────────────────────────────────────────────
// LEMON SQUEEZY helpers
// ─────────────────────────────────────────────────────────────────────────────
function lsHeaders() {
  const key = process.env.LS_API_KEY;
  if (!key) throw new Error('LS_API_KEY no configurado en Railway');
  return {
    'Authorization':  `Bearer ${key}`,
    'Accept':         'application/vnd.api+json',
    'Content-Type':   'application/vnd.api+json',
  };
}

const LS_VARIANTS = {
  starter: () => process.env.LS_VARIANT_STARTER,
  pro:     () => process.env.LS_VARIANT_PRO,
  agency:  () => process.env.LS_VARIANT_AGENCY,
};

// ─────────────────────────────────────────────────────────────────────────────
// MERCADO PAGO helpers
// ─────────────────────────────────────────────────────────────────────────────
function mpHeaders() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN no configurado en Railway');
  return {
    'Authorization':   `Bearer ${token}`,
    'Content-Type':    'application/json',
    'X-Idempotency-Key': crypto.randomUUID(),
  };
}

const MP_PLANS = {
  starter: () => process.env.MP_PLAN_STARTER,
  pro:     () => process.env.MP_PLAN_PRO,
  agency:  () => process.env.MP_PLAN_AGENCY,
};

// CLP prices (configurable via env; defaults are ~USD equivalent)
const MP_CLP = {
  starter: () => parseInt(process.env.MP_PRICE_STARTER_CLP || '180000'),
  pro:     () => parseInt(process.env.MP_PRICE_PRO_CLP     || '270000'),
  agency:  () => parseInt(process.env.MP_PRICE_AGENCY_CLP  || '450000'),
};

const PLAN_NAMES = { starter: 'Starter', pro: 'Pro', agency: 'Agency' };

// ─────────────────────────────────────────────────────────────────────────────
// Shared logic: activate subscription in DB
// ─────────────────────────────────────────────────────────────────────────────
async function activateSubscription(userId, plan, provider, extra = {}) {
  const user = await db.findOne(db.users, { _id: userId });
  const wasNotActiveBefore = !user || user.subscriptionStatus !== 'active';

  const exp = new Date();
  exp.setMonth(exp.getMonth() + 1);
  await db.update(db.users, { _id: userId }, {
    membershipPlan:      plan,
    membershipExpiresAt: exp.toISOString(),
    subscriptionStatus:  'active',
    paymentProvider:     provider,
    ...extra,
  });
  console.log(`✅ ${provider.toUpperCase()}: suscripción activada — usuario ${userId} (${plan})`);

  // ── REFERRAL REWARD ────────────────────────────────────────────────────
  // Si este user fue referido por otro Y es la primera vez que activa
  // suscripción, recompensar al referidor con 30 días extra.
  // Anti-abuso: la recompensa solo se da UNA VEZ por referido.
  if (wasNotActiveBefore && user && user.referredBy) {
    try {
      const existingReward = await db.findOne(db.referrals, {
        referrer_id:      user.referredBy,
        referred_user_id: userId,
        kind:             'paid',
      });
      if (!existingReward) {
        const referrer = await db.findOne(db.users, { _id: user.referredBy });
        if (referrer) {
          const creditDays = 3; // +3 días por cada referido pago. 5 referidos = 15 días.
          // Extender membershipExpiresAt: si está vigente, sumar; si está vencido, desde hoy
          const now = Date.now();
          const current = referrer.membershipExpiresAt ? new Date(referrer.membershipExpiresAt).getTime() : 0;
          const base = current > now ? current : now;
          const newExp = new Date(base + creditDays * 24 * 3_600_000).toISOString();
          await db.update(db.users, { _id: referrer._id }, { membershipExpiresAt: newExp });

          // Marcar la conversión como 'paid' en la tabla referrals
          await db.insert(db.referrals, {
            referrer_id:      referrer._id,
            referred_user_id: userId,
            kind:             'paid',
            credit_days:      creditDays,
            credit_applied_at: new Date().toISOString(),
            referredPlan:     plan,
          });

          // Notificación email al referidor (best-effort)
          try {
            const { sendEmail } = require('../services/email');
            sendEmail({
              to: referrer.email,
              subject: `🎉 +${creditDays} días gratis: tu referido se suscribió`,
              html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:auto;padding:24px"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px"><h1 style="color:#16a34a;font-size:22px;margin:0 0 12px">🎉 +${creditDays} días gratis</h1><p style="color:#475569;line-height:1.6">Buenas noticias: alguien que invitaste se suscribió a DMCloser. Como agradecimiento, te agregamos <strong>${creditDays} días extra</strong> a tu plan.</p><p style="color:#475569;line-height:1.6">Tu suscripción ahora vence el <strong>${new Date(newExp).toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric' })}</strong>.</p><p style="color:#475569;line-height:1.6">Recordá: cada 5 referidos pagos = 15 días gratis. Seguí compartiendo tu link 🚀</p><a href="${process.env.APP_URL || 'https://dmcloser.app'}/app" style="display:inline-block;background:#f97316;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:14px">Ver mi panel →</a></div></div>`,
              userId: referrer._id,
              tag: 'referral_reward',
            }).catch(() => null);
          } catch (e) { /* silent */ }

          console.log(`🎁 Referral reward: ${referrer.email} +${creditDays}d (referido: ${user.email})`);
        }
      }
    } catch (e) { console.warn('referral reward error:', e.message); }
  }
}

async function renewSubscription(userId, provider) {
  const exp = new Date();
  exp.setMonth(exp.getMonth() + 1);
  await db.update(db.users, { _id: userId }, {
    membershipExpiresAt: exp.toISOString(),
    subscriptionStatus:  'active',
  });
  console.log(`✅ ${provider.toUpperCase()}: renovación pagada — usuario ${userId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const user = await db.findOne(db.users, { _id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isAdmin   = user.role === 'admin';
    const now       = new Date();
    const expiresAt = user.membershipExpiresAt ? new Date(user.membershipExpiresAt) : null;
    const isExpired = !isAdmin && expiresAt ? expiresAt < now : false;
    const daysLeft  = expiresAt && !isExpired
      ? Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      : 0;

    res.json({
      plan:               user.membershipPlan      || 'trial',
      isAdmin,
      isExpired:          isAdmin ? false : isExpired,
      daysLeft:           isAdmin ? 999  : daysLeft,
      expiresAt:          user.membershipExpiresAt || null,
      subscriptionStatus: user.subscriptionStatus  || null,
      provider:           user.paymentProvider     || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/checkout   body: { plan, provider: 'ls' | 'mp' }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { plan, provider } = req.body;

    if (!PLAN_NAMES[plan])             return res.status(400).json({ error: 'Plan inválido. Usa: starter, pro, agency' });
    if (!['ls', 'mp'].includes(provider)) return res.status(400).json({ error: 'Provider inválido. Usa: ls (USD) o mp (CLP)' });

    const user   = await db.findOne(db.users, { _id: req.user.userId });
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    // ── Lemon Squeezy ─────────────────────────────────────────────────────────
    if (provider === 'ls') {
      const variantId = LS_VARIANTS[plan]();
      if (!variantId)                  return res.status(400).json({ error: `LS_VARIANT_${plan.toUpperCase()} no configurado` });
      if (!process.env.LS_STORE_ID)   return res.status(400).json({ error: 'LS_STORE_ID no configurado' });

      const resp = await axios.post(
        'https://api.lemonsqueezy.com/v1/checkouts',
        {
          data: {
            type: 'checkouts',
            attributes: {
              checkout_data: {
                email:  user.email,
                name:   user.name,
                custom: { userId: user._id, plan },
              },
              product_options: {
                redirect_url:     `${appUrl}/?billing=success&plan=${plan}&provider=ls`,
                receipt_link_url: `${appUrl}/?billing=success&plan=${plan}&provider=ls`,
              },
              checkout_options: { embed: false, media: true, logo: true },
            },
            relationships: {
              store:   { data: { type: 'stores',   id: process.env.LS_STORE_ID } },
              variant: { data: { type: 'variants', id: variantId } },
            },
          },
        },
        { headers: lsHeaders() }
      );

      return res.json({ url: resp.data.data.attributes.url });
    }

    // ── Mercado Pago ──────────────────────────────────────────────────────────
    if (provider === 'mp') {
      const planId = MP_PLANS[plan]();
      if (!planId) return res.status(400).json({ error: `MP_PLAN_${plan.toUpperCase()} no configurado` });

      const resp = await axios.post(
        'https://api.mercadopago.com/preapproval',
        {
          preapproval_plan_id: planId,
          reason:              `DMCloser ${PLAN_NAMES[plan]}`,
          payer_email:         user.email,
          back_url:            `${appUrl}/?billing=success&plan=${plan}&provider=mp`,
          external_reference:  user._id,
          status:              'pending',
        },
        { headers: mpHeaders() }
      );

      // Persist MP sub ID so we can match webhooks
      await db.update(db.users, { _id: user._id }, { mpSubscriptionId: resp.data.id });

      return res.json({ url: resp.data.init_point });
    }

  } catch (e) {
    const detail = e.response?.data?.message || e.response?.data || e.message;
    console.error('checkout error:', detail);
    res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/portal
// ─────────────────────────────────────────────────────────────────────────────
router.get('/portal', requireAuth, async (req, res) => {
  try {
    const user = await db.findOne(db.users, { _id: req.user.userId });

    // LS: we save the customer portal URL from webhook
    if (user.lsCustomerPortalUrl) {
      return res.json({ url: user.lsCustomerPortalUrl });
    }

    // MP: direct to MP subscriptions dashboard
    if (user.mpSubscriptionId) {
      return res.json({ url: 'https://www.mercadopago.cl/subscriptions' });
    }

    return res.status(400).json({ error: 'No hay suscripción activa para gestionar' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Exported helpers — used by webhook handlers in server.js
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
module.exports.activateSubscription = activateSubscription;
module.exports.renewSubscription    = renewSubscription;
module.exports.mpHeaders            = mpHeaders;
