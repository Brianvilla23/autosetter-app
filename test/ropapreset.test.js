/**
 * Atinov — Tests del preset "Tienda de ropa" y del stock vivo
 *
 * Lo que se protege:
 *  1. el preset es AUTOCONTENIDO (la regla dura aprendida con dental/estética:
 *     is_main en knowledge contamina el prompt de TODOS los agentes vivos),
 *  2. las 6 plantillas sugeridas cumplen el contrato de variables del playbook
 *     ({{1}} nombre · {{2}} pedido · {{3}} extra) y su categoría Meta correcta
 *     — un cuerpo MARKETING declarado como UTILITY es motivo de rechazo o de
 *     baja de calidad del número,
 *  3. el stock vivo es fail-closed: sin token no existe, y jamás bloquea.
 */

// DB temporal antes de cargar nada que toque la base.
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-ropa-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const {
  applyRopaPreset, ROPA_AGENT_INSTRUCTIONS, ROPA_PLANTILLAS_SUGERIDAS,
} = require('../services/presets/ropaPreset');
const stock = require('../services/shopifyStock');

// ── Preset ──────────────────────────────────────────────────────────────────

test('applyRopaPreset: agente desactivado, autocontenido y con objetivo de venta', async () => {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'tienda' });
  // Agente previo VIVO de la cuenta: el preset no puede tocarlo ni contaminarlo.
  const vivo = await db.insert(db.agents, { account_id: accountId, name: 'Original', enabled: true });

  const r = await applyRopaPreset(db, accountId, { nombreTienda: 'Urban Wear' });
  assert.strictEqual(r.ok, true);

  const agente = await db.findOne(db.agents, { _id: r.agentId });
  assert.strictEqual(agente.enabled, false, 'nace apagado: el dueño lo enciende al completar los [EDITAR]');
  assert.strictEqual(agente.ignore_main_knowledge, true, 'autocontenido');
  assert.strictEqual(agente.objetivo, 'vender');
  assert.ok(agente.instructions.includes('Urban Wear'), 'el nombre de la tienda se inyecta');

  const knowledge = await db.find(db.knowledge, { account_id: accountId });
  assert.strictEqual(knowledge.length, r.created.knowledge);
  for (const k of knowledge) {
    assert.strictEqual(k.is_main, false, `"${k.title}" con is_main contaminaría al agente vivo`);
    assert.deepStrictEqual(k.agent_ids, [r.agentId], 'ligada SOLO al agente del preset');
  }

  const originalDespues = await db.findOne(db.agents, { _id: vivo._id });
  assert.strictEqual(originalDespues.enabled, true, 'el agente previo no se toca');
});

test('las instrucciones del vertical traen las reglas que pagan: dirección siempre y stock honesto', () => {
  assert.match(ROPA_AGENT_INSTRUCTIONS, /confirma dirección COMPLETA/i);
  assert.match(ROPA_AGENT_INSTRUCTIONS, /NUNCA inventes tallas/i);
  assert.match(ROPA_AGENT_INSTRUCTIONS, /PROHIBIDO inventar descuentos/i);
  assert.match(ROPA_AGENT_INSTRUCTIONS, /NUNCA voseo argentino/);
});

test('las 6 plantillas sugeridas cumplen el contrato del playbook', () => {
  assert.strictEqual(ROPA_PLANTILLAS_SUGERIDAS.length, 6);
  const porConfig = Object.fromEntries(ROPA_PLANTILLAS_SUGERIDAS.map(p => [p.config, p]));

  // Contrato profundo: si el dueño guarda las 6 configs sugeridas por el
  // preset, configDe() del playbook debe recoger TODAS. Un typo en el nombre
  // de config del preset dejaría un paso "sin plantilla" en silencio.
  const { configDe } = require('../services/playbookPedido');
  const settingsCompletos = { playbook_pedido_enabled: true };
  for (const p of ROPA_PLANTILLAS_SUGERIDAS) settingsCompletos[p.config] = p.nombre_sugerido;
  const cfg = configDe(settingsCompletos);
  for (const [paso, plantilla] of Object.entries(cfg.plantillas)) {
    assert.ok(plantilla, `configDe no recogió plantilla para el paso "${paso}" — nombre de config desalineado entre preset y playbook`);
  }

  for (const p of ROPA_PLANTILLAS_SUGERIDAS) {
    assert.match(p.cuerpo, /\{\{1\}\}/, `${p.nombre_sugerido}: falta {{1}} (nombre)`);
    assert.match(p.cuerpo, /\{\{2\}\}|\{\{3\}\}/, `${p.nombre_sugerido}: sin variables de pedido`);
    assert.ok(['UTILITY', 'MARKETING'].includes(p.categoria));
  }
  // La categoría correcta protege el número: los pasos de servicio como
  // utility (llegan siempre, no gastan casilla), los comerciales como marketing.
  assert.strictEqual(porConfig.playbook_template_tracking.categoria, 'UTILITY');
  assert.strictEqual(porConfig.playbook_template_llega_hoy.categoria, 'UTILITY');
  assert.strictEqual(porConfig.playbook_template_entregado.categoria, 'UTILITY');
  assert.strictEqual(porConfig.playbook_template_upsell.categoria, 'MARKETING');
  assert.strictEqual(porConfig.playbook_template_resena.categoria, 'MARKETING');
  assert.strictEqual(porConfig.playbook_template_winback.categoria, 'MARKETING');
});

// ── Stock vivo ──────────────────────────────────────────────────────────────

test('normalizarDominio acepta las tres formas en que el dueño pega su tienda', () => {
  assert.strictEqual(stock.normalizarDominio('mitienda'), 'mitienda.myshopify.com');
  assert.strictEqual(stock.normalizarDominio('MiTienda.myshopify.com'), 'mitienda.myshopify.com');
  assert.strictEqual(stock.normalizarDominio('https://mitienda.myshopify.com/admin'), 'mitienda.myshopify.com');
  assert.strictEqual(stock.normalizarDominio(''), null);
  assert.strictEqual(stock.normalizarDominio(null), null);
});

test('lineaProducto: agotado se dice AGOTADO, la variante única no inventa talla', () => {
  const linea = stock.lineaProducto({
    title: 'Polerón oversize negro',
    variants: [
      { title: 'S', inventory_quantity: 3 },
      { title: 'M', inventory_quantity: 0 },
      { title: 'L', inventory_quantity: -2 },
    ],
  });
  assert.match(linea, /S: 3/);
  assert.match(linea, /M: AGOTADO/);
  assert.match(linea, /L: AGOTADO/, 'inventario negativo (sobreventa) también es agotado');

  const unica = stock.lineaProducto({ title: 'Gorro', variants: [{ title: 'Default Title', inventory_quantity: 7 }] });
  assert.match(unica, /única: 7/);
  // Sin tracking de inventario (qty no numérica) no se inventa un número.
  const sinTracking = stock.lineaProducto({ title: 'Tote', variants: [{ title: 'única' }] });
  assert.match(sinTracking, /consultar/);
});

test('fail-closed: sin token o sin dominio NO hay bloque de stock (y no hay red)', async () => {
  assert.strictEqual(await stock.getStockContext('acc-x', {}), null);
  assert.strictEqual(await stock.getStockContext('acc-x', { shopify_admin_token: 'shpat_x' }), null);
  assert.strictEqual(await stock.getStockContext('acc-x', { shopify_shop_domain: 'mitienda' }), null);
  assert.strictEqual(await stock.getStockContext('acc-x', null), null);
});
