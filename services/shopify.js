/**
 * Atinov — Confirmación de pedidos de Shopify por WhatsApp
 *
 * El flujo del e-commerce chileno (contra-entrega / despacho por confirmar):
 * entra un pedido en Shopify → webhook → se crea el lead con el pedido en su
 * ficha → sale el mensaje de confirmación por WhatsApp (template aprobado) →
 * cuando la clienta responde, el agente YA SABE qué pidió, a qué dirección y
 * cuándo llega, y conversa: confirma, corrige la dirección o cancela.
 *
 * Todo lo que el dueño hoy copia a mano (nombre, producto, dirección, fecha)
 * viene en el webhook — no se saca de pantallazos.
 *
 * FAIL-CLOSED: sin `shopify_webhook_secret` en los settings de la cuenta el
 * webhook rechaza todo y el módulo es inerte. Sin WhatsApp conectado no se
 * envía nada (el pedido igual queda registrado en el lead).
 *
 * Cierre del ciclo: el agente marca el resultado con
 *   [PEDIDO: confirmado]  ·  [PEDIDO: direccion | nueva dirección]  ·  [PEDIDO: cancelado]
 * y este módulo actualiza el lead, avisa al dueño y registra el evento
 * facturable — mismo contrato que [PAGO:] y [AGENDAR:].
 */

const crypto = require('crypto');
const db     = require('../db/database');

const TZ = 'America/Santiago';
// Tolerante a propósito: puntuación pegada ("confirmado.") y detalles cortos
// ("5B") deben matchear igual — un marcador que no matchea se borra en el
// scrub y el pedido se despacharía con datos viejos, en silencio.
const MARKER_RE = /\[PEDIDO:\s*(confirmado|cancelado|direccion|dirección)\s*[.,;]?\s*(?:\|\s*([^\]]{1,200}))?\s*\]/gi;

// Un pedido deja de inyectarse al prompt pasados estos días aunque nadie lo
// haya resuelto: si no, TODA conversación futura de esa clienta arrancaría
// con un pedido viejo y una fecha de entrega congelada.
const VIGENCIA_DIAS = 14;

// ── Verificación de firma ─────────────────────────────────────────────────────

/**
 * Shopify firma con HMAC-SHA256 del cuerpo CRUDO en base64 (X-Shopify-Hmac-Sha256).
 * Comparación en tiempo constante; cualquier duda → false.
 */
function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!rawBody || !hmacHeader || !secret) return false;
  try {
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    const a = Buffer.from(digest);
    const b = Buffer.from(String(hmacHeader));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ── Normalización de teléfono chileno → wa_id ────────────────────────────────

/**
 * Shopify entrega el teléfono como lo escribió el cliente: "+56 9 1234 5678",
 * "912345678", "56912345678", "9 1234 5678". WhatsApp necesita "56912345678".
 * Devuelve null si no se puede normalizar con confianza (mejor no mandar nada
 * que mandarle el pedido a un desconocido).
 */
function normalizePhoneCL(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0056')) d = d.slice(2);          // 0056... → 56...
  if (d.startsWith('56') && d.length === 11) return d;         // 56 9 XXXXXXXX
  if (d.length === 9 && d.startsWith('9')) return `56${d}`;    // 9XXXXXXXX
  // 8 dígitos NO se completan con "9": un fijo antiguo escrito sin código de
  // área ("23456789") se convertiría en el móvil de un DESCONOCIDO, que
  // recibiría nombre, dirección y monto del pedido. Preferimos no contactar.
  // Extranjero: se acepta tal cual si es un largo internacional plausible.
  if (d.length >= 10 && d.length <= 15) return d;
  return null;
}

// ── Fechas ────────────────────────────────────────────────────────────────────

/** Suma N días HÁBILES a hoy y devuelve { iso, legible } en hora de Chile. */
function etaHabiles(dias = 3) {
  const d = new Date();
  const diaSemana = f => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(f);
  let sumados = 0;
  let guarda = 0;
  while (sumados < dias && guarda++ < 60) {
    d.setDate(d.getDate() + 1);
    const nombre = diaSemana(d);
    if (nombre !== 'Sat' && nombre !== 'Sun') sumados++;
  }
  return {
    iso: new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d),
    legible: new Intl.DateTimeFormat('es-CL', {
      timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
    }).format(d),
  };
}

// ── Parseo del pedido ─────────────────────────────────────────────────────────

