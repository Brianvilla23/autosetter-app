/**
 * Atinov — Memoria que razona (memory_profile)
 *
 * Pedido de Brayan (2026-09-12): recordar lo que dice el lead y, si se le
 * vuelve a preguntar, retomar esa conversación. Lo que se fija:
 *  - el perfil se sanea (tipos, topes, sin basura) antes de guardarse;
 *  - el bloque para el prompt dice QUÉ NO REPETIR, qué retomar y qué se prometió;
 *  - sin perfil, se sigue con la lista de hechos de siempre;
 *  - la extracción guarda hechos + perfil en UNA llamada y nunca borra lo
 *    que ya había por una respuesta vacía.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-memoria-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../db/database');
const mem = require('../services/leadMemory');

const PERFIL_CRUDO = {
  quiere: 'camioneta 4x4 para el trabajo',
  presupuesto: { monto: '12000000', moneda: 'clp', certeza: 'baja' },
  urgencia: 'alta',
  etapa_percibida: 'evaluando_opciones',
  objeciones: [
    { tipo: 'precio', detalle: 'le parece caro vs una usada', resuelta: false },
    { tipo: 'desconfianza', detalle: 'pidió ver el local', resuelta: true },
    { tipo: 'x' },                                    // sin detalle: se descarta
  ],
  compromisos: [{ que: 'mandarle la ficha técnica en PDF', cumplido: false }],
  ya_respondio: [
    { pregunta: '¿para qué la necesitas?', respuesta: 'para subir a la mina, terreno' },
    { pregunta: '¿cuándo la necesitas?', respuesta: 'antes de fin de mes' },
  ],
  contexto_personal: ['tiene un taller de gasfitería', 42, ''],
  estilo_escritura: { registro: 'chileno informal, sin tildes', largo_tipico_palabras: 7.6, usa_emojis: false, muletillas: ['ya', 'po'] },
  clave_rara: 'esto no se guarda',
};

test('sanearPerfil: tipos correctos, topes, y descarta lo que no sirve', () => {
  const p = mem.sanearPerfil(PERFIL_CRUDO);
  assert.strictEqual(p.presupuesto.monto, 12000000);
  assert.strictEqual(p.presupuesto.moneda, 'CLP');
  assert.strictEqual(p.presupuesto.certeza, 'baja');
  assert.strictEqual(p.objeciones.length, 2, 'la objeción sin detalle se va');
  assert.strictEqual(p.ya_respondio.length, 2);
  assert.deepStrictEqual(p.contexto_personal, ['tiene un taller de gasfitería']);
  assert.strictEqual(p.estilo_escritura.largo_tipico_palabras, 8);
  assert.ok(!('clave_rara' in p));
  assert.strictEqual(mem.sanearPerfil(null), null);
  assert.strictEqual(mem.sanearPerfil({ urgencia: 'urgentísima' }), null, 'valor fuera del enum y nada más = nada');
});

test('buildMemoryContext razona: no repetir la objeción viva, retomar lo ya respondido, cumplir lo prometido', () => {
  const lead = { memory_facts: ['Rubro: gasfitería'], memory_profile: mem.sanearPerfil(PERFIL_CRUDO) };
  const txt = mem.buildMemoryContext(lead);
  assert.match(txt, /Quiere: camioneta 4x4/);
  assert.match(txt, /Urgencia: ALTA/);
  assert.match(txt, /Objeción SIN resolver \(precio\).*NO repitas el argumento/);
  assert.match(txt, /Objeción ya resuelta \(desconfianza\).*no la vuelvas a abrir/);
  assert.match(txt, /Se le PROMETIÓ y sigue pendiente: mandarle la ficha técnica/);
  assert.match(txt, /Ya te respondió \(NO se lo vuelvas a preguntar/);
  assert.match(txt, /¿cuándo la necesitas\? → antes de fin de mes/);
  assert.match(txt, /lo insinuó, no lo confirmó/, 'presupuesto con certeza baja se marca');
  assert.match(txt, /Escribe así: chileno informal.*~8 palabras.*no usa emojis.*"ya", "po"/);
  assert.match(txt, /Otros hechos:\n• Rubro: gasfitería/);
  assert.match(txt, /NUNCA lo recites en lista/);
});

test('sin perfil se sigue con los hechos de siempre; sin nada, null', () => {
  const txt = mem.buildMemoryContext({ memory_facts: ['Presupuesto: hasta 500 mil'] });
  assert.match(txt, /• Presupuesto: hasta 500 mil/);
  assert.ok(!txt.includes('Ya te respondió'));
  assert.strictEqual(mem.buildMemoryContext({}), null);
  assert.strictEqual(mem.buildMemoryContext(null), null);
});

test('parsearRespuesta: objeto nuevo, con texto alrededor, y el array viejo', () => {
  assert.deepStrictEqual(mem.parsearRespuesta('{"facts":["a"],"perfil":{"urgencia":"alta"}}'), { facts: ['a'], perfil: { urgencia: 'alta' } });
  assert.deepStrictEqual(mem.parsearRespuesta('claro: {"facts":[],"perfil":{}} fin').facts, []);
  assert.deepStrictEqual(mem.parsearRespuesta('["Presupuesto: 500"]'), { facts: ['Presupuesto: 500'], perfil: null });
  assert.strictEqual(mem.parsearRespuesta('nada'), null);
});

async function leadConConversacion(extra = {}) {
  const lead = await db.insert(db.leads, { account_id: 'acc', wa_id: '56911111111', channel: 'whatsapp', ...extra });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola, busco una camioneta 4x4' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'agent', content: '¿para qué la necesitas?' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'para subir a la mina, la necesito antes de fin de mes' });
  return lead;
}

test('updateLeadMemory: UNA llamada guarda hechos + perfil, y el prompt manda el perfil previo', async () => {
  const lead = await leadConConversacion({ memory_profile: { quiere: 'algo viejo' } });
  const llamadas = [];
  const completar = async ({ system, user }) => {
    llamadas.push({ system, user });
    return JSON.stringify({ facts: ['Busca: camioneta 4x4', 'Plazo: fin de mes'], perfil: PERFIL_CRUDO });
  };
  const r = await mem.updateLeadMemory({ leadId: lead._id, apiKey: 'sk-test', completar });
  assert.strictEqual(llamadas.length, 1, 'una sola llamada al modelo');
  assert.match(llamadas[0].system, /"ya_respondio"/);
  assert.match(llamadas[0].user, /PERFIL CONOCIDO:\n\{"quiere":"algo viejo"\}/);
  assert.deepStrictEqual(r.facts, ['Busca: camioneta 4x4', 'Plazo: fin de mes']);
  const doc = await db.findOne(db.leads, { _id: lead._id });
  assert.strictEqual(doc.memory_profile.quiere, 'camioneta 4x4 para el trabajo');
  assert.strictEqual(doc.memory_profile.ya_respondio.length, 2);
  assert.ok(doc.memory_profile.ultima_actualizacion);
  assert.ok(doc.memory_updated_at);
});

test('updateLeadMemory: una respuesta vacía NO borra los hechos ni el perfil que ya había', async () => {
  const previo = mem.sanearPerfil(PERFIL_CRUDO);
  const lead = await leadConConversacion({ memory_facts: ['Rubro: gasfitería'], memory_profile: previo });
  const r = await mem.updateLeadMemory({ leadId: lead._id, apiKey: 'sk-test', completar: async () => '{"facts":[],"perfil":{}}' });
  assert.strictEqual(r, null);
  const doc = await db.findOne(db.leads, { _id: lead._id });
  assert.deepStrictEqual(doc.memory_facts, ['Rubro: gasfitería']);
  assert.strictEqual(doc.memory_profile.quiere, previo.quiere);
});

test('updateLeadMemory: con menos de 2 mensajes del lead no gasta', async () => {
  const lead = await db.insert(db.leads, { account_id: 'acc', wa_id: '56922222222' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola' });
  let llamado = false;
  const r = await mem.updateLeadMemory({ leadId: lead._id, apiKey: 'sk-test', completar: async () => { llamado = true; return '{}'; } });
  assert.strictEqual(r, null);
  assert.strictEqual(llamado, false);
});
