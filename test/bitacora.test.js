/**
 * Atinov — Bitácora de trabajo (centro de datos del panel admin)
 *
 * Lo que se fija:
 *  - una entrada se normaliza venga como venga (pendientes como texto suelto,
 *    dueño inválido, fecha basura, listas gigantes);
 *  - guardar dos veces la misma conversación actualiza en vez de duplicar;
 *  - los pendientes se marcan y se desmarcan por id, sin tocar los demás;
 *  - el centro devuelve los abiertos juntos y las cifras de cabecera;
 *  - la siembra corre una sola vez.
 */

process.env.DB_PATH = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'atinov-bitacora-test-')
);

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../db/database');
const bit = require('../services/bitacora');
const { hoyChile } = require('../services/limits');

test('sanear normaliza lo que venga y nunca deja una entrada rota', () => {
  const e = bit.sanear({
    fecha: 'ayer', titulo: '  ', resumen: '  hola  ',
    commits: ['abc123', '', '   '],
    construido: 'no es lista',
    decisiones: ['una', null, 'dos'],
    pendientes: ['texto suelto', { texto: 'con dueño', de: 'CLAUDE' }, { texto: 'raro', de: 'pedro' }, { texto: '' }],
  });
  assert.strictEqual(e.fecha, hoyChile(), 'fecha basura → hoy en Chile');
  assert.strictEqual(e.titulo, 'Sesión de trabajo', 'sin título → uno por defecto');
  assert.strictEqual(e.resumen, 'hola');
  assert.deepStrictEqual(e.commits, ['abc123'], 'los vacíos se van');
  assert.deepStrictEqual(e.construido, [], 'lo que no es lista queda vacío, no explota');
  assert.deepStrictEqual(e.decisiones, ['una', 'dos']);
  assert.strictEqual(e.pendientes.length, 3, 'el pendiente sin texto no entra');
  assert.strictEqual(e.pendientes[0].de, 'brayan', 'texto suelto → dueño por defecto');
  assert.strictEqual(e.pendientes[1].de, 'claude', 'acepta mayúsculas');
  assert.strictEqual(e.pendientes[2].de, 'brayan', 'dueño inválido → por defecto');
  assert.ok(e.pendientes.every(p => p.listo === false && p.id));
});

test('los textos se recortan en vez de crecer sin límite', () => {
  const e = bit.sanear({
    titulo: 'x'.repeat(500), resumen: 'y'.repeat(5000),
    construido: Array.from({ length: 80 }, (_, i) => 'item ' + i),
  });
  assert.strictEqual(e.titulo.length, 160);
  assert.strictEqual(e.resumen.length, 2000);
  assert.strictEqual(e.construido.length, 40);
});

test('guardar la misma conversación dos veces actualiza, no duplica', async () => {
  const a = await bit.crear({ fecha: '2026-09-20', titulo: 'Agenda propia', construido: ['uno'] });
  const b = await bit.crear({ fecha: '2026-09-20', titulo: 'Agenda propia', construido: ['uno', 'dos'] });
  assert.strictEqual(b.actualizada, true);
  const todas = await db.find(db.bitacora, { titulo: 'Agenda propia' });
  assert.strictEqual(todas.length, 1);
  assert.deepStrictEqual(todas[0].construido, ['uno', 'dos']);

  // Mismo título pero otra fecha es otra conversación.
  await bit.crear({ fecha: '2026-09-21', titulo: 'Agenda propia' });
  assert.strictEqual((await db.find(db.bitacora, { titulo: 'Agenda propia' })).length, 2);
  assert.ok(a._id);
});

test('actualizar cambia solo lo que se manda', async () => {
  const e = await bit.crear({ fecha: '2026-09-18', titulo: 'Parcial', resumen: 'original', construido: ['uno'] });
  const r = await bit.actualizar(e._id, { resumen: 'nuevo' });
  assert.strictEqual(r.resumen, 'nuevo');
  assert.deepStrictEqual(r.construido, ['uno'], 'lo que no se manda no se pisa');
  assert.strictEqual(r.titulo, 'Parcial');
  assert.strictEqual(await bit.actualizar('no-existe', { resumen: 'x' }), null);
});

