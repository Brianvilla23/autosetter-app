/**
 * Atinov — Agrupar mensajes rápidos del lead
 *
 * Lo que se fija: una ráfaga de burbujas se responde UNA vez con todas las
 * partes en orden; cada burbuja nueva reinicia la espera; el tope máximo
 * dispara aunque la persona siga escribiendo; leads distintos no se mezclan;
 * un error del consumidor no rompe el agrupador.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { crearAgrupador } = require('../services/agrupadorMensajes');

/** Reloj + timers falsos: avanzar(ms) ejecuta lo que venza. */
function relojFalso() {
  let t = 0;
  const cola = [];   // { en, fn, id }
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; cola.push({ en: t + ms, fn, id }); return id; },
    clearTimeout(id) { const i = cola.findIndex(x => x.id === id); if (i >= 0) cola.splice(i, 1); },
  };
  async function avanzar(ms) {
    const hasta = t + ms;
    while (true) {
      const listos = cola.filter(x => x.en <= hasta).sort((a, b) => a.en - b.en);
      if (!listos.length) break;
      const x = listos[0];
      cola.splice(cola.indexOf(x), 1);
      t = x.en;
      x.fn();
      await new Promise(r => setImmediate(r));   // deja correr la promesa del disparo
    }
    t = hasta;
  }
  return { timers, avanzar, ahora: () => t };
}

test('una rafaga de 3 burbujas dispara UNA vez con las 3 partes en orden', async () => {
  const r = relojFalso();
  const ag = crearAgrupador({ esperaMs: 2500, maxMs: 12000, timers: r.timers, ahora: r.ahora });
  const disparos = [];
  const al = (partes) => disparos.push(partes.map(p => p.text));

  ag.agregar('lead-1', { text: 'hola' }, al);
  await r.avanzar(1000);
  ag.agregar('lead-1', { text: 'quiero saber el precio' }, al);
  await r.avanzar(1000);
  ag.agregar('lead-1', { text: 'es para mi negocio' }, al);
  assert.strictEqual(ag.pendientes('lead-1'), 3);
  assert.deepStrictEqual(disparos, [], 'todavia no: la persona sigue escribiendo');

  await r.avanzar(2499);
  assert.deepStrictEqual(disparos, [], 'a 1 ms del silencio, aun no');
  await r.avanzar(1);
  assert.deepStrictEqual(disparos, [['hola', 'quiero saber el precio', 'es para mi negocio']]);
  assert.strictEqual(ag.pendientes('lead-1'), 0);
});

test('cada burbuja nueva reinicia la espera', async () => {
  const r = relojFalso();
  const ag = crearAgrupador({ esperaMs: 2500, maxMs: 12000, timers: r.timers, ahora: r.ahora });
  const disparos = [];
  const al = (p) => disparos.push(p.length);
  ag.agregar('l', { text: 'a' }, al);
  await r.avanzar(2000);
  ag.agregar('l', { text: 'b' }, al);
  await r.avanzar(2000);
  assert.deepStrictEqual(disparos, [], 'a 4 s del primero pero solo 2 s del ultimo');
  await r.avanzar(500);
  assert.deepStrictEqual(disparos, [2]);
});

test('tope maximo: si sigue escribiendo, se responde igual a los MAX_MS', async () => {
  const r = relojFalso();
  const ag = crearAgrupador({ esperaMs: 2500, maxMs: 6000, timers: r.timers, ahora: r.ahora });
  const disparos = [];
  const al = (p) => disparos.push(p.length);
  for (let i = 0; i < 10; i++) {           // una burbuja cada segundo, sin parar
    ag.agregar('l', { text: 'x' + i }, al);
    await r.avanzar(1000);
    if (disparos.length) break;
  }
  assert.strictEqual(disparos.length, 1, 'disparo por tope');
  assert.ok(disparos[0] >= 6 && disparos[0] <= 7, 'agrupo lo escrito hasta el tope: ' + disparos[0]);
});

test('leads distintos no se mezclan', async () => {
  const r = relojFalso();
  const ag = crearAgrupador({ esperaMs: 1000, maxMs: 5000, timers: r.timers, ahora: r.ahora });
  const disparos = {};
  const al = (clave) => (p) => { disparos[clave] = p.map(x => x.text); };
  ag.agregar('A', { text: 'a1' }, al('A'));
  ag.agregar('B', { text: 'b1' }, al('B'));
  ag.agregar('A', { text: 'a2' }, al('A'));
  await r.avanzar(1000);
  assert.deepStrictEqual(disparos, { A: ['a1', 'a2'], B: ['b1'] });
});

test('un error del consumidor no rompe el agrupador ni los otros leads', async () => {
  const r = relojFalso();
  const ag = crearAgrupador({ esperaMs: 100, maxMs: 1000, timers: r.timers, ahora: r.ahora });
  const ok = [];
  ag.agregar('malo', { text: 'x' }, () => { throw new Error('boom'); });
  ag.agregar('bueno', { text: 'y' }, (p) => ok.push(p.length));
  const origError = console.error; console.error = () => {};
  try { await r.avanzar(100); } finally { console.error = origError; }
  assert.deepStrictEqual(ok, [1]);
  assert.strictEqual(ag.pendientes('malo'), 0);
  // y el lead "malo" puede volver a escribir
  ag.agregar('malo', { text: 'z' }, (p) => ok.push(p.length));
  await r.avanzar(100);
  assert.deepStrictEqual(ok, [1, 1]);
});

// -- Integracion minima con runConversation (sin red) ---------------------------
test('runConversation con partes: relee el lead y NO responde si el dueno tomo el control', async () => {
  process.env.DB_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'atinov-agrup-int-'));
  delete process.env.OPENAI_API_KEY;
  const db = require('../db/database');
  const webhook = require('../routes/webhook');
  assert.strictEqual(typeof webhook.runConversation, 'function', 'runConversation debe exportarse para testear el gate');

  const lead = await db.insert(db.leads, { account_id: 'acc', wa_id: '56911111111', channel: 'whatsapp', automation: 'automated', is_bypassed: false });
  // Las burbujas ya estan guardadas (asi lo hace el handler antes de agrupar).
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola', mid: 'wamid.1' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'precio?', mid: 'wamid.2' });
  // Mientras escribia, el dueno tomo el control.
  await db.update(db.leads, { _id: lead._id }, { automation: 'paused', is_bypassed: true });

  const r = await webhook.runConversation({
    account: { _id: 'acc' }, agent: { _id: 'ag', name: 'A' }, lead, senderId: '56911111111',
    partes: [{ text: 'hola', mid: 'wamid.1' }, { text: 'precio?', mid: 'wamid.2' }],
  });
  assert.strictEqual(r, false, 'lead viejo decia automated; el fresco dice pausado → no responde');
  const msgs = await db.find(db.messages, { lead_id: lead._id });
  assert.strictEqual(msgs.length, 2, 'no duplica las burbujas ya guardadas');
});
