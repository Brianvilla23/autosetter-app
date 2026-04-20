const express    = require('express');
const router     = express.Router();
const db         = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY no configurado en variables de entorno');
  return require('stripe')(key);
}

const PLANS = {
  starter: { name: 'Starter', priceId: () => process.env.STRIPE_PRICE_STARTER },
  pro:     { name: 'Pro',     priceId: () => process.env.STRIPE_PRICE_PRO     },
  agency:  { name: 'Agency',  priceId: () => process.env.STRIPE_PRICE_AGENCY  },
};

// ── GET /api/billing/status ───────────────────────────────────────────────────
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
      stripeCustomerId:   user.stripeCustomerId    || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/billing/checkout ────────────────────────────────────────────────
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plan inválido. Usa: starter, pro, agency' });

    const priceId = PLANS[plan].priceId();
    if (!priceId) return res.status(400).json({ error: `STRIPE_PRICE_${plan.toUpperCase()} no configurado` });

    const stripe = getStripe();
    const user   = await db.findOne(db.users, { _id: req.user.userId });

    // Obtener o crear cliente Stripe
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    user.email,
        name:     user.name,
        metadata: { userId: user._id, accountId: user.account_id },
      });
      customerId = customer.id;
      await db.update(db.users, { _id: user._id }, { stripeCustomerId: customerId });
    }

    const appUrl  = process.env.APP_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      mode:                 'subscription',
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          `${appUrl}/?billing=success&plan=${plan}`,
      cancel_url:           `${appUrl}/?billing=cancelled`,
      metadata:             { userId: user._id, accountId: user.account_id, plan },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/billing/portal ───────────────────────────────────────────────────
router.get('/portal', requireAuth, async (req, res) => {
  try {
    const stripe = getStripe();
    const user   = await db.findOne(db.users, { _id: req.user.userId });

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No hay suscripción activa para gestionar' });
    }

    const appUrl  = process.env.APP_URL || 'http://localhost:3000';
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${appUrl}/`,
    });

    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
