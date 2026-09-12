/**
 * Atinov — Memoria por lead (cross-canal) — ahora "memoria que razona"
 *
 * El RAG aprende a nivel de NEGOCIO (conversaciones ganadas/perdidas).
 * Esta capa aprende a nivel de LEAD individual: presupuesto, objeciones,
 * preferencias, contexto personal — y lo recuerda en la siguiente
 * conversación venga por el canal que venga ("preguntó por implantes en
 * IG hace 2 semanas, hoy vuelve por WhatsApp").
 *
 * Dos capas, en el MISMO documento del lead y extraídas en la MISMA llamada:
 *  - memory_facts   (string[])  — la ficha en texto libre de siempre. No se toca.
 *  - memory_profile (objeto)    — lo que vale la pena leer POR CÓDIGO y
 *    razonar: qué quiere, urgencia, objeciones vivas vs resueltas, lo que se
 *    le prometió, lo que YA RESPONDIÓ (para no volver a preguntárselo) y cómo
 *    escribe. Pedido de Brayan (2026-09-12): "recordar lo que nos dice el
 *    lead y, si volvemos a preguntarle, retomar esa conversación".
 *
 * Costo: la misma llamada a gpt-4o-mini que ya corría (max_tokens 500 → 800):
 * del orden de +US$0,00006 por turno. No es un servicio nuevo, es un JSON
 * más grande en la respuesta del que ya existe. Fail-open: si el perfil no
 * viene o no parsea, se sigue con los hechos de siempre.
 */

const OpenAI = require('openai');
const db     = require('../db/database');

const MAX_FACTS = 12;

// No gastar el extractor en el "hola" inicial: correr recién cuando hay
// conversación real (2+ mensajes del lead).
const MIN_USER_MESSAGES = 2;

const URGENCIAS = ['alta', 'media', 'baja'];
const ETAPAS    = ['explorando', 'evaluando_opciones', 'listo_para_decidir', 'frenado', 'perdido'];
const CERTEZAS  = ['alta', 'media', 'baja'];

const LIMPIA = (v, n) => String(v || '').trim().slice(0, n);

/**
 * Deja el perfil en una forma segura para guardar e inyectar: tipos
 * correctos, listas acotadas, nada que un prompt pueda usar para inyectar.
 * Devuelve null si no hay nada aprovechable.
 */
function sanearPerfil(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = {};

  const quiere = LIMPIA(raw.quiere, 200);
  if (quiere) p.quiere = quiere;

  if (raw.presupuesto && typeof raw.presupuesto === 'object') {
    const monto = Number(raw.presupuesto.monto);
    const moneda = LIMPIA(raw.presupuesto.moneda, 8).toUpperCase();
    if (Number.isFinite(monto) && monto > 0) {
      p.presupuesto = { monto, moneda: moneda || 'CLP', certeza: CERTEZAS.includes(raw.presupuesto.certeza) ? raw.presupuesto.certeza : 'media' };
    }
  }

  if (URGENCIAS.includes(raw.urgencia)) p.urgencia = raw.urgencia;
  if (ETAPAS.includes(raw.etapa_percibida)) p.etapa_percibida = raw.etapa_percibida;

  if (Array.isArray(raw.objeciones)) {
    p.objeciones = raw.objeciones
      .filter(o => o && typeof o === 'object' && LIMPIA(o.detalle, 1))
      .slice(0, 6)
      .map(o => ({ tipo: LIMPIA(o.tipo, 30) || 'otra', detalle: LIMPIA(o.detalle, 160), resuelta: o.resuelta === true }));
  }

  if (Array.isArray(raw.compromisos)) {
    p.compromisos = raw.compromisos
      .filter(c => c && typeof c === 'object' && LIMPIA(c.que, 1))
      .slice(0, 6)
      .map(c => ({ que: LIMPIA(c.que, 160), cumplido: c.cumplido === true }));
  }

  // Lo que la persona YA contestó: para retomar, no para volver a preguntar.
  if (Array.isArray(raw.ya_respondio)) {
    p.ya_respondio = raw.ya_respondio
      .filter(x => x && typeof x === 'object' && LIMPIA(x.pregunta, 1) && LIMPIA(x.respuesta, 1))
      .slice(0, 8)
      .map(x => ({ pregunta: LIMPIA(x.pregunta, 100), respuesta: LIMPIA(x.respuesta, 160) }));
  }

  if (Array.isArray(raw.contexto_personal)) {
    p.contexto_personal = raw.contexto_personal.filter(s => typeof s === 'string' && s.trim()).slice(0, 6).map(s => LIMPIA(s, 140));
  }

  if (raw.estilo_escritura && typeof raw.estilo_escritura === 'object') {
    const e = raw.estilo_escritura;
    const est = {};
    if (LIMPIA(e.registro, 1)) est.registro = LIMPIA(e.registro, 120);
    const largo = Number(e.largo_tipico_palabras);
    if (Number.isFinite(largo) && largo > 0) est.largo_tipico_palabras = Math.round(largo);
    if (typeof e.usa_emojis === 'boolean') est.usa_emojis = e.usa_emojis;
    if (Array.isArray(e.muletillas)) est.muletillas = e.muletillas.filter(m => typeof m === 'string' && m.trim()).slice(0, 5).map(m => LIMPIA(m, 20));
    if (Object.keys(est).length) p.estilo_escritura = est;
  }

  return Object.keys(p).length ? p : null;
}

