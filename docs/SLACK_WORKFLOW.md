# Supplier Resources and the Slack workflow

Public description of the contract only. Channel IDs, message links, supplier terms and real examples live in the
signed-in app's private database and in private pass files, never in this repository.

## Supplier Resources

Top-level tab **Supplier Resources**, and a **Resources** shortcut on every partner record. A supplier is an
existing partner record (marketplace or supplier opportunity) or a product vendor record; resources link to it by
its existing ID (`partner:<uuid>` / `vendor:<uuid>`).

| Section | Resource types |
|---|---|
| Catalogs and pricing | catalog, availability list, quote, price sheet |
| Gift options and terms | sample option, minimum quantity, customization, lead time, shipping method, order cutoff, other term |
| Assets and documents | product photos, logo, packaging guide, proof, order form, other document |
| Decisions and follow-ups | decision, follow-up (optionally linked to an open action or a requirement) |

Each resource: title, type, link, short note, source message link, effective date (only when stated), last
confirmed date. **Replace** saves a new version and marks the earlier one **Superseded** (kept in the supplier's
history). Signed-in team members can add and edit everything; each change is audited.

The tab also holds the workflow views: **Review queue**, **Follow-ups** (actions, blockers, decisions),
**Sample boxes** (workflow status; separate from the Google Form signup count), and **Slack scans**.

## Slack scan passes

A scanner (scheduled task) reads `#seo` and `#teammarketing` separately, classifies corporate gifting messages
into findings, and imports one pass per channel. Two ways in, same rules:

- **From the app (no secret):** Supplier Resources → Slack scans → **Import a scan**. A signed-in team member picks
  the pass file, previews it, then saves. The import is logged under the typed signature and the Google account.
  `POST /api/slack/import` with `{ pass, dry_run, signer_name }` (session + `x-requested-with: sbg`).
- **Machine credential (optional):** the bearer endpoint below, enabled only when `CORPORATE_SLACK_INGEST_SECRET` is set.

```
POST /api/ingest/slack-findings[?dry_run=1]      Authorization: Bearer <CORPORATE_SLACK_INGEST_SECRET>
GET  /api/ingest/slack-state                       per-channel position + threads with findings (revisit for new replies)
```

```json
{ "schema": "sbcg-slack-v1", "channel": "seo", "through_ts": "1790000000.000100",
  "messages": [{ "ts": "…", "thread_ts": "…", "edited_ts": "…" }],
  "findings": [{ "key": "stable-event-key", "kind": "resource|terms|decision|sample|outreach|proposal|requirement|action|blocker",
                 "certainty": "confirmed|tentative|conflicting|ambiguous", "supplier": { "names": ["…"], "kind": "partner|vendor" },
                 "title": "…", "summary": "…", "question": "…", "resource_type": "quote", "link_url": "https://…",
                 "series": "same-series-for-versions", "effective_date": "YYYY-MM-DD", "sample_status": "shipped",
                 "action_status": "open", "marketplace_status": "application_submitted", "requirement_category": "other",
                 "owner": "…", "due": "YYYY-MM-DD", "occurred_on": "YYYY-MM-DD",
                 "sources": [{ "channel": "seo", "ts": "…", "thread_ts": "…", "permalink": "https://<workspace>.slack.com/archives/…" }] }] }
```

Rules (all in one transaction per pass):

| Finding | Action |
|---|---|
| Resource or terms, supplier matched | Add or update the resource; a new finding in the same `series` supersedes the earlier current version |
| Sample requested/approved/shipped/delivered | Update the matching sample (never backwards); unclear match → review |
| Outreach, proposal, requirement | Communication note / requirement on the partner; a working status change moves the partner (history kept); inactive statuses → review |
| Action, blocker, decision | Recorded with owner and due date when stated |
| Tentative, conflicting, ambiguous, or supplier not matched to exactly one record | Review item with sources and the question |

- The `key` identifies the event: retries, edited messages, corrected thread replies and the same event in the
  other channel update the same record and merge its supporting messages. Existing records (same supplier and
  title) are matched before anything is created.
- A channel's position advances only after its pass is saved. A failed pass saves nothing and records the
  error; the channel's last successful scan time is kept.
- Answers contain counts and record references only (`added`, `updated`, `flagged`, `unchanged`).
- `npm run slack:pass -- --file private/pass.json [--dry-run]` sends a pass file from a trusted computer (bearer endpoint).
- Importing the same file twice, or through both ways, changes nothing the second time.

## Marketing Dashboard

`GET /api/reporting/v1/corporate-workflow` (reporting credential): sample progress (tracked requests by latest
status), open and overdue follow-ups (overdue = open action with an explicit due date before today, Los Angeles),
and up to 8 decisions/blockers from the last 30 days as one-line titles. No files, quotes, terms, contacts or
Slack messages. Google Form signups stay a separate count.
