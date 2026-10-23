# Security and private data

This repository is **public**. It holds code, schemas, generic formulas and **fictional** examples only.
Real partner records, prices, costs, revenue, contacts, sheet locations, approved logins and credentials live
only in the Neon database and in Netlify environment variables.

## What protects the app

| Area | Control |
|---|---|
| Sign-in | Google authorization-code flow, server side. ID token signature (Google JWKS), issuer, audience, expiry, nonce and `email_verified` are checked. OAuth `state` + `nonce` are held in a signed, 10-minute, HttpOnly cookie. |
| Who may use it | `APPROVED_GOOGLE_EMAILS` (private env var). Re-checked on **every** request, so removing a login revokes it immediately. Not shipped to the browser. |
| Sessions | HS256-signed cookie (`SESSION_SECRET` ≥ 32 chars), 12 h expiry, HttpOnly, SameSite=Lax, Secure (except plain-http localhost). `SESSION_NOT_BEFORE` (ISO time with zone, e.g. `2026-10-23T18:00:00Z`) ends every older session at once; an invalid or impossible value (wrong format, Feb 30, hour 24 …) denies all access rather than being ignored or rolled over. |
| Missing settings | No secret / empty allowlist / no OAuth client → every protected request is refused (503), sign-in is unavailable. There is no anonymous mode. |
| Local dev login | `LOCAL_DEV_LOGIN` exists only in `scripts/dev-server.ts`; it and `createApp({devSession})` refuse to run on Netlify, Lambda or `NODE_ENV=production`. |
| CSRF | Writes need `X-Requested-With: sbg`, a same-origin request (`Origin`, `Sec-Fetch-Site`) and a JSON body. No CORS is enabled. |
| Every API route | Session check before any database or external call; record IDs must be UUIDs (400 otherwise); bodies limited in **bytes** (1 MB; 6 MB only for file previews and the collector), checked on the declared length and while streaming, and read and parsed before any database work including rate-limit counters; zod validation; parameterized SQL; `Cache-Control: no-store, private`. |
| Limits (durable, in Postgres `rate_limits`, keys are HMAC hashes) | Sign-in and callback 30 / 10 min per address; ingestion 30 / h per address (counted before the credential check); expensive operations per Google account (catalog refresh, Product Master refresh, previews …); all writes 600 / 10 min per account. If the limit table is unavailable, requests are refused. |
| Errors and logs | Users see short messages. Server logs are one JSON line with URLs, emails, tokens, connection strings and long IDs replaced (`server/redact.ts`). Row values are not logged. |
| Audit | Every change stores the typed name ("Your name", self-reported) **and** the verified Google `sub` (private column, never returned by the API), with action and time. |
| Collector ingestion | Separate `CORPORATE_INGEST_SECRET` bearer token, required on every call, valid for that one endpoint only; a Google session cannot ingest and the token cannot call any other route. Order: method → configured? → content type → declared size (≤ 6 MB) → durable per-address counter (30/h, also limits secret guessing) → credential → byte-bounded body read → schema validation. Re-sending the same export is idempotent; failures never touch the GP results. |
| Google Sheets | Product Master stays "anyone with the link can view" (needed for the free CSV export). Locations are stored in the database, not in code. Lists show only a short reference; **Show saved link** reveals the full link to a signed-in member and is audited. The server contacts only `docs.google.com`, `*.googleusercontent.com`, `sheets.googleapis.com`, `oauth2.googleapis.com` over https:443, re-checking every redirect; it is not a general URL fetcher. Hiding the link in the app does **not** restrict who can open the sheet in Google. |
| Website catalog | Only the configured shop origin is fetched; redirects to other hosts are refused. |
| Excel / CSV | Size and type limits, header/row/number validation, formulas and macro files refused, preview before saving. Exported template text cannot start a formula (`= + - @`), and marketplace names starting with those characters are refused. Files are never executed or stored. |
| Browser bundle | No seeds, mappings, prices, contacts or allowlist; source maps off. `npm run check:public` (run by every Netlify build) fails on connection strings, sheet links, private keys, non-example emails, source maps, server secret values, approved logins or terms from a private list. |

**Intentional disclosures (public by design):** the code, database schema, generic pricing formulas, business rules
(e.g. pots with succulents are bulk only), the public website catalog origin, and the app's API shape. The public
Product Master sheet can be read by anyone holding its link — that is Google sharing, not app security.

## Private data: never through Git