/**
 * Bloque de contexto para el system prompt. null si el lead no tiene memoria.
 * Con memory_profile arma el bloque RAZONADO (qué no repetir, qué retomar,
 * qué se prometió); sin él, la lista de hechos de siempre.
 */
function buildMemoryContext(lead) {
  const facts = Array.isArray(lead?.memory_facts) ? lead.memory_facts.filter(Boolean) : [];
  const p = lead?.memory_profile && typeof lead.memory_profile === 'object' ? lead.memory_profile : null;
  if (!facts.length && !p) return null;

  const lineas = ['--- MEMORIA DEL LEAD (lo que ya conversaron, cualquier canal) ---'];

  if (p) {
    if (p.quiere) lineas.push(`Quiere: ${p.quiere}.`);
    if (p.presupuesto) {
      const inc = p.presupuesto.certeza === 'baja' ? ' (lo insinuó, no lo confirmó: no se lo afirmes como suyo)' : '';
      lineas.push(`Presupuesto: ${p.presupuesto.monto.toLocaleString('es-CL')} ${p.presupuesto.moneda}${inc}.`);
    }
    if (p.urgencia === 'alta') lineas.push('Urgencia: ALTA — no lo hagas esperar con preguntas que ya respondió; ve al siguiente paso.');
    else if (p.urgencia) lineas.push(`Urgencia: ${p.urgencia}.`);
    if (p.etapa_percibida) lineas.push(`Etapa: ${p.etapa_percibida.replace(/_/g, ' ')}.`);

    const vivas = (p.objeciones || []).filter(o => !o.resuelta);
    const resueltas = (p.objeciones || []).filter(o => o.resuelta);
    for (const o of vivas) {
      lineas.push(`Objeción SIN resolver (${o.tipo}): ${o.detalle} — si vuelve a tocarla, NO repitas el argumento que ya no le convenció: prueba otro ángulo o pregúntale qué necesitaría para quedarse tranquilo.`);
    }
    for (const o of resueltas) lineas.push(`Objeción ya resuelta (${o.tipo}): ${o.detalle} — no la vuelvas a abrir.`);

    for (const c of (p.compromisos || [])) {
      lineas.push(c.cumplido ? `Ya se le entregó: ${c.que}.` : `Se le PROMETIÓ y sigue pendiente: ${c.que} — no prometas otra cosa antes de cumplir o explicar esta.`);
    }

    if ((p.ya_respondio || []).length) {
      lineas.push('Ya te respondió (NO se lo vuelvas a preguntar; si el tema reaparece, retoma desde su respuesta con "como me contaste…"):');
      for (const x of p.ya_respondio) lineas.push(`  · ${x.pregunta} → ${x.respuesta}`);
    }

    if ((p.contexto_personal || []).length) lineas.push(`Contexto: ${p.contexto_personal.join('; ')}.`);

    const e = p.estilo_escritura;
    if (e) {
      const partes = [];
      if (e.registro) partes.push(e.registro);
      if (e.largo_tipico_palabras) partes.push(`mensajes de ~${e.largo_tipico_palabras} palabras`);
      if (typeof e.usa_emojis === 'boolean') partes.push(e.usa_emojis ? 'usa emojis' : 'no usa emojis');
      if ((e.muletillas || []).length) partes.push(`dice "${e.muletillas.join('", "')}"`);
      if (partes.length) lineas.push(`Escribe así: ${partes.join(', ')} — espéjalo sin exagerar.`);
    }
  }

  if (facts.length) {
    if (p) lineas.push('Otros hechos:');
    lineas.push(...facts.map(f => `• ${f}`));
  }

  lineas.push('Usa todo esto con naturalidad ("como me contaste...", "tú que buscabas..."). NUNCA lo recites en lista ni digas que tienes "memoria", "perfil" o "registro". Si algo contradice lo que la persona dice HOY, manda lo de hoy.');
  return lineas.join('\n');
}

