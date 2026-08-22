/**
 * Atinov — Pricing por resultado (piloto manual)
 *
 * La medición ya existía (billableEvents, escrita por webhook/calendar/
 * payments/shopify); esto la convierte en una factura legible. Módulo PURO
 * a propósito — sin db ni red — para poder testear la dedup y el tope sin
 * cargar la cadena de NeDB (misma razón que services/channels/core.js).
 *
 * Modelo piloto (montos NETOS, sin IVA):
 *   piso CLP 49.000 + CLP 9.000 por cita agendada, con tope CLP 179.000.
 *   - La CITA es el outcome que se cobra (no el lead calificado): vive en el
 *     Google Calendar del propio cliente, así que no hay disputa de "ese
 *     lead no servía". Lección Zillow/TrueCar del research de monetización.
 *   - El tope no es generosidad, es retención: el cliente de alto volumen
 *     no explota en la factura, y el tope mismo es la conversación de
 *     upgrade al plan plano.
 * Se factura A MANO a fin de mes leyendo /api/admin/eventos-facturables
 * mientras el piloto corre con 2-3 clientes; se automatiza solo si funciona.
 */

const TARIFAS_RESULTADO = {
  piso_clp: 49000,
  por_cita_clp: 9000,
  tope_clp: 179000,
};

/**
 * Agrega los eventos facturables de un mes en contadores por cuenta.
 * Dedup del lado LECTURA — la métrica de cobro debe ser inmune a carreras
 * de escritura:
 *  - ventas: únicas por mp_payment_id (MP notifica el mismo pago 2 veces).
 *  - leads: únicos por lead_id (clasificaciones concurrentes).
 *  - pedidos: únicos por shopify_order_id.
 *  - citas: únicas por lead_id + fecha_cita (espeja la dedup de escritura
 *    de calendar.js: doble marcador o lead re-confirmando el mismo slot).
 */
function agregarEventosFacturables(eventos) {
  const porCuenta = {};
  const pagosVistos = new Set();
  const leadsVistos = new Set();
  const pedidosVistos = new Set();
  const citasVistas = new Set();

  for (const e of eventos || []) {
    const c = (porCuenta[e.account_id] ||= {
      leads_calificados: 0, ventas_cerradas: 0, monto_ventas_clp: 0,
      pedidos_confirmados: 0, citas_agendadas: 0,
    });
    // Pedidos de Shopify confirmados por el agente: mismo peso de outcome que
    // una venta cerrada para el pricing por resultado.
    if (e.type === 'pedido_confirmado') {
      const key = `${e.account_id}:${e.shopify_order_id}`;
      if (pedidosVistos.has(key)) continue;
      pedidosVistos.add(key);
      c.pedidos_confirmados++;
      if (e.currency === 'CLP') c.monto_ventas_clp += Number(e.amount) || 0;
    }
    if (e.type === 'lead_calificado') {
      const key = `${e.account_id}:${e.lead_id}`;
      if (leadsVistos.has(key)) continue;
      leadsVistos.add(key);
      c.leads_calificados++;
    }
    if (e.type === 'venta_cerrada') {
      if (e.mp_payment_id && pagosVistos.has(e.mp_payment_id)) continue;
      if (e.mp_payment_id) pagosVistos.add(e.mp_payment_id);
      c.ventas_cerradas++;
      c.monto_ventas_clp += Number(e.amount) || 0;
    }
    if (e.type === 'cita_agendada') {
      // Sin fecha_cita (no debería pasar: calendar.js siempre la escribe) el
      // fallback es el _id — dos citas sin fecha no se colapsan entre sí.
      const key = `${e.account_id}:${e.lead_id}:${e.fecha_cita || e._id}`;
      if (citasVistas.has(key)) continue;
      citasVistas.add(key);
      c.citas_agendadas++;
    }
  }
  return porCuenta;
}

/**
 * La factura del piloto para un mes: piso + citas × tarifa, con tope.
 * Devuelve el desglose completo para que el admin no calcule nada a mano.
 */
function facturaPorResultado(citasAgendadas) {
  const citas = Math.max(0, Number(citasAgendadas) || 0);
  const variable = citas * TARIFAS_RESULTADO.por_cita_clp;
  const bruto = TARIFAS_RESULTADO.piso_clp + variable;
  const total = Math.min(bruto, TARIFAS_RESULTADO.tope_clp);
  return {
    piso_clp: TARIFAS_RESULTADO.piso_clp,
    citas_cobradas: citas,
    variable_clp: variable,
    total_clp: total,
    tope_aplicado: bruto > TARIFAS_RESULTADO.tope_clp,
    nota: 'montos netos (sin IVA) — piloto de cobro por resultado, facturación manual',
  };
}

module.exports = { TARIFAS_RESULTADO, agregarEventosFacturables, facturaPorResultado };
