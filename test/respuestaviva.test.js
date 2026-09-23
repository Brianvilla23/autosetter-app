/**
 * Atinov — Respuesta viva: que no se alargue y que no repita
 *
 * Los casos vienen de la prueba real que grabó Brayan el 20-09-2026. Cada
 * test de abajo es uno de los tres problemas que se vieron en ese video:
 *  1. respuesta de 55 palabras con cuatro marcas enumeradas y dos preguntas;
 *  2. la nota de voz siguiente repitió el texto anterior;
 *  3. sonó a robot porque el texto estaba escrito para leerse, no para decirse.
 *
 * Módulo puro: corre sin NeDB, sin red y sin modelo.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const v = require('../services/respuestaViva');

// La respuesta exacta que mandó el agente en la prueba.
const LA_DEL_VIDEO = 'te cuento, mi servicio es un asistente que atiende el inbox de tu negocio en '
  + 'Instagram, WhatsApp, Messenger y tu web. responde en segundos, entiende notas de voz y fotos, '
  + 'y filtra quiénes son las personas listas para trabajar contigo. ¿qué vendes y qué te tiene '
  + 'complicado con los mensajes?';

// ── Medición ─────────────────────────────────────────────────────────────────

test('mide la respuesta del video y encuentra todo lo que estaba mal', () => {
  const m = v.medir(LA_DEL_VIDEO);
  assert.ok(m.palabras > 45, `eran ${m.palabras} palabras`);
  assert.strictEqual(m.preguntaDoble, true, 'pide dos cosas en una sola pregunta');
  assert.strictEqual(m.preguntas, 2, 'cuenta el signo mas la pregunta doble');
  assert.strictEqual(m.enumeracion, true, 'enumera cuatro canales');
});

test('una respuesta corta y sana no dispara nada', () => {
  const buena = 'contesto tus mensajes de Instagram y WhatsApp al toque. ¿qué vendes?';
  const m = v.medir(buena);
  assert.ok(m.palabras <= 45);
  assert.strictEqual(m.preguntas, 1);
  assert.strictEqual(m.enumeracion, false);
  assert.strictEqual(v.revisar(buena).ok, true);
});

test('los links no cuentan como palabras ni rompen la cuenta', () => {
  const con = 'te dejo el link acá https://atinov.com/pricing?utm=x&algo=y para que lo mires.';
  assert.ok(v.medir(con).palabras < 14, 'el link largo no infla el conteo');
  assert.strictEqual(v.revisar(con).ok, true);
});

// ── Revisión ─────────────────────────────────────────────────────────────────

test('la respuesta del video se manda a reescribir, con motivos concretos', () => {
  const r = v.revisar(LA_DEL_VIDEO);
  assert.strictEqual(r.ok, false);
  const todos = r.motivos.join(' ');
  assert.match(todos, /palabras/, 'dice que es larga');
  assert.match(todos, /una pregunta|UNA sola/i, 'dice que hace dos preguntas');
  assert.match(todos, /[Ee]numera/, 'dice que enumera');
});

test('el límite hablado es más estricto que el escrito', () => {
  // 26 palabras y dos frases: pasa el límite escrito y se pasa del hablado.
  const media = 'te cuento rápido cómo funciona esto antes de que decidas. yo contesto a la gente que te escribe mientras tú estás ocupado trabajando en otra cosa.';
  assert.strictEqual(v.revisar(media, { voz: false }).ok, true, 'como texto pasa');
  assert.strictEqual(v.revisar(media, { voz: true }).ok, false, 'hablada es muy larga');
  assert.ok(v.LIMITES.voz.palabras < v.LIMITES.texto.palabras);
});

test('hablado exige frases cortas terminadas en punto', () => {
  const corrido = 'mira, lo que hago es atender a la gente que te escribe mientras tú estás ocupado con otras cosas más importantes.';
  const r = v.revisar(corrido, { voz: true });
  assert.ok(r.motivos.some(m => /frase demasiado larga|pártela/i.test(m)),
    'avisa que hay que partir la frase');
});

test('una respuesta vacía no rompe nada', () => {
  assert.strictEqual(v.revisar('').ok, true);
  assert.strictEqual(v.revisar(null).ok, true);
  assert.strictEqual(v.revisar(undefined).ok, true);
});

// ── Repetición ───────────────────────────────────────────────────────────────

test('detecta la nota de voz que repite el texto anterior', () => {
  const audioRepetido = 'mi servicio es un asistente que atiende el inbox de tu negocio en Instagram y WhatsApp, responde en segundos y filtra las personas listas para trabajar contigo.';
  const r = v.revisar(audioRepetido, { voz: true, dichos: [LA_DEL_VIDEO] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.motivos.some(m => /ya se lo dijiste/i.test(m)), 'lo marca como repetido');
});

test('avanzar el tema no cuenta como repetir', () => {
  const avanza = 'perfecto. ¿cuántos mensajes te llegan al día, más o menos?';
  const r = v.revisar(avanza, { dichos: [LA_DEL_VIDEO] });
  assert.strictEqual(r.ok, true, 'una pregunta nueva sí pasa');
});

test('la similitud mide cuánto de lo nuevo ya estaba dicho', () => {
  assert.strictEqual(v.similitud('hola', ''), 0, 'sin contenido no hay repetición');
  assert.ok(v.similitud(LA_DEL_VIDEO, LA_DEL_VIDEO) > 0.9, 'idéntico da casi uno');
  // Un mensaje de dos palabras con contenido da una proporcion enganosa:
  // por eso revisar() no juzga repeticion bajo cuatro palabras.
  assert.strictEqual(v.similitud(LA_DEL_VIDEO, 'cuéntame qué vendes'), 0.5);
  assert.strictEqual(v.revisar('cuéntame qué vendes', { dichos: [LA_DEL_VIDEO] }).ok, true,
    'demasiado corto para acusarlo de repetir');
  // Un mensaje nuevo corto que solo repite cosas viejas debe dar alto aunque
  // el viejo sea mucho más largo: por eso se mide contra el nuevo.
  assert.ok(v.similitud(LA_DEL_VIDEO, 'atiende el inbox de tu negocio') > v.SIMILITUD_MAX);
});

test('los acentos y las mayúsculas no engañan a la comparación', () => {
  assert.ok(v.similitud('Respondemos en SEGUNDOS', 'respondemos en segundos') > 0.9);
  assert.ok(v.similitud('atención inmediata', 'atencion inmediata') > 0.9);
});

// ── Bloques para el prompt ───────────────────────────────────────────────────

test('el bloque de lo ya dicho toma solo los mensajes del agente', () => {
  const history = [
    { role: 'user',   content: 'hola' },
    { role: 'agent',  content: 'hola, ¿qué tal? ¿cómo va el día?' },
    { role: 'user',   content: 'de qué se trata tu servicio?' },
    { role: 'agent',  content: LA_DEL_VIDEO },
    { role: 'sistema', content: 'cita agendada' },
  ];
  const dichos = v.loQueYaDijo(history);
  assert.strictEqual(dichos.length, 2);
  assert.ok(dichos.every(d => !/hola$/.test(d) || d.includes('qué tal')));
  assert.ok(!dichos.some(d => /cita agendada/.test(d)), 'las notas del sistema no cuentan');

  const bloque = v.bloqueNoRepetir(history);
  assert.match(bloque, /LO QUE YA LE DIJISTE/);
  assert.match(bloque, /no lo repitas/i);
  assert.match(bloque, /avanza/i);
  assert.strictEqual(v.bloqueNoRepetir([]), null, 'sin mensajes del agente no hay bloque');
  assert.strictEqual(v.bloqueNoRepetir(null), null);
});

test('el bloque de voz pide lo que hace que suene humano', () => {
  const b = v.bloqueVoz();
  assert.match(b, /SE VA A ESCUCHAR/);
  assert.match(b, new RegExp(String(v.LIMITES.voz.palabras)));
  assert.match(b, /terminadas en punto/);
  assert.match(b, /enumeraciones/);
  assert.match(b, /emojis/);
});

test('la instrucción de reescritura no deja perder los marcadores', () => {
  const p = v.promptDeAjuste(LA_DEL_VIDEO, ['Tiene 55 palabras.'], { voz: true });
  assert.match(p, /55 palabras/, 'le pasa el motivo concreto');
  assert.match(p, /\[AGENDAR/, 'protege los marcadores del agente');
  assert.match(p, /SOLO la respuesta reescrita/);
  assert.match(p, new RegExp(String(v.LIMITES.voz.palabras)), 'usa el límite hablado');
  assert.match(v.promptDeAjuste('x', ['y'], { voz: false }),
    new RegExp(String(v.LIMITES.texto.palabras)), 'y el escrito cuando no es voz');
});

// ── Huella de chat real (23-09-2026) ─────────────────────────────────────────
// En un grupo de WhatsApp real: 0,3 % de las preguntas abre con "¿", 12 % de
// los mensajes termina en punto, menos de 5 % lleva emoji y "con gusto" no
// aparece nunca. El agente hacía todo eso al revés.

test('la huella quita los signos de apertura y el punto final', () => {
  assert.strictEqual(v.aplicarHuella('¡Hola! ¿Qué andas buscando?'), 'Hola! Qué andas buscando?');
  assert.strictEqual(v.aplicarHuella('El corte sale 12 mil. Te sirve el jueves a las 18:00.'),
    'El corte sale 12 mil. Te sirve el jueves a las 18:00', 'el punto de en medio se queda');
  assert.strictEqual(v.aplicarHuella('déjame revisar...'), 'déjame revisar...', 'los puntos suspensivos se quedan');
  assert.strictEqual(v.aplicarHuella(''), '');
  assert.strictEqual(v.aplicarHuella(null), '');
});

test('la huella no toca marcadores ni links', () => {
  assert.strictEqual(v.aplicarHuella('listo, te agendé. [AGENDAR: 2026-09-25 18:00]'),
    'listo, te agendé. [AGENDAR: 2026-09-25 18:00]');
  assert.strictEqual(v.aplicarHuella('mira acá https://atinov.com/pricing.'), 'mira acá https://atinov.com/pricing');
});

test('emojis solo si el cliente los usa', () => {
  assert.strictEqual(v.aplicarHuella('hola 🙂 qué tal?'), 'hola qué tal?');
  assert.strictEqual(v.aplicarHuella('súper, nos vemos 👍'), 'súper, nos vemos');
  assert.strictEqual(v.aplicarHuella('hola 🙂 qué tal?', { leadUsaEmoji: true }), 'hola 🙂 qué tal?');
  assert.strictEqual(v.usaEmoji(['hola', 'jaja 😅']), true);
  assert.strictEqual(v.usaEmoji(['hola', 'cuánto sale?']), false);
  assert.strictEqual(v.usaEmoji('👍🏻'), true, 'con tono de piel también');
});

test('las frases de call center mandan a reescribir', () => {
  const r = v.revisar('Claro que sí, con gusto te ayudo con eso');
  assert.strictEqual(r.ok, false);
  assert.match(r.motivos.join(' '), /call center/);
  assert.deepStrictEqual(v.frasesDeCallCenter('No dudes en escribirme'), ['no dudes en']);
  assert.deepStrictEqual(v.frasesDeCallCenter('ya, te aviso'), []);
});

test('los límites calzan con cómo escribe la gente de verdad', () => {
  assert.ok(v.LIMITES.texto.palabras <= 30, 'el 88 % de los mensajes reales tiene 20 palabras o menos');
  assert.ok(v.LIMITES.texto.oraciones <= 2, '3 de cada 4 mensajes reales son una sola oración');
});
