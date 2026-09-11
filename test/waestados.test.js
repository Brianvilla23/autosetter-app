/**
 * Atinov — "Enviada" no es "entregada" (WhatsApp)
 *
 * 2026-09-10: el boton "Enviarme las 10 voces" mostro 10/10 enviadas y no
 * llego ninguna. Meta acepta el envio con 200 y lo descarta DESPUES por la
 * ventana de 24 h (codigo 131047), avisando por un webhook de `statuses` que
 * nadie leia. Esto fija tres cosas:
 *   1. Los estados de Meta se guardan y se explican.
 *   2. La ventana de 24 h se revisa en NUESTRA base antes de gastar.
 *   3. El boton se niega a enviar con la ventana cerrada (sin tocar la red) y,
 *      con la ventana abierta, informa ENTREGA por voz, no "aceptada".
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-waestados-test-')
);
process.env.OPENAI_API_KEY = 'sk-test';

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../db/database');
const waEstados = require('../services/waEstados');
const { POR_CUENTA } = require('../services/supresionPlan');
const adminRouter = require('../routes/admin');

const ACCOUNT = 'acc-wa-1';
const PHONE_ID = 'pnid-123';
const MI_CEL = '56995684130';

function handlerDe(router, path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}
function llamar(handler, body) {
  return new Promise((resolve) => {
    const req = { body, params: {}, query: {}, user: { accountId: ACCOUNT, userId: 'u1', role: 'admin' } };
    const res = { _status: 200, status(s) { this._status = s; return this; }, json(d) { resolve({ status: this._status, data: d }); } };
    Promise.resolve(handler(req, res, (e) => resolve({ status: 500, data: { error: e && e.message } })))
      .catch(e => resolve({ status: 500, data: { error: e.message } }));
  });
}
const probarVoces = handlerDe(adminRouter, '/probar-voces', 'post');

const STATUS_FALLIDO = {
  id: 'wamid.FALLA', status: 'failed', timestamp: '1757548800', recipient_id: MI_CEL,
  errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message',
    error_data: { details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.' } }],
};

async function limpiar() {
  for (const c of ['accounts', 'leads', 'messages', 'waEstados', 'settings']) await db.remove(db[c], {}, { multi: true });
  await db.insert(db.accounts, { _id: ACCOUNT, wa_phone_number_id: PHONE_ID, wa_access_token: 'tok', wa_display_number: '+56 9 8566 6043' });
}

// -- 1. Estados de Meta -------------------------------------------------------

test('resumirEstado saca codigo, titulo y detalle de un failed; normaliza el numero', () => {
  const r = waEstados.resumirEstado(STATUS_FALLIDO);
  assert.strictEqual(r.wamid, 'wamid.FALLA');
  assert.strictEqual(r.estado, 'failed');
  assert.strictEqual(r.codigo, 131047);
  assert.match(r.detalle, /24 hours/);
  assert.strictEqual(waEstados.normalizarWaId('+56 9 9568 4130'), MI_CEL);
  assert.strictEqual(waEstados.resumirEstado(null), null);
});

test('explicarFallo: 131047 dice lo que el dueno tiene que hacer', () => {
  const t = waEstados.explicarFallo(131047, '', '+56 9 8566 6043');
  assert.match(t, /24 horas/);
  assert.match(t, /\+56 9 8566 6043/);
  assert.match(waEstados.explicarFallo(131026), /no está en WhatsApp/);
  assert.match(waEstados.explicarFallo(99999, 'algo raro'), /99999.*algo raro/);
});

test('registrarEstadosWa guarda con la cuenta del phone_number_id y estadosDe se queda con el mas avanzado', async () => {
  await limpiar();
  await waEstados.registrarEstadosWa({ phoneNumberId: PHONE_ID, statuses: [
    { id: 'wamid.A', status: 'sent', timestamp: '1757548800', recipient_id: MI_CEL },
    { id: 'wamid.A', status: 'delivered', timestamp: '1757548801', recipient_id: MI_CEL },
    STATUS_FALLIDO,
  ] });
  const docs = await db.find(db.waEstados, { wamid: 'wamid.A' });
  assert.strictEqual(docs.length, 2);
  assert.ok(docs.every(d => d.account_id === ACCOUNT), 'cada estado sabe de que cuenta es (cascada de borrado)');
  const e = await waEstados.estadosDe(['wamid.A', 'wamid.FALLA', 'wamid.NADA']);
  assert.strictEqual(e['wamid.A'].estado, 'delivered');
  assert.strictEqual(e['wamid.FALLA'].estado, 'failed');
  assert.strictEqual(e['wamid.NADA'], undefined);
});

test('esperarEstados corta al tope y devuelve lo que haya', async () => {
  await limpiar();
  const t0 = Date.now();
  const e = await waEstados.esperarEstados({ wamids: ['wamid.X'], ms: 400, cada: 100 });
  assert.deepStrictEqual(e, {});
  assert.ok(Date.now() - t0 >= 350, 'espero hasta el tope');
});

test('waEstados esta en la cascada de supresion por cuenta (lleva el numero del destinatario)', () => {
  const fila = POR_CUENTA.find(([c]) => c === 'waEstados');
  assert.ok(fila, 'falta waEstados en supresionPlan');
  assert.strictEqual(fila[1], 'account_id');
});

// -- 2. Ventana de 24 h en nuestra base ---------------------------------------

test('ventana24hAbierta: sin lead, con entrante viejo, con entrante reciente', async () => {
  await limpiar();
  let v = await waEstados.ventana24hAbierta({ accountId: ACCOUNT, waId: MI_CEL });
  assert.strictEqual(v.abierta, false, 'nunca escribio');

  const lead = await db.insert(db.leads, { account_id: ACCOUNT, wa_id: MI_CEL, channel: 'whatsapp' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola', createdAt: new Date(Date.now() - 2 * 24 * 3600e3).toISOString() });
  v = await waEstados.ventana24hAbierta({ accountId: ACCOUNT, waId: '+56 9 9568 4130' });
  assert.strictEqual(v.abierta, false, 'hace 2 dias: cerrada');
  assert.match(v.motivo, /24 horas/);

  // Lo que responde el agente NO abre la ventana: solo lo que escribe la persona.
  await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: 'te cuento...' });
  v = await waEstados.ventana24hAbierta({ accountId: ACCOUNT, waId: MI_CEL });
  assert.strictEqual(v.abierta, false, 'la respuesta del agente no cuenta');

  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola de nuevo' });
  v = await waEstados.ventana24hAbierta({ accountId: ACCOUNT, waId: MI_CEL });
  assert.strictEqual(v.abierta, true, 'acaba de escribir: abierta');
});

// -- 3. El boton del panel ----------------------------------------------------

test('probar-voces con la ventana cerrada: 400 con instruccion y CERO llamadas a la red', async () => {
  await limpiar();
  const wa = require('../services/whatsapp');
  const original = wa.sendMessage;
  wa.sendMessage = async () => { throw new Error('NO debia tocar la red'); };
  try {
    const r = await llamar(probarVoces, { to: '+56 9 9568 4130' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /24 horas/);
    assert.match(r.data.error, /\+56 9 8566 6043/, 'le dice a que numero escribir');
    assert.strictEqual(r.data.ventana_24h, false);
  } finally { wa.sendMessage = original; }
});

test('probar-voces con la ventana abierta: informa ENTREGA real por voz, no "aceptada"', async () => {
  await limpiar();
  const lead = await db.insert(db.leads, { account_id: ACCOUNT, wa_id: MI_CEL, channel: 'whatsapp' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola' });

  const wa = require('../services/whatsapp');
  const audio = require('../services/audio');
  const orig = { send: wa.sendMessage, syn: audio.synthesizeVoice, ogg: audio.toVoiceNoteOgg, up: audio.uploadWhatsAppAudio, sendA: audio.sendWhatsAppAudioMessage };
  wa.sendMessage = async () => ({ messages: [{ id: 'wamid.texto' }] });
  audio.synthesizeVoice = async () => Buffer.from('mp3');
  audio.toVoiceNoteOgg = async () => Buffer.from('ogg');
  audio.uploadWhatsAppAudio = async () => 'media-1';
  audio.sendWhatsAppAudioMessage = async () => 'wamid.audio.' + (audio._n = (audio._n || 0) + 1);
  // Meta "responde" por webhook: la primera voz falla por 24 h, la segunda se entrega.
  await waEstados.registrarEstadosWa({ phoneNumberId: PHONE_ID, statuses: [
    { ...STATUS_FALLIDO, id: 'wamid.audio.1' },
    { id: 'wamid.audio.2', status: 'delivered', timestamp: '1757548801', recipient_id: MI_CEL },
  ] });
  try {
    const r = await llamar(probarVoces, { to: MI_CEL, voces: ['alloy', 'cedar'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.enviadas, 2, 'Meta acepto las dos');
    assert.strictEqual(r.data.entregadas, 1);
    assert.strictEqual(r.data.fallidas, 1);
    const [alloy, cedar] = r.data.resultados;
    assert.strictEqual(alloy.entrega, 'fallida');
    assert.match(alloy.motivo, /24 horas/);
    assert.strictEqual(cedar.entrega, 'entregada');
    assert.match(r.data.diagnostico, /24 horas/);
  } finally {
    wa.sendMessage = orig.send; audio.synthesizeVoice = orig.syn; audio.toVoiceNoteOgg = orig.ogg;
    audio.uploadWhatsAppAudio = orig.up; audio.sendWhatsAppAudioMessage = orig.sendA;
  }
});
