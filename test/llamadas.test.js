/**
 * Atinov — Suite de llamadas telefónicas (Twilio)
 *
 * Garantiza que los CANDADOS del batch de llamadas no se rompan:
 *  1. Fail-closed: sin credenciales de Twilio no se programa NADA.
 *  2. Interruptores de cuenta y de agente, los dos obligatorios.
 *  3. Horario permitido (hora Chile), incluyendo ventana que cruza medianoche.
 *  4. Consentimiento: sin mensaje reciente del lead, no hay llamada.
 *  5. Anti-invención: un número que el lead nunca dictó no se marca.
 *  6. Tope 1 llamada por lead por día.
 *  7. Firma de Twilio y token HMAC por llamada.
 *  8. TwiML bien formado y escapado.
 *  9. Costo estimado con redondeo por minuto (como factura Twilio).
 *
 * Corre con `npm test` (node:test nativo). Usa una DB temporal (DB_PATH)
 * para no ensuciar la de desarrollo — cada archivo de test corre en su
 * propio proceso, así que esto no afecta a las otras suites.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-llamadas-test-')
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-test';
process.env.APP_URL = 'https://test.atinov.local';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_PHONE_NUMBER;

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const telefonia = require('../services/telefonia');

const CREDS = {
  TWILIO_ACCOUNT_SID: 'ACtest00000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'token-secreto-twilio',
  TWILIO_PHONE_NUMBER: '+15005550006',
};
function conCredenciales() { Object.assign(process.env, CREDS); }
function sinCredenciales() { Object.keys(CREDS).forEach(k => delete process.env[k]); }

// Ventana horaria abierta AHORA (hora Chile), gane quien gane el reloj: los
// tests del camino feliz no pueden depender de a qué hora corre la suite.
// El candado de horario en sí se prueba aparte con fechas fijas.
function ventanaAbiertaAhora() {
  const h = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', hour: 'numeric', hour12: false,
  }).formatToParts(new Date()).find(p => p.type === 'hour').value);
  return { llamadas_hora_inicio: (h + 23) % 24, llamadas_hora_fin: (h + 2) % 24 };
}

// Fixture mínima: cuenta + agente + lead de WhatsApp con conversación viva.
async function armarLead({ consentHaceMin = 1, plan = 'crecimiento' } = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  // La llamada con IA va por plan: Inicial no la trae. Sin un usuario con un
  // plan que la incluya, el candado de telefonia.js corta antes de empezar.
  await db.insert(db.users, {
    account_id: accountId, email: `test-${accountId}@atinov.com`, membershipPlan: plan,
  });
  const agent = await db.insert(db.agents, {
    account_id: accountId, name: 'Vale', enabled: true, calls_enabled: true,
  });
  const lead = await db.insert(db.leads, {
    account_id: accountId, channel: 'whatsapp', wa_id: '56987654321',
    wa_name: 'Pablo', qualification: 'hot',
  });
  await db.insert(db.messages, {
    lead_id: lead._id, account_id: accountId, role: 'user',
    content: 'ya po, llámame no más',
    createdAt: new Date(Date.now() - consentHaceMin * 60000).toISOString(),
  });
  const settings = { account_id: accountId, llamadas_enabled: true, ...ventanaAbiertaAhora() };
  return { accountId, agent, lead, settings };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-2. FAIL-CLOSED e interruptores
// ─────────────────────────────────────────────────────────────────────────────

test('sin credenciales de Twilio: el marcador se elimina y NO se programa nada', async () => {
  sinCredenciales();
  const { agent, lead, settings } = await armarLead();
  const r = await telefonia.resolveLlamadaMarkers(
    'te llamo altiro 👌 [LLAMAR: whatsapp | dudas del plan]',
    { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 0);
  assert.ok(!r.text.includes('[LLAMAR'), 'el marcador nunca llega crudo al lead');
  assert.ok(r.text.includes('te llamo altiro'), 'el resto del mensaje sobrevive');
  const docs = await db.find(db.llamadas, { lead_id: lead._id });
  assert.strictEqual(docs.length, 0, 'no debe existir llamada programada');
});

test('sin credenciales: la capacidad NO aparece en el prompt', async () => {
  sinCredenciales();
  const { agent, lead, settings } = await armarLead();
  const ctx = await telefonia.buildLlamadaContext({ settings, agent, lead, incomingText: 'llámame' });
  assert.strictEqual(ctx, null);
});

test('interruptor de CUENTA apagado bloquea aunque el del agente esté prendido', async () => {
  conCredenciales();
  const { agent, lead } = await armarLead();
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | tema]',
    { settings: { llamadas_enabled: false }, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 0);
  assert.strictEqual((await db.find(db.llamadas, { lead_id: lead._id })).length, 0);
});

test('interruptor de AGENTE apagado bloquea aunque el de la cuenta esté prendido', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  await db.update(db.agents, { _id: agent._id }, { calls_enabled: false });
  const agentApagado = await db.findOne(db.agents, { _id: agent._id });
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | tema]',
    { settings, account: {}, agent: agentApagado, lead }
  );
  assert.strictEqual(r.llamadas.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. HORARIO (hora Chile, configurable, ventana que cruza medianoche)
// ─────────────────────────────────────────────────────────────────────────────

test('dentroDeHorario respeta la hora de Chile', () => {
  // Agosto = invierno chileno = UTC-4. 12:00Z → 08:00 Chile. 15:00Z → 11:00.
  const s = { llamadas_hora_inicio: 9, llamadas_hora_fin: 21 };
  assert.strictEqual(telefonia.dentroDeHorario(s, new Date('2026-08-12T12:00:00Z')), false, '08:00 Chile es antes de las 9');
  assert.strictEqual(telefonia.dentroDeHorario(s, new Date('2026-08-12T15:00:00Z')), true,  '11:00 Chile está dentro');
  assert.strictEqual(telefonia.dentroDeHorario(s, new Date('2026-08-13T01:30:00Z')), false, '21:30 Chile ya está fuera (fin exclusivo)');
});

test('dentroDeHorario: ventana que cruza medianoche y ventana nula', () => {
  const cruzada = { llamadas_hora_inicio: 22, llamadas_hora_fin: 2 };
  assert.strictEqual(telefonia.dentroDeHorario(cruzada, new Date('2026-08-13T03:00:00Z')), true,  '23:00 Chile entra');
  assert.strictEqual(telefonia.dentroDeHorario(cruzada, new Date('2026-08-12T15:00:00Z')), false, '11:00 Chile no entra');
  const nula = { llamadas_hora_inicio: 9, llamadas_hora_fin: 9 };
  assert.strictEqual(telefonia.dentroDeHorario(nula, new Date('2026-08-12T15:00:00Z')), false, 'ventana inicio=fin = apagado');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONSENTIMIENTO
// ─────────────────────────────────────────────────────────────────────────────

test('sin mensaje reciente del lead NO hay llamada (consentimiento vencido)', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead({ consentHaceMin: 45 });
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | tema]', { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 0, 'un "sí" de hace 45 min no vale como consentimiento');
});

test('camino feliz: programa la llamada, registra consentimiento con cita y hora', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  const antes = Date.now();
  const r = await telefonia.resolveLlamadaMarkers(
    'perfecto, te llamo en un par de minutos 👌 [LLAMAR: whatsapp | resolver dudas del plan founder]',
    { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 1);
  assert.ok(!r.text.includes('[LLAMAR'), 'marcador removido');

  const doc = await db.findOne(db.llamadas, { _id: r.llamadas[0].id });
  assert.strictEqual(doc.status, 'programada');
  assert.strictEqual(doc.telefono, '+56987654321', 'wa_id normalizado a E.164');
  assert.strictEqual(doc.tema, 'resolver dudas del plan founder');
  assert.strictEqual(doc.consent_texto, 'ya po, llámame no más', 'la cita textual del lead queda registrada');
  assert.ok(doc.consent_at, 'la hora del consentimiento queda registrada');
  // Sin ancla (nadie dijo cuándo sale el aviso) → margen conservador de 30 s.
  // Ventana ancha a propósito: bajo carga (suites en paralelo) el reloj se
  // mueve unos segundos entre `antes` y el insert. Lo que se fija es el ORDEN
  // DE MAGNITUD (~30 s), no el segundo exacto.
  const dialMs = new Date(doc.dial_at).getTime() - antes;
  assert.ok(dialMs >= 25_000 && dialMs <= 60_000, `sin ancla marca a los ~30s, fue ${Math.round(dialMs / 1000)}s`);

  const sistema = (await db.find(db.messages, { lead_id: lead._id }))
    .filter(m => m.role === 'sistema');
  assert.ok(sistema.some(m => m.content.includes('Llamada programada')), 'nota de sistema en el hilo');
});

test('la llamada suena 20 s DESPUÉS de que el aviso sale, aunque el agente tenga delay largo', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  // El preset Atinov manda el aviso 20-60 s después: si la llamada se contara
  // desde "ahora", sonaría antes del mensaje. Anclada al envío, siempre después.
  const avisoSaleAt = new Date(Date.now() + 60_000).toISOString();
  const r = await telefonia.resolveLlamadaMarkers(
    'te llamo altiro [LLAMAR: whatsapp | cerrar]',
    { settings, account: {}, agent, lead, avisoSaleAt }
  );
  assert.strictEqual(r.llamadas.length, 1);
  const doc = await db.findOne(db.llamadas, { _id: r.llamadas[0].id });
  const gap = new Date(doc.dial_at).getTime() - new Date(avisoSaleAt).getTime();
  assert.ok(gap >= 19_000 && gap <= 21_000, `debe ser aviso + 20 s, fue aviso + ${Math.round(gap / 1000)}s`);
  assert.ok(new Date(doc.dial_at) > new Date(avisoSaleAt), 'NUNCA antes del aviso');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ANTI-INVENCIÓN de números
// ─────────────────────────────────────────────────────────────────────────────

test('un número que el lead NUNCA dictó no se marca', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: +56 9 1111 2222 | tema]', { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 0, 'número inventado por el modelo = rechazo');
});

test('un número dictado por el lead en la conversación SÍ se acepta', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  await db.insert(db.messages, {
    lead_id: lead._id, account_id: lead.account_id, role: 'user',
    content: 'mejor al 9 3333 4444 que es mi personal',
    createdAt: new Date().toISOString(),
  });
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: 933334444 | coordinar visita]', { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 1);
  const doc = await db.findOne(db.llamadas, { _id: r.llamadas[0].id });
  assert.strictEqual(doc.telefono, '+56933334444');
});

test('marcador "whatsapp" con lead que NO es de WhatsApp = rechazo', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  await db.update(db.leads, { _id: lead._id }, { channel: 'instagram', wa_id: null });
  const leadIG = await db.findOne(db.leads, { _id: lead._id });
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | tema]', { settings, account: {}, agent, lead: leadIG }
  );
  assert.strictEqual(r.llamadas.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TOPE por lead y por día
// ─────────────────────────────────────────────────────────────────────────────

test('segunda llamada al mismo lead el mismo día = rechazo (aunque la primera no contestó)', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  const r1 = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | tema]', { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r1.llamadas.length, 1);
  await db.update(db.llamadas, { _id: r1.llamadas[0].id }, { status: 'no_contesto' });

  const r2 = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | tema]', { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r2.llamadas.length, 0, 'una llamada por lead por día, contestada o no');
});

test('dos marcadores en el mismo mensaje: solo el primero programa', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  const r = await telefonia.resolveLlamadaMarkers(
    '[LLAMAR: whatsapp | a] y de nuevo [LLAMAR: whatsapp | b]',
    { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 1);
  assert.ok(!r.text.includes('[LLAMAR'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. TOKEN HMAC y FIRMA de Twilio
// ─────────────────────────────────────────────────────────────────────────────

test('tokenLlamada: válido solo para SU llamada, timing-safe ante basura', () => {
  const t = telefonia.tokenLlamada('llamada-123');
  assert.ok(telefonia.tokenValido('llamada-123', t));
  assert.ok(!telefonia.tokenValido('llamada-456', t), 'token de otra llamada no sirve');
  assert.ok(!telefonia.tokenValido('llamada-123', t.slice(0, -1) + 'x'), 'token alterado no sirve');
  assert.ok(!telefonia.tokenValido('llamada-123', ''), 'vacío no sirve');
  assert.ok(!telefonia.tokenValido('llamada-123', null), 'null no sirve');
});

test('firmaTwilioValida acepta la firma real y rechaza forjadas', () => {
  conCredenciales();
  const originalUrl = '/webhook/twilio/status?ll=abc&t=def';
  const body = { CallStatus: 'completed', CallDuration: '61', CallSid: 'CAxxx' };
  const url = process.env.APP_URL + originalUrl;
  const data = url + Object.keys(body).sort().map(k => k + body[k]).join('');
  const firma = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN)
    .update(Buffer.from(data, 'utf8')).digest('base64');

  const reqOk = { headers: { 'x-twilio-signature': firma }, originalUrl, body };
  assert.ok(telefonia.firmaTwilioValida(reqOk));

  const reqMal = { headers: { 'x-twilio-signature': firma }, originalUrl, body: { ...body, CallDuration: '9999' } };
  assert.ok(!telefonia.firmaTwilioValida(reqMal), 'cambiar un param invalida la firma');

  const reqSin = { headers: {}, originalUrl, body };
  assert.ok(!telefonia.firmaTwilioValida(reqSin), 'sin header = rechazo');
});

test('firmaTwilioValida sobrevive al sanitizador XSS usando el raw body', () => {
  conCredenciales();
  const originalUrl = '/webhook/twilio/status?ll=abc&t=def';
  // Twilio firmó el valor ORIGINAL "AT&T"...
  const raw = 'CallStatus=completed&CallerName=AT%26T';
  const url = process.env.APP_URL + originalUrl;
  const orig = { CallStatus: 'completed', CallerName: 'AT&T' };
  const data = url + Object.keys(orig).sort().map(k => k + orig[k]).join('');
  const firma = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN)
    .update(Buffer.from(data, 'utf8')).digest('base64');

  // ...pero sanitizeBody ya reescribió el body parseado ("AT&amp;T").
  const req = {
    headers: { 'x-twilio-signature': firma },
    originalUrl,
    body: { CallStatus: 'completed', CallerName: 'AT&amp;T' },
    rawBody: Buffer.from(raw, 'utf8'),
  };
  assert.ok(telefonia.firmaTwilioValida(req), 'la firma se valida sobre el raw, no sobre lo sanitizado');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. TwiML
// ─────────────────────────────────────────────────────────────────────────────

test('twimlParaLlamada: wss correcto, Parameters presentes, XML escapado', () => {
  conCredenciales();
  const xml = telefonia.twimlParaLlamada('id-con-<raros>&"');
  assert.ok(xml.includes('wss://test.atinov.local/twilio-media'), 'https → wss');
  assert.ok(xml.includes('<Connect>') && xml.includes('<Stream'), 'estructura Connect/Stream');
  assert.ok(xml.includes('&lt;raros&gt;&amp;&quot;'), 'el id va escapado');
  assert.ok(!xml.includes('<raros>'), 'nada de XML inyectable');
  assert.ok(xml.includes('name="t"'), 'el token viaja como Parameter, no en la URL');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. COSTOS
// ─────────────────────────────────────────────────────────────────────────────

test('costoEstimadoUSD redondea el minuto hacia arriba como factura Twilio', () => {
  const c61 = telefonia.costoEstimadoUSD(61);
  assert.strictEqual(c61.minutos, 2, '61s = 2 minutos facturables');
  assert.ok(Math.abs(c61.twilio - 2 * telefonia.USD_MIN_TWILIO_MOVIL) < 1e-9);
  assert.ok(c61.total_est > c61.twilio, 'el total incluye OpenAI');

  const c300 = telefonia.costoEstimadoUSD(300);
  assert.strictEqual(c300.minutos, 5);
  assert.ok(c300.total_est >= 0.48 && c300.total_est <= 0.68,
    `5 min cae en el rango verificado del batch doc (US$0,48-0,68), fue ${c300.total_est}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Extras de robustez
// ─────────────────────────────────────────────────────────────────────────────

test('marcador truncado por max_tokens se limpia igual (scrub residual)', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  const r = await telefonia.resolveLlamadaMarkers(
    'te llamo [LLAMAR: whatsapp | tema que quedó cor',
    { settings, account: {}, agent, lead }
  );
  assert.ok(!r.text.includes('[LLAMAR'), 'ni truncado llega crudo al lead');
  assert.strictEqual(r.llamadas.length, 0);
});

test('buildLlamadaContext: aparece con lead HOT, y con lead frío solo si lo pide', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead();
  const ctxHot = await telefonia.buildLlamadaContext({ settings, agent, lead, incomingText: 'ya' });
  assert.ok(ctxHot && ctxHot.includes('[LLAMAR:'), 'lead hot recibe la capacidad');

  await db.update(db.leads, { _id: lead._id }, { qualification: 'warm' });
  const leadWarm = await db.findOne(db.leads, { _id: lead._id });
  const ctxFrio = await telefonia.buildLlamadaContext({ settings, agent, lead: leadWarm, incomingText: 'cuánto vale?' });
  assert.strictEqual(ctxFrio, null, 'lead no-hot sin pedirlo: sin capacidad');
  const ctxPide = await telefonia.buildLlamadaContext({ settings, agent, lead: leadWarm, incomingText: 'mejor llámame y lo vemos' });
  assert.ok(ctxPide, 'si el lead lo pide, la capacidad aparece aunque no esté hot');
});

test('resumenTranscript respeta el tope de caracteres y toma el final', () => {
  const tr = Array.from({ length: 50 }, (_, i) => ({ quien: i % 2 ? 'lead' : 'agente', texto: `línea ${i} xxxxxxxxxx` }));
  const out = telefonia.resumenTranscript(tr, 200);
  assert.ok(out.length <= 220, 'acotado');
  assert.ok(out.includes('línea 49'), 'incluye el final');
  assert.ok(!out.includes('línea 0 '), 'no arranca del principio');
});

// ── CANDADO DE PLAN ──────────────────────────────────────────────────────────
// La llamada con IA es lo que separa Inicial de Crecimiento. Si este candado
// se cae, el plan de entrada regala el diferenciador y la escalera pierde
// sentido comercial — además de gastar Twilio y Realtime que nadie pagó.

test('plan Inicial: el agente ni se entera de que puede llamar', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead({ plan: 'inicial' });
  const ctx = await telefonia.buildLlamadaContext({
    settings, agent, lead, incomingText: 'llámame por favor',
  });
  assert.strictEqual(ctx, null, 'sin plan con llamadas, no hay capacidad en el prompt');
});

test('plan Inicial: aunque llegue el marcador, no se programa nada', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead({ plan: 'inicial' });
  const r = await telefonia.resolveLlamadaMarkers(
    'Perfecto, te llamo al tiro. [LLAMAR: whatsapp | cerrar la venta]',
    { settings, account: {}, agent, lead }
  );
  assert.strictEqual(r.llamadas.length, 0, 'no se programa ninguna llamada');
  assert.ok(!/LLAMAR/.test(r.text), 'el marcador se limpia del mensaje al cliente');
});

test('plan Crecimiento: la llamada sí está disponible', async () => {
  conCredenciales();
  const { agent, lead, settings } = await armarLead({ plan: 'crecimiento' });
  const ctx = await telefonia.buildLlamadaContext({
    settings, agent, lead, incomingText: 'llámame por favor',
  });
  assert.ok(ctx, 'Crecimiento compró la llamada: tiene que aparecer');
});
