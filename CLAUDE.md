# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**DMCloser** (package name `dmcloser`) — SaaS that auto-replies Instagram DMs with an AI sales-closer agent. Single Node/Express monolith, deployed on Railway. Frontend is vanilla HTML/JS in `public/` (no build step).

## Common commands

```bash
npm run dev      # nodemon server.js — local dev with auto-reload
npm start        # node server.js — production entrypoint (Railway uses this)
```

There is no test suite, no linter, and no build step. Changes to `public/*.html|js|css` are picked up on the next browser reload (static files are served directly).

## Required environment

Copy `.env.example` to `.env` for local dev. The minimum keys to boot are `OPENAI_API_KEY`, `META_APP_ID`, `META_APP_SECRET`, `JWT_SECRET`. Lemon Squeezy and Mercado Pago vars are optional locally but the billing webhooks return early without them. Full deploy checklist lives in `DEPLOY_PRODUCTION.md`.

`/health/ready` returns 503 when critical config or DB is missing — use it to verify a new environment.

## Architecture

### Entry point: `server.js`
Order of middleware matters and is intentional:

1. `helmet` with an explicit CSP. **`scriptSrcAttr: ["'unsafe-inline'"]` is critical** — the dashboard UI uses `onclick="..."` inline handlers everywhere (knowledge, links, agents, lead detail). Removing it silently breaks every button (regression history: commit `8e23d12`).
2. CORS allows `process.env.APP_URL` + `localhost:3000` only. Requests with no `Origin` (Meta webhook, Postman) pass.
3. **The Lemon Squeezy webhook (`/api/billing/ls-webhook`) is mounted BEFORE `express.json()`** because HMAC verification needs the raw body. Do not move it.
4. Mercado Pago webhook can use parsed JSON (no HMAC) and is mounted later.
5. Custom security middleware: `blockSuspiciousAgents`, `blockAttackPaths`, `preventParamPollution`, `sanitizeBody` (see `middleware/security.js`).
6. `express.static('public', { index: false })` — `index: false` matters: `/` must serve `home.html` (landing), not `index.html` (dashboard).

### Routing convention
- `/` → `public/home.html` (marketing landing). Redirects to `/app` if `?auth=` or `?billing=` query is present (post-OAuth/checkout).
- `/app` → `public/index.html` (SPA dashboard).
- `/api/*` routes are protected by `requireAuth` + `checkSubscription` (except `/api/user`, `/api/billing`, `/api/settings`, `/api/notifications`, `/api/usage`, public `/api/referrals/track-click`).
- `/api/admin/*` requires `requireAdmin` (admin email allowlist in `middleware/requireAdmin.js`).
- Catch-all `app.get('*')` serves the dashboard SPA — keep it last.

### Database: NeDB (`db/database.js`)
Embedded NeDB datastore (file-per-collection). Path comes from `process.env.DB_PATH` or falls back to `./db/data` (ephemeral).

**Production gotcha:** Railway containers are ephemeral. `DB_PATH=/data` MUST be set and a Railway Volume mounted at `/data`, otherwise every redeploy wipes users, leads, messages, and subscriptions. The startup log warns when running on an ephemeral path.

All access is through the promisified helpers (`db.find`, `db.findOne`, `db.insert`, `db.update`, `db.remove`) — `db.insert` auto-injects `_id` (uuid) and `createdAt`. Don't use callback APIs directly.

Collections of note: `users` (auth + plan state), `accounts` (one per Instagram account, linked to user), `agents` (AI persona config), `leads`/`messages` (the inbox), `pendingSends` (delayed reply queue), `followups`, `magnetLinks`/`linkClicks` (lead magnets + tracking), `referrals`, `errorLog`/`emailLog`/`auditLog` (homebrew observability).

### Background workers (all `setInterval` in `server.js`)
Single-process, no external queue. Be careful adding more — they all share the event loop:

- `processPendingSends` every 10s — drains delayed DM replies via `services/meta`. Increments plan usage on success.
- `refreshAllExpiring` at +30s and every 6h — renews Meta/Instagram long-lived tokens (60-day expiry) so users never re-OAuth.
- `scheduleFollowUps` (2 min) + `processFollowUps` (30s) — two-stage follow-up engine.
- `sweepTrialEmails` at +60s and every 6h — sends trial-ending and trial-ended emails, idempotent via `trialEndingEmailSent` / `trialEndedEmailSent` flags on the user doc.

### Plans / feature gating: `config/plans.js`
**Single source of truth** for plan limits (`maxDMs`, `maxAccounts`, `maxAgents`, `maxMagnets`, `overagePerDM`) and the `features` boolean dict (followups, leadMagnets, qualification, webhook, multiAccount, whiteLabel, multiUser, apiAccess, prioritySupport, etc.). Frontend reads it via `/api/usage` to render lock UI. Backend gates via `middleware/checkPlanLimits.js`. Change here = changes everywhere.

`UNLIMITED` is not a concept — every plan has a ceiling and overage is billed per-DM above it.

### Billing
Two providers run in parallel:
- **Lemon Squeezy** (USD, international): HMAC-verified webhook. `subscription_created`, `subscription_payment_success` (renewal), `subscription_payment_failed` (sets `past_due`), `subscription_cancelled`/`expired`. Flag the user with `paymentProvider: 'ls'` and store `lsSubscriptionId` + `lsCustomerPortalUrl`.
- **Mercado Pago** (CLP/LATAM): no HMAC, fetches the subscription from MP API to get authoritative status. Uses `external_reference` = userId. Flag with `paymentProvider: 'mp'`.

Both providers send a "subscription activated" email on first activation (idempotent — checked via `subscriptionStatus !== 'active'` before update).

### Services layer (`services/`)
- `openai.js` — agent reply generation (uses knowledge base for context).
- `meta.js` — Instagram Graph API send + receive. `metaRefresh.js` handles long-lived token renewal.
- `email.js` + `emailTemplates.js` — Resend wrapper. Every send is logged in `db.emailLog` even if it fails.
- `followup.js` — exports `scheduleFollowUps` + `processFollowUps`, called from server.js loops.
- `limits.js` — `incrementDMCount` + plan-limit checks. Use this, not raw DB writes, when counting DMs.
- `magnetDelivery.js` — sends a lead magnet (file/link/discount) when a lead qualifies.
- `dmcloserPreset.js` — built-in agent persona used when a user has no custom agent yet.

### Error tracking
`middleware/errorTracker.js` is a homebrew Sentry-lite. It catches Express errors, persists them to `db.errorLog`, and `installProcessHandlers()` captures `unhandledRejection`/`uncaughtException`. Visible from the admin panel.

## Conventions

- All comments and log lines are in Spanish — match this when editing.
- Console logs use emoji prefixes (`✅` success, `❌` error, `⚠️` warning, `📦` config, `🚀` boot). Match the convention.
- Frontend uses inline `onclick` handlers — don't introduce a build step or framework without updating the CSP and the inline-handler pattern.
- Money: USD prices in `priceUSD`, CLP in `priceCLP` — both are stored on the plan, not derived.
