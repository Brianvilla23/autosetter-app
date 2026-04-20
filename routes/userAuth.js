const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../db/database');
const { SECRET } = require('../middleware/authMiddleware');

// ── CHECK: ¿Hay usuarios registrados? ─────────────────────────────────────────
router.get('/check', async (req, res) => {
  try {
    const count = await db.count(db.users, {});
    res.json({ hasUsers: count > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, inviteCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (password.length < 6)  return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

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
    });

    // Marcar código como usado
    if (codeDoc) {
      await db.update(db.inviteCodes, { _id: codeDoc._id }, {
        uses:    codeDoc.uses + 1,
        usedBy:  [...(codeDoc.usedBy || []), user._id],
      });
    }

    await seedDemoAgent(account._id);

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const user = await db.findOne(db.users, { email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
router.post('/change-password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !currentPassword || !newPassword) return res.status(400).json({ error: 'Faltan campos' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });

    const user = await db.findOne(db.users, { email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.update(db.users, { _id: user._id }, { password_hash: hash });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

module.exports = router;
