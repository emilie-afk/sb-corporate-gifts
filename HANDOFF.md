# Corporate gifting tracker — handoff (v2: easier pricing + Shopify revenue)

Base: `main` @ `cadd3a7`. This change is **not pushed and not deployed**. Same three tabs; no new navigation.

> **Deployment note:** pushing to `main` triggers a Netlify **production** build, which runs
> `npm run db:migrate` first. That applies `db/migrations/002_pricing_sources_and_shopify_revenue.sql` (additive:
> new tables/columns, one replaced trigger function; existing rows unchanged; verified on a copy with v1 data) and
> `003_pots_with_succulents_complete_gift.sql` (data only, see below) to the Neon production database. Push only
> with authorization.

## What changed

**Pricing**
- Form prefills (read-only, with source and date): website retail price, latest confirmed Product Master cost
  (basis, pack quantity, what it includes) and channel defaults (MOQ, direct discount, terms). Main fields: channel,
  gift, proposed price, agreed price, customer shipping, marketplace fees, status, dates, name. The rest is under
  **More details**.
- Missing values stay **Unknown**. A manual value needs amount + reason + source + date and is labelled
  **Manual**. The API refuses typed `retail_ref_cents` / `internal_cost_cents`.
- Agreed prices snapshot retail, cost and terms; refreshes show current values beside the snapshot; Revise creates
  a new dated version from current source values.
- **Import pricing Excel** (optional): downloadable template, automatic column recognition + manual mapping,
  stable-identifier matching (variant ID / exact SKU, never names), ambiguity resolution, validation, explicit draft
  updates, new versions only after per-row confirmation, overlap checks, idempotent re-uploads, formula/macro
  rejection, file not stored (name, hash, date, signer, row reference kept).

**Revenue**
- Canonical Shopify orders (store + order Name), shared reducer that runs in the browser for manual uploads and is
  proposed for the existing GP collector (`docs/COLLECTOR_CONTRACT.md`).
- Secret-protected ingestion endpoint + manual **Upload Shopify report** — same validation/import code.
- Newer snapshots update, older/equal-time-different snapshots never overwrite, exact duplicates are no-ops,
  missing orders are never deleted, failures change nothing; every run is recorded.
- **Shopify matching rules** panel (source / tags / billing company; exact or contains; case/space-insensitive):
  preview → typed name → confirm; same-channel alternatives OK, cross-channel = conflict (never auto-picked).
  Manual assign/exclude/clear with reason and history; manual wins until cleared.
- Channel/month table: From Shopify + Manual = Combined; fees only from actual recorded entries ("Fees not
  recorded" otherwise); revenue after fees (not gross profit); coverage and partial-month flags; import freshness.
- Legacy monthly totals start as **Needs review** (excluded) until marked *additional* or *covered by Shopify*.
  Manual entries (off-Shopify sale / correction / fee) need reason + reference + date; void keeps history.

**Gifts — pots with succulents (team clarification)**
- Custom pots are available on their own, or with succulents as a **complete gift**. Pots with succulents are
  **Available**, **bulk orders only**; individual recipient shipping is unavailable (individual and separate-address
  formats stay blocked in gifts, pricing, Excel import and marketplace proposals).
- Messages and notes no longer mention "multiple shipments" or "assembly not confirmed".
- Migration 003 sets seeded pots-with-succulents rows to Available and replaces the old seed note only where it
  is still the original text; team-edited values are kept. Each change is recorded in the audit history
  ("System migration").

## Verification

| Check | Kind | Result |
|---|---|---|
| `npm run typecheck` | static | PASS |
| `npm test` — 77 tests (16 marketplaces, 13 pricing/revenue incl. pots-with-succulents seed + migration 003, 17 Product Master/website refresh, 19 Shopify revenue, 12 pricing references + Excel) | **fixtures** on real PostgreSQL 16 | **77/77 PASS** |
| `npm run build` + function bundle load (exceljs/jszip external) | build | PASS |
| `scripts/ui-smoke.ts` — 28 browser checks, desktop 1366 px + mobile 390 px | **fixtures** (local DB, synthetic orders CSV, two fixture gift variants) | **28/28 PASS** |
| Migration 002 on a database holding v1 data | local copy | PASS (legacy record → Needs review; agreed price untouched) |
| Live public Shopify catalog import | **real service**, read-only | Worked earlier in the session (12,766 variants); a repeat run hit Shopify **HTTP 429** after several full pulls — nothing was written (failed run recorded, previous data kept) |
| GP collector → this app | — | **NOT RUN** (collector change not applied; needs review in the GP repo) |
| Netlify / Neon / Google | — | **NOT RUN** (no push, no deploy) |

Fixture tests cover the brief's list: prefilling, unknown costs, per-piece vs complete-pack, snapshot preservation,
Excel mapping/ambiguity/invalid values/formulas/macros/duplicates/revisions/overlaps, multi-line orders, repeated and
overlapping imports, older-snapshot protection, discounts/shipping/refunds/taxes/Route/gift cards, LA month boundary,
matching normalisation, same-channel and cross-channel rules, exclusions, manual overrides, rule confirmation and
stale previews, reconciliation, unauthorised ingestion (no secret / wrong secret / Google cookie), privacy rejection,
failed imports preserving data.

## Setup after authorization

1. Push to `main` (migrations 002 and 003 run in the production build).
2. Netlify → add `CORPORATE_INGEST_SECRET` (secret, Functions scope, ≥ 32 random chars). Until then the endpoint
   answers 503 and only manual uploads work.
3. GP repo (separate review): add the corporate payload step to the collector (snippet in the contract), store the
   same secret in Windows Credential Manager (`sb-corporate-ingest`), set the app URL in collector config. No new
   scheduled task; the existing Monday run carries it.
4. First use: upload one Shopify export manually, create matching rules from the values offered, reconcile legacy
   monthly totals.

## Remaining questions

- Which fields identify corporate orders in practice (source app id, tags, billing company)? Rules are configured
  after real orders arrive; only fields present in reports are offered.
- Is sharing **Billing Company** with this app acceptable for the collector payload? (Tags and source are already
  business identifiers; personal-looking values are dropped.)
- Pending / authorized / partially paid orders are **counted and flagged** (GP does not filter by payment status).
  Should corporate revenue wait for payment instead?
- Refunds are attributed to the original order month (no refund dates in the export). OK for v1?
- Cancelled orders with a retained amount are excluded and flagged (GP keeps shipping only with carrier evidence).
- Gift-card purchases and Route lines are excluded from gift revenue — confirm.
- Approve the GP collector change and its review path.
