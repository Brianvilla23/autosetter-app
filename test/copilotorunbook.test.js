/**
 * Atinov — Libro de fallas del copiloto (soporte que aprende)
 *
 * Lo que se protege:
 *  - cada entrada tiene forma completa (síntoma, causa real, dónde hacer clic, fecha);
 *  - las señales disparan con el estado que describe el problema y CALLAN con
 *    una cuenta sana (un copiloto que inventa problemas es peor que ninguno);
 *  - una señal rota no calla a las demás;
 *  - el libro entra al prompt y sus hallazgos entran al diagnóstico general.
 *
 * Módulo puro: corre sin NeDB ni OpenAI.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { FALLAS, hallazgosDelRunbook, textoRunbook, fallaPorId } = require('../services/copilotoRunbook');
const { diagnosticar, construirPrompt, MANUAL } = require('../services/copilotoConocimiento');

const hay = (lista, rx) => lista.some(h => rx.test(h));

/** Cuenta sana con TODAS las señales nuevas en cero. */
const sana = (over = {}) => ({
  negocio: 'Barbería Cruz',
  canales: {
    instagram: { conectado: true, pausado: false },
    whatsapp:  { conectado: true, pausado: false },
    messenger: { conectado: true, pausado: false },
  },
  plan: { name: 'Crecimiento', price: 275, maxDMs: 3000, maxDMsWhatsApp: 150, minutosLlamada: 150, llamadas: true },
  uso: { dms: 10, whatsapp: 3, minutosVoz: 1 },
  agentes: { total: 1, activos: 1, nombres: ['Vale'] },
  twilioListo: true,
  wa: { reconectar: false, diasToken: null, fallos7d: {}, totalFallos7d: 0, ultimoFallo: null },
  fb: { reconectar: false, motivo: null },
  agenda: { activa: true, diasConHorario: 5, servicios: 2, citasHoy: 3 },
  playbook: { activo: false, faltan: [] },
  pagos: { mp: true },
  shopify: false,
  leads: { bypass: 0 },
  errores24h: 0,
  agentesUsanPago: true,
  ...over,
});

test('cada entrada del libro tiene forma completa y un id único', () => {
  assert.ok(FALLAS.length >= 20, 'el libro parte con lo aprendido hasta hoy');
  const ids = new Set();
  for (const f of FALLAS) {
    for (const campo of ['id', 'sintoma', 'causa', 'solucion', 'desde']) {
      assert.ok(typeof f[campo] === 'string' && f[campo].trim(), `${f.id || '?'}: falta ${campo}`);
    }
    assert.match(f.desde, /^\d{4}-\d{2}-\d{2}$/, `${f.id}: fecha`);
    assert.ok(!ids.has(f.id), `id repetido: ${f.id}`);
    ids.add(f.id);
    if (f.senal !== undefined) assert.strictEqual(typeof f.senal, 'function', `${f.id}: senal`);
    // Sin emojis: el texto viaja al modelo y al panel.
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(f.sintoma + f.causa + f.solucion), `${f.id}: emoji`);
  }
  assert.ok(fallaPorId('ventana_24h'));
  assert.strictEqual(fallaPorId('no_existe'), null);
});

test('una cuenta sana no dispara ninguna señal', () => {
  assert.deepStrictEqual(hallazgosDelRunbook(sana()), []);
  assert.deepStrictEqual(hallazgosDelRunbook(null), []);
  assert.deepStrictEqual(hallazgosDelRunbook({}), [], 'estado sin señales nuevas tampoco inventa');
});

test('WhatsApp por reconectar y token que caduca', () => {
  assert.ok(hay(hallazgosDelRunbook(sana({ wa: { reconectar: true, fallos7d: {} } })), /RECONECTAR/));
  assert.ok(hay(hallazgosDelRunbook(sana({ wa: { reconectar: false, diasToken: 5, fallos7d: {} } })), /caduca en 5 día/));
  assert.ok(hay(hallazgosDelRunbook(sana({ wa: { reconectar: false, diasToken: -1, fallos7d: {} } })), /YA CADUCÓ/));
  assert.ok(!hay(hallazgosDelRunbook(sana({ wa: { reconectar: false, diasToken: 40, fallos7d: {} } })), /caduca/), 'a 40 días no molesta');
});

