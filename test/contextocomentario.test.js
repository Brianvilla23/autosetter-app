/**
 * Atinov — Contexto y aprendizaje en la respuesta a un comentario
 *
 * El 01-10-2026 el privado a quien comentó "info" no mencionaba el post y
 * habría sido idéntico para todos. Se fija: que se traiga el texto de la
 * publicación, que se recuerde qué se le escribió a cada uno y que las
 * aperturas que consiguieron respuesta queden marcadas para imitarlas.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-ctxcom-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const db = require('../db/database');
const cc = require('../services/contextoComentario');
const viva = require('../services/respuestaViva');

test('trae el texto completo del post y lo recuerda; si Instagram falla, usa el de la regla', async () => {
  cc._cache().clear();
  const orig = axios.get;
  let llamadas = 0;
  axios.get = async (url, cfg) => {
    llamadas++;
    assert.ok(url.startsWith('https://graph.instagram.com/'), 'token IG → graph.instagram.com');
    assert.strictEqual(cfg.params.fields, 'caption');
    return { data: { caption: 'Atinov responde tus DMs y WhatsApp al instante. Comenta INFO y te cuento cómo funciona' } };
  };
  try {
    const t1 = await cc.textoDePublicacion('m1', { access_token: 'IGAAx' }, { caption: 'Atinov responde tus DMs' });
    const t2 = await cc.textoDePublicacion('m1', { access_token: 'IGAAx' });
    assert.match(t1, /Comenta INFO/);
    assert.strictEqual(t2, t1);
    assert.strictEqual(llamadas, 1, 'la segunda vez sale del recuerdo');
  } finally { axios.get = orig; }

  axios.get = async () => { throw new Error('caído'); };
  try {
    assert.strictEqual(await cc.textoDePublicacion('m2', { access_token: 'IGAAx' }, { caption: 'corto' }), 'corto');
    assert.strictEqual(await cc.textoDePublicacion(null, {}, null), null);
  } finally { axios.get = orig; }
});

test('registra la apertura y la marca como exitosa cuando la persona contesta', async () => {
  const ap = await cc.registrarApertura({ accountId: 'acc1', leadId: 'lead1', mediaId: 'm1', texto: 'vi que te interesó lo de responder al instante…' });
  assert.ok(ap._id);
  assert.strictEqual(await cc.marcarRespondida('lead1'), true);
  const guardada = await db.findOne(db.aperturas, { _id: ap._id });
  assert.strictEqual(guardada.respondio, true);
  assert.strictEqual(await cc.marcarRespondida('lead1'), false, 'ya estaba marcada');
  assert.strictEqual(await cc.marcarRespondida('lead-sin-apertura'), false);
});

test('una respuesta de hace más de 7 días no cuenta como éxito de esa apertura', async () => {
  const ap = await cc.registrarApertura({ accountId: 'acc2', leadId: 'lead2', texto: 'hola' });
  const dentroDe8Dias = Date.parse(ap.createdAt) + 8 * 24 * 3600 * 1000;
  assert.strictEqual(await cc.marcarRespondida('lead2', dentroDe8Dias), false);
});

test('el bloque le muestra al agente lo que ya dijo y lo que funcionó', async () => {
  for (let i = 1; i <= 6; i++) {
    await cc.registrarApertura({ accountId: 'acc3', leadId: `l${i}`, texto: `apertura número ${i}` });
    await new Promise(r => setTimeout(r, 5));
  }
  await cc.marcarRespondida('l1');   // una vieja que funcionó
  const bloque = await cc.bloqueAperturas('acc3');
  assert.match(bloque, /NO repitas/);
  assert.match(bloque, /apertura número 6/, 'las recientes, para no repetirlas');
  assert.match(bloque, /SÍ consiguieron/);
  assert.match(bloque, /apertura número 1/, 'la que consiguió respuesta, para imitar la idea');
  assert.strictEqual(await cc.bloqueAperturas('cuenta-sin-historial'), null);

  const r = await cc.resumenAperturas('acc3');
  assert.deepStrictEqual({ total: r.total, respondidas: r.respondidas }, { total: 6, respondidas: 1 });
});

test('cerrar con "¿te gustaría que te ayude?" manda a reescribir', () => {
  const r = viva.revisar('Activa tu prueba gratis aquí: https://atinov.com/app. ¿Te gustaría que te ayude con eso?');
  assert.strictEqual(r.ok, false);
  assert.match(r.motivos.join(' '), /call center/);
});