/**
 * Extrae del payload de Shopify lo único que importa para la conversación.
 * Tolera pedidos sin cliente registrado (guest checkout) y sin dirección.
 */
function parseOrder(payload, { etaDias = 3 } = {}) {
  const ship = payload.shipping_address || payload.billing_address || payload.customer?.default_address || {};
  const cli  = payload.customer || {};

  const nombre = [ship.first_name || cli.first_name, ship.last_name || cli.last_name]
    .filter(Boolean).join(' ').trim() || ship.name || '';

  const telefono = normalizePhoneCL(
    ship.phone || payload.phone || cli.phone || payload.billing_address?.phone
  );

  const items = (payload.line_items || []).map(li => ({
    titulo: li.title || li.name || 'Producto',
    cantidad: li.quantity || 1,
  }));
  const productos = items.length
    ? items.map(i => (i.cantidad > 1 ? `${i.cantidad}× ${i.titulo}` : i.titulo)).join(', ')
    : 'tu pedido';

  const direccion = [
    ship.address1, ship.address2, ship.city, ship.province,
  ].filter(Boolean).join(', ') || null;

  const eta = etaHabiles(etaDias);

  return {
    orderId:     String(payload.id || ''),
    numero:      payload.order_number ? `#${payload.order_number}` : (payload.name || ''),
    nombre:      nombre || 'Cliente',
    // Guest checkout sin nombre: "Hola cliente!" es feo pero honesto — Meta
    // no acepta variables vacías y "Hola Hola!" era peor.
    primerNombre: nombre.split(' ')[0] || 'cliente',
    telefono,
    productos,
    items,
    direccion,
    total:       payload.total_price || null,
    moneda:      payload.currency || 'CLP',
    etaLegible:  eta.legible,
    etaIso:      eta.iso,
  };
}

// ── Contexto para el agente ───────────────────────────────────────────────────

/**
 * Bloque de capacidad para el system prompt — solo si el lead tiene un pedido
 * PENDIENTE de confirmar. Le da al agente el pedido completo y el objetivo
 * único de esa conversación.
 */
function buildOrderContext(lead) {
  const o = lead?.shopify_order;
  if (!o || o.estado !== 'pendiente') return null;
  // Vencido: sin esto el pedido (y su fecha de entrega congelada) se inyectaría
  // en TODAS las conversaciones futuras de esa clienta, meses después, y el
  // agente nunca volvería a venderle.
  if (o.creado_at && Date.now() - new Date(o.creado_at).getTime() > VIGENCIA_DIAS * 864e5) return null;
  const totalFmt = o.total
    ? (o.moneda === 'CLP'
        ? `$${Number(o.total).toLocaleString('es-CL')} CLP`
        : `${Number(o.total).toFixed(2)} ${o.moneda}`)
    : '';
  return [
    '--- PEDIDO PENDIENTE DE CONFIRMAR (de la tienda online) ---',
    `Pedido ${o.numero || ''}: ${o.productos}`.trim(),
    o.direccion ? `Dirección de despacho registrada: ${o.direccion}` : 'Sin dirección registrada en el pedido — pídesela.',
    totalFmt ? `Total: ${totalFmt}` : '',
    `Llegada estimada: ${o.etaLegible}`,
    '',
    'TU OBJETIVO EN ESTA CONVERSACIÓN: que la persona CONFIRME el pedido y la dirección para despacharlo. Es una clienta que YA compró — trátala como compradora, no como prospecto: nada de calificar ni de vender de nuevo.',
    'Cuando tengas el resultado, incluye AL FINAL de tu mensaje UNO de estos marcadores exactos:',
    '[PEDIDO: confirmado] — la persona confirma el pedido y la dirección.',
    '[PEDIDO: direccion | dirección nueva completa] — quiere cambiar la dirección de despacho.',
    '[PEDIDO: cancelado] — dice que no lo quiere, que no lo pidió o que lo anulen.',
    'Reglas: un solo marcador y solo cuando la persona haya sido CLARA (si dice "déjame ver" o pregunta algo, responde sin marcador). Si dice que no reconoce el pedido, NO discutas: pide disculpas, marca cancelado y avisa que el dueño la contactará. Nunca inventes fechas de entrega distintas a la estimada ni prometas horarios exactos.',
  ].filter(Boolean).join('\n');
}

// ── Resolución de marcadores ──────────────────────────────────────────────────

