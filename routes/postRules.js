/**
 * Atinov — Reglas por publicación (keyword por post/reel)
 *
 * Lo que hace ManyChat y a Atinov le faltaba: en vez de UNA keyword global
 * para toda la cuenta, cada publicación puede tener la suya.
 *   "En este reel la palabra es PRECIO y le mando la lista"
 *   "En este carrusel la palabra es GUÍA y le mando el PDF"
 *
 * Si una publicación no tiene regla, todo sigue funcionando exactamente como
 * hoy (keywords del agente). La regla NO reemplaza al agente: le dice qué
 * palabra escuchar en ESE post y qué tiene que entregar.
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../db/database');

const IG_BASE = 'https://graph.instagram.com/v21.0';

function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

/**
 * GET /api/post-rules/media
 * Publicaciones recientes de la cuenta, para elegirlas de una lista con su
 * miniatura en vez de pedirle al usuario un ID que no tiene cómo conocer.
 */
router.get('/media', async (req, res, next) => {
  try {
    const accountId = req.user.accountId;
    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account?.access_token) {
      return res.status(400).json({ error: 'Conecta tu cuenta de Instagram primero.' });
    }
    const igId = account.ig_platform_id || account.ig_user_id;
    const r = await axios.get(`${IG_BASE}/${igId}/media`, {
      params: {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
        limit: 25,
        access_token: account.access_token,
      },
      timeout: 15000,
    });
    const media = (r.data?.data || []).map(m => ({
      id: m.id,
      tipo: m.media_type,
      caption: (m.caption || '').slice(0, 90),
      thumb: m.thumbnail_url || m.media_url || null,
      permalink: m.permalink,
      fecha: m.timestamp,
    }));
    res.json({ media });
  } catch (e) {
    console.error('[reglas] no se pudieron listar publicaciones:', e.response?.data?.error?.message || e.message);
    res.status(500).json({ error: 'No se pudieron cargar tus publicaciones. Revisa la conexión con Instagram.' });
  }
});

/** GET /api/post-rules — reglas de la cuenta */
router.get('/', async (req, res, next) => {
  try {
    const reglas = await db.find(db.postRules, { account_id: req.user.accountId });
    reglas.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(reglas.map(r => ({ ...r, id: r._id })));
  } catch (e) { next(e); }
});

/**
 * POST /api/post-rules
 * Body: { accountId, media_id, keywords, entregar?, public_reply?, agent_id?, permalink?, thumb? }
 */
router.post('/', async (req, res, next) => {
  try {
    const { accountId, media_id, keywords, entregar, public_reply, agent_id, permalink, thumb, caption } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    if (!media_id) return res.status(400).json({ error: 'Elige una publicación' });

    // Las keywords se validan como se van a USAR (separadas por coma y sin
    // vacíos): "," pasaría un trim() pero deja la regla muerta en silencio.
    const listaKw = String(keywords || '').split(',').map(k => k.trim()).filter(Boolean);
    if (!listaKw.length) return res.status(400).json({ error: 'Escribe al menos una palabra clave' });

    // agent_id debe ser un id string: un objeto acá termina como operador de
    // NeDB en la consulta del webhook y rompe el flujo de ese post en silencio.
    if (agent_id !== undefined && agent_id !== null && typeof agent_id !== 'string') {
      return res.status(400).json({ error: 'agent_id inválido' });
    }

    // Una regla por publicación: si ya existe, se actualiza.
    const existente = await db.findOne(db.postRules, { account_id: accountId, media_id: String(media_id) });
    // Todo se guarda como string acotado: sin esto, thumb/permalink/caption
    // aceptan objetos o strings de 1 MB (el límite del body de Express).
    const texto = (v, max) => String(v == null ? '' : v).slice(0, max);
    const datos = {
      keywords:     listaKw.join(', ').slice(0, 300),
      entregar:     texto(entregar, 600).trim(),
      public_reply: texto(public_reply, 280).trim(),
      agent_id:     agent_id || null,
      permalink:    texto(permalink || existente?.permalink, 300) || null,
      // Las comillas romperían el url('...') del fondo en la UI del panel.
      thumb:        texto(thumb || existente?.thumb, 500).replace(/['"\\]/g, '') || null,
      caption:      texto(caption || existente?.caption, 90),
      enabled:      existente ? existente.enabled : true,
    };
    if (existente) {
      await db.update(db.postRules, { _id: existente._id }, datos);
      return res.json({ ...existente, ...datos, id: existente._id, actualizada: true });
    }
    const regla = await db.insert(db.postRules, {
      account_id: accountId, media_id: String(media_id), ...datos,
    });
    res.json({ ...regla, id: regla._id });
  } catch (e) { next(e); }
});

/** PATCH /api/post-rules/:id/toggle — activar/desactivar sin borrar */
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const regla = await db.findOne(db.postRules, { _id: req.params.id });
    if (!regla) return res.status(404).json({ error: 'no encontrada' });
    if (regla.account_id !== req.user.accountId) return res.status(403).json({ error: 'forbidden' });
    await db.update(db.postRules, { _id: regla._id }, { enabled: !regla.enabled });
    res.json({ ok: true, enabled: !regla.enabled });
  } catch (e) { next(e); }
});

/** DELETE /api/post-rules/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const regla = await db.findOne(db.postRules, { _id: req.params.id });
    if (!regla) return res.status(404).json({ error: 'no encontrada' });
    if (regla.account_id !== req.user.accountId) return res.status(403).json({ error: 'forbidden' });
    await db.remove(db.postRules, { _id: regla._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
