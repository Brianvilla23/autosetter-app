/**
 * Atinov — Tests del copiloto del panel
 *
 * Lo que se protege acá es la HONESTIDAD del diagnóstico. El copiloto le dice
 * al dueño "tu WhatsApp está pausado, por eso no responde" como un hecho — si
 * el diagnóstico se equivoca, el copiloto miente con total seguridad, que es
 * peor que no tener copiloto. Por eso las conclusiones las saca el código
 * (testeado) y el modelo solo las redacta.
 *
 * Módulo puro: corre sin NeDB ni OpenAI.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { diagnosticar, construirPrompt, MANUAL, REGLAS } = require('../services/copilotoConocimiento');

/** Cuenta sana de base; cada test rompe solo lo que quiere probar. */
const sana = (over = {}) => ({
  negocio: 'Poleras SPA',
  canales: {
    instagram: { conectado: true, pausado: false, detalle: '@poleras' },
    whatsapp:  { conectado: true, pausado: false, detalle: '+56912345678' },
    messenger: { conectado: false, pausado: false },
  },
  plan: { name: 'Crecimiento', price: 275, maxDMs: 3000, maxDMsWhatsApp: 150, minutosLlamada: 150, llamadas: true },
  uso: { dms: 100, whatsapp: 10, minutosVoz: 5 },
  agentes: { total: 2, activos: 2, nombres: ['Vale', 'Mati'] },
  twilioListo: true,
  ...over,
});

const hay = (lista, rx) => lista.some(h => rx.test(h));

test('una cuenta sana no inventa problemas', () => {
  assert.deepStrictEqual(diagnosticar(sana()), []);
  assert.deepStrictEqual(diagnosticar(null), []);
});

test('detecta el canal pausado, que es la causa #1 de "no responde"', () => {
  const h = diagnosticar(sana({
    canales: {
      instagram: { conectado: true, pausado: false },
      whatsapp:  { conectado: true, pausado: true },
      messenger: { conectado: false, pausado: false },
    },
  }));
  assert.ok(hay(h, /whatsapp.*PAUSA/i), 'debe nombrar el canal pausado');
  assert.ok(!hay(h, /instagram/i), 'y no acusar al que está bien');
});

test('si TODOS los canales están pausados lo dice de una vez, no uno por uno', () => {
  const h = diagnosticar(sana({
    canales: {
      instagram: { conectado: true, pausado: true },
      whatsapp:  { conectado: true, pausado: true },
      messenger: { conectado: false, pausado: false },
    },
  }));
  assert.ok(hay(h, /TODOS los canales.*PAUSA/i));
  assert.strictEqual(h.filter(x => /PAUSA/i.test(x)).length, 1, 'un solo aviso, no tres');
});

test('sin ningún canal conectado, ese es el primer hallazgo', () => {
  const h = diagnosticar(sana({
    canales: {
      instagram: { conectado: false, pausado: false },
      whatsapp:  { conectado: false, pausado: false },
      messenger: { conectado: false, pausado: false },
    },
  }));
  assert.ok(/NO hay ningún canal conectado/.test(h[0]), 'va primero: sin canal nada funciona');
});

test('detecta agentes faltantes y agentes apagados como cosas distintas', () => {
  assert.ok(hay(diagnosticar(sana({ agentes: { total: 0, activos: 0 } })), /No hay ningún agente creado/));
  const apagados = diagnosticar(sana({ agentes: { total: 3, activos: 0 } }));
  assert.ok(hay(apagados, /3 agente\(s\) pero ninguno está habilitado/));
});

