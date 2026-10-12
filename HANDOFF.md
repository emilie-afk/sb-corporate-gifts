# Corporate gifting tracker — v1 handoff (2026-10-09)

Status: three-tab core is implemented and tested locally. **Not deployed.** Deployment needs separate authorization.

## Verification results

- `npm test`: **41/41 pass** (real PostgreSQL 16). Covers access control, seed, checklist, status/reactivation,
  requirements, fulfillment rules, pricing versions/overlaps, revenue, Product Master cost rules, website import.
- `scripts/ui-smoke.ts`: **15/15 pass** in Chromium (desktop 1366 px + mobile 390 px, no horizontal scroll).
- Live website import (read-only) ran end to end: 11 pages, 12,720 variants, 5 seeded variants kept their team fields.
- Collection membership import for the corporate collection: 136 products → 574 variant links.

| Acceptance check | Result |
|---|---|
| Shared login sees the same persisted records (server-side Postgres; browser stores only filters + last typed name) | Pass (design + tests) |
| Milestone done records name/date; reopen keeps history; N/A needs reason and leaves the denominator; all-N/A → "No applicable milestones" | Pass |
| Works without task-tracker links; no assignee/due-date fields | Pass |
| Rejected/Not qualified/On hold/Inactive need a reason, hide by default, muted + labelled when shown | Pass |
| Reactivation needs an explicit status and preserves every record | Pass |
| Requirement and our response stored separately; nothing seeded as confirmed | Pass |
| Product names/variants shown, not IDs | Pass |
| Direct 20% discount never sets marketplace supplier prices; suggestion is labelled and not stored | Pass |
| Revisions keep previous agreed versions; overlapping active periods rejected; supersede closes period in a transaction | Pass |
| Duplicate channel/month revenue blocked (DB unique); totals include inactive channels | Pass |
| Revenue = SB's supplier revenue; fees separate; "Revenue after marketplace fees" (not gross profit) | Pass |
| Concurrent edits → 409 conflict, input kept | Pass |
| Failed saves keep form input with actionable errors | Pass |
| Unauthorized/unlisted logins rejected on all APIs | Pass |
| 8 providers, correct types, no invented contacts/prices/completions | Pass |
| $4 × 5 = $20; complete-pack $20 stays $20; bad data never overwrites a cost | Pass |
| Refresh previews before confirm; snapshots and agreed prices survive | Pass |
| Pots-only show "plants not included"; pots + succulents can't be individual/separate-address; pots & watering cans seeded Available | Pass |
| Repeated imports don't duplicate; partial failures erase nothing; variants stay distinct | Pass |

## Remaining requirements before deployment

1. **Database** — the team chose a free option. Recommended: Neon free tier (works from Netlify Functions with the
   standard `pg` driver; available via Netlify's database integration or directly). Provide/approve, then run
   migrations + seed against it.
2. **Netlify site** — create/link once the repository URL is provided; set the environment variables in README.
3. **Google OAuth client** — create the web client; register production and one stable branch-deploy redirect URI.
4. **Approved login(s)** — supply privately; entered only into Netlify `APPROVED_GOOGLE_EMAILS`.
5. **Product Master access** — create a service account (or choose OAuth), share the sheet as Viewer.
6. **Vendor tab mappings** — per vendor: tab name, header row, match column(s), cost column, cost basis, pack
   quantity source, what the cost already includes. Not configured — nothing was guessed.
7. **Deployment authorization** — separate approval required.

## Open questions for the team

- Does Product Master stay authoritative for base costs/prices? (Built that way: read-only source; agreements live here.)
- Which marketplace terms are common vs gift-specific? (Both supported; agreed prices snapshot them.)
- Research verification dates for seeded requirements were not supplied — left blank; fill in when known.
- Seeded pots + succulents variants have availability **unset** (the team confirmed only pots and watering cans).

## Notes

- Live to Give is applied only to gifts the team marks as "Live to Give Gift Box" — never automatically.
- Per-PR deploy previews cannot use Google sign-in (Google does not accept wildcard redirect URIs); use a branch deploy.
- The static app bundle has no business data; all records come from authenticated API calls.
- Screenshots in `screenshots/` come from a local database; entries marked "Example only (screenshot)" / "UI smoke
  test" are local test data, not business records.
