/**
 * Atinov — Tests del playbook post-compra (vertical tiendas)
 *
 * Lo que se protege acá es la promesa al cliente laboratorio Y la regla que
 * hace esto viable para cualquier tienda:
 *  1. cada estado del courier dispara su paso UNA sola vez,
 *  2. los pasos de marketing respetan el cap por contacto (Meta capea la
 *     casilla del usuario a ~2 promos/día contando todas las marcas — si
 *     nosotros no racionamos, el mensaje muere en silencio y el número del
 *     cliente se degrada),
 *  3. fuera de la ventana de 24h no se intenta texto libre jamás: plantilla
 *     aprobada o aviso al dueño, nunca un mensaje que la API va a rechazar,
 *  4. el rechazo 131049 se reprograma, no se pierde en silencio.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-playbook-test-')
);
delete process.env.OPENAI_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const { parseOrder, parseFulfillment } = require('../services/shopify');
const pb = require('../services/playbookPedido');

// ── Utilería ────────────────────────────────────────────────────────────────

async function armarTienda({ playbook = true, settingsExtra = {} } = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, {
    _id: accountId, ig_username: 'tienda',
    wa_phone_number_id: 'phone-1', wa_access_token: 'token-1',
  });
  await db.insert(db.users, {
    account_id: accountId, email: `${accountId}@tienda.com`, membershipPlan: 'crecimiento',
  });
  await db.insert(db.settings, {
    account_id: accountId,
    playbook_pedido_enabled: playbook,
    ...settingsExtra,
  });
  const agent = await db.insert(db.agents, {
    account_id: accountId, name: 'Vende', enabled: true, instructions: 'Vende ropa.',
  });
  return { accountId, agent };
}

async function armarLeadConPedido(accountId, { estado = 'confirmado', extraOrder = {}, extraLead = {} } = {}) {
  return db.insert(db.leads, {
    account_id: accountId,
    wa_id: '569' + Math.floor(Math.random() * 1e8),
    wa_name: 'Carla Soto',
    channel: 'whatsapp',
    automation: 'automated',
    shopify_order: {
      orderId: 'ord-' + crypto.randomUUID(),
      numero: '#1001', productos: 'Polerón oversize negro',
      estado, creado_at: new Date().toISOString(),
      ...extraOrder,
    },
    ...extraLead,
  });
}

/** Ventana de 24h abierta: la clienta escribió hace poco. */
const abrirVentana = (leadId) =>
  db.insert(db.messages, { lead_id: leadId, role: 'user', content: 'sí, confirmo' });

const tareasDe = (leadId) => db.find(db.pedidoTasks, { lead_id: leadId });

/** Transporte falso: registra llamadas, sin red. */
function transporteFake() {
  const llamadas = { textos: [], plantillas: [], llm: [] };
  return {
    llamadas,
    deps: {
      enviarTexto: async ({ texto }) => { llamadas.textos.push(texto); },
      enviarPlantilla: async ({ tarea }) => { llamadas.plantillas.push(tarea.tipo); },
      generarLlm: async ({ tarea }) => { llamadas.llm.push(tarea.tipo); return `msg-llm-${tarea.tipo}`; },
    },
  };
}

// ── Parsers ─────────────────────────────────────────────────────────────────

test('parseFulfillment saca lo que el playbook necesita del payload de Shopify', () => {
  const f = parseFulfillment({
    order_id: 123456, shipment_status: 'Out_For_Delivery',
    tracking_number: 'CHX123', tracking_urls: ['https://courier.cl/CHX123'],
    tracking_company: 'Chilexpress',
  });
  assert.deepStrictEqual(f, {
    orderId: '123456', status: 'out_for_delivery',
    trackingNumber: 'CHX123', trackingUrl: 'https://courier.cl/CHX123',
    empresa: 'Chilexpress',
  });
  assert.strictEqual(parseFulfillment({}).status, null);
});

test('parseOrder detecta contra-entrega por el gateway del pedido', () => {
  const base = { id: 1, line_items: [{ title: 'Buzo', quantity: 1 }], shipping_address: { phone: '+56 9 1234 5678' } };
  assert.strictEqual(parseOrder({ ...base, payment_gateway_names: ['Cash on Delivery (COD)'] }).pagoContraEntrega, true);
  assert.strictEqual(parseOrder({ ...base, payment_gateway_names: ['Pago contra entrega'] }).pagoContraEntrega, true);
  assert.strictEqual(parseOrder({ ...base, payment_gateway_names: ['mercado_pago'] }).pagoContraEntrega, false);
  assert.strictEqual(parseOrder(base).pagoContraEntrega, false);
});

