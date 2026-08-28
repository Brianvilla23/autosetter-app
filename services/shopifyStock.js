/**
 * Atinov — Stock vivo de Shopify para el agente
 *
 * "¿Queda talla M del polerón negro?" era imposible de responder con la
 * Knowledge Base estática: el dueño la escribía una vez y el inventario reál
 * cambiaba a la hora. Con el token de Admin API de la tienda, el agente ve el
 * inventario REAL con nombre, variante y cantidad — y tiene prohibido
 * inventar stock que no esté en la lista.
 *
 * FAIL-CLOSED: sin `shopify_admin_token` + `shopify_shop_domain` en los
 * settings de la cuenta, no existe bloque de stock y todo sigue como antes.
 * Un error o timeout de la API de Shopify tampoco bloquea jamás la respuesta:
 * el agente contesta sin el bloque (y con la KB estática que ya tenía).
 *
 * Cache de 5 minutos por cuenta: el inventario no cambia por segundo y cada
 * mensaje del lead NO puede costar un round-trip a Shopify.
 */

const axios = require('axios');

const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS   = 5000;
const MAX_PRODUCTOS_PROMPT = 40;   // cap de tokens: catálogos gigantes se truncan
const API_VERSION  = '2024-10';

/** cache por cuenta: accountId → { at, bloque } */
const cache = new Map();

/** Normaliza el dominio: acepta "mitienda", "mitienda.myshopify.com" o URL completa. */
function normalizarDominio(raw) {
  if (!raw) return null;
  let d = String(raw).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return null;
  if (!d.includes('.')) d = `${d}.myshopify.com`;
  return d;
}

/** Una línea legible por producto: "Polerón oversize — S: 3 · M: agotado · L: 12". */
function lineaProducto(p) {
  const variantes = (p.variants || []).map(v => {
    const qty = Number(v.inventory_quantity);
    const nombre = (v.title && v.title !== 'Default Title') ? v.title : 'única';
    if (!Number.isFinite(qty)) return `${nombre}: consultar`;
    return `${nombre}: ${qty <= 0 ? 'AGOTADO' : qty}`;
  });
  return `- ${p.title} — ${variantes.join(' · ') || 'sin variantes'}`;
}

/**
 * Trae el inventario de la tienda y lo arma como bloque de contexto.
 * Devuelve null si no está configurado o si la API falla (fail-closed).
 */
async function getStockContext(accountId, settings) {
  const token = settings?.shopify_admin_token;
  const dominio = normalizarDominio(settings?.shopify_shop_domain);
  if (!token || !dominio) return null;

  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bloque;

  try {
    const r = await axios.get(
      `https://${dominio}/admin/api/${API_VERSION}/products.json`,
      {
        params: { limit: 100, status: 'active', fields: 'id,title,variants,status' },
        headers: { 'X-Shopify-Access-Token': token },
        timeout: TIMEOUT_MS,
      }
    );
    const productos = (r.data?.products || []).filter(p => p.status === 'active');
    if (!productos.length) {
      // Catálogo vacío también se cachea: sin esto, cada mensaje del lead
      // pegaría a Shopify durante los 5 minutos igual.
      cache.set(accountId, { at: Date.now(), bloque: null });
      return null;
    }

    const visibles = productos.slice(0, MAX_PRODUCTOS_PROMPT);
    const bloque = [
      '--- STOCK ACTUAL DE LA TIENDA (dato REAL, actualizado hace minutos) ---',
      ...visibles.map(lineaProducto),
      productos.length > visibles.length
        ? `(…y ${productos.length - visibles.length} productos más — si preguntan por uno que no está en la lista, di que lo confirmas y avisa al dueño)`
        : '',
      '',
      'REGLAS DEL STOCK: responde disponibilidad SOLO con esta lista. Si algo está AGOTADO, dilo honesto y ofrece una alternativa parecida de la misma lista. NUNCA inventes tallas, colores ni cantidades que no estén aquí. Si el stock de algo es bajo (3 o menos), puedes decirlo — urgencia real, no inventada.',
    ].filter(Boolean).join('\n');

    cache.set(accountId, { at: Date.now(), bloque });
    return bloque;
  } catch (e) {
    console.warn(`[stock] Shopify no respondió para cuenta ${accountId}:`,
      e.response?.status || e.message);
    return null; // sin bloque: el agente responde con lo que ya tenía
  }
}

/** Borra el cache de una cuenta (al desconectar Shopify o en tests). */
function invalidar(accountId) {
  if (accountId) cache.delete(accountId);
  else cache.clear();
}

module.exports = { getStockContext, invalidar, normalizarDominio, lineaProducto, MAX_PRODUCTOS_PROMPT };
