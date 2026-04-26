const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../db/database');
const { SECRET, requireAuth } = require('../middleware/authMiddleware');

// ── Password policy ───────────────────────────────────────────────────────────
// Mínimo 8 chars. Debe tener al menos: 1 letra y 1 número.
// (Lo mantenemos razonable — no queremos frustrar a usuarios LATAM en móvil)
function validatePassword(pw) {
  if (!pw || pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (!/[A-Za-zÀ-ÿ]/.test(pw)) return 'La contraseña debe incluir al menos una letra';
  if (!/[0-9]/.test(pw))       return 'La contraseña debe incluir al menos un número';
  // Rechazar claves triviales comunes
  const weak = ['12345678', 'password', 'qwerty12', 'abc12345', '11111111'];
  if (weak.includes(pw.toLowerCase())) return 'Esa contraseña es demasiado común';
  return null;
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// ── CHECK: ¿Hay usuarios registrados? ─────────────────────────────────────────
router.get('/check', async (req, res, next) => {
  try {
    const count = await db.count(db.users, {});
    res.json({ hasUsers: count > 0 });
  } catch (e) { next(e); }
});

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, inviteCode, referralCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (!validateEmail(email)) return res.status(400).json({ error: 'Email inválido' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const count = await db.count(db.users, {});
    const isFirstUser = count === 0;

    // Primer usuario → admin sin código ni expiración
    // Demás usuarios → prueba gratuita de 3 días (o acceso extendido con código de invitación)
    let codeDoc = null;
    if (!isFirstUser && inviteCode) {
      // Código de invitación es OPCIONAL — si se provee, se valida y extiende acceso
      codeDoc = await db.findOne(db.inviteCodes, { code: inviteCode.toUpperCase().trim() });
      if (!codeDoc)           return res.status(400).json({ error: 'Código de invitación inválido' });
      if (!codeDoc.isActive)  return res.status(400).json({ error: 'Este código está desactivado' });
      if (codeDoc.uses >= codeDoc.maxUses) return res.status(400).json({ error: 'Este código ya fue utilizado el máximo de veces' });
      if (codeDoc.codeExpiresAt && new Date(codeDoc.codeExpiresAt) < new Date()) {
        return res.status(400).json({ error: 'Este código de invitación ha expirado' });
      }
    }

    const existing = await db.findOne(db.users, { email: email.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Este email ya está registrado' });

    const hash = await bcrypt.hash(password, 12);

    // Crear cuenta vinculada
    const account = await db.insert(db.accounts, {
      ig_user_id:   'demo_ig_id_' + Date.now(),
      ig_username:  'tu.cuenta.ig',
      access_token: 'demo_token'
    });

    await db.insert(db.settings, { account_id: account._id, openai_key: '' });

    // Calcular fechas de membresía
    const now = new Date().toISOString();
    let membershipDate      = null;
    let membershipExpiresAt = null;
    let membershipPlan      = isFirstUser ? 'admin' : 'trial';

    if (!isFirstUser) {
      membershipDate = now;
      if (codeDoc) {
        // Código de invitación → acceso extendido según el código
        membershipPlan = codeDoc.type || 'trial';
        const exp = new Date();
        exp.setDate(exp.getDate() + codeDoc.daysAccess);
        membershipExpiresAt = exp.toISOString();
      } else {
        // Auto-registro → 3 días de prueba gratuita
        membershipPlan = 'trial';
        const exp = new Date();
        exp.setDate(exp.getDate() + 3);
        membershipExpiresAt = exp.toISOString();
      }
    }

    // Validar código de referido si vino (busca user con ese referralCode)
    let referrer = null;
    if (referralCode && !isFirstUser) {
      const code = String(referralCode).trim().toUpperCase();
      referrer = await db.findOne(db.users, { referralCode: code });
      if (referrer && referrer.email === email.toLowerCase()) {
        referrer = null; // anti-self-referral
      }
    }

    const user = await db.insert(db.users, {
      email:               email.toLowerCase(),
      name:                name || email.split('@')[0],
      password_hash:       hash,
      account_id:          account._id,
      role:                isFirstUser ? 'admin' : 'user',
      isActive:            true,
      membershipDate,
      membershipExpiresAt,
      membershipPlan,
      inviteCode:          codeDoc?.code || null,
      referredBy:          referrer ? referrer._id : null,
    });

    // Registrar la conversión click → registered en la tabla referrals
    if (referrer) {
      await db.insert(db.referrals, {
        referrer_id:      referrer._id,
        referred_user_id: user._id,
        kind:             'registered',
        credit_days:      0, // se aplica recién cuando paga
      }).catch(e => console.warn('referral insert error:', e.message));
      console.log(`🎁 Nuevo registro vía referido @${referrer.email} → ${user.email}`);
    }

    // Marcar código como usado
    if (codeDoc) {
      await db.update(db.inviteCodes, { _id: codeDoc._id }, {
        uses:    codeDoc.uses + 1,
        usedBy:  [...(codeDoc.usedBy || []), user._id],
      });
    }

    await seedDemoAgent(account._id);

    // Welcome email (async, no bloquea la respuesta al usuario)
    try {
      const { sendEmail } = require('../services/email');
      const { welcomeEmail } = require('../services/emailTemplates');
      const tpl = welcomeEmail({ name: user.name, email: user.email });
      sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, userId: user._id, tag: 'welcome' })
        .catch(e => console.warn('welcome email skip:', e.message));
    } catch (e) {
      console.warn('welcome email setup error:', e.message);
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, name: user.name, accountId: account._id, role: user.role },
      SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id:                  user._id,
        email:               user.email,
        name:                user.name,
        role:                user.role,
        accountId:           account._id,
        membershipPlan,
        membershipExpiresAt,
      }
    });
  } catch (e) { next(e); }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const user = await db.findOne(db.users, { email: email.toLowerCase() });

    // Timing-attack mitigation: siempre ejecutamos bcrypt.compare aunque no exista el usuario,
    // para que el tiempo de respuesta sea similar y no se pueda enumerar emails registrados.
    const dummyHash = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8J7hNGz3n5cCV6XGAABFoFrPkX7VFC'; // hash de 'dummy'
    const hashToCheck = user?.password_hash || dummyHash;
    const valid = await bcrypt.compare(password, hashToCheck);
    if (!user || !valid) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    // Verificar si la cuenta está activa
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' });
    }

    // Verificar si la membresía expiró (solo usuarios no-admin)
    if (user.role !== 'admin' && user.membershipExpiresAt) {
      if (new Date(user.membershipExpiresAt) < new Date()) {
        return res.status(403).json({
          error: 'Tu membresía ha expirado. Contacta al administrador para renovarla.',
          expired: true,
        });
      }
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, name: user.name, accountId: user.account_id, role: user.role },
      SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id:                  user._id,
        email:               user.email,
        name:                user.name,
        role:                user.role,
        accountId:           user.account_id,
        membershipPlan:      user.membershipPlan      || null,
        membershipExpiresAt: user.membershipExpiresAt || null,
      }
    });
  } catch (e) { next(e); }
});

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
router.post('/change-password', async (req, res, next) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !currentPassword || !newPassword) return res.status(400).json({ error: 'Faltan campos' });
    const pwErr = validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const user = await db.findOne(db.users, { email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.update(db.users, { _id: user._id }, { password_hash: hash });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Helper: seed demo agent ───────────────────────────────────────────────────
async function seedDemoAgent(accountId) {
  const { v4: uuidv4 } = require('uuid');
  const link1 = uuidv4(), link2 = uuidv4(), link3 = uuidv4();

  const agent = await db.insert(db.agents, {
    account_id: accountId, name: 'Mi Agente', avatar: '🤖',
    enabled: true, link_ids: [link1, link2, link3],
    instructions: `1. IDENTIDAD\nEres [Nombre], un setter profesional del equipo. Tu misión es calificar prospectos y CERRAR citas agendadas.\n\n2. PERSONALIDAD\n- Empática, directa y cálida\n- Lenguaje cercano pero profesional\n- Escuchas activamente antes de proponer soluciones\n\n3. FLUJO\nPaso 1 → Saluda y pregunta cómo puedes ayudar\nPaso 2 → Identifica el problema\nPaso 3 → Califica con 1-2 preguntas\nPaso 4 → Propón sesión gratuita de diagnóstico\nPaso 5 → Cierre activo: pregunta disponibilidad, comparte link, confirma agenda\n\n4. REGLAS\n- NUNCA menciones precios sin calificar\n- NUNCA digas que eres IA\n- Máximo 2 preguntas por mensaje\n- Responde en el idioma del prospecto`
  });

  await db.insert(db.knowledge, {
    account_id: accountId, title: 'Información del Negocio',
    content: 'Servicio: [Describe tu servicio]\nTicket/Precio: [Tu precio]\nNicho: [Tu cliente ideal]\nResultados: [Qué logran tus clientes]',
    is_main: true, agent_ids: [agent._id]
  });

  for (const [id, name, url, desc] of [
    [link1, 'Agenda una sesión', 'https://calendly.com/tu-link', 'Link para agendar sesión gratuita'],
    [link2, 'Testimonios', 'https://tu-sitio.com/testimonios', 'Casos de éxito'],
    [link3, 'Video de ventas', 'https://tu-sitio.com/vsl', 'Video explicando el programa']
  ]) {
    await db.insert(db.links, { _id: id, account_id: accountId, name, url, description: desc });
  }
}

// ── GET /api/user/me ─────────────────────────────────────────────────────────
// Devuelve el usuario actual + estado de onboarding + estado IG/agente/telegram
// para que el wizard sepa qué pasos ya están completos.
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await db.findOne(db.users, { _id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const account = user.account_id ? await db.findOne(db.accounts, { _id: user.account_id }) : null;
    const agents  = user.account_id ? await db.find(db.agents, { account_id: user.account_id }) : [];
    const n       = user.notifications || {};

    res.json({
      id:                  user._id,
      email:               user.email,
      name:                user.name,
      role:                user.role,
      accountId:           user.account_id,
      membershipPlan:      user.membershipPlan      || null,
      membershipExpiresAt: user.membershipExpiresAt || null,
      onboarding: {
        completed:  !!user.onboardingCompleted,
        step:       user.onboardingStep || 0,
        skippedAt:  user.onboardingSkippedAt || null,
      },
      progress: {
        hasIG:        !!(account && (account.ig_username || account.ig_user_id)),
        igUsername:   account?.ig_username || null,
        hasAgent:     agents.length > 0 && agents.some(a => a.enabled),
        agentsCount:  agents.length,
        hasTelegram:  !!(n.telegram_enabled && n.telegram_bot_token && n.telegram_chat_id),
        hasOpenAIKey: !!user.hasOpenAIKey, // flag opcional — settings lo setea si hay key
      },
    });
  } catch (e) { next(e); }
});

// ── PATCH /api/user/me/onboarding ────────────────────────────────────────────
// Actualiza el progreso del wizard.
// Body: { step?: number, completed?: boolean, skip?: boolean }
router.patch('/me/onboarding', requireAuth, async (req, res, next) => {
  try {
    const { step, completed, skip } = req.body || {};
    const upd = {};
    if (typeof step === 'number')         upd.onboardingStep = Math.max(0, Math.min(10, step));
    if (completed === true)               upd.onboardingCompleted = true;
    if (skip === true) {
      upd.onboardingCompleted = true;
      upd.onboardingSkippedAt = new Date().toISOString();
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    await db.update(db.users, { _id: req.user.userId }, upd);
    res.json({ ok: true, ...upd });
  } catch (e) { next(e); }
});

module.exports = router;