// ── Configuración ───────────────────────────────────────────────────────────

test('configDe: opt-in explícito y defaults del playbook', () => {
  assert.strictEqual(pb.configDe({}).activo, false, 'sin flag = apagado');
  assert.strictEqual(pb.configDe({ playbook_pedido_enabled: 'true' }).activo, false, 'string no es true');
  const cfg = pb.configDe({ playbook_pedido_enabled: true, playbook_resena_dias: 7 });
  assert.strictEqual(cfg.activo, true);
  assert.strictEqual(cfg.resenaDias, 7);
  assert.strictEqual(cfg.winbackDias, pb.DEFAULTS.winback_dias);
  assert.strictEqual(cfg.capMktMes, pb.DEFAULTS.mkt_cap_mes);
  assert.strictEqual(cfg.incentivoVideo, null, 'sin incentivo configurado no se promete nada');
});

// ── Agendamiento por eventos ────────────────────────────────────────────────

test('delivered agenda check + reseña + winback con los tiempos configurados; el mismo estado no repite', async () => {
  const { accountId } = await armarTienda({ settingsExtra: { playbook_resena_dias: 7, playbook_winback_dias: 20 } });
  const lead = await armarLeadConPedido(accountId);
  const f = { orderId: lead.shopify_order.orderId, status: 'delivered', trackingUrl: null, trackingNumber: null, empresa: null };

  const r1 = await pb.alCambioEnvio({ lead, accountId, fulfillment: f });
  assert.strictEqual(r1.agendadas, 3);

  const tareas = await tareasDe(lead._id);
  const tipos = tareas.map(t => t.tipo).sort();
  assert.deepStrictEqual(tipos, ['entregado_check', 'resena', 'winback']);

  const resena = tareas.find(t => t.tipo === 'resena');
  const dias = (new Date(resena.scheduled_for) - Date.now()) / 864e5;
  assert.ok(dias > 6.9 && dias < 7.1, `la reseña va a ~7 días (dio ${dias.toFixed(2)})`);

  // El webhook reintenta: el mismo estado no puede duplicar tareas.
  const fresco = await db.findOne(db.leads, { _id: lead._id });
  const r2 = await pb.alCambioEnvio({ lead: fresco, accountId, fulfillment: f });
  assert.strictEqual(r2.agendadas, 0);
  assert.strictEqual((await tareasDe(lead._id)).length, 3);
});

test('in_transit → tracking inmediata (y guarda la URL en el lead); out_for_delivery → llega_hoy', async () => {
  const { accountId } = await armarTienda();
  const lead = await armarLeadConPedido(accountId);
  await pb.alCambioEnvio({
    lead, accountId,
    fulfillment: { orderId: lead.shopify_order.orderId, status: 'in_transit', trackingUrl: 'https://x.cl/t', trackingNumber: 'T1', empresa: 'Starken' },
  });
  const conTracking = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(conTracking.shopify_order.tracking_url, 'https://x.cl/t');
  await pb.alCambioEnvio({
    lead: conTracking, accountId,
    fulfillment: { orderId: lead.shopify_order.orderId, status: 'out_for_delivery', trackingUrl: null, trackingNumber: null, empresa: null },
  });
  const tipos = (await tareasDe(lead._id)).map(t => t.tipo).sort();
  assert.deepStrictEqual(tipos, ['llega_hoy', 'tracking']);
});

test('entrega FALLIDA no manda mensaje automático: aviso al dueño en el hilo', async () => {
  const { accountId } = await armarTienda();
  const lead = await armarLeadConPedido(accountId);
  await pb.alCambioEnvio({
    lead, accountId,
    fulfillment: { orderId: lead.shopify_order.orderId, status: 'failure', trackingUrl: null, trackingNumber: null, empresa: null },
  });
  assert.strictEqual((await tareasDe(lead._id)).length, 0);
  const avisos = await db.find(db.messages, { lead_id: lead._id, role: 'sistema' });
  assert.ok(avisos.some(m => /ENTREGA FALLIDA/.test(m.content)));
});

