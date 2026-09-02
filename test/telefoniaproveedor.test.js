/**
 * Atinov — Tests de la capa de proveedor de telefonía (Twilio | Telnyx)
 *
 * Esta capa nació porque Twilio dejó la cuenta bloqueada 13 días con el error
 * 18603 y una consola que no ofrece dónde escribir la dirección. La lección
 * es la misma de Cloudflare: un proveedor único es un punto único de falla.
 *
 * Lo que se fija acá:
 *  1. La SELECCIÓN es explícita y predecible: la variable manda, la
 *     autodetección es el respaldo, y agregar credenciales NUNCA cambia de
 *     proveedor solo — cambiar de operador telefónico tiene que ser una
 *     decisión escrita.
 *  2. Fail-closed: con credenciales incompletas la telefonía queda apagada.
 *  3. Las dos diferencias que romperían la llamada en silencio:
 *     - TeXML necesita bidirectionalMode="rtp" o el lead NO escucha al agente
 *       (el audio entra pero no sale, y nadie ve un error),
 *     - el audio de vuelta lleva streamSid en Twilio y NO lo lleva en Telnyx.
 */

// DB temporal: llamadaBridge arrastra db/database.js al cargarse, y dos test
// abriendo los mismos .db en paralelo disparan EPERM en la compactacion de
// NeDB (el mismo motivo por el que services/channels/core.js vive aparte).
process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-telprov-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');

const prov = require('../services/telefoniaProveedor');
const { leerStart, msgAudio, msgClear } = require('../services/llamadaBridge');

const VARS = [
  'TELEFONIA_PROVEEDOR', 'TELEFONIA_USD_MIN',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'TELNYX_API_KEY', 'TELNYX_ACCOUNT_SID', 'TELNYX_APP_SID', 'TELNYX_PHONE_NUMBER',
  'TELNYX_PUBLIC_KEY',
];
function limpiar() { for (const v of VARS) delete process.env[v]; }
function conTwilio() {
  process.env.TWILIO_ACCOUNT_SID  = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN   = 'tok-test';
  process.env.TWILIO_PHONE_NUMBER = '+15550001111';
}
function conTelnyx() {
  process.env.TELNYX_API_KEY      = 'KEY-test';
  process.env.TELNYX_ACCOUNT_SID  = 'acc-test';
  process.env.TELNYX_APP_SID      = 'app-test';
  process.env.TELNYX_PHONE_NUMBER = '+56220000000';
}

// ── Selección de proveedor ──────────────────────────────────────────────────

test('sin credenciales: la telefonía queda APAGADA (fail-closed)', () => {
  limpiar();
  assert.strictEqual(prov.telefoniaHabilitada(), false);
  const e = prov.estadoTelefonia();
  assert.strictEqual(e.configurado, false);
  assert.ok(e.faltantes.length > 0, 'dice QUÉ falta, no solo que falla');
});

test('credenciales incompletas siguen siendo fail-closed', () => {
  limpiar();
  process.env.TELNYX_API_KEY = 'KEY-test';
  process.env.TELNYX_ACCOUNT_SID = 'acc-test';
  // faltan APP_SID y PHONE_NUMBER
  assert.strictEqual(prov.telefoniaHabilitada(), false);
  const e = prov.estadoTelefonia();
  assert.deepStrictEqual(e.faltantes.sort(), ['TELNYX_APP_SID', 'TELNYX_PHONE_NUMBER'].sort());
});

test('autodetección: se usa el que esté configurado', () => {
  limpiar(); conTelnyx();
  assert.strictEqual(prov.proveedorActivo().id, 'telnyx');
  assert.strictEqual(prov.telefoniaHabilitada(), true);

  limpiar(); conTwilio();
  assert.strictEqual(prov.proveedorActivo().id, 'twilio');
});

test('con AMBOS configurados y sin variable, gana Twilio: cambiar de operador no puede ser un efecto secundario', () => {
  limpiar(); conTwilio(); conTelnyx();
  assert.strictEqual(prov.proveedorActivo().id, 'twilio');
  assert.strictEqual(prov.estadoTelefonia().forzado, false);
});

