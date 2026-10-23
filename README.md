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
| `docs/TEAM_GUIDE.md` | Short team instructions (pricing models, pricing file import, matching rules, revenue review) |
| `netlify/functions/api.ts` | Single function serving `/api/*` |
| `server/` | API: auth, router, validation, audit, routes, Shopify/Sheets/cost logic |
| `db/migrations/*.sql` | Schema (constraints, overlap exclusion, immutability trigger) |
| `db/seed/demo.ts`, `scripts/seed.ts` | **Fictional** demo data (local/tests only, `SEED_DEMO_DATA=1`) and the Direct website baseline row |
| `scripts/private-data.ts` | Private export/import of operational records between databases (never via Git) |
| `scripts/check-public-build.ts` | Fails if build output / folders contain secrets, sheet links, real emails, source maps or private terms |
| `docs/SECURITY.md` | Security model, private data handling, rollout and rollback |
| `scripts/migrate.ts` | Applies pending migrations and ensures the Direct website row exists (no business data) |
| `scripts/dev-server.ts` | Local preview server (built SPA + same API handler) |
| `tests/` | Business-rule tests (Vitest, real Postgres); `tests/fixtures/*SYNTHETIC*` are invented data |
| `scripts/ui-smoke.ts` | Browser smoke test + review screenshots (Playwright) |

## Local setup

```bash
npm install
createdb gifting && createdb gifting_test          # any Postgres 14+
export DATABASE_URL=postgresql://localhost/gifting
npm run db:demo                                    # schema + FICTIONAL demo data (local only)
npm test                                            # uses TEST_DATABASE_URL (drops/recreates its schema!)
npm run build && LOCAL_DEV_LOGIN=1 npm run dev      # http://localhost:8888 with a placeholder local login
```

`LOCAL_DEV_LOGIN` exists only in `scripts/dev-server.ts`, which refuses to start on Netlify/Lambda or with
`NODE_ENV=production`; the deployed function always requires Google sign-in. Real records are never in Git: copy
them between databases with the private export/import in `docs/SECURITY.md`.

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
| `BASELINE_DIRECT_DISCOUNT_PCT`, `BASELINE_CORPORATE_MOQ` | optional, Builds | Only used when the *Direct website* row is created for the first time in an empty database. Existing values are never changed; edit terms in the app |
| `SESSION_NOT_BEFORE` | optional, Functions | ISO time with zone (`2026-10-23T18:00:00Z`); sessions issued earlier are rejected (emergency sign-out of everyone). An invalid value denies all access |
| `SEED_DEMO_DATA` | local only | `1` loads fictional demo data; refused on Netlify/production and in any database with records in any operational table (only the untouched automatic Direct website row is allowed) |
| `PRIVATE_TERMS_FILE` | local only | Path to a git-ignored list of confidential terms for `npm run check:public` |

## Netlify

`netlify.toml`: build `npm run build`, publish `dist`, functions `netlify/functions` (esbuild;
`exceljs`/`jszip` are shipped as external node modules because they cannot be inlined into the ESM bundle).
Security headers include `noindex`, `X-Frame-Options: DENY`, and a strict CSP.
Database: **Neon** (free plan) PostgreSQL. Put the Neon **pooled** connection string in Netlify as
`DATABASE_URL` (secret; context **Production**; scopes **Builds** and **Functions**). Production builds run
`npm run build && npm run check:public && npm run db:migrate` (see `netlify.toml`): the public output is scanned,
then pending migrations are applied; any failure stops the deploy. Preview/branch builds never touch the database.
No business data is created by the build (only the *Direct website* channel row if it is missing); demo data cannot
run there. Source maps are off.

## Google sign-in

1. Google Cloud Console → OAuth consent screen (Internal or Testing) → Credentials → **OAuth client ID (Web)**.
2. Authorized redirect URIs: `<APP_BASE_URL>/api/auth/callback` for each context, e.g.
   - production: `https://<production-site>/api/auth/callback`
   - preview: a **stable branch deploy** such as `https://staging--<site>.netlify.app/api/auth/callback`
     (Google does not accept wildcards, so per-PR deploy-preview URLs cannot sign in; use the branch deploy or local preview).
3. Set `APP_BASE_URL` per context to match. Scopes requested: `openid email` only.

Flow: server-side authorization-code exchange → ID token verified against Google JWKS (issuer, audience, nonce,
`email_verified`) → email must be in `APPROVED_GOOGLE_EMAILS` → HttpOnly, SameSite=Lax session cookie (12 h).
The allowlist is re-checked on every request (removing a login revokes it at once). Mutations also require the
`X-Requested-With: sbg` header, a same-origin request (Origin / Sec-Fetch-Site) and a JSON body (CSRF). Sign-in,
callback, ingestion, expensive operations and overall writes have durable limits stored in the database
(`rate_limits`, hashed keys). Missing `SESSION_SECRET`/allowlist/OAuth settings deny all access.
The Google `sub` is stored privately in audit columns and stripped from all API responses.
"Your name" is a self-reported signature, never treated as verified identity.

## Product Master (Google Sheets) access

