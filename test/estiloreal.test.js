/**
 * Atinov — Tests de "Estilo real" + entrenador
 *
 * El agente aprende CÓMO ESCRIBEN los clientes del negocio (bandeja o chats
 * pegados) y se entrena contra un cliente simulado que escribe igual. Lo que
 * se cubre acá sin tocar la red:
 *   • parseo de exports de WhatsApp (Android/iOS) y de chats genéricos
 *   • anonimización antes de salir al modelo (Ley 21.719)
 *   • saneo del perfil y de la salida del juez (el modelo devuelve basura a
 *     veces: nunca puede romper el prompt)
 *   • el bloque de prompt: sin perfil → '' (cero cambio para agentes viejos)
 *   • el simulador en modo 'cliente_real' habla del negocio de la cuenta y
 *     con el estilo aprendido; los ICPs de Atinov quedan intactos
 *   • rutas: propiedad de la cuenta, cupos diarios y candados de gasto
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-estilo-test-')
);
// Los caminos cubiertos cortan ANTES de tocar la red: sin key real nunca.
delete process.env.OPENAI_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const db = require('../db/database');
const router = require('../routes/intelligence');
const {
  LIMITES, anonimizar, parsearChatExportado, muestrasDesdeMensajes, corpusDesdeTexto,
  sanearPerfil, parsearJSON, bloqueEstilo, bloqueEstiloLead, corpusDesdeBandeja,
  aprenderEstilo, olvidarEstilo,
} = require('../services/estiloReal');
const {
  ICPS, OBJECIONES_CLIENTE, resumenNegocio, buildLeadSystemPrompt, detectOutcome, sanearNaturalidad,
} = require('../services/conversationSimulator');

function handlerDe(path, metodo) {
  const capa = router.stack.find(l => l.route?.path === path && l.route.methods[metodo]);
  assert.ok(capa, `no existe la ruta ${metodo.toUpperCase()} ${path}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}
function llamar(handler, { query = {}, body = {}, accountId } = {}) {
  return new Promise((resolve) => {
    const req = { query, body, user: { accountId } };
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { resolve({ status: this._status, data: d, error: null }); },
    };
    handler(req, res, (e) => resolve({ status: 500, data: null, error: e }));
  });
}
async function armarCuenta(extra = {}) {
  const accountId = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: accountId, ig_username: 'clinicademo' });
  const agent = await db.insert(db.agents, {
    account_id: accountId, name: 'Vendedora', enabled: true, instructions: 'Saluda con buena onda.',
    ...extra.agent,
  });
  return { accountId, agent };
}

const PERFIL = {
  registro: 'chileno informal, tuteo, minúsculas',
  largo: 'clientes 3-8 palabras',
  muletillas: ['po', 'ya', 'al tiro'],
  emojis: 'casi nunca',
  muestras_cliente: ['hola precio?', 'cuanto sale la limpieza', 'ya po y donde estan'],
  pares: [{ cliente: 'hola precio?', humano: 'hola! la limpieza sale 35 lucas, te agendo?' }],
};

// ── Anonimización ────────────────────────────────────────────────────────────

test('anonimizar borra correos, links, teléfonos y @usuarios; deja el resto intacto', () => {
  const t = anonimizar('escríbeme a ana.perez@gmail.com o al +56 9 8566 6043, ig @ana.perez, ver https://x.cl/p?q=1 ya po');
  assert.ok(!t.includes('ana.perez@gmail.com') && t.includes('[correo]'));
  assert.ok(!t.includes('8566') && t.includes('[teléfono]'));
  assert.ok(!t.includes('@ana.perez') && t.includes('[@usuario]'));
  assert.ok(!t.includes('x.cl') && t.includes('[link]'));
  assert.ok(t.endsWith('ya po'));
  // Un precio o una hora NO es teléfono
  assert.strictEqual(anonimizar('sale 35.000 a las 10:30'), 'sale 35.000 a las 10:30');
  assert.strictEqual(anonimizar(null), '');
});

// ── Parseo de chats ──────────────────────────────────────────────────────────

test('parsearChatExportado entiende WhatsApp Android, iOS y "Nombre: mensaje"; pega multilínea y bota sistema', () => {
  const android = [
    '5/9/26, 10:31 - Los mensajes y las llamadas están cifrados de extremo a extremo.',
    '5/9/26, 10:31 - Ana: hola precio?',
    '5/9/26, 10:32 - Clínica: hola! la limpieza sale 35',
    'lucas, te agendo?',
    '5/9/26, 10:33 - Ana: <Multimedia omitido>',
    '5/9/26, 10:34 - Ana: ya po',
  ].join('\n');
  const a = parsearChatExportado(android);
  assert.deepStrictEqual(a, [
    { autor: 'Ana', texto: 'hola precio?' },
    { autor: 'Clínica', texto: 'hola! la limpieza sale 35\nlucas, te agendo?' },
    { autor: 'Ana', texto: 'ya po' },
  ]);

  const ios = '[05/09/26, 10:31:07] Ana: hola precio?\n[05/09/26, 10:32:00] Clínica: 35 lucas';
  assert.deepStrictEqual(parsearChatExportado(ios).map(x => x.autor), ['Ana', 'Clínica']);

  const generico = 'Cliente: Hola, tienen hora mañana?\nYo: sí, a las 10 o a las 16\nCliente: la de las 10';
  const g = parsearChatExportado(generico);
  assert.strictEqual(g.length, 3);
  assert.strictEqual(g[1].autor, 'Yo');

  assert.deepStrictEqual(parsearChatExportado(''), []);
  // Texto corrido sin autores → nada que aprender (no inventa autores)
  assert.deepStrictEqual(parsearChatExportado('esto es un párrafo sin formato de chat'), []);
});

test('corpusDesdeTexto anonimiza cada línea y cuenta mensajes', () => {
  const c = corpusDesdeTexto('Ana: mi correo es a@b.cl\nYo: dale');
  assert.strictEqual(c.n_mensajes, 2);
  assert.ok(c.filas[0].includes('[correo]') && !c.filas[0].includes('a@b.cl'));
});

// ── Corpus desde la bandeja ──────────────────────────────────────────────────

test('muestrasDesdeMensajes: frases de clientes + pares solo con respuestas HUMANAS (manual), nunca del bot', () => {
  const m = muestrasDesdeMensajes([
    { role: 'user', content: 'hola precio?' },
    { role: 'agent', content: 'Hola! Sale 35.000' },      // bot: no es ejemplo humano
    { role: 'user', content: 'y tienen hora mañana' },
    { role: 'manual', content: 'sí, a las 10 te sirve?' }, // dueño: sí
    { role: 'user', content: '' },
    { role: 'sistema', content: 'lead calificado' },
  ]);
  assert.deepStrictEqual(m.clientes, ['hola precio?', 'y tienen hora mañana']);
  assert.deepStrictEqual(m.pares, [{ cliente: 'y tienen hora mañana', humano: 'sí, a las 10 te sirve?' }]);
  assert.deepStrictEqual(muestrasDesdeMensajes(null), { clientes: [], pares: [] });
});

test('corpusDesdeBandeja lee los leads de la cuenta, anonimiza y cuenta conversaciones', async () => {
  const { accountId } = await armarCuenta();
  const lead = await db.insert(db.leads, { account_id: accountId, ig_username: 'ana', last_message_at: '2026-09-01T10:00:00Z' });
  const otra = await db.insert(db.leads, { account_id: 'otra-cuenta', ig_username: 'x', last_message_at: '2026-09-01T10:00:00Z' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'user', content: 'hola mi fono es +56 9 8566 6043', createdAt: '2026-09-01T10:00:00Z' });
  await db.insert(db.messages, { lead_id: lead._id, role: 'manual', content: 'te llamo al tiro', createdAt: '2026-09-01T10:01:00Z' });
  await db.insert(db.messages, { lead_id: otra._id, role: 'user', content: 'NO DEBE APARECER', createdAt: '2026-09-01T10:00:00Z' });

  const c = await corpusDesdeBandeja(accountId);
  assert.strictEqual(c.conversaciones, 1);
  assert.strictEqual(c.n_mensajes, 1);
  assert.ok(c.clientes[0].includes('[teléfono]') && !c.clientes[0].includes('8566'));
  assert.deepStrictEqual(c.pares, [{ cliente: c.clientes[0], humano: 'te llamo al tiro' }]);
  assert.ok(!JSON.stringify(c).includes('NO DEBE APARECER'), 'nunca cruza cuentas');
});

// ── Saneo del perfil ─────────────────────────────────────────────────────────

test('sanearPerfil recorta, dedup y devuelve null sin señal', () => {
  assert.strictEqual(sanearPerfil(null), null);
  assert.strictEqual(sanearPerfil({ muestras_cliente: [] }), null);
  assert.strictEqual(sanearPerfil({ muestras_cliente: ['una', 'dos'] }), null, 'menos de 3 muestras no es un estilo');

  const p = sanearPerfil({
    registro: 'x'.repeat(500),
    muletillas: ['po', 'po', 'ya', 3, null, ...Array(20).fill('z')],
    muestras_cliente: Array(30).fill('m').map((m, i) => `${m}${i} ` + 'w'.repeat(300)),
    pares: [{ cliente: 'a', humano: '' }, { cliente: 'b', humano: 'c' }, ...Array(10).fill({ cliente: 'd', humano: 'e' })],
  });
  assert.strictEqual(p.registro.length, LIMITES.largoCampo);
  assert.deepStrictEqual(p.muletillas, ['po', 'ya', '3', 'z']);
  assert.strictEqual(p.muestras_cliente.length, LIMITES.muestras);
  assert.ok(p.muestras_cliente.every(m => m.length <= LIMITES.largoMuestra));
  assert.strictEqual(p.pares.length, LIMITES.pares);
  assert.ok(p.pares.every(x => x.cliente && x.humano), 'un par sin lado humano no sirve');
});

test('sanearPerfil limpia el andamiaje del esquema que el modelo a veces copia ("1 frase:", "<…>")', () => {
  // Visto en producción el 05-09: gpt-4o-mini devolvió "1 frase: Chile, tuteo…"
  const p = sanearPerfil({
    registro: '1 frase: Chile, tuteo, informal',
    largo: 'Una frase — clientes 5-12 palabras',
    emojis: '<casi nunca>',
    muestras_cliente: ['a', 'b', 'c'],
  });
  assert.strictEqual(p.registro, 'Chile, tuteo, informal');
  assert.strictEqual(p.largo, 'clientes 5-12 palabras');
  assert.strictEqual(p.emojis, 'casi nunca');
});

test('parsearJSON rescata el objeto aunque venga envuelto; nunca throw', () => {
  assert.deepStrictEqual(parsearJSON('claro:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.strictEqual(parsearJSON('sin json'), null);
  assert.strictEqual(parsearJSON('{roto'), null);
  assert.strictEqual(parsearJSON(null), null);
});

// ── Bloques de prompt ────────────────────────────────────────────────────────

test('bloqueEstilo: sin perfil devuelve "" (agentes viejos no cambian ni un byte)', () => {
  assert.strictEqual(bloqueEstilo(null), '');
  assert.strictEqual(bloqueEstilo(undefined), '');
  assert.strictEqual(bloqueEstilo({}), '');
  assert.strictEqual(bloqueEstilo({ muestras_cliente: [] }), '');
  assert.strictEqual(bloqueEstiloLead(null), '');
});

test('bloqueEstilo lleva registro, muletillas, muestras y pares al prompt del agente', () => {
  const b = bloqueEstilo({ ...PERFIL, n_mensajes: 42 });
  assert.ok(b.startsWith('\n\n--- ASÍ ESCRIBEN TUS CLIENTES DE VERDAD (aprendido de 42 mensajes reales) ---'));
  assert.ok(b.includes('Registro: chileno informal'));
  assert.ok(b.includes('"po", "ya", "al tiro"'));
  assert.ok(b.includes('• "hola precio?"'));
  assert.ok(b.includes('Cliente: hola precio?\nHumano: hola! la limpieza sale 35 lucas'));
  assert.ok(b.includes('Nunca más formal ni más largo que el humano de los ejemplos'));
});

test('bloqueEstiloLead le da al bot-prospecto las muestras para escribir como cliente real', () => {
  const b = bloqueEstiloLead(PERFIL);
  assert.ok(b.startsWith('CÓMO ESCRIBES (aprendido de clientes reales'));
  assert.ok(b.includes('"cuanto sale la limpieza"'));
  assert.ok(b.includes('Muletillas: po, ya, al tiro'));
});

// ── Simulador: modo cliente_real ─────────────────────────────────────────────

test('resumenNegocio prefiere p_contexto, luego knowledge, luego instrucciones', () => {
  assert.strictEqual(resumenNegocio({ agent: { p_contexto: '  Clínica dental en La Serena  ' } }), 'Clínica dental en La Serena');
  const kb = resumenNegocio({ agent: {}, knowledge: [{ title: 'Precios', content: 'Limpieza 35.000' }] });
  assert.strictEqual(kb, 'Precios: Limpieza 35.000');
  assert.strictEqual(resumenNegocio({ agent: { instructions: 'Vendes poleras' } }), 'Vendes poleras');
  assert.strictEqual(resumenNegocio({}), 'un negocio que vende por Instagram y WhatsApp');
});

test("buildLeadSystemPrompt('cliente_real') habla del negocio de la cuenta y con el estilo aprendido", () => {
  const p = buildLeadSystemPrompt({
    icp: 'cliente_real', temperature: 'tibio', objection: 'precio',
    negocio: 'Clínica dental Sonrisa', estilo: PERFIL,
  });
  assert.ok(p.includes('CLIENTE real escribiéndole por WhatsApp/Instagram a un negocio'));
  assert.ok(p.includes('Clínica dental Sonrisa'));
  assert.ok(p.includes(OBJECIONES_CLIENTE.precio));
  assert.ok(p.includes('"ya po y donde estan"'), 'usa las muestras reales');
  assert.ok(!p.includes('asistente con IA'), 'no es el prospecto de Atinov');

  // Sin estilo aprendido cae a un default de persona común, no a español de manual
  const sin = buildLeadSystemPrompt({ icp: 'cliente_real', temperature: 'frio', objection: 'ninguna', negocio: 'Tienda de ropa' });
  assert.ok(sin.includes('mensajes de 3 a 12 palabras, en minúscula'));
  assert.ok(sin.includes('Solo estás mirando'));
});

test('los ICPs de Atinov (coach, setter…) siguen recibiendo su prompt de siempre', () => {
  const p = buildLeadSystemPrompt({ icp: 'coach', temperature: 'tibio', objection: 'precio' });
  assert.ok(p.includes('ofreciéndote un asistente con IA'));
  assert.ok(p.includes(ICPS.coach.persona));
  assert.ok(p.includes('español neutro de LATAM'));
  assert.ok(ICPS.cliente_real && ICPS.cliente_real.label, 'cliente_real aparece en el formulario del admin');
});

test('detectOutcome reconoce cierres de cliente común (agendar, pagar, llevar) además de "lo pruebo"', () => {
  assert.strictEqual(detectOutcome('dale, lo pruebo'), 'cerrado');
  assert.strictEqual(detectOutcome('ya, agéndame para la hora de las 10'), 'cerrado');
  assert.strictEqual(detectOutcome('perfecto, cómo pago?'), 'cerrado');
  assert.strictEqual(detectOutcome('lo pienso y te aviso'), 'frio_o_abandono');
  assert.strictEqual(detectOutcome('ya, gracias'), 'frio_o_abandono');
  assert.strictEqual(detectOutcome('y cuánto sale?'), 'en_curso');
});

test('sanearNaturalidad acota el puntaje a 1-10, acepta "senales" con o sin ñ y bota basura', () => {
  assert.strictEqual(sanearNaturalidad(null), null);
  const n = sanearNaturalidad({
    puntaje: 14, veredicto: 'Suena a folleto',
    señales: [{ turno: '2', fragmento: 'Claro que sí', problema: 'muletilla de call center' }, { problema: '' }],
    recomendaciones: [{ causa: 'c', propuesta: 'p' }, { causa: '', propuesta: 'x' }, { causa: 'd', propuesta: 'q' }, { causa: 'e', propuesta: 'r' }],
  });
  assert.strictEqual(n.puntaje, 10);
  assert.deepStrictEqual(n.senales, [{ turno: 2, fragmento: 'Claro que sí', problema: 'muletilla de call center' }]);
  assert.strictEqual(n.recomendaciones.length, 2);
  assert.strictEqual(sanearNaturalidad({ puntaje: 'nada', senales: [] }).puntaje, null);
  assert.strictEqual(sanearNaturalidad({ puntaje: 0.4 }).puntaje, 1);
});

// ── Servicio: candados antes de la red ───────────────────────────────────────

test('aprenderEstilo corta sin red cuando no hay agente, poca señal o falta la key', async () => {
  const sinAgente = await aprenderEstilo({ accountId: 'no-existe', fuente: 'bandeja' });
  assert.strictEqual(sinAgente.ok, false);
  assert.match(sinAgente.error, /agente activo/);

  const { accountId } = await armarCuenta();
  const vacia = await aprenderEstilo({ accountId, fuente: 'bandeja', apiKey: 'sk-falsa' });
  assert.strictEqual(vacia.ok, false);
  assert.match(vacia.error, /Tu bandeja tiene 0 mensaje/);

  const texto = await aprenderEstilo({ accountId, fuente: 'texto', texto: 'párrafo sin formato de chat', apiKey: 'sk-falsa' });
  assert.strictEqual(texto.ok, false);
  assert.match(texto.error, /al menos 8 mensajes/);

  const chat = Array.from({ length: 10 }, (_, i) => `${i % 2 ? 'Yo' : 'Ana'}: mensaje ${i}`).join('\n');
  const sinKey = await aprenderEstilo({ accountId, fuente: 'texto', texto: chat, apiKey: null });
  assert.strictEqual(sinKey.ok, false);
  assert.match(sinKey.error, /API key/);
});

test('olvidarEstilo limpia el perfil del agente activo', async () => {
  const { accountId, agent } = await armarCuenta({ agent: { estilo_real: PERFIL } });
  const r = await olvidarEstilo(accountId);
  assert.strictEqual(r.ok, true);
  const a = await db.findOne(db.agents, { _id: agent._id });
  assert.strictEqual(a.estilo_real, null);
  assert.strictEqual((await olvidarEstilo('sin-cuenta')).ok, false);
});

// ── Rutas ────────────────────────────────────────────────────────────────────

test('GET /estilo exige ser dueño; sin perfil devuelve null y los cupos completos', async () => {
  const { accountId } = await armarCuenta();
  const ajeno = await llamar(handlerDe('/estilo', 'get'), { query: { accountId }, accountId: 'otro' });
  assert.strictEqual(ajeno.status, 403);

  const r = await llamar(handlerDe('/estilo', 'get'), { query: { accountId }, accountId });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.perfil, null);
  assert.strictEqual(r.data.agente, 'Vendedora');
  assert.deepStrictEqual(r.data.restantes_hoy, { aprender: 5, entrenar: 3 });
});

test('GET /estilo expone el perfil aprendido sin campos internos de más', async () => {
  const { accountId } = await armarCuenta({ agent: { estilo_real: { ...PERFIL, fuente: 'bandeja', n_mensajes: 42, aprendido_en: '2026-09-05T12:00:00Z' } } });
  const r = await llamar(handlerDe('/estilo', 'get'), { query: { accountId }, accountId });
  assert.strictEqual(r.data.perfil.n_mensajes, 42);
  assert.deepStrictEqual(r.data.perfil.muestras_cliente, PERFIL.muestras_cliente);
  assert.strictEqual(r.data.perfil.fuente, 'bandeja');
});

test('POST /estilo/aprender: 403 ajeno, 400 sin señal (sin gastar cupo), 429 con el cupo del día agotado', async () => {
  const { accountId } = await armarCuenta();
  const h = handlerDe('/estilo/aprender', 'post');

  assert.strictEqual((await llamar(h, { body: { accountId, fuente: 'bandeja' }, accountId: 'otro' })).status, 403);

  const vacia = await llamar(h, { body: { accountId, fuente: 'bandeja' }, accountId });
  assert.strictEqual(vacia.status, 400);
  assert.match(vacia.data.error, /Tu bandeja tiene 0 mensaje/);
  const cupo = await llamar(handlerDe('/estilo', 'get'), { query: { accountId }, accountId });
  assert.strictEqual(cupo.data.restantes_hoy.aprender, 5, 'un intento sin señal no quema cupo');

  const hoy = new Date().toISOString().slice(0, 10);
  await db.insert(db.settings, { account_id: accountId, style_learn_date: hoy, style_learn_count: 5 });
  const tope = await llamar(h, { body: { accountId, fuente: 'texto', texto: 'x' }, accountId });
  assert.strictEqual(tope.status, 429);
});

test('DELETE /estilo borra el perfil (acepta accountId en body o query)', async () => {
  const { accountId, agent } = await armarCuenta({ agent: { estilo_real: PERFIL } });
  const h = handlerDe('/estilo', 'delete');
  assert.strictEqual((await llamar(h, { body: { accountId }, accountId: 'otro' })).status, 403);
  const r = await llamar(h, { query: { accountId }, accountId });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await db.findOne(db.agents, { _id: agent._id })).estilo_real, null);
});

test('POST /entrenar: 403 ajeno, 400 sin agente, 400 sin key (antes de tocar la red), 429 con cupo agotado', async () => {
  const h = handlerDe('/entrenar', 'post');
  const sinAgente = 'acc-' + crypto.randomUUID();
  await db.insert(db.accounts, { _id: sinAgente });
  assert.strictEqual((await llamar(h, { body: { accountId: sinAgente }, accountId: 'otro' })).status, 403);
  const r0 = await llamar(h, { body: { accountId: sinAgente }, accountId: sinAgente });
  assert.strictEqual(r0.status, 400);
  assert.match(r0.data.error, /agente activo/);

  const { accountId } = await armarCuenta();
  const r1 = await llamar(h, { body: { accountId }, accountId });
  assert.strictEqual(r1.status, 400);
  assert.match(r1.data.error, /API key/);

  const hoy = new Date().toISOString().slice(0, 10);
  await db.insert(db.settings, { account_id: accountId, training_date: hoy, training_count: 3, openai_key: 'sk-falsa' });
  const r2 = await llamar(h, { body: { accountId }, accountId });
  assert.strictEqual(r2.status, 429, 'con el cupo agotado corta antes de gastar aunque haya key');
});
