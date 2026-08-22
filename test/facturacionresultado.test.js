/**
 * Atinov — Tests del pricing por resultado (piloto)
 *
 * Importa el módulo puro (sin db/red) para no cargar la cadena de NeDB —
 * misma convención que test/channels.test.js. La dedup de lectura es lo que
 * hace confiable la factura: acá se prueba con los duplicados REALES que
 * produce el sistema (MP notificando 2 veces, doble marcador de cita).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { TARIFAS_RESULTADO, agregarEventosFacturables, facturaPorResultado } =
  require('../services/facturacionResultado');

// ── La factura: piso + citas × tarifa, con tope ─────────────────────────────

test('factura: la tabla completa del piloto (0/5/10/15/30 citas)', () => {
  // Estos números son los del modelo vendible: si cambian las tarifas, este
  // test obliga a cambiar también la tabla que se le muestra al cliente.
  assert.strictEqual(facturaPorResultado(0).total_clp, 49000, 'sin citas paga solo el piso');
  assert.strictEqual(facturaPorResultado(5).total_clp, 94000);
  assert.strictEqual(facturaPorResultado(10).total_clp, 139000);
  assert.strictEqual(facturaPorResultado(15).total_clp, 179000, '15 citas topa (49k+135k=184k > tope)');
  assert.strictEqual(facturaPorResultado(30).total_clp, 179000, 'el tope es techo duro');
});

test('factura: tope_aplicado marca la conversación de upgrade', () => {
  assert.strictEqual(facturaPorResultado(10).tope_aplicado, false);
  assert.strictEqual(facturaPorResultado(15).tope_aplicado, true);
  assert.strictEqual(facturaPorResultado(14).total_clp, 175000, '14 citas todavía no topa');
  assert.strictEqual(facturaPorResultado(14).tope_aplicado, false);
});

test('factura: entradas sucias no rompen el cobro', () => {
  assert.strictEqual(facturaPorResultado(undefined).total_clp, TARIFAS_RESULTADO.piso_clp);
  assert.strictEqual(facturaPorResultado(null).total_clp, TARIFAS_RESULTADO.piso_clp);
  assert.strictEqual(facturaPorResultado(-3).total_clp, TARIFAS_RESULTADO.piso_clp, 'negativo → piso, nunca menos');
});

// ── La agregación con dedup de lectura ──────────────────────────────────────

const ev = (over) => ({ _id: Math.random().toString(36).slice(2), account_id: 'acc1', ...over });

test('citas: se cuentan y el doble marcador del mismo slot no duplica', () => {
  const r = agregarEventosFacturables([
    ev({ type: 'cita_agendada', lead_id: 'L1', fecha_cita: '2026-08-25 15:30' }),
    ev({ type: 'cita_agendada', lead_id: 'L1', fecha_cita: '2026-08-25 15:30' }), // re-confirmación
    ev({ type: 'cita_agendada', lead_id: 'L1', fecha_cita: '2026-08-28 10:00' }), // otra cita real
    ev({ type: 'cita_agendada', lead_id: 'L2', fecha_cita: '2026-08-25 15:30' }), // otro lead, mismo slot
  ]);
  assert.strictEqual(r.acc1.citas_agendadas, 3,
    'mismo lead+slot dedup; distinto día o distinto lead sí cuentan');
});

test('citas sin fecha_cita no se colapsan entre sí (fallback _id)', () => {
  const r = agregarEventosFacturables([
    ev({ type: 'cita_agendada', lead_id: 'L1' }),
    ev({ type: 'cita_agendada', lead_id: 'L1' }),
  ]);
  assert.strictEqual(r.acc1.citas_agendadas, 2);
});

test('ventas: MP notificando el mismo pago dos veces cuenta una sola vez', () => {
  const r = agregarEventosFacturables([
    ev({ type: 'venta_cerrada', lead_id: 'L1', amount: 50000, mp_payment_id: 'pay1' }),
    ev({ type: 'venta_cerrada', lead_id: 'L1', amount: 50000, mp_payment_id: 'pay1' }), // created + updated
    ev({ type: 'venta_cerrada', lead_id: 'L2', amount: 30000, mp_payment_id: 'pay2' }),
  ]);
  assert.strictEqual(r.acc1.ventas_cerradas, 2);
  assert.strictEqual(r.acc1.monto_ventas_clp, 80000, 'el monto tampoco se duplica');
});

test('leads y pedidos: dedup por lead_id y por shopify_order_id; moneda no-CLP no suma monto', () => {
  const r = agregarEventosFacturables([
    ev({ type: 'lead_calificado', lead_id: 'L1' }),
    ev({ type: 'lead_calificado', lead_id: 'L1' }), // clasificación concurrente
    ev({ type: 'pedido_confirmado', lead_id: 'L1', shopify_order_id: 'o1', amount: 20000, currency: 'CLP' }),
    ev({ type: 'pedido_confirmado', lead_id: 'L1', shopify_order_id: 'o1', amount: 20000, currency: 'CLP' }),
    ev({ type: 'pedido_confirmado', lead_id: 'L2', shopify_order_id: 'o2', amount: 99, currency: 'USD' }),
  ]);
  assert.strictEqual(r.acc1.leads_calificados, 1);
  assert.strictEqual(r.acc1.pedidos_confirmados, 2);
  assert.strictEqual(r.acc1.monto_ventas_clp, 20000, 'los USD del pedido o2 no contaminan el monto CLP');
});

test('las cuentas no se mezclan entre sí', () => {
  const r = agregarEventosFacturables([
    ev({ type: 'cita_agendada', account_id: 'accA', lead_id: 'L1', fecha_cita: '2026-08-25 15:30' }),
    ev({ type: 'cita_agendada', account_id: 'accB', lead_id: 'L1', fecha_cita: '2026-08-25 15:30' }),
  ]);
  assert.strictEqual(r.accA.citas_agendadas, 1);
  assert.strictEqual(r.accB.citas_agendadas, 1);
});

test('lista vacía o nula devuelve un resumen vacío, no revienta', () => {
  assert.deepStrictEqual(agregarEventosFacturables([]), {});
  assert.deepStrictEqual(agregarEventosFacturables(null), {});
});
