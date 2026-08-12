/**
 * Atinov — Suite de links de acceso directo (ig.me / wa.me / m.me)
 *
 * Garantiza que /go/<slug> siempre redirija a una puerta VÁLIDA del canal:
 *  1. Normalización de números para wa.me (Chile primero, E.164 tolerante).
 *  2. Construcción de URL por canal, con texto pre-escrito bien codificado.
 *  3. Links viejos sin `channel` siguen siendo Instagram (cero regresión).
 *  4. Fail-closed: datos incompletos → null (redirige a la home, no a basura).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { digitosWhatsapp, buildMagnetTarget } = require('../services/accessLinks');

// ─────────────────────────────────────────────────────────────────────────────
// 1. dígitos para wa.me
// ─────────────────────────────────────────────────────────────────────────────

test('digitosWhatsapp normaliza los formatos chilenos típicos', () => {
  assert.strictEqual(digitosWhatsapp('+56 9 8566 6043'), '56985666043');
  assert.strictEqual(digitosWhatsapp('56985666043'),     '56985666043');
  assert.strictEqual(digitosWhatsapp('985666043'),       '56985666043', 'celular pelado gana el 56');
  assert.strictEqual(digitosWhatsapp('0056985666043'),   '56985666043', '00 internacional');
});

test('digitosWhatsapp acepta internacional y rechaza basura', () => {
  assert.strictEqual(digitosWhatsapp('+1 415 555 0134'), '14155550134', 'número gringo válido');
  assert.strictEqual(digitosWhatsapp('12345'),  null, 'muy corto');
  assert.strictEqual(digitosWhatsapp('1234567890123456'), null, 'más largo que E.164');
  assert.strictEqual(digitosWhatsapp(''),       null);
  assert.strictEqual(digitosWhatsapp(null),     null);
  assert.strictEqual(digitosWhatsapp('hola'),   null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2-4. destino por canal
// ─────────────────────────────────────────────────────────────────────────────

test('whatsapp: wa.me con texto pre-escrito codificado', () => {
  const url = buildMagnetTarget({
    channel: 'whatsapp', wa_digits: '56985666043',
    preset_text: 'Quiero la guía ¿me la pasas?',
  });
  assert.ok(url.startsWith('https://wa.me/56985666043?text='));
  assert.ok(url.includes(encodeURIComponent('¿me la pasas?')), 'texto va URL-encoded');
  assert.ok(!url.includes(' '), 'sin espacios crudos');
});

test('whatsapp sin texto: wa.me pelado', () => {
  assert.strictEqual(
    buildMagnetTarget({ channel: 'whatsapp', wa_digits: '56985666043' }),
    'https://wa.me/56985666043'
  );
});

test('messenger: m.me con ref=slug y SIN texto (m.me no lo soporta)', () => {
  const url = buildMagnetTarget({
    channel: 'messenger', fb_page: 'atinov.cl', slug: 'abc123',
    preset_text: 'esto no debe aparecer',
  });
  assert.strictEqual(url, 'https://m.me/atinov.cl?ref=abc123');
  assert.ok(!url.includes('text='));
});

test('messenger acepta ID numérico de Página y limpia el @', () => {
  assert.strictEqual(
    buildMagnetTarget({ channel: 'messenger', fb_page: '@1198838849977922', slug: 's1' }),
    'https://m.me/1198838849977922?ref=s1'
  );
});

test('instagram: link viejo SIN channel se comporta igual que siempre', () => {
  const url = buildMagnetTarget({ ig_username: 'atinov.cl', preset_text: 'INFO' });
  assert.strictEqual(url, 'https://ig.me/m/atinov.cl?text=INFO');
});

test('fail-closed: datos incompletos devuelven null, nunca una URL rota', () => {
  assert.strictEqual(buildMagnetTarget({ channel: 'whatsapp' }), null, 'whatsapp sin dígitos');
  assert.strictEqual(buildMagnetTarget({ channel: 'whatsapp', wa_digits: '99' }), null, 'dígitos inválidos');
  assert.strictEqual(buildMagnetTarget({ channel: 'messenger', slug: 'x' }), null, 'messenger sin página');
  assert.strictEqual(buildMagnetTarget({ channel: 'messenger', fb_page: 'con espacios malos', slug: 'x' }), null);
  assert.strictEqual(buildMagnetTarget({}), null, 'instagram sin username');
});

test('inyección: una página con caracteres de URL no fabrica otro destino', () => {
  const url = buildMagnetTarget({ channel: 'messenger', fb_page: 'pagina/../otra?x=1', slug: 's' });
  assert.strictEqual(url, null, 'caracteres fuera de [\\w.-] = rechazo');
});