`db/seed/demo.ts` is fictional and only loads locally with `SEED_DEMO_DATA=1`. It refuses on Netlify/production
and in any database with a record in any operational table (products, prices, revenue, audit …); only the
untouched, automatically created *Direct website* row is allowed. Production builds create **no** business data; migrations only
ensure the *Direct website* row exists (with `BASELINE_DIRECT_DISCOUNT_PCT` / `BASELINE_CORPORATE_MOQ` if set, else
blank), and never change an existing row.

To copy real records between databases (e.g. production → a private staging database), on a trusted computer:

```bash
# 1. Export (read-only). The file must be outside the repo or in the git-ignored private/ folder; it is chmod 600.
DATABASE_URL=<source> npm run private:export -- --out private/ops-YYYYMMDD.json
# 2. Target: apply the app's migrations first.
DATABASE_URL=<target> npm run db:migrate
# 3. Preview (one transaction, rolled back) — shows per table: in file / would add / already present.
DATABASE_URL=<target> npm run private:import -- --in private/ops-YYYYMMDD.json
# 4. Apply.
DATABASE_URL=<target> npm run private:import -- --in private/ops-YYYYMMDD.json --apply
```

The export reads every table from one read-only, repeatable-read snapshot, so records changed during the export
cannot produce mismatched rows. IDs are preserved, so relationships (proposals, requirements, price versions, revenue, audit) stay intact. Import
only adds missing rows; existing rows are never updated. The one exception: on a freshly migrated target the
automatically created, unused and unedited *Direct website* row is replaced by the exported one so its ID is kept.
Rows whose name is already used by a different ID are reported (`same_name_other_id`), never merged. Delete the export file when done; never
commit, email or upload it.

## Environment variables (placeholders only)

```
DATABASE_URL=<neon pooled connection string>            # Builds + Functions, secret
SESSION_SECRET=<64 random characters>                   # Functions, secret
GOOGLE_CLIENT_ID=<oauth client id>                      # Functions
GOOGLE_CLIENT_SECRET=<oauth client secret>              # Functions, secret, Production context only
APPROVED_GOOGLE_EMAILS=<login1>,<login2>                # Functions, secret
APP_BASE_URL=https://<site>                             # per context
CORPORATE_INGEST_SECRET=<64 random characters>          # Functions, secret (unset = ingestion off)
SESSION_NOT_BEFORE=<YYYY-MM-DDTHH:MM:SSZ>               # optional kill switch; invalid value = deny all
BASELINE_DIRECT_DISCOUNT_PCT=<number>                   # optional, Builds; first creation only
BASELINE_CORPORATE_MOQ=<number>                         # optional, Builds; first creation only
GOOGLE_SERVICE_ACCOUNT_JSON=<json>                      # optional, only if the sheet becomes private
```

## Migrations

`005_rate_limits.sql` — adds the `rate_limits` table (bucket, window, hit count). Additive; no existing table or
row changes. Applied by the production build after the public-output check.

## Rollout (needs approval for each production step)

1. **Backup**: Neon → create a branch/snapshot of production (or `private:export` to a private location).
2. **Settings**: confirm `SESSION_SECRET` (≥ 32), `APPROVED_GOOGLE_EMAILS`, `GOOGLE_CLIENT_*`, `APP_BASE_URL`,
   `CORPORATE_INGEST_SECRET` are set with the right scopes/contexts; secrets marked secret; `GOOGLE_CLIENT_SECRET`
   not exposed to deploy previews. Optionally set the `BASELINE_*` values (only matter for a new empty database).
3. **Deploy**: merge the branch → production build runs build → public check → migration 005.
4. **Verify**: signed-out browser sees only the sign-in screen; `curl https://<site>/api/marketplaces` → 401;
   approved login works; an unapproved Google account is refused; existing marketplaces, prices, revenue months
   and overrides show the same counts/totals as before (parity check against the backup); Direct website terms
   unchanged; the deployed JS has no `.map` files.
5. **Collector**: no change needed (same endpoint, same secret). After the next Monday run, check the import
   record (counts only). A burst of more than 30 failed calls per hour from one address is refused with 429.
6. **Logs**: review Netlify function logs for a day; entries should contain no URLs, emails or row values.

## Rollback

Redeploy the previous production deploy in Netlify (instant). Migration 005 can stay (unused table). Keep
unauthorized access blocked: do not remove `SESSION_SECRET`/allowlist, and **never** restore confidential seed
data to the public repository as a rollback step. If a data problem appears, restore from the Neon backup branch.

## History

Earlier commits of this public repository may contain business information that has since been removed from the
current files. Removing it from the current branch does not remove it from Git history, forks, clones or caches,
and copies already made cannot be recalled. Any history rewrite is a separate, explicitly approved step.
