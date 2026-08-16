/**
 * Atinov — Rutas de plantillas de WhatsApp (por cuenta)
 *
 * Montado en server.js: /api/wa-templates con apiLimiter + requireAuth +
 * checkSubscription. Todo opera con el WABA y el token de la PROPIA cuenta
 * (tenant isolation por JWT). Sin WhatsApp conectado responde 400 claro.
 *
 *   GET    /api/wa-templates          → lista con estado de aprobación
 *   POST   /api/wa-templates          → crea (valida antes de llamar a Meta)
 *   DELETE /api/wa-templates/:name    → borra por nombre
 *   GET    /api/wa-templates/opciones → categorías e idiomas para el formulario
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const tpl     = require('../services/waTemplates');

async function cuentaConWhatsapp(req, res) {
  const account = await db.findOne(db.accounts, { _id: req.user.accountId });
  if (!account?.wa_access_token || !account?.wa_business_account_id) {
    res.status(400).json({ error: 'Conecta tu WhatsApp Business primero (Configuración → WhatsApp). Falta el WABA o el token.' });
    return null;
  }
  return account;
}

router.get('/opciones', (req, res) => {
  res.json({ categorias: tpl.CATEGORIAS, idiomas: tpl.IDIOMAS_COMUNES });
});

router.get('/', async (req, res, next) => {
  try {
    const account = await cuentaConWhatsapp(req, res);
    if (!account) return;
    const lista = await tpl.listar({ wabaId: account.wa_business_account_id, accessToken: account.wa_access_token });
    res.json({ templates: lista, waba_id: account.wa_business_account_id });
  } catch (e) {
    console.error('[wa-templates] listar:', e.response?.data?.error?.message || e.message);
    res.status(502).json({ error: tpl.explicarErrorMeta(e) });
  }
});

router.post('/', async (req, res, next) => {
  try {
    const account = await cuentaConWhatsapp(req, res);
    if (!account) return;
    const { name, category, language, header, body, footer, buttons } = req.body || {};
    let r;
    try {
      r = await tpl.crear({
        wabaId: account.wa_business_account_id, accessToken: account.wa_access_token,
        borrador: { name, category, language, header, body, footer, buttons },
      });
    } catch (e) {
      if (e instanceof tpl.ErrorPlantilla) return res.status(400).json({ error: e.message });
      throw e;
    }
    await db.insert(db.auditLog, {
      action: 'wa_template_create', account_id: account._id, target: r.name,
      actor: req.user.email || req.user.userId, at: new Date().toISOString(),
    }).catch(() => null);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[wa-templates] crear:', e.response?.data?.error?.message || e.message);
    res.status(502).json({ error: tpl.explicarErrorMeta(e) });
  }
});

router.delete('/:name', async (req, res, next) => {
  try {
    const account = await cuentaConWhatsapp(req, res);
    if (!account) return;
    let r;
    try {
      r = await tpl.borrar({ wabaId: account.wa_business_account_id, accessToken: account.wa_access_token, name: req.params.name });
    } catch (e) {
      if (e instanceof tpl.ErrorPlantilla) return res.status(400).json({ error: e.message });
      throw e;
    }
    await db.insert(db.auditLog, {
      action: 'wa_template_delete', account_id: account._id, target: r.name,
      actor: req.user.email || req.user.userId, at: new Date().toISOString(),
    }).catch(() => null);
    res.json(r);
  } catch (e) {
    console.error('[wa-templates] borrar:', e.response?.data?.error?.message || e.message);
    res.status(502).json({ error: tpl.explicarErrorMeta(e) });
  }
});

module.exports = router;
