# SB Corporate Gifting tracker

Private internal app for Succulents Box corporate gifting: **Marketplaces** (landing), **Pricing**, **Revenue**.
Modular monolith — one React + TypeScript SPA, one Netlify Function API (`/api/*`), one PostgreSQL database.
Independent of the team's task tracker (no links or sync).

## Layout

| Path | What |
|---|---|
| `src/` | React SPA (Vite). Screens: `Marketplaces`, `Pricing` (+ `Gifts`, `Refresh`), `Revenue` |
| `netlify/functions/api.ts` | Single function serving `/api/*` |
| `server/` | API: auth, router, validation, audit, routes, Shopify/Sheets/cost logic |
| `db/migrations/*.sql` | Schema (constraints, overlap exclusion, immutability trigger) |
| `db/seed/providers.ts`, `scripts/seed.ts` | Reproducible, idempotent seed |
| `scripts/migrate.ts` | Applies migrations once each |
| `scripts/dev-server.ts` | Local preview server (built SPA + same API handler) |
| `tests/` | Business-rule tests (Vitest, real Postgres) |
| `scripts/ui-smoke.ts` | Browser smoke test + review screenshots (Playwright) |

## Local setup

```bash
npm install
createdb gifting && createdb gifting_test          # any Postgres 14+
export DATABASE_URL=postgresql://localhost/gifting
npm run db:migrate && npm run db:seed
npm test                                            # uses TEST_DATABASE_URL (drops/recreates its schema!)
npm run build && LOCAL_DEV_LOGIN=1 npm run dev      # http://localhost:8888 with a placeholder local login
```

`LOCAL_DEV_LOGIN` exists only in `scripts/dev-server.ts`; the deployed function always requires Google sign-in.

## Environment variables (names only — set values privately)

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Netlify (Functions), secret | Managed Postgres connection string |
| `SESSION_SECRET` | Netlify, secret | ≥ 32 random chars; signs the session cookie |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Netlify, secret | Google OAuth web client |
| `APPROVED_GOOGLE_EMAILS` | Netlify, secret | Comma-separated approved login(s). **Never** in code, seed, docs or screenshots |
| `APP_BASE_URL` | Netlify, per deploy context | Site origin used to build the OAuth redirect |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Netlify, secret | Read-only Product Master access (see below) |
| `SHOPIFY_CATALOG_ORIGIN` | optional | Defaults to `https://succulentsbox.com` |
| `DB_POOL_MAX`, `DATABASE_SSL` | optional | Pool size; `false` disables TLS (local only) |

## Netlify

`netlify.toml`: build `npm run build`, publish `dist`, functions `netlify/functions` (esbuild).
Security headers include `noindex`, `X-Frame-Options: DENY`, and a strict CSP.
Migrations are run deliberately (not on every build): `DATABASE_URL=<context db> npm run db:migrate && npm run db:seed`.

## Google sign-in

1. Google Cloud Console → OAuth consent screen (Internal or Testing) → Credentials → **OAuth client ID (Web)**.
2. Authorized redirect URIs: `<APP_BASE_URL>/api/auth/callback` for each context, e.g.
   - production: `https://<production-site>/api/auth/callback`
   - preview: a **stable branch deploy** such as `https://staging--<site>.netlify.app/api/auth/callback`
     (Google does not accept wildcards, so per-PR deploy-preview URLs cannot sign in; use the branch deploy or local preview).
3. Set `APP_BASE_URL` per context to match. Scopes requested: `openid email` only.

Flow: server-side authorization-code exchange → ID token verified against Google JWKS (issuer, audience, nonce,
`email_verified`) → email must be in `APPROVED_GOOGLE_EMAILS` → HttpOnly, SameSite=Lax session cookie (12 h).
The allowlist is re-checked on every request. Mutations also require the `X-Requested-With: sbg` header (CSRF).
The Google `sub` is stored privately in audit columns and stripped from all API responses.
"Your name" is a self-reported signature, never treated as verified identity.

## Product Master (Google Sheets) access

Read-only, server-side. Default: a Google Cloud service account with the Sheets API enabled; share the Product
Master sheet with its `client_email` as **Viewer** and put the JSON key in `GOOGLE_SERVICE_ACCOUNT_JSON`.
The sheet never needs to be public. (If the team prefers explicit OAuth Sheets authorization, swap the reader in
`server/lib/sheets.ts`.) Each vendor tab is configured in **Pricing → Cost source settings**; gifts are mapped to
exact rows from **Gifts → Edit → Product Master cost mapping**. No mappings are pre-filled.

## Website catalog

**Pricing → Refresh website products** reads `https://succulentsbox.com/products.json?limit=250&page=N` one page
per request (bounded, resumable). Verified 2026-10-09: ~11 pages, ~12,700 variants, per-variant `price`, `sku`,
`available`. Preview → confirm; upsert by Shopify variant ID; team fields are never overwritten; retail changes on
selected gifts need explicit confirmation; items missing from a complete import are flagged (never deleted).
Collection membership can be imported for `succulentsbox.com/collections/<handle>` references (add-only).

## API (all under `/api`, JSON)

`GET/POST /marketplaces`, `GET/PATCH /marketplaces/:id`, `POST /marketplaces/:id/status-transitions`,
`GET/POST /marketplaces/:id/{milestones|requirements|communications|products}`, `PATCH …/:childId`,
`GET/POST /products`, `GET/PATCH /products/:id`, `POST /products/:id/collections`,
`GET/POST /products/:id/source-links`, `PATCH …/:linkId`, `GET/POST /collections`, `PATCH /collections/:id`,
`POST /collections/:id/refresh-membership`, `GET /channels`, `PATCH /channels/:id/terms`,
`GET/POST /pricing`, `GET/PATCH /pricing/:id` (draft/proposed only), `GET /pricing/:id/history`,
`POST /pricing/:id/{revisions|activate|expire}`, `GET/POST /revenue/monthly`, `PATCH /revenue/monthly/:id`,
`GET /revenue/monthly/:id/history`, `GET/POST /sources`, `PATCH /sources/:id`, `POST /sources/:id/lookup`,
`GET /imports`, `POST /imports/shopify`, `POST /imports/shopify/:id/{next|confirm}`,
`POST /imports/product-master`, `POST /imports/product-master/:id/confirm`, `POST /imports/:id/discard`,
`GET /auth/{login|callback|session}`, `POST /auth/logout`.

Conventions: every mutation needs `signer_name` and (for edits) the record's `version` — a stale version returns
`409 conflict`. Validation errors return `400` with `error.details.fields`. Money is integer cents; `null` = unknown.
