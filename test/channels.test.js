/**
 * Atinov — Tests de abstracción de canal + bandeja unificada (Tarea 3)
 */

const { test } = require('node:test');
const assert = require('node:assert');

// Importamos de core.js (puro, sin db/red) para que el test no cargue la
// cadena de NeDB (que en OneDrive dispara EPERM en el rename de compactación).
const channels = require('../services/channels/core');
const { identityOf } = require('../services/channels/core');

test('channelOf normaliza canal desde string o lead', () => {
  assert.strictEqual(channels.channelOf('whatsapp'), 'whatsapp');
  assert.strictEqual(channels.channelOf('instagram'), 'instagram');
  assert.strictEqual(channels.channelOf({ channel: 'whatsapp' }), 'whatsapp');
  assert.strictEqual(channels.channelOf('inexistente'), 'instagram', 'desconocido → instagram (default)');
  assert.strictEqual(channels.channelOf({}), 'instagram', 'sin channel → instagram');
});

test('configuredChannels detecta canales según credenciales del account', () => {
  assert.deepStrictEqual(channels.configuredChannels({}), []);
  assert.deepStrictEqual(
    channels.configuredChannels({ access_token: 'x', ig_user_id: 'y' }),
    ['instagram']
  );
  assert.deepStrictEqual(
    channels.configuredChannels({ wa_phone_number_id: '1', wa_access_token: 't' }),
    ['whatsapp']
  );
  assert.deepStrictEqual(
    channels.configuredChannels({ access_token: 'x', ig_user_id: 'y', wa_phone_number_id: '1', wa_access_token: 't' }),
    ['instagram', 'whatsapp'],
    'ambos canales configurados'
  );
});

test('identityOf arma la identidad correcta por canal', () => {
  assert.deepStrictEqual(
    identityOf({ channel: 'instagram', ig_user_id: '123', ig_username: 'juan' }),
    { channel: 'instagram', id: '123', username: 'juan' }
  );
  assert.deepStrictEqual(
    identityOf({ channel: 'whatsapp', wa_id: '5215555', wa_name: 'Juan' }),
    { channel: 'whatsapp', id: '5215555', name: 'Juan' }
  );
});

test('WhatsApp NO está configurado si falta el token (solo phone id)', () => {
  // Garantía de seguridad: sin token no se considera conectado → no intenta enviar
  assert.deepStrictEqual(channels.configuredChannels({ wa_phone_number_id: '1' }), []);
});