const SYS_EXTRACTOR = `Mantienes la ficha de memoria de un prospecto de ventas. Te paso los hechos ya conocidos, el perfil ya conocido y la conversación reciente. Devuelve SOLO un objeto JSON con dos claves:

"facts": array de strings con la ficha ACTUALIZADA (máximo ${MAX_FACTS}). Qué es un hecho útil: presupuesto, qué busca exactamente, urgencia/plazos, objeciones que puso, datos de contacto que dio, contexto personal o del negocio relevante para venderle, qué se le prometió o envió. Formato "Categoría: dato" (ej: "Presupuesto: hasta $500 mil CLP"). Fusiona duplicados, actualiza lo que cambió (manda lo más reciente), elimina lo irrelevante o especulativo. Máximo 120 caracteres cada uno, en español.

"perfil": objeto con lo que se pueda razonar (omite las claves que no sepas, NO inventes):
  "quiere": string corto (qué busca, para qué),
  "presupuesto": { "monto": número, "moneda": "CLP"|"USD"|..., "certeza": "alta"|"media"|"baja" },
  "urgencia": "alta"|"media"|"baja",
  "etapa_percibida": "explorando"|"evaluando_opciones"|"listo_para_decidir"|"frenado"|"perdido",
  "objeciones": [ { "tipo": "precio"|"tiempo"|"desconfianza"|"competencia"|"otra", "detalle": string, "resuelta": true|false } ],
  "compromisos": [ { "que": string (lo que el AGENTE prometió), "cumplido": true|false } ],
  "ya_respondio": [ { "pregunta": string (qué se le preguntó), "respuesta": string (qué contestó) } ] — SOLO preguntas que la persona ya contestó, para no volver a preguntárselas,
  "contexto_personal": [ string ],
  "estilo_escritura": { "registro": string, "largo_tipico_palabras": número, "usa_emojis": true|false, "muletillas": [ string ] }

Reglas: una objeción pasa a "resuelta": true solo si la persona lo dio por superado. "certeza": "baja" si el monto es una inferencia tuya. Si no hay nada que valga la pena, devuelve {"facts": [], "perfil": {}}.`;

/** Llamada real a OpenAI (se puede inyectar otra en tests). */
async function completarConOpenAI({ apiKey, system, user }) {
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return res.choices?.[0]?.message?.content || '{}';
}

/** Saca el JSON aunque venga con texto alrededor; tolera el formato viejo (array). */
function parsearRespuesta(raw) {
  const s = String(raw || '').trim();
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    try { const j = JSON.parse(obj[0]); if (j && typeof j === 'object') return { facts: j.facts, perfil: j.perfil }; } catch { /* sigue */ }
  }
  const arr = s.match(/\[[\s\S]*\]/);
  if (arr) {
    try { const a = JSON.parse(arr[0]); if (Array.isArray(a)) return { facts: a, perfil: null }; } catch { /* sigue */ }
  }
  return null;
}

/**
 * Extrae/actualiza hechos + perfil del lead a partir de la conversación
 * reciente. Fire-and-forget desde runConversation (mismo patrón que classifyLead).
 */
async function updateLeadMemory({ leadId, apiKey, completar = completarConOpenAI }) {
  if (!apiKey) return null;

  const lead = await db.findOne(db.leads, { _id: leadId });
  if (!lead) return null;

  const messages = await db.find(db.messages, { lead_id: leadId },
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const userCount = messages.filter(m => m.role === 'user').length;
  if (userCount < MIN_USER_MESSAGES) return null;

  // Últimos 12 turnos alcanzan: lo viejo ya está en la ficha y el perfil.
  const recent = messages.slice(-12)
    .map(m => `${m.role === 'user' ? 'LEAD' : 'AGENTE'}: ${String(m.content).slice(0, 300)}`)
    .join('\n');
  const existing = Array.isArray(lead.memory_facts) ? lead.memory_facts : [];
  const perfilPrevio = lead.memory_profile && typeof lead.memory_profile === 'object' ? lead.memory_profile : {};

  try {
    const raw = await completar({
      apiKey,
      system: SYS_EXTRACTOR,
      user: `HECHOS CONOCIDOS:\n${existing.length ? existing.map(f => `- ${f}`).join('\n') : '(ninguno)'}\n\nPERFIL CONOCIDO:\n${JSON.stringify(perfilPrevio)}\n\nCONVERSACIÓN RECIENTE:\n${recent}`,
    });
    const r = parsearRespuesta(raw);
    if (!r) return null;

    let facts = Array.isArray(r.facts) ? r.facts : [];
    facts = facts
      .filter(f => typeof f === 'string' && f.trim().length > 3)
      .map(f => f.trim().slice(0, 160))
      .slice(0, MAX_FACTS);
    const perfil = sanearPerfil(r.perfil);

    // Nunca vaciar memoria existente por una extracción vacía: los hechos
    // solo se reemplazan por hechos, y el perfil solo por perfil.
    const upd = { memory_updated_at: new Date().toISOString() };
    if (facts.length || !existing.length) upd.memory_facts = facts;
    if (perfil) upd.memory_profile = { ...perfil, ultima_actualizacion: upd.memory_updated_at };
    if (!('memory_facts' in upd) && !perfil) return null;

    await db.update(db.leads, { _id: leadId }, upd);
    return { facts: upd.memory_facts || existing, perfil: upd.memory_profile || perfilPrevio };
  } catch (e) {
    console.warn('[memoria] extracción falló (no bloquea):', e.message);
    return null;
  }
}

module.exports = { buildMemoryContext, updateLeadMemory, sanearPerfil, parsearRespuesta, MAX_FACTS };