test('los pendientes se marcan y se desmarcan por id, sin tocar los demás', async () => {
  const e = await bit.crear({
    fecha: '2026-09-17', titulo: 'Con pendientes',
    pendientes: [{ texto: 'uno', de: 'brayan' }, { texto: 'dos', de: 'claude' }],
  });
  const ids = e.pendientes.map(p => p.id);

  let r = await bit.marcarPendiente(e._id, ids[0], true);
  assert.strictEqual(r.pendientes[0].listo, true);
  assert.strictEqual(r.pendientes[1].listo, false, 'el otro no se toca');

  r = await bit.marcarPendiente(e._id, ids[0], false);
  assert.strictEqual(r.pendientes[0].listo, false, 'se puede devolver a la lista');

  assert.strictEqual(await bit.marcarPendiente(e._id, 'pX', true), null, 'pendiente que no existe');
  assert.strictEqual(await bit.marcarPendiente('no-existe', ids[0], true), null, 'entrada que no existe');
});

test('el centro junta los abiertos y cuenta lo que importa', async () => {
  await db.remove(db.bitacora, {});
  await bit.crear({
    fecha: '2026-09-19', titulo: 'Vieja', commits: ['aaa111'],
    pendientes: [{ texto: 'de brayan', de: 'brayan' }, { texto: 'ya resuelto', de: 'claude', listo: true }],
  });
  const nueva = await bit.crear({
    fecha: '2026-09-20', titulo: 'Nueva', commits: ['bbb222', 'aaa111'],
    pendientes: [{ texto: 'de claude', de: 'claude' }],
  });

  const c = await bit.centro();
  assert.strictEqual(c.entradas[0].titulo, 'Nueva', 'la más nueva primero');
  assert.strictEqual(c.stats.sesiones, 2);
  assert.strictEqual(c.stats.commits, 2, 'el commit repetido se cuenta una vez');
  assert.strictEqual(c.stats.de_brayan, 1);
  assert.strictEqual(c.stats.de_claude, 1);
  assert.strictEqual(c.stats.resueltos, 1);
  assert.strictEqual(c.stats.ultima, '2026-09-20');

  assert.strictEqual(c.abiertos.length, 2, 'los resueltos no aparecen como abiertos');
  const deClaude = c.abiertos.find(p => p.de === 'claude');
  assert.strictEqual(deClaude.entrada, 'Nueva', 'cada abierto dice de qué conversación viene');
  assert.strictEqual(deClaude.entrada_id, nueva._id);
});

test('borrar quita la entrada y no revive con la siembra', async () => {
  const e = await bit.crear({ fecha: '2026-09-16', titulo: 'Para borrar' });
  assert.strictEqual(await bit.borrar(e._id), true);
  assert.strictEqual(await bit.borrar(e._id), false);

  const { sembrarSiVacia } = require('../services/bitacoraSeed');
  const antes = await db.count(db.bitacora, {});
  assert.ok(antes > 0, 'la bitácora no está vacía');
  assert.strictEqual(await sembrarSiVacia(), 0, 'con entradas, la siembra no hace nada');
});

test('la siembra corre cuando está vacía y deja entradas válidas', async () => {
  await db.remove(db.bitacora, {});
  const { sembrarSiVacia, HISTORIA } = require('../services/bitacoraSeed');
  assert.strictEqual(await sembrarSiVacia(), HISTORIA.length);
  assert.strictEqual(await sembrarSiVacia(), 0, 'la segunda vez no duplica');

  const c = await bit.centro();
  assert.strictEqual(c.stats.sesiones, HISTORIA.length);
  assert.ok(c.abiertos.length >= 5, 'la historia trae pendientes vivos');
  assert.ok(c.abiertos.some(p => /Mercado Pago/.test(p.texto)), 'incluye el bloqueo del cobro');
  for (const e of c.entradas) {
    assert.match(e.fecha, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.titulo && e.titulo.length <= 160);
    assert.ok((e.pendientes || []).every(p => bit.DUENOS.includes(p.de)));
  }
});