test('fail-closed: con el playbook apagado ningún evento agenda nada', async () => {
  const { accountId } = await armarTienda({ playbook: false });
  const lead = await armarLeadConPedido(accountId);
  const r = await pb.alCambioEnvio({
    lead, accountId,
    fulfillment: { orderId: lead.shopify_order.orderId, status: 'delivered', trackingUrl: null, trackingNumber: null, empresa: null },
  });
  assert.strictEqual(r.agendadas, 0);
  assert.strictEqual((await pb.alConfirmarPedido({ lead, accountId })).agendadas, 0);
});

test('alConfirmarPedido agenda el upsell a las horas configuradas, una sola vez', async () => {
  const { accountId } = await armarTienda({ settingsExtra: { playbook_upsell_horas: 2 } });
  const lead = await armarLeadConPedido(accountId);
  await pb.alConfirmarPedido({ lead, accountId });
  await pb.alConfirmarPedido({ lead, accountId }); // reintento del marcador
  const tareas = await tareasDe(lead._id);
  assert.strictEqual(tareas.length, 1);
  const horas = (new Date(tareas[0].scheduled_for) - Date.now()) / 3600e3;
  assert.ok(horas > 1.9 && horas < 2.1, `upsell a ~2h (dio ${horas.toFixed(2)})`);
});

// ── Frecuencia de marketing ─────────────────────────────────────────────────

test('el cap por contacto: mes lleno bloquea, día ocupado bloquea, limpio pasa', () => {
  const cfg = pb.configDe({ playbook_pedido_enabled: true, playbook_mkt_cap_mes: 3 });
  const mes = new Date().toISOString().slice(0, 7);
  const hoy = new Date().toISOString().slice(0, 10);
  assert.deepStrictEqual(pb.chequearCapMarketing({}, cfg), { ok: true });
  assert.deepStrictEqual(
    pb.chequearCapMarketing({ mkt_month: mes, mkt_count_month: 3 }, cfg),
    { ok: false, motivo: 'cap_mes' });
  assert.deepStrictEqual(
    pb.chequearCapMarketing({ mkt_month: mes, mkt_count_month: 1, mkt_last_day: hoy }, cfg),
    { ok: false, motivo: 'cap_dia' });
  // Mes viejo: los contadores no arrastran al mes nuevo.
  assert.deepStrictEqual(
    pb.chequearCapMarketing({ mkt_month: '2020-01', mkt_count_month: 99 }, cfg),
    { ok: true });
});

// ── Textos ──────────────────────────────────────────────────────────────────