test('entregas fallidas de WhatsApp se explican por código de Meta', () => {
  const h = hallazgosDelRunbook(sana({ wa: { reconectar: false, fallos7d: { 131047: 3, 131026: 1, 131049: 2 } } }));
  assert.ok(hay(h, /3 mensaje.*24 horas.*131047/s), 'ventana cerrada');
  assert.ok(hay(h, /1 mensaje.*131026/s), 'número sin WhatsApp');
  assert.ok(hay(h, /2 mensaje.*marketing.*131049/s), 'límite de marketing');
});

test('Messenger por reconectar trae el motivo', () => {
  const h = hallazgosDelRunbook(sana({ fb: { reconectar: true, motivo: 'token vencido' } }));
  assert.ok(hay(h, /Messenger.*RECONECTAR.*token vencido/s));
});

test('agenda activa pero sin horario o sin servicios', () => {
  assert.ok(hay(hallazgosDelRunbook(sana({ agenda: { activa: true, diasConHorario: 0, servicios: 1 } })), /no tiene horario/));
  assert.ok(hay(hallazgosDelRunbook(sana({ agenda: { activa: true, diasConHorario: 5, servicios: 0 } })), /no tiene servicios/));
  assert.ok(!hay(hallazgosDelRunbook(sana({ agenda: { activa: false, diasConHorario: 0, servicios: 0 } })), /agenda/i), 'apagada no molesta');
});

test('playbook activo sin plantillas nombra los pasos que faltan', () => {
  const h = hallazgosDelRunbook(sana({ playbook: { activo: true, faltan: ['tracking', 'resena'] } }));
  assert.ok(hay(h, /tracking, resena/));
  assert.ok(!hay(hallazgosDelRunbook(sana({ playbook: { activo: false, faltan: ['tracking'] } })), /playbook/i), 'apagado no molesta');
});

test('agente que cobra sin token de Mercado Pago', () => {
  assert.ok(hay(hallazgosDelRunbook(sana({ pagos: { mp: false }, agentesUsanPago: true })), /Mercado Pago/));
  assert.ok(!hay(hallazgosDelRunbook(sana({ pagos: { mp: false }, agentesUsanPago: false })), /Mercado Pago/), 'si nadie cobra, no molesta');
});

test('control humano y errores internos se informan con la cifra', () => {
  assert.ok(hay(hallazgosDelRunbook(sana({ leads: { bypass: 2 } })), /2 persona/));
  assert.ok(hay(hallazgosDelRunbook(sana({ errores24h: 4 })), /4 error/));
});

test('una señal rota no calla a las demás', () => {
  FALLAS.push({ id: '_rota', sintoma: 'x', causa: 'x', solucion: 'x', desde: '2026-01-01', senal: () => { throw new Error('boom'); } });
  try {
    const h = hallazgosDelRunbook(sana({ wa: { reconectar: true, fallos7d: {} } }));
    assert.ok(hay(h, /RECONECTAR/));
  } finally {
    FALLAS.pop();
  }
});

test('el libro entra al prompt y sus hallazgos al diagnóstico general', () => {
  const texto = textoRunbook();
  assert.ok(texto.includes('ventana de 24 horas'));
  assert.strictEqual(texto.split('\n').length, FALLAS.length, 'una línea por falla');

  const prompt = construirPrompt(sana());
  assert.ok(prompt.includes('LIBRO DE FALLAS'));
  assert.ok(prompt.includes('Qué hacer:'));
  assert.ok(prompt.includes('Agenda propia: activa'), 'las líneas de estado nuevas van al prompt');
  assert.ok(prompt.includes('No se detectaron problemas'), 'sana → sin problemas');

  const h = diagnosticar(sana({ wa: { reconectar: true, fallos7d: {} } }));
  assert.ok(hay(h, /RECONECTAR/), 'diagnosticar() incluye lo del runbook');
  assert.ok(construirPrompt(sana({ wa: { reconectar: true, fallos7d: {} } })).includes('PROBLEMAS YA DETECTADOS'));
});

test('el manual del copiloto conoce la agenda propia', () => {
  assert.ok(/AGENDA PROPIA/.test(MANUAL));
  assert.ok(/Aplicar atraso/.test(MANUAL));
});