Read-only, server-side. Product Master is shared "Anyone with the link can view", so each vendor tab is read from
Google's CSV export of that tab (`/export?format=csv&gid=<tab gid>`). No credentials are needed; if the sheet is
ever made private, set `GOOGLE_SERVICE_ACCOUNT_JSON` (service account shared as Viewer) and the Sheets API is used
instead. Each vendor tab is configured in **Pricing → Cost source settings** by pasting the tab's link (the gid is
taken from it). Sheet locations are stored in the database only; lists show a short reference (`…abcd`) and a
signed-in team member can reveal one with **Show saved link** (audited). The sheet stays link-viewable, so anyone who
has the link can read it — hiding it in the app is not Google access control. The server only contacts
`docs.google.com` / `*.googleusercontent.com` (and the Sheets API hosts) over https, checking every redirect. Header line breaks/extra spaces are ignored when matching column names. Gifts are mapped to exact
rows from **Gifts → Edit → Product Master cost mapping**. No mappings are pre-filled.

## Website catalog

**Pricing → Refresh website products** reads `https://succulentsbox.com/products.json?limit=250&page=N` one page
per request (bounded, resumable). Verified 2026-10-09: ~11 pages, ~12,700 variants, per-variant `price`, `sku`,
`available`. Preview → confirm; upsert by Shopify variant ID; team fields are never overwritten; retail changes on
selected gifts need explicit confirmation; items missing from a complete import are flagged (never deleted).
Collection membership can be imported for `succulentsbox.com/collections/<handle>` references (add-only).

## API (all under `/api`, JSON)

`GET/POST /marketplaces`, `POST /marketplaces/bulk` (`items[{name, provider_type, status}]`, ≤ 200, `dry_run` to check; all-or-nothing), `GET/PATCH /marketplaces/:id`, `POST /marketplaces/:id/status-transitions`,
`GET/POST /marketplaces/:id/{milestones|requirements|communications|products}`, `PATCH …/:childId`, `POST /marketplaces/:id/products/candidates` (gift category, succulentsbox.com collection link or picked gifts), `POST /marketplaces/:id/products/bulk`, `POST /marketplaces/:id/requirements/bulk` (both with `dry_run`, all-or-nothing),
`GET/POST /products`, `GET/PATCH /products/:id`, `POST /products/:id/collections`,
`GET/POST /products/:id/source-links`, `PATCH …/:linkId`, `GET/POST /collections`, `PATCH /collections/:id`,
`POST /collections/:id/refresh-membership`, `GET /channels`, `PATCH /channels/:id/terms`,
`GET/POST /pricing`, `GET/PATCH /pricing/:id` (draft/proposed only), `GET /pricing/:id/history`,
`POST /pricing/:id/{revisions|activate|expire}`, `GET/POST /revenue/monthly`, `PATCH /revenue/monthly/:id`,
`GET /revenue/monthly/:id/history`, `GET/POST /sources`, `PATCH /sources/:id`, `POST /sources/:id/lookup`,
`GET /sources/:id/location` (audited), `GET /imports`, `POST /imports/shopify`, `POST /imports/shopify/:id/{next|confirm}`,
`POST /imports/product-master`, `POST /imports/product-master/:id/confirm`, `POST /imports/:id/discard`,
`GET /auth/{login|callback|session}`, `POST /auth/logout`.

Conventions: every mutation needs `signer_name` and (for edits) the record's `version` — a stale version returns
`409 conflict`. Validation errors return `400` with `error.details.fields`. Money is integer cents; `null` = unknown.

## Pricing models, references and pricing file import

- Pricing models (`shared/pricingModel.ts`, used by the API, the import and the screens): `fixed_supplier`
  (`supplier_price_cents` = what SB receives; commission/fee refused, also by a database constraint),
  `commission` (`selling_price_cents` + `commission_basis` + optional `commission_pct` / `fixed_fee_cents`),
  `custom` (`agreed_price_cents` + `custom_terms`), `direct` (Direct website only). `agreed_price_cents` is derived
  from the model's own price for fixed/commission. Model-specific fields are required only when agreed/active.
  Records created before migration 004 keep `pricing_model = null` ("Model not specified").
- `GET /api/pricing/references?product_id&channel_id` returns the current website retail price, the latest
  confirmed Product Master cost (basis, pack quantity, inclusions) and channel defaults. Pricing records store
  `retail_source` / `cost_source` (`shopify`, `product_master`, `manual`) with details; typed reference numbers are
  refused unless sent as `retail_override` / `cost_override` `{cents, reason, source, date}`.
- Pricing files (.xlsx or .csv ≤ 2 MB, any layout): `GET /api/pricing-import/template` (optional),
  `POST /api/pricing-import/preview` (base64 file), `POST /api/pricing-import/:id/preview` (`sheet`, `header_row`,
  `mapping`, `settings` {channel_id, pricing_model, commission_basis, fulfillment_format, status}, `resolutions`,
  `row_models`), `POST /api/pricing-import/:id/confirm`, `POST /api/pricing-import/:id/discard`. The file is never
  stored; parsed values of the chosen worksheet, file name, SHA-256, date and signer are kept (other worksheets'
  values are dropped on confirm/discard).

## Shopify revenue

- Collector: `POST /api/ingest/shopify-orders` (bearer `CORPORATE_INGEST_SECRET`). Manual fallback:
  **Revenue → Upload Shopify report** (reduced in the browser, then `POST /api/revenue/imports/manual`). Same
  validation and import code. See `docs/COLLECTOR_CONTRACT.md`.
- Other routes: `GET /api/revenue/summary`, `GET /api/revenue/imports`, `GET /api/revenue/orders`,
  `POST /api/revenue/orders/:id/classify`, `GET /api/revenue/rules`, `GET /api/revenue/rules/fields`,
  `POST /api/revenue/rules/preview`, `POST /api/revenue/rules/apply`, `GET|POST /api/revenue/adjustments`,
  `POST /api/revenue/adjustments/:id/void`, `POST /api/revenue/monthly/:id/reconcile`.