/**
 * Procesa los marcadores [PEDIDO: ...] del reply: actualiza el estado del
 * pedido en el lead, avisa al dueño y registra el evento facturable.
 * Fail-closed: el marcador SIEMPRE se elimina del texto (incluso truncado o
 * mal formado) — el mensaje sale igual, nunca se rompe la conversación.
 */
async function resolveOrderMarkers(text, { lead, accountId }) {
  if (!text || !/\[PEDIDO/i.test(text)) return { text, outcome: null };
  MARKER_RE.lastIndex = 0;

  let out = text;
  let outcome = null;
  // Relectura: el `lead` del caller es el snapshot de antes de llamar al LLM.
  // Si entró un pedido nuevo en esos segundos, escribir sobre el snapshot
  // pisaría el pedido nuevo con el viejo.
  const fresco = await db.findOne(db.leads, { _id: lead._id }).catch(() => null);
  const o = (fresco || lead)?.shopify_order;

  for (const m of [...text.matchAll(MARKER_RE)]) {
    const accion = (m[1] || '').toLowerCase().replace('ó', 'o');
    const detalle = (m[2] || '').trim();
    if (o && o.estado === 'pendiente' && !outcome) {
      const estado = accion === 'confirmado' ? 'confirmado'
                   : accion === 'cancelado'  ? 'cancelado'
                   : 'direccion_nueva';
      const upd = {
        shopify_order: {
          ...o,
          estado,
          ...(detalle && estado === 'direccion_nueva' ? { direccion_nueva: detalle } : {}),
          resuelto_at: new Date().toISOString(),
        },
      };
      // El pedido confirmado es una venta real: al kanban de ganados.
      if (estado === 'confirmado') {
        upd.pipeline_stage = 'ganado';
        upd.is_converted = true;
        upd.stage_changed_at = new Date().toISOString();
        if (o.total) { upd.deal_value = Number(o.total); upd.deal_currency = o.moneda || 'CLP'; }
      }
      await db.update(db.leads, { _id: lead._id }, upd).catch(() => null);

      const etiqueta = estado === 'confirmado' ? '✅ Pedido CONFIRMADO'
                     : estado === 'cancelado'  ? '❌ Pedido CANCELADO por la clienta'
                     : `📍 Cambio de dirección: ${detalle}`;
      await db.insert(db.messages, {
        lead_id: lead._id, role: 'sistema',
        content: `${etiqueta} — ${o.numero || 'pedido'} (${o.productos})`,
      }).catch(() => null);

      if (estado === 'confirmado' || estado === 'direccion_nueva') {
        const dupEv = await db.findOne(db.billableEvents, {
          type: 'pedido_confirmado', account_id: accountId, shopify_order_id: o.orderId,
        }).catch(() => null);
        if (!dupEv) {
          await db.insert(db.billableEvents, {
            account_id: accountId, lead_id: lead._id,
            type: 'pedido_confirmado',
            shopify_order_id: o.orderId,
            amount: o.total ? Number(o.total) : null,
            currency: o.moneda || 'CLP',
          }).catch(() => null);
        }
      }

      // Avisar al dueño: cancelaciones y cambios de dirección necesitan acción
      // humana; la confirmación también le sirve para despachar al tiro.
      // Los eventos válidos son ganado/perdido/tibio — cualquier otro string
      // hace que notifyLeadEvent devuelva sin avisar EN SILENCIO.
      try {
        const { notifyLeadEvent } = require('./notifications');
        const owner = await db.findOne(db.users, { account_id: accountId });
        const evento = estado === 'confirmado' ? 'ganado'
                     : estado === 'cancelado'  ? 'perdido'
                     : 'tibio';
        if (owner) await notifyLeadEvent({ userId: owner._id, leadId: lead._id, event: evento });
      } catch (e) { /* notificación best-effort */ }

      outcome = { estado, detalle: detalle || null };
      console.log(`🛒 [shopify] ${etiqueta} — lead ${lead._id}`);
    }
    out = out.replace(m[0], '');
  }
  // Scrub de residuos (marcador truncado por max_tokens o mal formado)
  out = out.replace(/\[PEDIDO[^\]]*\]?/gi, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
  return { text: out, outcome };
}

module.exports = {
  verifyWebhook,
  normalizePhoneCL,
  etaHabiles,
  parseOrder,
  buildOrderContext,
  resolveOrderMarkers,
};
