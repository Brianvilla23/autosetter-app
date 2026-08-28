/**
 * Atinov — Suite de Embedded Signup v4
 *
 * El popup de Meta corre en el navegador DEL CLIENTE, así que el `waba_id` y
 * el `phone_number_id` llegan desde el cliente y son, por definición,
 * falsificables: cualquiera con sesión podría mandar el WABA de otro negocio
 * y quedarse con sus mensajes. La única defensa es preguntarle a Meta —con el
 * token recién canjeado— si esos activos son realmente suyos.
 *
 * Estos tests fijan esa defensa y el fail-closed.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-es-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const es = require('../services/embeddedSignup');

const WABA = '111111111111111';
const NUM  = '222222222222222';

/** Reemplaza axios.get por una respuesta a medida y devuelve el restore. */
function fingirGet(fn) {
  const original = axios.get;
  axios.get = fn;
  return () => { axios.get = original; };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed
// ─────────────────────────────────────────────────────────────────────────────

test('sin las 3 variables de entorno, la función está apagada', () => {
  const prev = { ...process.env };
  delete process.env.META_APP_ID; delete process.env.META_APP_SECRET; delete process.env.META_ES_CONFIG_ID;
  delete process.env.META_ES_APP_ID; delete process.env.META_ES_APP_SECRET;
  assert.strictEqual(es.estaHabilitado(), false, 'sin nada configurado: apagado');

  process.env.META_APP_ID = 'app'; process.env.META_APP_SECRET = 'secreto';
  assert.strictEqual(es.estaHabilitado(), false, 'falta el config id: sigue apagado');

  process.env.META_ES_CONFIG_ID = 'cfg';
  assert.strictEqual(es.estaHabilitado(), true);
  process.env = prev;
});

test('la config pública NO incluye el app secret', () => {
  const prev = { ...process.env };
  process.env.META_APP_ID = 'app-123';
  process.env.META_APP_SECRET = 'SECRETO_QUE_NO_DEBE_SALIR';
  process.env.META_ES_CONFIG_ID = 'cfg-456';

  const cfg = es.configPublica();
  const serializado = JSON.stringify(cfg);
  assert.ok(!serializado.includes('SECRETO_QUE_NO_DEBE_SALIR'), 'el app secret jamás viaja al browser');
  assert.strictEqual(cfg.appId, 'app-123');
  assert.strictEqual(cfg.configId, 'cfg-456');
  process.env = prev;
});

test('la app del ES manda: META_ES_APP_ID/SECRET ganan sobre las de Instagram', () => {
  // Dos apps de Meta conviven: la sub-app de Instagram (META_APP_ID) y la
  // principal, dueña de la Configuración de registro insertado. El popup y el
  // canje deben correr con la principal, o Meta rechaza el config_id.
  const prev = { ...process.env };
  process.env.META_APP_ID = 'sub-app-instagram';
  process.env.META_APP_SECRET = 'secreto-ig';
  process.env.META_ES_APP_ID = 'app-principal-whatsapp';
  process.env.META_ES_APP_SECRET = 'secreto-wa';
  process.env.META_ES_CONFIG_ID = 'cfg-789';

  assert.strictEqual(es.estaHabilitado(), true);
  assert.strictEqual(es.configPublica().appId, 'app-principal-whatsapp',
    'el popup abre con la app dueña de la configuración, no con la sub-app de IG');

  // Sin las viejas, las del ES bastan por sí solas.
  delete process.env.META_APP_ID; delete process.env.META_APP_SECRET;
  assert.strictEqual(es.estaHabilitado(), true);
  process.env = prev;
});

// ─────────────────────────────────────────────────────────────────────────────
// Validación de propiedad — el candado central
// ─────────────────────────────────────────────────────────────────────────────

test('rechaza un WABA al que el token NO da acceso (WABA de otro negocio)', async () => {
  const restore = fingirGet(async () => { throw new Error('(#200) Permissions error'); });
  try {
    await assert.rejects(
      () => es.verificarPropiedad({ token: 't', wabaId: WABA, phoneNumberId: NUM }),
      (e) => e instanceof es.PropiedadInvalida && /no da acceso/.test(e.message)
    );
  } finally { restore(); }
});

test('rechaza un número que NO pertenece al WABA autorizado', async () => {
  const restore = fingirGet(async (url) => {
    if (url.endsWith(`/${WABA}`)) return { data: { id: WABA, name: 'Negocio Real' } };
    return { data: { data: [{ id: '999999999999999', display_phone_number: '+56 9 0000 0000' }] } };
  });
  try {
    await assert.rejects(
      () => es.verificarPropiedad({ token: 't', wabaId: WABA, phoneNumberId: NUM }),
      (e) => e instanceof es.PropiedadInvalida && /no pertenece/.test(e.message)
    );
  } finally { restore(); }
});

test('rechaza si Meta devuelve un WABA distinto al pedido', async () => {
  const restore = fingirGet(async () => ({ data: { id: '333333333333333', name: 'Otro' } }));
  try {
    await assert.rejects(
      () => es.verificarPropiedad({ token: 't', wabaId: WABA, phoneNumberId: NUM }),
      (e) => e instanceof es.PropiedadInvalida
    );
  } finally { restore(); }
});

test('acepta cuando el WABA y el número sí son del cliente', async () => {
  const restore = fingirGet(async (url) => {
    if (url.endsWith(`/${WABA}`)) return { data: { id: WABA, name: 'Clínica Demo' } };
    return { data: { data: [
      { id: NUM, display_phone_number: '+56 9 8566 6043', verified_name: 'Clínica Demo', quality_rating: 'GREEN' },
    ] } };
  });
  try {
    const r = await es.verificarPropiedad({ token: 't', wabaId: WABA, phoneNumberId: NUM });
    assert.strictEqual(r.numero.display_phone_number, '+56 9 8566 6043');
    assert.strictEqual(r.waba.name, 'Clínica Demo');
  } finally { restore(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PIN de dos pasos
// ─────────────────────────────────────────────────────────────────────────────

test('el PIN son 6 dígitos y no se repite', () => {
  const pins = new Set();
  for (let i = 0; i < 50; i++) {
    const pin = es.generarPin();
    assert.match(pin, /^\d{6}$/, 'exactamente 6 dígitos, con ceros a la izquierda si toca');
    pins.add(pin);
  }
  assert.ok(pins.size > 40, 'no puede ser siempre el mismo valor');
});

test('el PIN está en la lista de campos que nunca salen al cliente', () => {
  const { sanitizeAccount } = require('../services/sanitize');
  const safe = sanitizeAccount({ _id: 'a1', wa_register_pin: '123456', wa_phone_number_id: '55' });
  assert.ok(!('wa_register_pin' in safe), 'el PIN permite re-registrar el número en otra app');
  assert.ok(!JSON.stringify(safe).includes('123456'));
  assert.strictEqual(safe.wa_phone_number_id, '55', 'lo no sensible sigue visible');
});