test('la variable TELEFONIA_PROVEEDOR manda sobre la autodetección', () => {
  limpiar(); conTwilio(); conTelnyx();
  process.env.TELEFONIA_PROVEEDOR = 'telnyx';
  assert.strictEqual(prov.proveedorActivo().id, 'telnyx');
  assert.strictEqual(prov.estadoTelefonia().forzado, true);

  process.env.TELEFONIA_PROVEEDOR = 'TWILIO';   // mayúsculas y espacios toleran
  assert.strictEqual(prov.proveedorActivo().id, 'twilio');
  process.env.TELEFONIA_PROVEEDOR = '  telnyx ';
  assert.strictEqual(prov.proveedorActivo().id, 'telnyx');
});

test('un proveedor inexistente no rompe: avisa y cae a la autodetección', () => {
  limpiar(); conTelnyx();
  process.env.TELEFONIA_PROVEEDOR = 'vonage';
  assert.strictEqual(prov.proveedorActivo().id, 'telnyx');
});

// ── Costo por minuto ────────────────────────────────────────────────────────

test('el costo/minuto es configurable, con el de Twilio como piso conservador', () => {
  limpiar();
  // Sin variable: la tarifa VERIFICADA de Twilio. Subestimar el costo infla el
  // margen en el papel — el error que el monitor de margen existe para evitar.
  assert.strictEqual(prov.costoMinutoUSD(), 0.0746);
  process.env.TELEFONIA_USD_MIN = '0.019';
  assert.strictEqual(prov.costoMinutoUSD(), 0.019);
  // Basura o negativo → vuelve al conservador, nunca a cero.
  process.env.TELEFONIA_USD_MIN = 'gratis';
  assert.strictEqual(prov.costoMinutoUSD(), 0.0746);
  process.env.TELEFONIA_USD_MIN = '-1';
  assert.strictEqual(prov.costoMinutoUSD(), 0.0746);
});

// ── El XML del stream: la diferencia que rompería la llamada en silencio ────

test('TeXML pide el audio de vuelta explícito; TwiML lo trae implícito', () => {
  const args = { wsUrl: 'wss://atinov.com/twilio-media', parametros: { ll: 'abc', t: 'xyz' } };

  const twiml = prov.PROVEEDORES.twilio.streamXml(args);
  assert.match(twiml, /<Connect>/);
  assert.match(twiml, /<Stream url="wss:\/\/atinov\.com\/twilio-media">/);
  assert.match(twiml, /<Parameter name="ll" value="abc"\/>/);
  assert.match(twiml, /<Parameter name="t" value="xyz"\/>/);

  const texml = prov.PROVEEDORES.telnyx.streamXml(args);
  // SIN esto el agente oye al lead y el lead NO oye al agente. Falla muda.
  assert.match(texml, /bidirectionalMode="rtp"/);
  assert.match(texml, /bidirectionalCodec="PCMU"/);
  assert.match(texml, /bidirectionalSamplingRate="8000"/);
  // Mismo códec que acepta OpenAI Realtime nativo: cero transcodificación.
  assert.match(texml, /codec="PCMU"/);
  assert.match(texml, /<Parameter name="ll" value="abc"\/>/);
});

test('el XML escapa lo que se le meta: los parámetros no pueden inyectar etiquetas', () => {
  const malicioso = { wsUrl: 'wss://x/y?a=1&b=2', parametros: { ll: '"><Hangup/>', t: "o'reilly & <b>" } };
  for (const id of ['twilio', 'telnyx']) {
    const xml = prov.PROVEEDORES[id].streamXml(malicioso);
    assert.ok(!xml.includes('<Hangup/>'), `${id}: se coló una etiqueta`);
    assert.match(xml, /&amp;/);
    assert.match(xml, /&quot;|&apos;/);
  }
});

// ── Firma de webhooks ───────────────────────────────────────────────────────

