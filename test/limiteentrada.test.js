/**
 * Atinov — La pantalla de "primera instalación" con la base intacta
 *
 * El 21-09-2026 Brayan, grabando el video del App Review, recargó varias veces
 * la página de entrada y el panel le mostró "Primera vez en el sistema. Crea
 * tu cuenta de administrador". La base estaba intacta. La cadena:
 *
 *  1. GET /api/user/check (que el panel llama en CADA carga) contaba contra el
 *     límite de intentos de login: 10 cada 15 minutos por red.
 *  2. A la carga 11 respondía 429.
 *  3. El panel trataba cualquier falla de esa consulta como "no hay usuarios".
 *
 * Lo que se fija: las lecturas no cuentan como intentos, los intentos sí
 * siguen limitados, y el panel solo muestra la pantalla de instalación cuando
 * el servidor lo dice de forma explícita.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { authLimiter } = require('../middleware/security');

/** App mínima con el limitador REAL, en un puerto efímero. */
function levantar() {
  const app = express();
  app.get('/check', authLimiter, (req, res) => res.json({ hasUsers: true }));
  app.post('/login', authLimiter, (req, res) => res.json({ ok: true }));
  return new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('cargar la página muchas veces no gasta intentos de login', async () => {
  const { srv, base } = await levantar();
  try {
    for (let i = 1; i <= 15; i++) {
      const r = await fetch(`${base}/check`);
      assert.strictEqual(r.status, 200, `la carga ${i} no puede toparse con el límite de intentos`);
      assert.strictEqual((await r.json()).hasUsers, true);
    }
    // Y como las lecturas no contaron, los 10 intentos siguen disponibles.
    for (let i = 1; i <= 10; i++) {
      const r = await fetch(`${base}/login`, { method: 'POST' });
      assert.strictEqual(r.status, 200, `el intento ${i} de 10 tiene que pasar`);
    }
    // Los intentos sí siguen limitados: esa es la protección contra quien
    // prueba contraseñas.
    const r11 = await fetch(`${base}/login`, { method: 'POST' });
    assert.strictEqual(r11.status, 429, 'el intento 11 en 15 minutos se frena');
    // Y aun así la página se puede seguir cargando.
    assert.strictEqual((await fetch(`${base}/check`)).status, 200);
  } finally {
    srv.close();
  }
});

test('el panel solo muestra la instalación si el servidor lo dice explícitamente', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8');
  assert.ok(!main.includes(".catch(() => ({ hasUsers: false }))"),
    'una falla de la consulta no puede convertirse en "no hay usuarios"');
  assert.ok(/check\s*&&\s*check\.hasUsers\s*===\s*false/.test(main),
    'la pantalla de instalación exige hasUsers === false explícito');
  assert.ok(/r\.ok\s*\?\s*r\.json\(\)\s*:\s*null/.test(main),
    'una respuesta de error (429, 500) no se lee como si fuera la respuesta');
});

test('las lecturas de /api/user quedan bajo el límite general, no sin freno', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/user',\s*apiLimiter,\s*authLimiter,/,
    'apiLimiter va antes de authLimiter en /api/user');
});
