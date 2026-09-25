/**
 * Atinov — Revisar comentarios de Instagram sin webhook
 *
 * Sin acceso avanzado Meta no manda el webhook de comentarios, así que el
 * "comenta INFO" no hacía nada. El revisor pregunta cada minuto y le pasa lo
 * nuevo al mismo manejador del webhook. Lo que se fija acá: que solo pase lo
 * posterior a la regla, que no repita, y que un error de Meta no lo tumbe.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-coment-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const db = require('../db/database');
const cp = require('../services/comentariosPoller');

const AHORA = Date.parse('2026-09-24T22:00:00Z');

function fingirComentarios(porMedia) {
  const orig = axios.get;
  const pedidos = [];
  axios.get = async (url, cfg) => {
    pedidos.push({ url, cfg });
    const media = url.split('/').slice(-2)[0];
    if (porMedia[media] instanceof Error) throw porMedia[media];
    return { data: { data: porMedia[media] || [] } };
  };
  return { pedidos, restaurar: () => { axios.get = orig; } };
}

async function cuentaConRegla({ token = 'IGAAtoken', media = '9001', creada = '2026-09-24T21:00:00Z', ...extra } = {}) {
  const acc = await db.insert(db.accounts, { ig_user_id: '1784' + Math.floor(Math.random() * 1e9), ig_username: 'barberia', access_token: token, ...extra });
  await db.insert(db.postRules, { account_id: acc._id, media_id: media, keywords: 'info', enabled: true });
  await db.update(db.postRules, { account_id: acc._id, media_id: media }, { createdAt: creada });
  return acc;
}

test('solo pasa los comentarios posteriores a la regla, con el formato del webhook', async () => {
  cp._vistos().clear();
  const acc = await cuentaConRegla({ media: '9001' });
  const meta = fingirComentarios({
    '9001': [
      { id: 'c-viejo', text: 'info', timestamp: '2026-09-20T10:00:00Z', from: { id: '55', username: 'antes' } },
      { id: 'c-nuevo', text: 'info', timestamp: '2026-09-24T21:30:00Z', from: { id: '66', username: 'amigo' } },
    ],
  });
  const recibidos = [];
  try {
    const n = await cp.revisarComentarios({ handleComment: async (id, c) => recibidos.push({ id, c }), ahora: AHORA });
    assert.strictEqual(n, 1);
    assert.strictEqual(recibidos.length, 1, 'el comentario de antes de la regla no se responde');
    assert.strictEqual(recibidos[0].id, acc.ig_user_id);
    assert.deepStrictEqual(recibidos[0].c.from, { id: '66', username: 'amigo' });
    assert.deepStrictEqual(recibidos[0].c.media, { id: '9001' });
    assert.strictEqual(recibidos[0].c.id, 'c-nuevo');
    assert.strictEqual(meta.pedidos[0].cfg.params.access_token, 'IGAAtoken');
  } finally { meta.restaurar(); await db.remove(db.postRules, { account_id: acc._id }, { multi: true }); }
});

test('no vuelve a pasar el mismo comentario en la siguiente vuelta', async () => {
  cp._vistos().clear();
  const acc = await cuentaConRegla({ media: '9002' });
  const meta = fingirComentarios({ '9002': [{ id: 'c1', text: 'info', timestamp: '2026-09-24T21:40:00Z', from: { id: '7', username: 'x' } }] });
  let llamadas = 0;
  try {
    await cp.revisarComentarios({ handleComment: async () => { llamadas++; }, ahora: AHORA });
    await cp.revisarComentarios({ handleComment: async () => { llamadas++; }, ahora: AHORA });
    assert.strictEqual(llamadas, 1);
  } finally { meta.restaurar(); await db.remove(db.postRules, { account_id: acc._id }, { multi: true }); }
});

test('no consulta cuentas sin token de Instagram Login ni las que piden reconectar', async () => {
  assert.strictEqual(cp.cuentaConsultable({ ig_user_id: '1', access_token: 'EAAxxx' }), false, 'token de Página, no de Instagram Login');
  assert.strictEqual(cp.cuentaConsultable({ ig_user_id: '1', access_token: 'IGAAx', needs_reauth: true }), false);
  assert.strictEqual(cp.cuentaConsultable({ ig_user_id: '1', access_token: 'IGAAx' }), true);
  assert.strictEqual(cp.cuentaConsultable(null), false);
});

test('si Meta falla en una publicación, sigue con las demás y no revienta', async () => {
  cp._vistos().clear();
  const a1 = await cuentaConRegla({ media: '9003' });
  const a2 = await cuentaConRegla({ media: '9004' });
  const meta = fingirComentarios({
    '9003': Object.assign(new Error('permiso'), { response: { data: { error: { message: '(#10) Application does not have permission' } } } }),
    '9004': [{ id: 'c2', text: 'info', timestamp: '2026-09-24T21:50:00Z', from: { id: '8', username: 'y' } }],
  });
  const recibidos = [];
  try {
    const n = await cp.revisarComentarios({ handleComment: async (id, c) => recibidos.push(c.id), ahora: AHORA });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(recibidos, ['c2']);
  } finally {
    meta.restaurar();
    await db.remove(db.postRules, { account_id: a1._id }, { multi: true });
    await db.remove(db.postRules, { account_id: a2._id }, { multi: true });
  }
});

test('sin reglas activas no le pregunta nada a Meta', async () => {
  const meta = fingirComentarios({});
  try {
    const n = await cp.revisarComentarios({ handleComment: async () => {}, ahora: AHORA });
    assert.strictEqual(n, 0);
    assert.strictEqual(meta.pedidos.length, 0);
  } finally { meta.restaurar(); }
});
