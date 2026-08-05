/**
 * Atinov — Fuentes de conocimiento (API)
 *
 * El dueño dice DE DÓNDE sacar la información de su negocio y el sistema la
 * convierte en una ficha lista para el agente. Ver services/knowledgeSources.js.
 *
 * La ficha nace desasignada (is_main:false, sin agentes): nada llega al agente
 * sin que un humano la haya revisado en la sección Conocimiento.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { TIPOS, procesarFuente, validarUrlPublica } = require('../services/knowledgeSources');

const MAX_FUENTES = 40;   // techo por cuenta: cada procesamiento cuesta tokens

function assertOwnsAccount(req, accountId) {
  return accountId && accountId === req.user.accountId;
}

/** GET /api/knowledge-sources */
router.get('/', async (req, res, next) => {
  try {
    const fuentes = await db.find(db.knowledgeSources, { account_id: req.user.accountId });
    fuentes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    // contenido_crudo puede pesar megas (PDF) — nunca vuelve al frontend
    res.json(fuentes.map(f => ({
      id: f._id, tipo: f.tipo, titulo: f.titulo, origen: f.origen,
      estado: f.estado, error: f.error || null,
      knowledge_id: f.knowledge_id || null,
      procesado_at: f.procesado_at || null,
      createdAt: f.createdAt,
    })));
  } catch (e) { next(e); }
});

/**
 * POST /api/knowledge-sources
 * Body: { accountId, tipo, origen?, titulo?, contenido_crudo? }
 * Crea la fuente y la procesa al toque (el frontend hace polling del estado).
 */
router.post('/', async (req, res, next) => {
  try {
    const { accountId, tipo, origen, titulo, contenido_crudo } = req.body;
    if (!assertOwnsAccount(req, accountId)) return res.status(403).json({ error: 'forbidden' });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de fuente no válido' });

    const total = await db.count(db.knowledgeSources, { account_id: accountId });
    if (total >= MAX_FUENTES) {
      return res.status(400).json({ error: `Llegaste al máximo de ${MAX_FUENTES} fuentes. Borra alguna para agregar otra.` });
    }

    // Validaciones por tipo, antes de guardar nada
    let origenLimpio = null;
    if (tipo === 'url' || tipo === 'youtube') {
      try { origenLimpio = validarUrlPublica(origen); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    // Topes del lado del servidor: los del navegador no protegen de un curl.
    // NeDB carga TODA la base en memoria, así que un documento gigante pesa
    // en cada arranque, para siempre.
    const MAX_TEXTO = 200_000;          // ~200 KB de texto pegado
    const MAX_PDF_B64 = 11 * 1024 * 1024;
    let crudo = null;
    if (tipo === 'texto') {
      crudo = String(contenido_crudo || '').trim();
      if (!crudo) return res.status(400).json({ error: 'Pega el texto que quieres cargar' });
      crudo = crudo.slice(0, MAX_TEXTO);
    }
    if (tipo === 'pdf') {
      crudo = String(contenido_crudo || '');
      if (!crudo.trim()) return res.status(400).json({ error: 'Falta el archivo PDF' });
      if (crudo.length > MAX_PDF_B64) return res.status(400).json({ error: 'El PDF pesa más de 8 MB' });
    }
    if (tipo === 'instagram') {
      const cuenta = await db.findOne(db.accounts, { _id: accountId });
      if (!cuenta?.access_token) {
        return res.status(400).json({ error: 'Conecta tu cuenta de Instagram antes de usar esta fuente.' });
      }
    }

    const fuente = await db.insert(db.knowledgeSources, {
      account_id: accountId,
      tipo,
      origen: origenLimpio,
      titulo: String(titulo || '').trim().slice(0, 90) || null,
      contenido_crudo: crudo,
      estado: 'pendiente',
      error: null,
      knowledge_id: null,
    });

    // Procesar en segundo plano: leer un sitio + resumirlo puede tardar más de
    // lo que un navegador espera sin cortar.
    procesarFuente(fuente._id).catch(e => console.error('[fuentes] proceso falló:', e.message));

    res.json({ id: fuente._id, estado: 'pendiente' });
  } catch (e) { next(e); }
});

/** POST /api/knowledge-sources/:id/reprocesar */
router.post('/:id/reprocesar', async (req, res, next) => {
  try {
    const fuente = await db.findOne(db.knowledgeSources, { _id: req.params.id });
    if (!fuente) return res.status(404).json({ error: 'no encontrada' });
    if (fuente.account_id !== req.user.accountId) return res.status(403).json({ error: 'forbidden' });
    if (fuente.estado === 'procesando') return res.json({ ok: true, ya: true });
    if ((fuente.tipo === 'pdf') && !fuente.contenido_crudo) {
      return res.status(400).json({ error: 'El PDF ya no está guardado. Súbelo de nuevo.' });
    }
    await db.update(db.knowledgeSources, { _id: fuente._id }, { estado: 'pendiente', error: null });
    procesarFuente(fuente._id).catch(e => console.error('[fuentes] reproceso falló:', e.message));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/knowledge-sources/:id
 * Borra la fuente. La ficha de conocimiento generada NO se borra: puede estar
 * ya editada por el dueño y asignada a un agente vivo.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const fuente = await db.findOne(db.knowledgeSources, { _id: req.params.id });
    if (!fuente) return res.status(404).json({ error: 'no encontrada' });
    if (fuente.account_id !== req.user.accountId) return res.status(403).json({ error: 'forbidden' });
    await db.remove(db.knowledgeSources, { _id: fuente._id });
    res.json({ ok: true, aviso: 'La ficha generada sigue en Conocimiento; bórrala ahí si tampoco la quieres.' });
  } catch (e) { next(e); }
});

module.exports = router;
