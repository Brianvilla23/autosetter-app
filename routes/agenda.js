/**
 * Atinov — Agenda propia (barberías y todo negocio con hora)
 *
 * Todo cuelga de la cuenta del JWT: no se acepta accountId del body/query.
 *   GET    /api/agenda/config            configuración (horario, servicios, atraso)
 *   PUT    /api/agenda/config            guardar configuración
 *   GET    /api/agenda/citas?fecha=      citas del día (default: hoy) + cupos libres
 *   POST   /api/agenda/citas             crear cita a mano { nombre, telefono, fecha, hora, servicio }
 *   PATCH  /api/agenda/citas/:id         { estado } | { fecha, hora } (reprogramar)
 *   POST   /api/agenda/atraso            { minutos } → citas afectadas con hora estimada
 */

const express = require('express');
const router  = express.Router();
const agenda  = require('../services/agenda');
const core    = require('../services/agendaCore');
const db      = require('../db/database');

router.get('/config', async (req, res, next) => {
  try {
    const settings = await db.findOne(db.settings, { account_id: req.user.accountId });
    res.json({ config: agenda.configDe(settings), hoy: agenda.hoyChile() });
  } catch (e) { next(e); }
});

router.put('/config', async (req, res, next) => {
  try {
    const cfg = await agenda.guardarConfig(req.user.accountId, req.body && req.body.config ? req.body.config : req.body);
    res.json({ ok: true, config: cfg });
  } catch (e) { next(e); }
});

router.get('/citas', async (req, res, next) => {
  try {
    const accountId = req.user.accountId;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '')) ? req.query.fecha : agenda.hoyChile();
    const settings = await db.findOne(db.settings, { account_id: accountId });
    const cfg = agenda.configDe(settings);
    const citas = await agenda.citasDelDia(accountId, fecha);
    const hoy = agenda.hoyChile();
    const ahoraMin = fecha === hoy ? agenda.ahoraMinChile() : null;
    const activas = citas.filter(c => agenda.ACTIVAS.includes(c.estado));
    const atraso = cfg.atraso && cfg.atraso.fecha === fecha ? cfg.atraso.minutos : 0;
    res.json({
      fecha, hoy, atraso,
      ventanas: core.ventanasDelDia(cfg, fecha).map(([a, b]) => `${core.deMinutos(a)}-${core.deMinutos(b)}`),
      cupos: core.cuposDisponibles(cfg, fecha, activas, { duracion: (cfg.servicios[0] || {}).min || 30, ahoraMin }),
      citas: citas.map(c => ({
        id: c._id, nombre: c.nombre, telefono: c.telefono, fecha: c.fecha, hora: c.hora,
        hora_estimada: atraso && agenda.ACTIVAS.includes(c.estado) ? core.deMinutos(core.aMinutos(c.hora) + atraso) : c.hora,
        servicio: c.servicio, precio: c.precio, duracion_min: c.duracion_min, estado: c.estado,
        origen: c.origen, lead_id: c.lead_id, notas: c.notas || '',
      })),
    });
  } catch (e) { next(e); }
});

router.post('/citas', async (req, res, next) => {
  try {
    const { nombre, telefono, fecha, hora, servicio, notas, lead_id } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) || core.aMinutos(hora) === null) {
      return res.status(400).json({ error: 'Fecha (YYYY-MM-DD) y hora (HH:MM) requeridas.' });
    }
    const r = await agenda.crearCita({
      accountId: req.user.accountId, leadId: lead_id || null, nombre, telefono, fecha,
      hora: core.deMinutos(core.aMinutos(hora)), servicio, origen: 'panel', notas,
    });
    if (!r.ok) return res.status(409).json({ error: r.motivo, alternativas: r.alternativas || null });
    res.json({ ok: true, cita: r.cita });
  } catch (e) { next(e); }
});

router.patch('/citas/:id', async (req, res, next) => {
  try {
    const { estado, fecha, hora, motivo } = req.body || {};
    if (estado) {
      const c = await agenda.cambiarEstado(req.user.accountId, req.params.id, estado, { motivo });
      if (!c) return res.status(404).json({ error: 'Cita no encontrada o estado inválido.' });
      return res.json({ ok: true, cita: c });
    }
    if (fecha && hora) {
      const r = await agenda.reprogramar(req.user.accountId, req.params.id, { fecha, hora });
      if (!r.ok) return res.status(409).json({ error: r.motivo, alternativas: r.alternativas || null });
      return res.json({ ok: true, cita: r.cita });
    }
    res.status(400).json({ error: 'Manda { estado } o { fecha, hora }.' });
  } catch (e) { next(e); }
});

router.post('/atraso', async (req, res, next) => {
  try {
    const r = await agenda.registrarAtraso(req.user.accountId, Number(req.body && req.body.minutos));
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

module.exports = router;
