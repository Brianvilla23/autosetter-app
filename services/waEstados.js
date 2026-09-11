/**
 * Atinov — Estados de entrega de WhatsApp
 *
 * POR QUÉ EXISTE: Meta acepta un envío con HTTP 200 y un id, y recién DESPUÉS
 * avisa por webhook (`statuses`) si lo entregó, lo leyeron o FALLÓ. Nadie leía
 * esos avisos: el 2026-09-10 el panel mostró "10/10 enviadas" para diez notas
 * de voz que nunca llegaron. La causa era la ventana de 24 h (código 131047):
 * WhatsApp solo deja mandar texto o audio libre si esa persona le escribió al
 * número del negocio en las últimas 24 horas. Meta lo rechaza en silencio y
 * el panel decía lo contrario.
 *
 * Tres cosas viven acá:
 *   1. registrarEstadosWa — guarda cada estado que llega por webhook.
 *   2. esperarEstados     — espera (con tope) a que los ids de un envío tengan
 *                           estado final, para mostrar ENTREGA y no "aceptado".
 *   3. ventana24hAbierta  — mira en NUESTRA base si el destinatario escribió
 *                           en las últimas 24 h, para avisar ANTES de enviar.
 */

const db = require('../db/database');

const VENTANA_MS = 24 * 60 * 60 * 1000;
const FINALES = new Set(['delivered', 'read', 'failed']);

/** Solo dígitos: `+56 9 9568 4130` y `56995684130` son el mismo wa_id. */
function normalizarWaId(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Traduce un código de error de Meta a algo que el dueño pueda arreglar.
 * Códigos de https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
function explicarFallo(codigo, detalle = '', numeroNegocio = 'el WhatsApp del negocio') {
  const c = Number(codigo);
  if (c === 131047) {
    return `Ventana de 24 horas cerrada: WhatsApp solo entrega mensajes libres si esa persona le escribió a ${numeroNegocio} en las últimas 24 h. Que le mande un "hola" desde su teléfono y reintenta.`;
  }
  if (c === 131026) return 'El número no está en WhatsApp o bloqueó al negocio (Meta: "message undeliverable").';
  if (c === 131053) return `Meta no pudo subir el archivo de audio (formato o tamaño). Detalle: ${detalle || 'sin detalle'}.`;
  if (c === 131049) return 'Meta frenó el envío por su límite de mensajes de marketing a esta persona ("healthy ecosystem").';
  if (c === 130472) return 'Meta excluyó a este número por un experimento suyo; no se puede forzar.';
  if (c === 131031 || c === 133010) return 'El número del negocio está restringido o no registrado en WhatsApp Cloud API.';
  return detalle ? `Error ${codigo} de Meta: ${detalle}` : `Error ${codigo} de Meta.`;
}

/** Resume un objeto `statuses[i]` de Meta al mínimo que guardamos. */
function resumirEstado(st) {
  if (!st || !st.id) return null;
  const err = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
  return {
    wamid:        String(st.id),
    destinatario: normalizarWaId(st.recipient_id),
    estado:       String(st.status || '').toLowerCase(),
    codigo:       err ? Number(err.code) || null : null,
    titulo:       err ? String(err.title || '').slice(0, 120) : null,
    detalle:      err ? String(err.error_data?.details || err.message || '').slice(0, 300) : null,
    ts:           st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString(),
  };
}

/**
 * Guarda los estados que trae un webhook. Un estado por documento: `delivered`
 * después de `sent` no pisa nada, se acumula, y el que consulta se queda con
 * el más avanzado.
 */
async function registrarEstadosWa({ phoneNumberId, statuses }) {
  const cuenta = await db.findOne(db.accounts, { wa_phone_number_id: phoneNumberId });
  const guardados = [];
  for (const st of statuses || []) {
    const r = resumirEstado(st);
    if (!r) continue;
    await db.insert(db.waEstados, { ...r, account_id: cuenta ? cuenta._id : null, phone_number_id: phoneNumberId });
    guardados.push(r);
    if (r.estado === 'failed') {
      console.warn(`[wa] entrega FALLIDA ${r.wamid} → ${r.destinatario}: ${r.codigo} ${r.titulo || ''} — ${r.detalle || ''}`);
    }
  }
  return guardados;
}

/** Peso de cada estado para quedarse con el más avanzado. `failed` gana siempre. */
const PESO = { sent: 1, delivered: 2, read: 3, failed: 9 };

/** Estado más avanzado registrado para cada wamid pedido. */
async function estadosDe(wamids) {
  const out = {};
  for (const id of wamids) {
    const docs = await db.find(db.waEstados, { wamid: id });
    let mejor = null;
    for (const d of docs) if (!mejor || (PESO[d.estado] || 0) > (PESO[mejor.estado] || 0)) mejor = d;
    if (mejor) out[id] = { estado: mejor.estado, codigo: mejor.codigo, titulo: mejor.titulo, detalle: mejor.detalle };
  }
  return out;
}

/**
 * Espera hasta `ms` a que TODOS los wamids tengan estado final (delivered,
 * read o failed). Devuelve lo que haya al cortar: un id sin estado final
 * queda como "aceptado, sin confirmación".
 */
async function esperarEstados({ wamids, ms = 12000, cada = 1500 }) {
  const ids = (wamids || []).filter(Boolean);
  const fin = Date.now() + ms;
  let actual = {};
  while (true) {
    actual = await estadosDe(ids);
    const listos = ids.every(id => actual[id] && FINALES.has(actual[id].estado));
    if (listos || Date.now() >= fin) return actual;
    await new Promise(r => setTimeout(r, cada));
  }
}

/**
 * ¿Esa persona le escribió al negocio en las últimas 24 h? Se mira el último
 * mensaje ENTRANTE (role 'user') del lead con ese wa_id. Las respuestas del
 * agente o del dueño no abren la ventana: solo lo que escribe la persona.
 */
async function ventana24hAbierta({ accountId, waId, ahora = Date.now() }) {
  const id = normalizarWaId(waId);
  const lead = await db.findOne(db.leads, { account_id: accountId, wa_id: id });
  if (!lead) return { abierta: false, ultimoEntrante: null, motivo: 'ese número nunca le ha escrito al negocio' };
  const entrantes = await db.find(db.messages, { lead_id: lead._id, role: 'user' });
  let ultimo = null;
  for (const m of entrantes) if (m.createdAt && (!ultimo || m.createdAt > ultimo)) ultimo = m.createdAt;
  if (!ultimo) return { abierta: false, ultimoEntrante: null, motivo: 'no hay mensajes entrantes de ese número' };
  const abierta = ahora - new Date(ultimo).getTime() < VENTANA_MS;
  return { abierta, ultimoEntrante: ultimo, motivo: abierta ? null : 'su último mensaje tiene más de 24 horas' };
}

module.exports = {
  VENTANA_MS, FINALES,
  normalizarWaId, explicarFallo, resumirEstado,
  registrarEstadosWa, estadosDe, esperarEstados, ventana24hAbierta,
};