test('Twilio sin auth token: fail-closed con motivo', () => {
  limpiar();
  const r = prov.PROVEEDORES.twilio.firmaValida({ headers: {}, body: {}, originalUrl: '/x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /TWILIO_AUTH_TOKEN/);
});

test('Twilio: firma válida pasa, firma alterada NO', () => {
  limpiar(); conTwilio();
  process.env.APP_URL = 'https://atinov.com';
  const crypto = require('crypto');
  const url = 'https://atinov.com/webhook/twilio/status?ll=1&t=2';
  const body = { CallSid: 'CA1', CallStatus: 'completed' };
  const data = url + Object.keys(body).sort().map(k => k + body[k]).join('');
  const firma = crypto.createHmac('sha1', 'tok-test').update(Buffer.from(data, 'utf8')).digest('base64');

  const req = { headers: { 'x-twilio-signature': firma }, body, originalUrl: '/webhook/twilio/status?ll=1&t=2' };
  assert.strictEqual(prov.PROVEEDORES.twilio.firmaValida(req).ok, true);

  const alterado = { ...req, body: { ...body, CallStatus: 'busy' } };
  assert.strictEqual(prov.PROVEEDORES.twilio.firmaValida(alterado).ok, false);
});

test('Telnyx sin llave pública: no verifica, pero lo DICE (el candado es el token por llamada)', () => {
  limpiar(); conTelnyx();
  const r = prov.PROVEEDORES.telnyx.firmaValida({ headers: {}, body: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sinVerificar, true, 'tiene que quedar marcado como no verificado');
  assert.match(r.motivo, /token HMAC/);
});

test('Telnyx con llave pública: verifica Ed25519 de verdad', () => {
  limpiar(); conTelnyx();
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
  process.env.TELNYX_PUBLIC_KEY = pubRaw.toString('base64');

  const ts = String(Math.floor(Date.now() / 1000));
  const cuerpo = JSON.stringify({ data: { event_type: 'call.answered' } });
  const firma = crypto.sign(null, Buffer.from(`${ts}|${cuerpo}`, 'utf8'), privateKey).toString('base64');

  const req = {
    headers: { 'telnyx-signature-ed25519': firma, 'telnyx-timestamp': ts },
    rawBody: Buffer.from(cuerpo, 'utf8'),
  };
  assert.strictEqual(prov.PROVEEDORES.telnyx.firmaValida(req).ok, true);

  // Cuerpo alterado → la firma deja de calzar.
  const alterado = { ...req, rawBody: Buffer.from(JSON.stringify({ data: { event_type: 'call.hangup' } }), 'utf8') };
  assert.strictEqual(prov.PROVEEDORES.telnyx.firmaValida(alterado).ok, false);

  // Timestamp viejo → anti-replay.
  const viejo = { ...req, headers: { ...req.headers, 'telnyx-timestamp': String(Math.floor(Date.now() / 1000) - 900) } };
  const rv = prov.PROVEEDORES.telnyx.firmaValida(viejo);
  assert.strictEqual(rv.ok, false);
  assert.match(rv.motivo, /ventana/);
});

// ── Normalización del WebSocket en el bridge ────────────────────────────────

test('leerStart entiende el formato de los DOS proveedores', () => {
  const twilio = {
    event: 'start',
    start: { streamSid: 'MZ123', customParameters: { ll: 'lla-1', t: 'tok-1' } },
  };
  const rt = leerStart(twilio);
  assert.strictEqual(rt.proveedor, 'twilio');
  assert.strictEqual(rt.streamId, 'MZ123');
  assert.deepStrictEqual(rt.params, { ll: 'lla-1', t: 'tok-1' });

  const telnyx = {
    event: 'start',
    stream_id: '32DE0DEA-53CB',
    start: {
      call_control_id: 'v2:abc',
      customParameters: { ll: 'lla-2', t: 'tok-2' },
      media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
    },
  };
  const rx = leerStart(telnyx);
  assert.strictEqual(rx.proveedor, 'telnyx');
  assert.strictEqual(rx.streamId, '32DE0DEA-53CB');
  assert.deepStrictEqual(rx.params, { ll: 'lla-2', t: 'tok-2' });
});

test('leerStart no revienta con un start vacío o basura', () => {
  for (const msg of [{}, { start: {} }, { event: 'start' }]) {
    const r = leerStart(msg);
    assert.deepStrictEqual(r.params, {});
    assert.strictEqual(r.streamId, null);
  }
});

test('el audio de vuelta lleva streamSid en Twilio y NO en Telnyx', () => {
  const tw = msgAudio('twilio', 'MZ123', 'BASE64AUDIO');
  assert.deepStrictEqual(tw, { event: 'media', streamSid: 'MZ123', media: { payload: 'BASE64AUDIO' } });

  const tx = msgAudio('telnyx', '32DE0DEA', 'BASE64AUDIO');
  assert.deepStrictEqual(tx, { event: 'media', media: { payload: 'BASE64AUDIO' } });
  assert.ok(!('streamSid' in tx), 'Telnyx no espera streamSid en la salida');
});

test('el clear del barge-in también difiere', () => {
  assert.deepStrictEqual(msgClear('twilio', 'MZ123'), { event: 'clear', streamSid: 'MZ123' });
  assert.deepStrictEqual(msgClear('telnyx', '32DE0DEA'), { event: 'clear' });
});
