/**
 * Atinov — Tests de pausa por canal
 *
 * Pausar un canal apaga la atención automática SIN borrar credenciales.
 * Nace de un problema real: el único botón que había borraba el token, y
 * recuperar un WhatsApp exigía generar otro System User token en Meta.
 *
 * Se importa de core.js (puro, sin db/red) por la misma razón que el resto de
 * los tests de canal: cargar NeDB desde OneDrive dispara EPERM al compactar.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../services/channels/core');
const { esPausable, flagPausa, estaPausado, canalesPausados } = core;

test('esPausable acepta los tres canales y rechaza cualquier otra cosa', () => {
  assert.strictEqual(esPausable('instagram'), true);
  assert.strictEqual(esPausable('whatsapp'), true);
  assert.strictEqual(esPausable('messenger'), true);

  // Lo que llega por la URL es input del usuario: no puede tocar la DB.
  assert.strictEqual(esPausable('telegram'), false);
  assert.strictEqual(esPausable(''), false);
  assert.strictEqual(esPausable(null), false);
  assert.strictEqual(esPausable(undefined), false);
  assert.strictEqual(esPausable('__proto__'), false, 'no se cuela por la cadena de prototipos');
  assert.strictEqual(esPausable('constructor'), false);
  assert.strictEqual(esPausable('INSTAGRAM'), false, 'es sensible a mayúsculas: solo el id exacto');
});

test('flagPausa devuelve el campo correcto de la cuenta', () => {
  assert.strictEqual(flagPausa('instagram'), 'ig_pausado');
  assert.strictEqual(flagPausa('whatsapp'), 'wa_pausado');
  assert.strictEqual(flagPausa('messenger'), 'fb_pausado');
  assert.strictEqual(flagPausa('telegram'), null);
  assert.strictEqual(flagPausa('__proto__'), null);
});

test('estaPausado: ante la duda, NO pausado (el agente sigue atendiendo)', () => {
  // Una cuenta vieja no tiene el campo: no puede quedar muda por eso.
  assert.strictEqual(estaPausado({}, 'whatsapp'), false);
  assert.strictEqual(estaPausado({ wa_pausado: undefined }, 'whatsapp'), false);
  assert.strictEqual(estaPausado({ wa_pausado: false }, 'whatsapp'), false);
  assert.strictEqual(estaPausado(null, 'whatsapp'), false);
  assert.strictEqual(estaPausado(undefined, 'whatsapp'), false);
  assert.strictEqual(estaPausado({ wa_pausado: true }, 'telegram'), false, 'canal inválido nunca pausa');
});

test('estaPausado normaliza a booleano lo que venga de la DB', () => {
  // NeDB no tiene esquema: el campo puede llegar como 1, "true" o null según
  // quién lo escribió. El motor de mensajes solo entiende true/false.
  assert.strictEqual(estaPausado({ wa_pausado: 1 }, 'whatsapp'), true);
  assert.strictEqual(estaPausado({ wa_pausado: 'true' }, 'whatsapp'), true);
  assert.strictEqual(estaPausado({ wa_pausado: 0 }, 'whatsapp'), false);
  assert.strictEqual(estaPausado({ wa_pausado: null }, 'whatsapp'), false);
});

test('estaPausado detecta la pausa real y no confunde canales', () => {
  const soloWa = { wa_pausado: true, ig_pausado: false, fb_pausado: false };
  assert.strictEqual(estaPausado(soloWa, 'whatsapp'), true);
  assert.strictEqual(estaPausado(soloWa, 'instagram'), false, 'pausar WhatsApp no apaga Instagram');
  assert.strictEqual(estaPausado(soloWa, 'messenger'), false, 'pausar WhatsApp no apaga Messenger');
});

test('canalesPausados lista solo los apagados', () => {
  assert.deepStrictEqual(canalesPausados({}), []);
  assert.deepStrictEqual(canalesPausados({ ig_pausado: true }), ['instagram']);
  assert.deepStrictEqual(
    canalesPausados({ ig_pausado: true, wa_pausado: true, fb_pausado: true }),
    ['instagram', 'whatsapp', 'messenger']
  );
});

test('pausar NO cambia si el canal está configurado (son cosas distintas)', () => {
  // Regresión: la pausa es un interruptor aparte. Las credenciales siguen
  // ahí, que es justamente el punto — reanudar tiene que ser un clic.
  const cuenta = {
    access_token: 'x', ig_user_id: 'y',
    wa_phone_number_id: '1', wa_access_token: 't',
    ig_pausado: true, wa_pausado: true,
  };
  assert.deepStrictEqual(
    core.configuredChannels(cuenta),
    ['instagram', 'whatsapp'],
    'un canal pausado sigue configurado: conserva sus credenciales'
  );
});

test('REGRESIÓN: PAUSABLES y CHANNELS son listas distintas a propósito', () => {
  // PAUSABLES incluye messenger; CHANNELS no, porque CHANNELS describe la
  // bandeja unificada y lo consume medio código. Si alguien mete messenger
  // en CHANNELS, configuredChannels() cambia para todos y este test avisa.
  assert.deepStrictEqual(core.configuredChannels({}), []);
  assert.deepStrictEqual(
    core.configuredChannels({ fb_page_id: '1', fb_page_token: 't' }),
    [],
    'messenger es pausable pero no participa de configuredChannels'
  );
  assert.ok(esPausable('messenger'), 'y sin embargo sí se puede pausar');
});