test('los textos utility son deterministas y el aviso COD pide tener el pago listo', () => {
  const base = { wa_name: 'Carla Soto', shopify_order: { numero: '#1001', tracking_url: 'https://x.cl/t', courier: 'Starken' } };
  assert.match(pb.textoUtility('tracking', base), /#1001/);
  assert.match(pb.textoUtility('tracking', base), /https:\/\/x\.cl\/t/);
  const cod = { ...base, shopify_order: { ...base.shopify_order, pago_contra_entrega: true } };
  assert.match(pb.textoUtility('llega_hoy', cod), /pago a mano/i);
  assert.doesNotMatch(pb.textoUtility('llega_hoy', base), /pago a mano/i);
  assert.match(pb.textoUtility('entregado_check', base), /llegó bien/i);
});

test('el hint de reseña promete el incentivo EXACTO configurado, o nada', () => {
  const lead = { shopify_order: { productos: 'Polerón' } };
  const con = pb.hintMarketing('resena', lead, pb.configDe({ playbook_pedido_enabled: true, playbook_incentivo_video: '10% en tu próxima compra' }));
  assert.match(con, /"10% en tu próxima compra"/);
  const sin = pb.hintMarketing('resena', lead, pb.configDe({ playbook_pedido_enabled: true }));
  assert.match(sin, /NO ofrezcas descuentos/);
});

// ── Worker ──────────────────────────────────────────────────────────────────

test('utility dentro de ventana: sale como texto determinista y queda en el hilo', async () => {
  const { accountId } = await armarTienda();
  const lead = await armarLeadConPedido(accountId);
  await abrirVentana(lead._id);
  await pb.agendar({
    accountId, leadId: lead._id, orderId: lead.shopify_order.orderId,
    tipo: 'tracking', cuandoIso: new Date(Date.now() - 1000).toISOString(),
  });
  const t = transporteFake();
  const r = await pb.procesarTareas(t.deps);
  assert.strictEqual(r.enviadas, 1);
  assert.strictEqual(t.llamadas.textos.length, 1);
  assert.strictEqual(t.llamadas.llm.length, 0, 'utility jamás pasa por el LLM');
  const enHilo = await db.find(db.messages, { lead_id: lead._id, is_playbook: true });
  assert.strictEqual(enHilo.length, 1);
  const tarea = (await tareasDe(lead._id))[0];
  assert.ok(tarea.sent_at);
});

test('marketing fuera de ventana SIN plantilla: cancelada con aviso, nunca un envío que la API rechazaría', async () => {
  const { accountId } = await armarTienda();
  const lead = await armarLeadConPedido(accountId); // sin mensajes user → ventana cerrada
  await pb.agendar({
    accountId, leadId: lead._id, orderId: lead.shopify_order.orderId,
    tipo: 'resena', cuandoIso: new Date(Date.now() - 1000).toISOString(),
  });
  const t = transporteFake();
  await pb.procesarTareas(t.deps);
  assert.strictEqual(t.llamadas.textos.length + t.llamadas.plantillas.length, 0);
  const tarea = (await tareasDe(lead._id))[0];
  assert.strictEqual(tarea.cancelled, true);
  assert.match(tarea.reason, /sin plantilla/);
  const avisos = await db.find(db.messages, { lead_id: lead._id, role: 'sistema' });
  assert.ok(avisos.some(m => /plantilla/.test(m.content)));
});

test('marketing fuera de ventana CON plantilla configurada: sale por plantilla', async () => {
  const { accountId } = await armarTienda({ settingsExtra: { playbook_template_resena: 'resena_v1' } });
  const lead = await armarLeadConPedido(accountId);
  await pb.agendar({
    accountId, leadId: lead._id, orderId: lead.shopify_order.orderId,
    tipo: 'resena', cuandoIso: new Date(Date.now() - 1000).toISOString(),
  });
  const t = transporteFake();
  const r = await pb.procesarTareas(t.deps);
  assert.strictEqual(r.enviadas, 1);
  assert.deepStrictEqual(t.llamadas.plantillas, ['resena']);
  // El envío marketing quedó contado en el lead (cap por contacto).
  const fresco = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(fresco.mkt_count_month, 1);
  assert.strictEqual(fresco.mkt_last_day, new Date().toISOString().slice(0, 10));
});

test('prioridad + cap diario: el upsell gana el día y el winback se corre solo a mañana', async () => {
  const { accountId } = await armarTienda({ settingsExtra: { playbook_template_upsell: 'up_v1', playbook_template_winback: 'wb_v1' } });
  const lead = await armarLeadConPedido(accountId);
  const vencida = new Date(Date.now() - 1000).toISOString();
  await pb.agendar({ accountId, leadId: lead._id, orderId: lead.shopify_order.orderId, tipo: 'winback', cuandoIso: vencida });
  await pb.agendar({ accountId, leadId: lead._id, orderId: lead.shopify_order.orderId, tipo: 'upsell', cuandoIso: vencida });
  const t = transporteFake();
  await pb.procesarTareas(t.deps);
  assert.deepStrictEqual(t.llamadas.plantillas, ['upsell'], 'la prioridad manda: upsell primero');
  const tareas = await tareasDe(lead._id);
  const winback = tareas.find(x => x.tipo === 'winback');
  assert.ok(!winback.sent_at && !winback.cancelled, 'el winback ni salió ni murió');
  assert.ok(winback.scheduled_for > new Date().toISOString(), 'quedó para mañana');
  assert.strictEqual(winback.pospuestos_cap, 1);
});

test('cap mensual lleno: el marketing se cancela; el utility del mismo lead pasa igual', async () => {
  const mes = new Date().toISOString().slice(0, 7);
  const { accountId } = await armarTienda({ settingsExtra: { playbook_template_upsell: 'up_v1' } });
  const lead = await armarLeadConPedido(accountId, {
    extraLead: { mkt_month: mes, mkt_count_month: 3 },
  });
  await abrirVentana(lead._id);
  const vencida = new Date(Date.now() - 1000).toISOString();
  await pb.agendar({ accountId, leadId: lead._id, orderId: lead.shopify_order.orderId, tipo: 'upsell', cuandoIso: vencida });
  await pb.agendar({ accountId, leadId: lead._id, orderId: lead.shopify_order.orderId, tipo: 'tracking', cuandoIso: vencida });
  const t = transporteFake();
  await pb.procesarTareas(t.deps);
  const tareas = await tareasDe(lead._id);
  assert.strictEqual(tareas.find(x => x.tipo === 'upsell').cancelled, true);
  assert.ok(tareas.find(x => x.tipo === 'tracking').sent_at, 'el tracking no se raciona: es servicio');
});

test('131049 (casilla del usuario llena): se reprograma a mañana; al agotar reintentos muere con motivo', async () => {
  const { accountId } = await armarTienda({ settingsExtra: { playbook_template_resena: 'resena_v1' } });
  const lead = await armarLeadConPedido(accountId);
  const err131049 = Object.assign(new Error('rate limited'), {
    response: { data: { error: { code: 131049, message: 'per-user marketing limit' } } },
  });
  const deps = {
    enviarTexto: async () => { throw err131049; },
    enviarPlantilla: async () => { throw err131049; },
    generarLlm: async () => 'x',
  };
  const vencida = () => new Date(Date.now() - 1000).toISOString();
  await pb.agendar({ accountId, leadId: lead._id, orderId: lead.shopify_order.orderId, tipo: 'resena', cuandoIso: vencida() });

  await pb.procesarTareas(deps);
  let tarea = (await tareasDe(lead._id))[0];
  assert.strictEqual(tarea.cancelled, false, 'primer 131049 NO mata la tarea');
  assert.strictEqual(tarea.reintentos_meta, 1);

  // Se agotan los reintentos → cancelada con el motivo visible.
  for (let i = 0; i < 2; i++) {
    await db.update(db.pedidoTasks, { _id: tarea._id }, { scheduled_for: vencida() });
    await pb.procesarTareas(deps);
    tarea = (await tareasDe(lead._id))[0];
  }
  assert.strictEqual(tarea.cancelled, true);
  assert.match(tarea.reason, /error/);
});

test('lead en manejo humano o pedido cancelado: el playbook no se mete', async () => {
  const { accountId } = await armarTienda();
  const humano = await armarLeadConPedido(accountId, { extraLead: { is_bypassed: true } });
  const cancelado = await armarLeadConPedido(accountId, { estado: 'cancelado' });
  await abrirVentana(humano._id);
  await abrirVentana(cancelado._id);
  const vencida = new Date(Date.now() - 1000).toISOString();
  await pb.agendar({ accountId, leadId: humano._id, orderId: humano.shopify_order.orderId, tipo: 'tracking', cuandoIso: vencida });
  await pb.agendar({ accountId, leadId: cancelado._id, orderId: cancelado.shopify_order.orderId, tipo: 'upsell', cuandoIso: vencida });
  const t = transporteFake();
  await pb.procesarTareas(t.deps);
  assert.strictEqual(t.llamadas.textos.length + t.llamadas.plantillas.length + t.llamadas.llm.length, 0);
  assert.match((await tareasDe(humano._id))[0].reason, /manejo humano/);
  assert.match((await tareasDe(cancelado._id))[0].reason, /pedido cancelado/);
});

test('cancelarPorLead apaga lo pendiente sin tocar lo enviado', async () => {
  const { accountId } = await armarTienda();
  const lead = await armarLeadConPedido(accountId);
  await pb.agendar({ accountId, leadId: lead._id, orderId: lead.shopify_order.orderId, tipo: 'resena', cuandoIso: new Date(Date.now() + 864e5).toISOString() });
  const enviada = await db.insert(db.pedidoTasks, {
    account_id: accountId, lead_id: lead._id, order_id: lead.shopify_order.orderId,
    tipo: 'tracking', categoria: 'utility', prioridad: 0,
    scheduled_for: new Date().toISOString(), sent_at: new Date().toISOString(), cancelled: false,
  });
  await pb.cancelarPorLead(lead._id, 'prueba');
  const tareas = await tareasDe(lead._id);
  assert.strictEqual(tareas.find(x => x.tipo === 'resena').cancelled, true);
  assert.strictEqual(tareas.find(x => x._id === enviada._id).cancelled, false, 'lo ya enviado es historia, no se toca');
});
