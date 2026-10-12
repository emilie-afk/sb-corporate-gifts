# SB Corporate Gifting tracker

Private internal app for Succulents Box corporate gifting: **Marketplaces** (landing), **Pricing**, **Revenue**.
Modular monolith — one React + TypeScript SPA, one Netlify Function API (`/api/*`), one PostgreSQL database.
Independent of the team's task tracker (no links or sync).

## Layout

| Path | What |
|---|---|
| `src/` | React SPA (Vite). Screens: `Marketplaces`, `Pricing` (+ `PricingForm`, `PricingImport`, `Gifts`, `Refresh`), `Revenue` |
| `shared/corporateOrders.js` | Shopify-export → minimal order payload (runs in the browser; proposed for the GP collector) |
| `docs/COLLECTOR_CONTRACT.md` | Ingestion endpoint, payload, privacy rules, revenue treatment, proposed collector change |
| `docs/TEAM_GUIDE.md` | Short team instructions (pricing, Excel import, matching rules, revenue review) |
| `netlify/functions/api.ts` | Single function serving `/api/*` |
| `server/` | API: auth, router, validation, audit, routes, Shopify/Sheets/cost logic |
| `db/migrations/*.sql` | Schema (constraints, overlap exclusion, immutability trigger) |
| `db/seed/providers.ts`, `scripts/seed.ts` | Initial data, applied once per database by `db:migrate` |
| `scripts/migrate.ts` | Applies pending migrations, then the initial data once |
| `scripts/dev-server.ts` | Local preview server (built SPA + same API handler) |
| `tests/` | Business-rule tests (Vitest, real Postgres); `tests/fixtures/*SYNTHETIC*` are invented data |
| `scripts/ui-smoke.ts` | Browser smoke test + review screenshots (Playwright) |

## Local setup

```bash
npm install
createdb gifting && createdb gifting_test          # any Postgres 14+
export DATABASE_URL=postgresql://localhost/gifting
npm run db:migrate                                 # schema + initial data (once)
npm test                                            # uses TEST_DATABASE_URL (drops/recreates its schema!)
npm run build && LOCAL_DEV_LOGIN=1 npm run dev      # http://localhost:8888 with a placeholder local login
```

`LOCAL_DEV_LOGIN` exists only in `scripts/dev-server.ts`; the deployed function always requires Google sign-in.

## Environment variables (names only — set values privately)

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Netlify (Production; Builds + Functions), secret | Neon pooled connection string |
| `SESSION_SECRET` | Netlify, secret | ≥ 32 random chars; signs the session cookie |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Netlify, secret | Google OAuth web client |
| `APPROVED_GOOGLE_EMAILS` | Netlify, secret | Comma-separated approved login(s). **Never** in code, seed, docs or screenshots |
| `APP_BASE_URL` | Netlify, per deploy context | Site origin used to build the OAuth redirect |
| `CORPORATE_INGEST_SECRET` | Netlify (Functions), secret | ≥ 32 random chars; bearer credential for `POST /api/ingest/shopify-orders` (collector). Unset = endpoint disabled |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | optional, secret | Only if Product Master becomes private (see below) |
| `SHOPIFY_CATALOG_ORIGIN` | optional | Defaults to `https://succulentsbox.com` |
| `DB_POOL_MAX`, `DATABASE_SSL` | optional | Pool size; `false` disables TLS (local only) |

## Netlify

`netlify.toml`: build `npm run build`, publish `dist`, functions `netlify/functions` (esbuild;
`exceljs`/`jszip` are shipped as external node modules because they cannot be inlined into the ESM bundle).
Security headers include `noindex`, `X-Frame-Options: DENY`, and a strict CSP.
Database: **Neon** (free plan) PostgreSQL. Put the Neon **pooled** connection string in Netlify as
`DATABASE_URL` (secret; context **Production**; scopes **Builds** and **Functions**). Production builds run
`npm run db:migrate && npm run build` (see `netlify.toml`): pending migrations and the one-time initial data are
applied before the site builds, and a failure stops the deploy. Preview/branch builds never touch the database.

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

Read-only, server-side. Product Master is shared "Anyone with the link can view", so each vendor tab is read from
Google's CSV export of that tab (`/export?format=csv&gid=<tab gid>`). No credentials are needed; if the sheet is
ever made private, set `GOOGLE_SERVICE_ACCOUNT_JSON` (service account shared as Viewer) and the Sheets API is used
instead. Each vendor tab is configured in **Pricing → Cost source settings** by pasting the tab's link (the gid is
taken from it). Header line breaks/extra spaces are ignored when matching column names. Gifts are mapped to exact
rows from **Gifts → Edit → Product Master cost mapping**. No mappings are pre-filled.

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

## Pricing references and Excel import

- `GET /api/pricing/references?product_id&channel_id` returns the current website retail price, the latest
  confirmed Product Master cost (basis, pack quantity, inclusions) and channel defaults. Pricing records store
  `retail_source` / `cost_source` (`shopify`, `product_master`, `manual`) with details; typed reference numbers are
  refused unless sent as `retail_override` / `cost_override` `{cents, reason, source, date}`.
- Excel: `GET /api/pricing-import/template`, `POST /api/pricing-import/preview` (base64 .xlsx ≤ 2 MB),
  `POST /api/pricing-import/:id/preview` (mapping / gift resolutions), `POST /api/pricing-import/:id/confirm`,
  `POST /api/pricing-import/:id/discard`. The workbook is never stored — only parsed values, file name, SHA-256,
  date and signer.

## Shopify revenue

- Collector: `POST /api/ingest/shopify-orders` (bearer `CORPORATE_INGEST_SECRET`). Manual fallback:
  **Revenue → Upload Shopify report** (reduced in the browser, then `POST /api/revenue/imports/manual`). Same
  validation and import code. See `docs/COLLECTOR_CONTRACT.md`.
- Other routes: `GET /api/revenue/summary`, `GET /api/revenue/imports`, `GET /api/revenue/orders`,
  `POST /api/revenue/orders/:id/classify`, `GET /api/revenue/rules`, `GET /api/revenue/rules/fields`,
  `POST /api/revenue/rules/preview`, `POST /api/revenue/rules/apply`, `GET|POST /api/revenue/adjustments`,
  `POST /api/revenue/adjustments/:id/void`, `POST /api/revenue/monthly/:id/reconcile`.
