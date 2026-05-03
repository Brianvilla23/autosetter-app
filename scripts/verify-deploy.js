#!/usr/bin/env node
/**
 * verify-deploy.js — Chequeo automático post-deploy de DMCloser
 *
 * Uso:
 *   node scripts/verify-deploy.js
 *   node scripts/verify-deploy.js https://otra-url.up.railway.app
 *
 * Sin argumento usa https://dmcloser-app.up.railway.app
 *
 * Sale con código 0 si todos los checks pasan, 1 si alguno falla.
 * Diseñado para correrse manualmente o como step de CI.
 */

const https = require('https');
const url = require('url');

const BASE = process.argv[2] || 'https://dmcloser-app.up.railway.app';

const CHECKS = [
  {
    name: 'Home (/) responde 200',
    method: 'GET',
    path: '/',
    expectStatus: 200,
  },
  {
    name: 'Privacy Policy URL (/privacy) responde 200',
    method: 'GET',
    path: '/privacy',
    expectStatus: 200,
  },
  {
    name: 'Terms (/terms) responde 200',
    method: 'GET',
    path: '/terms',
    expectStatus: 200,
  },
  {
    name: 'Sitemap responde 200',
    method: 'GET',
    path: '/sitemap.xml',
    expectStatus: 200,
  },
  {
    name: 'Webhook Meta GET con verify_token correcto → 200 + challenge',
    method: 'GET',
    path: '/webhook?hub.mode=subscribe&hub.verify_token=autosetter_webhook_2024&hub.challenge=test123',
    expectStatus: 200,
    expectBodyIncludes: 'test123',
  },
  {
    name: 'Webhook Meta GET con verify_token MAL → 403',
    method: 'GET',
    path: '/webhook?hub.mode=subscribe&hub.verify_token=hacker&hub.challenge=test',
    expectStatus: 403,
  },
  {
    name: 'Webhook Meta POST sin firma → 401 (CRÍTICO seguridad)',
    method: 'POST',
    path: '/webhook',
    body: '{"fake":"test"}',
    expectStatus: 401,
  },
  {
    name: 'LS webhook POST sin firma → 400',
    method: 'POST',
    path: '/api/billing/ls-webhook',
    body: '{"fake":1}',
    expectStatus: 400,
  },
  {
    name: 'Polar webhook POST sin firma → 401',
    method: 'POST',
    path: '/api/billing/polar-webhook',
    body: '{"fake":1}',
    expectStatus: 401,
  },
  {
    name: '/api/agents sin auth → 401',
    method: 'GET',
    path: '/api/agents?accountId=fake',
    expectStatus: 401,
  },
  {
    name: '/api/leads sin auth → 401',
    method: 'GET',
    path: '/api/leads?accountId=fake',
    expectStatus: 401,
  },
  {
    name: '/api/admin/health sin auth → 401',
    method: 'GET',
    path: '/api/admin/health',
    expectStatus: 401,
  },
  {
    name: 'Header CSP presente',
    method: 'GET',
    path: '/',
    expectHeaderIncludes: { 'content-security-policy': "default-src 'self'" },
  },
  {
    name: 'Header HSTS presente',
    method: 'GET',
    path: '/',
    expectHeaderIncludes: { 'strict-transport-security': 'max-age=31536000' },
  },
  {
    name: 'Header X-Frame-Options presente',
    method: 'GET',
    path: '/',
    expectHeaderIncludes: { 'x-frame-options': 'SAMEORIGIN' },
  },
  {
    name: 'Header Permissions-Policy presente (nuevo)',
    method: 'GET',
    path: '/',
    expectHeaderIncludes: { 'permissions-policy': 'camera=()' },
  },
  {
    name: 'X-Powered-By NO está presente',
    method: 'GET',
    path: '/',
    expectHeaderAbsent: 'x-powered-by',
  },
  {
    name: 'API path inexistente devuelve 404 JSON (no dashboard)',
    method: 'GET',
    path: '/api/no-existe',
    expectStatus: 404,
  },
  {
    name: 'Endpoints API tienen Cache-Control: no-store',
    method: 'GET',
    path: '/api/user/check',
    expectHeaderIncludes: { 'cache-control': 'no-store' },
  },
];

function request(method, path, body) {
  const u = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runCheck(check) {
  try {
    const res = await request(check.method, check.path, check.body);

    if (check.expectStatus && res.status !== check.expectStatus) {
      return { ok: false, msg: `esperaba ${check.expectStatus}, fue ${res.status}` };
    }
    if (check.expectBodyIncludes && !res.body.includes(check.expectBodyIncludes)) {
      return { ok: false, msg: `body no incluye "${check.expectBodyIncludes}"` };
    }
    if (check.expectHeaderIncludes) {
      for (const [h, v] of Object.entries(check.expectHeaderIncludes)) {
        const got = res.headers[h];
        if (!got || !got.includes(v)) {
          return { ok: false, msg: `header ${h} no incluye "${v}" (got: ${got || 'ausente'})` };
        }
      }
    }
    if (check.expectHeaderAbsent) {
      if (res.headers[check.expectHeaderAbsent]) {
        return { ok: false, msg: `header ${check.expectHeaderAbsent} presente (no debería)` };
      }
    }
    return { ok: true, msg: `${res.status}` };
  } catch (err) {
    return { ok: false, msg: `error: ${err.message}` };
  }
}

(async () => {
  console.log(`\n🔍 Verificando deploy en ${BASE}\n`);
  let passed = 0;
  let failed = 0;
  for (const check of CHECKS) {
    const result = await runCheck(check);
    if (result.ok) {
      console.log(`  ✅  ${check.name}  →  ${result.msg}`);
      passed++;
    } else {
      console.log(`  ❌  ${check.name}  →  ${result.msg}`);
      failed++;
    }
  }
  console.log(`\n──────────────────────────────────────`);
  console.log(`Total: ${passed + failed}  ✅ ${passed}  ❌ ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
