/**
 * Atinov — Growth Routes
 * Lead magnet links (ig.me con tracking) y export CSV.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { enforceMaxMagnets } = require('../middleware/checkPlanLimits');
const PIPE    = require('../config/pipeline');

// ─────────────────────────────────────────────────────────────────────────────
// MAGNET LINKS — URLs ig.me con tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/magnet-links?accountId=X
 * Lista los magnet links del usuario con clicks acumulados.
 */
router.get('/magnet-links', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const links = await db.find(db.magnetLinks, { account_id: accountId },
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Adjuntar contador de clicks
    const clicks = await db.find(db.linkClicks, { account_id: accountId });
    const countBySlug = {};
    for (const c of clicks) {
      countBySlug[c.slug] = (countBySlug[c.slug] || 0) + 1;
    }

    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.json(links.map(l => ({
      id:           l._id,
      slug:         l.slug,
      label:        l.label,
      source:       l.source,
      preset_text:  l.preset_text,
      clicks:       countBySlug[l.slug] || 0,
      createdAt:    l.createdAt,
      redirect_url: `${base}/go/${l.slug}`,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/growth/magnet-links
 * Crea un magnet link. Body: { accountId, label, source, preset_text }
 * El slug se genera automáticamente (hash corto).
 */
router.post('/magnet-links', enforceMaxMagnets, async (req, res) => {
  try {
    const { accountId, label, source = 'bio', preset_text } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId y label requeridos' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    // Verificar que la cuenta tenga username
    const account = await db.findOne(db.accounts, { _id: accountId });
    if (!account?.ig_username) return res.status(400).json({ error: 'Cuenta sin username de Instagram' });

    // Generar slug corto y único
    const slug = Math.random().toString(36).slice(2, 8);

    const link = await db.insert(db.magnetLinks, {
      account_id:  accountId,
      ig_username: account.ig_username,
      slug,
      label:       String(label).slice(0, 80),
      source:      String(source).slice(0, 40),
      preset_text: preset_text ? String(preset_text).slice(0, 280) : null,
    });

    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      id:           link._id,
      slug:         link.slug,
      label:        link.label,
      source:       link.source,
      preset_text:  link.preset_text,
      clicks:       0,
      redirect_url: `${base}/go/${link.slug}`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/growth/magnet-links/:id
 */
router.delete('/magnet-links/:id', async (req, res) => {
  try {
    const link = await db.findOne(db.magnetLinks, { _id: req.params.id });
    if (!link) return res.status(404).json({ error: 'No encontrado' });
    if (link.account_id !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });
    await db.remove(db.magnetLinks, { _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT CSV de leads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/export-leads?accountId=X
 * Devuelve un CSV con todos los leads de la cuenta.
 */
router.get('/export-leads', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const leads      = await db.find(db.leads,      { account_id: accountId });
    const agents     = await db.find(db.agents,     { account_id: accountId });
    const allMsgs    = await db.find(db.messages,   {});
    const deliveries = await db.find(db.magnetDeliveries, { account_id: accountId });
    const magnets    = await db.find(db.leadMagnets,      { account_id: accountId });

    const agentById  = {};
    for (const a of agents)  agentById[a._id]  = a.name;
    const magnetById = {};
    for (const m of magnets) magnetById[m._id] = m.title;

    // Indexar mensajes por lead (una sola pasada — N+1 evitado)
    const msgsByLead = {};
    for (const m of allMsgs) {
      if (!m.lead_id) continue;
      (msgsByLead[m.lead_id] = msgsByLead[m.lead_id] || []).push(m);
    }
    for (const id of Object.keys(msgsByLead)) {
      msgsByLead[id].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }

    const deliveriesByLead = {};
    for (const d of deliveries) {
      (deliveriesByLead[d.lead_id] = deliveriesByLead[d.lead_id] || []).push(d);
    }

    const isoDate = (s) => s ? new Date(s).toISOString().slice(0, 10) : '';
    const isoTime = (s) => s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') : '';
    const truncate = (s, n) => {
      const x = String(s || '').replace(/\s+/g, ' ').trim();
      return x.length > n ? x.slice(0, n - 1) + '…' : x;
    };

    // Score de cierre (RAG) — un solo fetch, graceful si está apagado
    const scoreByLead = {};
    try {
      const { isEnabled, getClient } = require('../services/rag/supabase');
      if (isEnabled()) {
        const client = getClient();
        if (client) {
          const { data } = await client.from('lead_scores')
            .select('lead_id, score').eq('account_id', accountId).limit(2000);
          for (const r of (data || [])) scoreByLead[r.lead_id] = Math.round(r.score);
        }
      }
    } catch (e) { /* RAG opcional */ }

    // Columnas — info completa para análisis en Excel/Sheets/CRM externo
    const rows = [[
      'fecha_primer_contacto', 'hora_primer_contacto',
      'ig_username', 'ig_link', 'ig_user_id',
      'canal', 'nombre_contacto',
      'etapa_pipeline', 'valor_negocio', 'moneda', 'tags',
      'score_cierre', 'proximo_followup',
      'agente_asignado', 'estado', 'automatizacion',
      'calificacion', 'razon_calificacion',
      'es_caliente', 'es_tibio', 'es_frio',
      'convertido', 'bypassed', 'limite_alcanzado',
      'total_mensajes', 'mensajes_lead', 'mensajes_bot', 'mensajes_manuales',
      'primer_mensaje_lead', 'ultimo_mensaje_lead',
      'ultimo_mensaje_bot', 'fecha_ultimo_mensaje',
      'email_capturado', 'telefono_capturado',
      'magnet_entregado', 'fecha_entrega_magnet',
      'duracion_conversacion_horas', 'tiempo_respuesta_bot_promedio_seg',
      'notas_admin',
    ]];

    for (const l of leads) {
      const msgs = msgsByLead[l._id] || [];
      const userMsgs   = msgs.filter(m => m.role === 'user');
      const agentMsgs  = msgs.filter(m => m.role === 'agent');
      const manualMsgs = msgs.filter(m => m.role === 'manual');
      const firstUserMsg = userMsgs[0];
      const lastUserMsg  = userMsgs[userMsgs.length - 1];
      const lastAgentMsg = agentMsgs[agentMsgs.length - 1] || manualMsgs[manualMsgs.length - 1];

      // Tiempo de respuesta del bot promedio
      let respDeltas = [];
      for (let i = 0; i < msgs.length - 1; i++) {
        if (msgs[i].role === 'user' && (msgs[i+1].role === 'agent' || msgs[i+1].role === 'manual')) {
          respDeltas.push((new Date(msgs[i+1].createdAt) - new Date(msgs[i].createdAt)) / 1000);
        }
      }
      const avgRespSec = respDeltas.length > 0
        ? Math.round(respDeltas.reduce((a, b) => a + b, 0) / respDeltas.length)
        : '';

      const firstMsgAt = msgs[0]?.createdAt || l.createdAt;
      const lastMsgAt  = msgs[msgs.length - 1]?.createdAt || l.last_message_at;
      const durationH = firstMsgAt && lastMsgAt
        ? +((new Date(lastMsgAt) - new Date(firstMsgAt)) / 3_600_000).toFixed(1)
        : '';

      const delivery = (deliveriesByLead[l._id] || [])[0];
      const igUser = l.ig_username || '';

      rows.push([
        isoDate(firstMsgAt),
        isoTime(firstMsgAt),
        igUser,
        igUser ? `https://instagram.com/${igUser}` : '',
        l.ig_user_id || '',
        l.channel || 'instagram',
        l.contact_name || '',
        l.pipeline_stage || 'nuevo',
        l.deal_value || '',
        l.deal_currency || '',
        (l.tags || []).join(' | '),
        scoreByLead[l._id] ?? '',
        isoDate(l.next_followup_at),
        agentById[l.agent_id] || '',
        l.status || '',
        l.automation || 'automated',
        l.qualification || 'sin_calificar',
        truncate(l.qualification_reason, 200),
        l.qualification === 'hot'  ? 'sí' : '',
        l.qualification === 'warm' ? 'sí' : '',
        l.qualification === 'cold' ? 'sí' : '',
        l.is_converted ? 'sí' : 'no',
        l.is_bypassed  ? 'sí' : 'no',
        l.limit_reached ? 'sí' : '',
        msgs.length,
        userMsgs.length,
        agentMsgs.length,
        manualMsgs.length,
        truncate(firstUserMsg?.content, 150),
        truncate(lastUserMsg?.content, 150),
        truncate(lastAgentMsg?.content, 150),
        isoTime(lastMsgAt),
        l.email || '',
        l.phone || '',
        delivery ? (magnetById[delivery.magnet_id] || delivery.magnet_id) : '',
        delivery ? isoDate(delivery.createdAt) : '',
        durationH,
        avgRespSec,
        truncate(l.admin_notes || l.notes, 200),
      ]);
    }

    const csv = rows.map(row => row.map(cell => {
      let s = String(cell ?? '');
      // Defensa CSV-injection (OWASP): '=' y '@' al inicio se interpretan como
      // fórmula al abrir en Excel — se neutralizan con apóstrofe. (+ y - se
      // dejan: teléfonos E.164 y números negativos legítimos.)
      if (/^[=@]/.test(s)) s = "'" + s;
      // Escapar comillas y envolver si contiene separador/nueva línea/comillas
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',')).join('\n');

    const filename = `atinov-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM para que Excel abra bien los acentos
    res.send('\uFEFF' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT XLSX — la planilla "buena" (multi-hoja, abre perfecto en Excel es-CL)
// ─────────────────────────────────────────────────────────────────────────────
// Por qué XLSX: Excel en español usa PUNTO Y COMA como separador, así que un
// CSV con comas se abre todo en una columna ("el desastre"). El XLSX nativo
// no tiene delimitador, conserva acentos, teléfonos con + y fechas reales.
// El CSV queda como formato de IMPORT a otros CRM (HubSpot/Pipedrive/Airtable).
//
// Hojas: Resumen (mini-dashboard) · Leads (accionable) · Conversaciones · Léeme

/** GET /api/growth/export-xlsx?accountId=X */
router.get('/export-xlsx', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const writeXlsxFile = require('write-excel-file/node');

    const leads   = await db.find(db.leads,    { account_id: accountId });
    const allMsgs = await db.find(db.messages, {});
    const msgsByLead = {};
    for (const m of allMsgs) {
      if (!m.lead_id) continue;
      (msgsByLead[m.lead_id] = msgsByLead[m.lead_id] || []).push(m);
    }
    for (const id of Object.keys(msgsByLead)) {
      msgsByLead[id].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }

    // Scores del RAG (graceful si está apagado)
    const scoreByLead = {};
    try {
      const { isEnabled, getClient } = require('../services/rag/supabase');
      if (isEnabled()) {
        const client = getClient();
        if (client) {
          const { data } = await client.from('lead_scores')
            .select('lead_id, score').eq('account_id', accountId).limit(2000);
          for (const r of (data || [])) scoreByLead[r.lead_id] = Math.round(r.score);
        }
      }
    } catch (e) { /* RAG opcional */ }

    const CALIF  = { hot: 'Caliente', warm: 'Tibio', cold: 'Frío' };
    const ETAPA  = { nuevo: 'Nuevo', contactado: 'Contactado', calificado: 'Calificado', demo: 'Demo / Llamada', propuesta: 'Propuesta', ganado: 'Ganado', perdido: 'Perdido' };
    const QUIEN  = { user: 'Lead', agent: 'Agente IA', manual: 'Humano' };
    const trunc  = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
    const fecha  = (s) => s ? new Date(s) : null;

    // Header con estilo (verde Atinov suave)
    const H = (value) => ({ value, fontWeight: 'bold', backgroundColor: '#ECFDF5', color: '#065F46' });

    // ── Hoja 1: Resumen ──────────────────────────────────────────────────────
    const hot   = leads.filter(l => l.qualification === 'hot').length;
    const warm  = leads.filter(l => l.qualification === 'warm').length;
    const cold  = leads.filter(l => l.qualification === 'cold').length;
    const conv  = leads.filter(l => l.is_converted).length;
    const pipeVal = leads.filter(l => l.pipeline_stage !== 'perdido')
      .reduce((s, l) => s + (Number(l.deal_value) || 0), 0);
    const porEtapa = Object.entries(ETAPA).map(([id, label]) =>
      [{ value: label }, { value: leads.filter(l => (l.pipeline_stage || 'nuevo') === id).length, type: Number }]);

    const sheetResumen = [
      [H('Reporte de leads — Atinov'), H('')],
      [{ value: 'Fecha de exportación' }, { value: new Date(), type: Date, format: 'dd/mm/yyyy hh:mm' }],
      [{ value: 'Total de leads' },       { value: leads.length, type: Number }],
      [{ value: 'Calientes' },            { value: hot,  type: Number }],
      [{ value: 'Tibios' },               { value: warm, type: Number }],
      [{ value: 'Fríos' },                { value: cold, type: Number }],
      [{ value: 'Convertidos' },          { value: conv, type: Number }],
      [{ value: 'Valor del pipeline' },   { value: pipeVal, type: Number, format: '#,##0' }],
      [{ value: '' }, { value: '' }],
      [H('Leads por etapa'), H('Cantidad')],
      ...porEtapa,
    ];

    // ── Hoja 2: Leads (orden por accionabilidad) ─────────────────────────────
    const headerLeads = [
      H('Nombre'), H('Usuario Instagram'), H('Teléfono'), H('Email'),
      H('Calificación'), H('Score de cierre'), H('Etapa'), H('Valor estimado'), H('Moneda'),
      H('Próximo seguimiento'), H('Último mensaje (fecha)'), H('Último mensaje (texto)'),
      H('Tags'), H('Canal'), H('Fecha primer contacto'), H('Mensajes'), H('Convertido'), H('Link Instagram'),
    ];
    // Calientes y mayor score primero — la fila 2 es el lead a llamar YA
    const ordenCalif = { hot: 0, warm: 1, cold: 2 };
    const leadsOrdenados = leads.slice().sort((a, b) =>
      (ordenCalif[a.qualification] ?? 3) - (ordenCalif[b.qualification] ?? 3) ||
      (scoreByLead[b._id] ?? -1) - (scoreByLead[a._id] ?? -1));

    const filasLeads = leadsOrdenados.map(l => {
      const msgs = msgsByLead[l._id] || [];
      const lastMsg = msgs[msgs.length - 1];
      return [
        { value: l.contact_name || '' },
        { value: l.ig_username ? '@' + l.ig_username : '' },
        { value: String(l.phone || ''), type: String },
        { value: l.email || '' },
        { value: CALIF[l.qualification] || 'Sin calificar' },
        scoreByLead[l._id] !== undefined ? { value: scoreByLead[l._id], type: Number } : { value: '' },
        { value: ETAPA[l.pipeline_stage] || 'Nuevo' },
        l.deal_value ? { value: Number(l.deal_value), type: Number, format: '#,##0' } : { value: '' },
        { value: l.deal_currency || '' },
        fecha(l.next_followup_at) ? { value: fecha(l.next_followup_at), type: Date, format: 'dd/mm/yyyy' } : { value: '' },
        fecha(l.last_message_at) ? { value: fecha(l.last_message_at), type: Date, format: 'dd/mm/yyyy hh:mm' } : { value: '' },
        { value: trunc(lastMsg?.content, 120), wrap: true },
        { value: (l.tags || []).join('; ') },
        { value: l.channel === 'whatsapp' ? 'WhatsApp' : 'Instagram DM' },
        fecha(l.createdAt) ? { value: fecha(l.createdAt), type: Date, format: 'dd/mm/yyyy' } : { value: '' },
        { value: msgs.length, type: Number },
        { value: l.is_converted ? 'Sí' : 'No' },
        { value: l.ig_username ? `https://instagram.com/${l.ig_username}` : '' },
      ];
    });
    const sheetLeads = [headerLeads, ...filasLeads];

    // ── Hoja 3: Conversaciones (1 fila por mensaje) ──────────────────────────
    const headerConv = [H('Usuario Instagram'), H('Fecha y hora'), H('Quién'), H('Mensaje')];
    const filasConv = [];
    for (const l of leadsOrdenados) {
      for (const m of (msgsByLead[l._id] || [])) {
        filasConv.push([
          { value: l.ig_username ? '@' + l.ig_username : (l.contact_name || '') },
          fecha(m.createdAt) ? { value: fecha(m.createdAt), type: Date, format: 'dd/mm/yyyy hh:mm' } : { value: '' },
          { value: QUIEN[m.role] || m.role },
          { value: trunc(m.content, 500), wrap: true },
        ]);
      }
    }
    const sheetConv = [headerConv, ...filasConv];

    // ── Hoja 4: Léeme ────────────────────────────────────────────────────────
    const sheetLeeme = [
      [H('Columna'), H('Qué significa')],
      [{ value: 'Calificación' }, { value: 'Caliente = listo para comprar · Tibio = interesado · Frío = sin interés todavía. La asigna el agente IA según la conversación.', wrap: true }],
      [{ value: 'Score de cierre' }, { value: '0 a 100. Probabilidad de cierre calculada comparando la conversación con tus ventas anteriores. Más alto = contactar primero.', wrap: true }],
      [{ value: 'Etapa' }, { value: 'Posición en tu pipeline (CRM de Atinov): Nuevo → Contactado → Calificado → Demo → Propuesta → Ganado/Perdido.', wrap: true }],
      [{ value: 'Tags' }, { value: 'Etiquetas separadas por punto y coma.', wrap: true }],
      [{ value: '' }, { value: '' }],
      [H('¿Importar a otro CRM?'), H('')],
      [{ value: 'HubSpot / Pipedrive / Airtable' }, { value: 'Usá el botón "CSV (importar a otro CRM)" en Atinov — ese archivo tiene los nombres de columna que esos sistemas reconocen.', wrap: true }],
      [{ value: 'Soporte' }, { value: 'soporte@atinov.com' }],
    ];

    const workbook = await writeXlsxFile([
      { name: 'Resumen', data: sheetResumen, stickyRowsCount: 1,
        columns: [{ width: 26 }, { width: 22 }] },
      { name: 'Leads', data: sheetLeads, stickyRowsCount: 1,
        columns: [{ width: 18 }, { width: 20 }, { width: 16 }, { width: 24 }, { width: 12 }, { width: 13 }, { width: 14 }, { width: 13 }, { width: 8 }, { width: 17 }, { width: 17 }, { width: 44 }, { width: 18 }, { width: 13 }, { width: 17 }, { width: 9 }, { width: 10 }, { width: 32 }] },
      { name: 'Conversaciones', data: sheetConv, stickyRowsCount: 1,
        columns: [{ width: 20 }, { width: 17 }, { width: 10 }, { width: 70 }] },
      { name: 'Léeme', data: sheetLeeme, stickyRowsCount: 1,
        columns: [{ width: 26 }, { width: 80 }] },
    ]);
    const buffer = await workbook.toBuffer();

    const filename = `atinov-leads-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    console.error('export-xlsx:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS de follow-ups (para dashboard del usuario)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/followup-stats?accountId=X
 */
router.get('/followup-stats', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const all = await db.find(db.followups, { account_id: accountId });
    res.json({
      total:     all.length,
      sent:      all.filter(f => f.sent_at).length,
      pending:   all.filter(f => !f.sent_at && !f.cancelled).length,
      cancelled: all.filter(f => f.cancelled).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/growth/analytics?accountId=X&days=30
 * Stats ricas para el dashboard del cliente:
 * - KPIs: leads totales, HOT/WARM/COLD, conversion rate, avg response time
 * - Serie temporal: leads por día (últimos N días)
 * - Distribución de calificación
 * - Funnel: total → respondido → calificado → HOT → convertido
 * - Top 10 fuentes (de dónde vienen los leads)
 * - Top 10 horas con más DMs (heatmap)
 */
router.get('/analytics', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 3_600_000);

    const leads = await db.find(db.leads, { account_id: accountId });
    const allMsgs = await db.find(db.messages, {});

    // Index msgs por lead
    const msgsByLead = {};
    for (const m of allMsgs) {
      if (!m.lead_id) continue;
      (msgsByLead[m.lead_id] = msgsByLead[m.lead_id] || []).push(m);
    }

    // KPIs principales
    const total      = leads.length;
    const hot        = leads.filter(l => l.qualification === 'hot').length;
    const warm       = leads.filter(l => l.qualification === 'warm').length;
    const cold       = leads.filter(l => l.qualification === 'cold').length;
    const unclass    = leads.filter(l => !l.qualification).length;
    const converted  = leads.filter(l => l.is_converted).length;
    const bypassed   = leads.filter(l => l.is_bypassed).length;
    const respondidos = Object.values(msgsByLead).filter(arr =>
      arr.some(m => m.role === 'agent' || m.role === 'manual')
    ).length;
    const conversionRate = total > 0 ? +((converted / total) * 100).toFixed(2) : 0;
    const qualifiedRate  = total > 0 ? +(((hot + warm + cold) / total) * 100).toFixed(2) : 0;
    const hotRate        = total > 0 ? +((hot / total) * 100).toFixed(2) : 0;

    // Avg response time (segundos) — sólo dentro de la ventana
    const allDeltas = [];
    for (const arr of Object.values(msgsByLead)) {
      for (let i = 0; i < arr.length - 1; i++) {
        if (arr[i].role === 'user' && (arr[i+1].role === 'agent' || arr[i+1].role === 'manual')) {
          const t = new Date(arr[i+1].createdAt) - new Date(arr[i].createdAt);
          if (t > 0 && t < 24 * 3_600_000) allDeltas.push(t / 1000);
        }
      }
    }
    const avgResponseSec = allDeltas.length > 0
      ? Math.round(allDeltas.reduce((a,b) => a+b, 0) / allDeltas.length)
      : null;

    // Serie temporal: leads por día (últimos N días)
    const leadsByDay = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3_600_000).toISOString().slice(0, 10);
      leadsByDay[d] = 0;
    }
    for (const l of leads) {
      const d = (l.createdAt || '').slice(0, 10);
      if (leadsByDay[d] !== undefined) leadsByDay[d]++;
    }

    // Distribución por hora (heatmap simple — 0-23h)
    const dmsByHour = Array(24).fill(0);
    for (const arr of Object.values(msgsByLead)) {
      for (const m of arr) {
        if (m.role !== 'user') continue;
        if (new Date(m.createdAt) < since) continue;
        const h = new Date(m.createdAt).getHours();
        dmsByHour[h]++;
      }
    }

    // Funnel
    const funnel = [
      { id: 'total',      label: 'Conversaciones totales', count: total },
      { id: 'respondido', label: 'Asistente respondió',    count: respondidos },
      { id: 'calificado', label: 'Asistente priorizó',     count: hot + warm + cold },
      { id: 'hot',        label: 'Cliente prioritario',    count: hot },
      { id: 'convertido', label: 'Convertido',             count: converted },
    ];

    // ── COMPARATIVA con período anterior ─────────────────────────────────
    // Misma duración hacia atrás. Ej: si days=30, comparamos 0-30d vs 30-60d.
    const prevSince = new Date(Date.now() - 2 * days * 24 * 3_600_000);
    const currentLeads = leads.filter(l => l.createdAt && new Date(l.createdAt) >= since);
    const prevLeads    = leads.filter(l => l.createdAt && new Date(l.createdAt) >= prevSince && new Date(l.createdAt) < since);
    const pctChange = (curr, prev) => {
      if (!prev) return curr > 0 ? 100 : 0;
      return +(((curr - prev) / prev) * 100).toFixed(1);
    };
    const compare = {
      total:     { current: currentLeads.length, prev: prevLeads.length, pct: pctChange(currentLeads.length, prevLeads.length) },
      hot:       { current: currentLeads.filter(l => l.qualification === 'hot').length,
                   prev:    prevLeads.filter(l => l.qualification === 'hot').length },
      converted: { current: currentLeads.filter(l => l.is_converted).length,
                   prev:    prevLeads.filter(l => l.is_converted).length },
    };
    compare.hot.pct       = pctChange(compare.hot.current,       compare.hot.prev);
    compare.converted.pct = pctChange(compare.converted.current, compare.converted.prev);

    // ── TOP KEYWORDS de mensajes de leads ────────────────────────────────
    // Stop words en español + inglés común. Heuristic simple: tokenizar,
    // bajar case, sacar stop words, contar frecuencia. Más útil que sentiment fancy.
    const STOP = new Set([
      // español
      'a','al','algo','algún','algun','alguna','algunas','alguno','algunos','allá','ante','aquel','aquella','así',
      'aún','aun','aunque','bastante','bien','cada','casi','cierto','como','con','contra','cual','cuales','cuán',
      'cuando','de','del','desde','donde','dos','el','él','ella','ellas','ellos','en','entre','era','eran','eres',
      'es','esa','esas','ese','eso','esos','esta','está','estaba','estado','estamos','están','estar','estas','este',
      'esto','estos','estoy','fue','fueron','fui','ha','había','han','hasta','hay','haya','hola','la','las','le',
      'les','lo','los','más','me','mi','mí','mientras','muy','nada','ni','no','nos','o','otra','otras','otro','otros',
      'para','pero','poco','por','porque','que','qué','quien','quién','se','sea','sea','ser','si','sí','sido','sin',
      'sobre','solo','sólo','son','soy','su','sus','también','tan','te','tengo','ti','tienen','tiene','toda','todas',
      'todo','todos','tu','tú','un','una','uno','unos','vos','y','ya','yo','ese','esos','aqui','aquí','ahi','ahí',
      'gracias','dale','okay','ok','si','no','que','pero','vez','ver',
      // ingles común
      'the','to','and','for','of','in','is','it','that','this','was','have','i','my','you','your','me','we','us','if',
      'or','as','at','be','an','by','do','dont','don','t','m','s','re','ve','ll',
    ]);
    const keywordCounts = {};
    for (const arr of Object.values(msgsByLead)) {
      for (const m of arr) {
        if (m.role !== 'user') continue;
        if (new Date(m.createdAt) < since) continue;
        const text = String(m.content || '').toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quitar tildes para agrupar mejor
          .replace(/[^a-z0-9\s]/g, ' ');
        const words = text.split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
        for (const w of words) {
          keywordCounts[w] = (keywordCounts[w] || 0) + 1;
        }
      }
    }
    const topKeywords = Object.entries(keywordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    // ── TOP LEADS (preview de últimos 20 con info de quick view) ────────
    const recentLeads = leads
      .sort((a, b) => new Date(b.last_message_at || b.createdAt) - new Date(a.last_message_at || a.createdAt))
      .slice(0, 20)
      .map(l => ({
        id:           l._id,
        ig_username:  l.ig_username || null,
        qualification: l.qualification || null,
        qualification_reason: l.qualification_reason ? String(l.qualification_reason).slice(0, 120) : null,
        is_converted: !!l.is_converted,
        is_bypassed:  !!l.is_bypassed,
        message_count: (msgsByLead[l._id] || []).length,
        last_message_at: l.last_message_at || l.createdAt,
        email:  l.email || null,
        phone:  l.phone || null,
      }));

    res.json({
      windowDays: days,
      kpis: {
        total, hot, warm, cold, unclass,
        converted, bypassed, respondidos,
        conversionRate, qualifiedRate, hotRate,
        avgResponseSec,
      },
      leadsByDay,
      qualificationBreakdown: { hot, warm, cold, sin_calificar: unclass },
      dmsByHour,
      funnel,
      compare,
      topKeywords,
      recentLeads,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT CONVERSACIONES COMPLETAS
// Devuelve TODOS los mensajes de TODOS los leads del account.
// Útil para casos de éxito, auditoría conversacional, fine-tuning de prompts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/growth/export-conversations?accountId=X&format=csv|json
 *
 * format=csv (default): 1 fila por mensaje, columnas legibles para Excel.
 * format=json: array estructurado con leads y messages anidados.
 */
router.get('/export-conversations', async (req, res) => {
  try {
    const { accountId, format = 'csv' } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    // Cargar todos los leads del account
    const leads = await db.find(db.leads, { account_id: accountId },
      (a, b) => new Date(b.last_message_at || b.createdAt) - new Date(a.last_message_at || a.createdAt));
    if (leads.length === 0) {
      return res.status(404).json({ error: 'No hay conversaciones para exportar' });
    }

    // Cargar agentes (para mostrar nombre del agente que respondió)
    const agents = await db.find(db.agents, { account_id: accountId });
    const agentById = {};
    for (const a of agents) agentById[a._id] = a.name;

    // Cargar TODOS los mensajes de TODOS los leads del account (1 query por lead)
    // Para evitar N+1 con muchos leads, podríamos hacer query con $in pero NeDB no lo soporta nativo
    // Para ≤500 leads esto está bien.
    const conversations = [];
    for (const lead of leads) {
      const messages = await db.find(db.messages, { lead_id: lead._id },
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      conversations.push({
        lead_id:               lead._id,
        ig_username:           lead.ig_username,
        ig_user_id:            lead.ig_user_id,
        agent_name:            agentById[lead.agent_id] || '(sin agente)',
        qualification:         lead.qualification || 'sin_calificar',
        qualification_reason:  lead.qualification_reason || '',
        status:                lead.status,
        automation:            lead.automation,
        is_bypassed:           !!lead.is_bypassed,
        is_converted:          !!lead.is_converted,
        triggered_by:          lead.triggered_by || '',
        first_seen:            lead.createdAt,
        last_message_at:       lead.last_message_at,
        message_count:         messages.length,
        messages:              messages.map(m => ({
          role:       m.role,
          content:    m.content,
          created_at: m.createdAt,
        })),
      });
    }

    const totalMessages = conversations.reduce((sum, c) => sum + c.message_count, 0);
    const exportedAt = new Date().toISOString();

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition',
        `attachment; filename="atinov-conversations-${exportedAt.slice(0, 10)}.json"`);
      return res.json({
        exported_at:    exportedAt,
        account_id:     accountId,
        total_leads:    conversations.length,
        total_messages: totalMessages,
        conversations,
      });
    }

    // CSV — 1 fila por mensaje. Si el lead no tiene mensajes (raro), 1 fila con campos vacíos.
    const csvRows = [];
    csvRows.push([
      'lead_id', 'ig_username', 'ig_user_id', 'agent_name', 'qualification',
      'qualification_reason', 'status', 'automation', 'is_bypassed', 'is_converted',
      'triggered_by', 'first_seen', 'last_message_at', 'message_index',
      'message_role', 'message_content', 'message_sent_at',
    ]);

    function csvEscape(val) {
      if (val === null || val === undefined) return '';
      const s = String(val);
      // CSV: si contiene coma/comilla/salto de línea, encerrar en comillas y escapar comillas internas
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }

    for (const c of conversations) {
      if (c.messages.length === 0) {
        csvRows.push([
          c.lead_id, c.ig_username, c.ig_user_id, c.agent_name, c.qualification,
          c.qualification_reason, c.status, c.automation, c.is_bypassed, c.is_converted,
          c.triggered_by, c.first_seen, c.last_message_at, '',
          '', '', '',
        ]);
      } else {
        for (let i = 0; i < c.messages.length; i++) {
          const m = c.messages[i];
          csvRows.push([
            c.lead_id, c.ig_username, c.ig_user_id, c.agent_name, c.qualification,
            c.qualification_reason, c.status, c.automation, c.is_bypassed, c.is_converted,
            c.triggered_by, c.first_seen, c.last_message_at, i + 1,
            m.role, m.content, m.created_at,
          ]);
        }
      }
    }

    const csv = csvRows.map(row => row.map(csvEscape).join(',')).join('\n');
    // BOM UTF-8 para que Excel abra con tildes y emojis correctos
    const bom = '﻿';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="atinov-conversations-${exportedAt.slice(0, 10)}.csv"`);
    res.send(bom + csv);
  } catch (e) {
    console.error('[export-conversations] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT CSV "CRM-ready" — 1 fila por lead, estructura importable
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/growth/export-crm?accountId=X
 *
 * CSV con 1 fila por lead y columnas en orden CRM estándar. Headers en
 * español por ahora (se internacionalizan después). La ESTRUCTURA (1 fila
 * = 1 contacto, columnas de pipeline/valor/etiquetas/fechas) es la que
 * HubSpot, Pipedrive, Airtable, Notion importan sin armar mapeo a mano.
 */
router.get('/export-crm', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId requerido' });
    if (accountId !== req.user.accountId) return res.status(403).json({ error: 'Prohibido' });

    const leads   = await db.find(db.leads,   { account_id: accountId });
    const agents  = await db.find(db.agents,  { account_id: accountId });
    const allMsgs = await db.find(db.messages, {});
    const agentById = Object.fromEntries(agents.map(a => [a._id, a.name]));

    const msgsByLead = {};
    for (const m of allMsgs) {
      if (!m.lead_id) continue;
      (msgsByLead[m.lead_id] = msgsByLead[m.lead_id] || []).push(m);
    }

    const isoDate = (s) => s ? new Date(s).toISOString().slice(0, 10) : '';
    const clean   = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // Orden de columnas estándar CRM (1 fila = 1 contacto)
    const header = [
      'Nombre',            // contact_name o @usuario
      'Email',
      'Telefono',
      'Empresa',           // vacío por ahora (Instagram no lo da)
      'Etapa',             // pipeline_stage (nombre legible)
      'Calificacion',      // hot/warm/cold
      'Valor',             // deal_value
      'Moneda',            // deal_currency
      'Origen',            // triggered_by legible
      'Canal',             // instagram/whatsapp
      'Etiquetas',         // tags separados por ;
      'Fecha Creacion',
      'Ultima Actividad',
      'Proximo Seguimiento',
      'Convertido',
      'Instagram',         // @usuario
      'URL Instagram',
      'Agente Asignado',
      'Notas',             // admin_notes + última nota del timeline
    ];
    const rows = [header];

    const sourceLabel = {
      dm_keyword: 'DM (keyword)',
      comment:    'Comentario IG',
      wa_dm:      'WhatsApp',
      '':         'DM directo',
    };

    for (const l of leads) {
      const msgs = (msgsByLead[l._id] || []).sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );
      const lastMsgAt = msgs.length ? msgs[msgs.length - 1].createdAt : l.last_message_at;
      const stage = l.pipeline_stage
        || PIPE.autoStageFromQualification(null, l.qualification, l.is_converted);
      const stageName = PIPE.STAGE_BY_ID[stage]?.name || stage || 'Nuevo';
      const lastNote = Array.isArray(l.activity_log) && l.activity_log.length
        ? l.activity_log[l.activity_log.length - 1].text : '';
      const igUser = l.ig_username || '';

      rows.push([
        clean(l.contact_name || igUser || l.wa_name || ''),
        l.email || '',
        l.phone || '',
        '',                                             // Empresa (futuro)
        stageName,
        l.qualification || 'sin_calificar',
        l.deal_value || 0,
        l.deal_currency || 'USD',
        sourceLabel[l.triggered_by || ''] || (l.triggered_by || 'DM directo'),
        l.channel || 'instagram',
        Array.isArray(l.tags) ? l.tags.join(';') : '',
        isoDate(msgs[0]?.createdAt || l.createdAt),
        isoDate(lastMsgAt),
        isoDate(l.next_followup_at),
        l.is_converted ? 'Si' : 'No',
        igUser,
        igUser ? `https://instagram.com/${igUser}` : '',
        agentById[l.agent_id] || '',
        clean([l.admin_notes || l.notes, lastNote].filter(Boolean).join(' | ')).slice(0, 500),
      ]);
    }

    const csv = rows.map(row => row.map(cell => {
      const s = String(cell ?? '');
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',')).join('\n');

    const filename = `atinov-crm-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv); // BOM para acentos en Excel
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