test('avisa de la cuota de WhatsApp ANTES de que se agote', () => {
  const cerca = diagnosticar(sana({ uso: { dms: 100, whatsapp: 120, minutosVoz: 0 } }));
  assert.ok(hay(cerca, /cuota de WhatsApp va en 80%/), 'a 120 de 150 ya debe avisar');
  assert.ok(!hay(cerca, /agotó/), 'pero sin decir que se agotó');

  const agotada = diagnosticar(sana({ uso: { dms: 100, whatsapp: 150, minutosVoz: 0 } }));
  assert.ok(hay(agotada, /Se agotó la cuota de WhatsApp/));
  assert.ok(hay(agotada, /US\$0,50/), 'y explica qué pasa ahora: se cobra excedente');
});

test('distingue "el plan no incluye llamadas" de "falta configurar Twilio"', () => {
  const sinPlan = diagnosticar(sana({
    plan: { name: 'Inicial', price: 98, maxDMs: 1500, maxDMsWhatsApp: 90, minutosLlamada: 0, llamadas: false },
  }));
  assert.ok(hay(sinPlan, /NO incluye llamadas/));
  assert.ok(hay(sinPlan, /Crecimiento o Escala/), 'y dice cómo resolverlo');

  const sinTwilio = diagnosticar(sana({ twilioListo: false }));
  assert.ok(hay(sinTwilio, /Twilio no está configurado/));
  assert.ok(!hay(sinTwilio, /NO incluye llamadas/), 'no confundir una cosa con la otra');
});

test('los topes vacíos o nulos no generan avisos falsos', () => {
  // Un plan heredado tiene maxDMsWhatsApp null, e Inicial tiene 0 minutos.
  // Dividir por eso daba Infinity o NaN y disparaba avisos absurdos.
  const h = diagnosticar(sana({
    plan: { name: 'Founder', price: 148, maxDMs: 6000, maxDMsWhatsApp: null, minutosLlamada: 0, llamadas: true },
    uso: { dms: 10, whatsapp: 500, minutosVoz: 0 },
  }));
  assert.ok(!hay(h, /cuota de WhatsApp/), 'sin tope de canal no hay cuota que avisar');
  assert.ok(!hay(h, /minutos de llamada/), 'sin bolsa de minutos tampoco');
});

test('el prompt lleva reglas, manual, estado y diagnóstico en ese orden', () => {
  const p = construirPrompt(sana({
    canales: {
      instagram: { conectado: true, pausado: true },
      whatsapp:  { conectado: false, pausado: false },
      messenger: { conectado: false, pausado: false },
    },
  }));
  assert.ok(p.includes(REGLAS), 'las reglas de conducta van sí o sí');
  assert.ok(p.includes(MANUAL), 'y el manual del producto');
  assert.match(p, /Poleras SPA/, 'el nombre del negocio');
  assert.match(p, /Instagram: conectado pero EN PAUSA/);
  assert.match(p, /WhatsApp: no conectado/);
  assert.match(p, /PROBLEMAS YA DETECTADOS/);
  assert.ok(p.indexOf('CÓMO FUNCIONA ATINOV') < p.indexOf('ESTADO ACTUAL'), 'manual antes que estado');
  assert.ok(p.indexOf('ESTADO ACTUAL') < p.indexOf('PROBLEMAS YA DETECTADOS'), 'el diagnóstico va al final');
});

test('sin problemas, el prompt lo dice explícitamente', () => {
  const p = construirPrompt(sana());
  assert.match(p, /No se detectaron problemas/);
  assert.ok(!p.includes('PROBLEMAS YA DETECTADOS'), 'no anunciar problemas que no hay');
});

test('el prompt aguanta una cuenta sin datos', () => {
  assert.ok(construirPrompt(null).includes(MANUAL), 'sin estado igual sabe del producto');
  const p = construirPrompt({});
  assert.match(p, /sin nombre/);
  assert.match(p, /no conectado/);
});

test('las reglas prohíben inventar y prohíben pedir credenciales', () => {
  assert.match(REGLAS, /NUNCA inventes/);
  assert.match(REGLAS, /Nunca pidas ni muestres tokens/);
  assert.match(REGLAS, /tuteando/, 'español de Chile con tú, como el resto del producto');
});
