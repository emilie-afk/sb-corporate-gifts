# Partners — migration, import and rollback

Marketplaces and researched companies are now managed as **Partners**: companies that buy, sell, promote or
distribute Succulents Box gifts. Product vendors (the `vendors` table) are not partners and are unchanged.

## What changes

| Area | Change | Unchanged |
|---|---|---|
| Labels | Marketplaces → **Partners**; Marketplace Resources → **Partner Resources** | Pricing, Revenue; `?tab=marketplaces`, `?tab=resources`, `&m=<id>` bookmarks |
| Database | Migration `010_partners.sql` (additive) | `marketplaces` table, every record ID, `/api/marketplaces` paths, channel IDs |
| Stages | New stored values `contacted`, `skipped`; display groups (Live shows as *Active*, Rejected as *Declined*, In discussion as *Discussing*, Approved / Setting up listings as *Onboarding · …*) | Every existing status value and its history |
| Partner fields | Primary category, channel models, occasion tags, priority (A/B/C/Not assessed), research readiness, parent company, opportunity summary, next action + due date, contact next step, owner | Sales role (Slack eligibility), aliases, application status/date, older contact fields |
| New tables | `partner_contacts`, `partner_applications` (published routes), `partner_import_batches`, `partner_import_items` | Requirements, communications, proposals, milestones, pricing, revenue, resources, tasks |
| Requirements | `kind` (published / negotiated / ordering assumption / open question / SB capability), applicability, SB readiness, verification note. Existing rows become `published` | Confirmation state, sources, dates, history |
| Outreach | Skipped, declined, on-hold, not-qualified and inactive partners get no new task requests (manual or Slack) and stay out of Priority and Follow-up views | Existing open tasks: listed on the record for reconciliation, never closed automatically |

Priority is migrated only from an explicit priority label in the existing note: the word "Priority" followed by
A, B or C (`"Priority A"`, `"Priority: B"`, `"priority - C"`). A note that merely begins with A, B or C, or any other
wording, does not set a priority: the record starts as *Not assessed* and keeps its note. Every existing record starts as
*Uncategorized*: categorise them with **Partners → tick rows → Update category / priority / owner** (preview first).

## Rollout order (production)

1. **Back up** (read-only): `DATABASE_URL=<prod> npm run private:export -- --out private/operational-YYYYMMDD-pre-partners.json`
   (git-ignored `private/` folder or outside the repo; owner-only permissions).
2. Review and merge the branch; Netlify's production build runs `db:migrate`, which applies `010_partners.sql` once.
3. Sign in and check **Partners → All partners**: the record count matches the export, stages are unchanged.
4. Categorise existing records (bulk update with preview) and set priorities where known.
5. **Partners → Import research** → choose the CSV → *Preview*. Review every row:
   - *Possible duplicate*: pick the record to update, *Create a separate partner*, or *Don't import this row*.
   - *Conflicting fields*: the existing value is kept unless you choose *Use imported*.
   - Tick *Import as Skipped* (with the reason) for partners you decided not to pursue.
   - Check each new person's role (historical and advertising-only contacts are never offered as the best contact).
6. *Apply import*. The batch appears under **Past imports** with what each row created or filled.

The CSV is read in the browser and sent only to the app's API; it is never committed. Imports are repeatable: applying
the same file again adds nothing (stable keys for people, routes and requirement notes; matched records only get
empty fields filled).

## Import rules

- **Matching:** record ID (optional `Partner ID` column), the normalised name, or one of the record's verified other
  names. A similar name, the same website, or a former name stated in the file makes the row a *possible duplicate*
  that needs a decision. A shared parent company is never used for matching.
- **Existing partners:** ID, stage, history, owner, actions, negotiated terms, pricing, products, revenue, resources,
  task links and sales role are kept. Only empty fields are filled. Contacts, routes and requirement notes are added
  with their source and date.
- **New partners:** created at *Prospect* (or *Skipped* with the given reason), sales role *Unclear* so a Slack
  mention cannot act on them until someone confirms they sell our gifts. No tasks or product proposals are created.
- **Research states** ("Not researched", "Responsible person not identified", "Replacement needed") are stored as the
  partner's research readiness, never as contact names.
- **Capability text:** the standard one-gift-per-order statement is shown app-wide and not copied per partner; any other
  sentence (e.g. bulk pricing) is kept as a separate *SB capability* note. Ordering text after "Expected ordering
  pattern" is stored as an *assumption*.
- Unknown fees stay unknown (never 0%).
- Fields are re-checked on the locked record when the import is applied. A field someone filled or changed after the
  preview is kept and reported as a conflict (listed under the batch); it is never overwritten.

## Reversing an import

**Partners → Import research → Past imports → Preview reversal → Reverse this import.** Reversal removes the rows the
batch added (unless edited since), restores the fields it filled (unless changed since), undoes an imported *Skipped*
stage (with a history entry), and deletes a partner it created only when it is exactly as the import left it (same record version, nothing linked to it
since). A partner edited afterwards — even only its owner or opportunity — is kept, with its edits. Anything kept
is listed. Reverse later batches that touched the same partners first.

API (signed in, `x-requested-with: sbg`): `POST /api/partners/import/batches/<id>/reverse` with `{"dry_run": true, "signer_name": "…"}`.

## Rolling back the migration

Only together with deploying the previous app version, and after a fresh private export.

1. Move any partner in a new stage (`contacted`, `skipped`) to a stage the previous version knows — the rollback
   script stops and lists them otherwise.
2. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/010_partners.down.sql`
3. Deploy the previous commit.

The rollback drops the Partner contacts, routes, categories, priorities and import batches (the export taken in step 1
of the rollout is the copy). Re-deploying this branch re-applies 010 with defaults; re-run the import to restore the
research.

## Validation

`npm run typecheck`, `npm test` (includes `tests/partners.test.ts` and `tests/upgrade-010.test.ts`), `npm run build`,
`npm run check:public` (optionally with `PRIVATE_TERMS_FILE=private/terms.txt` listing the researched company names).
