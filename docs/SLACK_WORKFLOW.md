# Marketplace Resources and the Slack workflow

Public description of the contract only. Channel IDs, message links, partner terms and real examples live in the
signed-in app's private database and in private scan files, never in this repository.

## Marketplace Resources

Top-level tab **Marketplace Resources** (URL `?tab=resources`, unchanged), and a **Resources** button on every
eligible record in **Marketplaces**. The partner list *is* Marketplaces: records that sell, or are being pursued to
sell, our corporate gifts (marketplaces, and companies we could supply gifts to for their corporate clients). Product
suppliers (vendor records) are not part of it.

Each Marketplaces record has:

- **Sells our corporate gifts**: Confirmed (default) or Unclear. Unclear keeps the record out of the Slack scan.
- **Other names (verified)**: names Slack messages may use for it (matched after normalising case and punctuation).
- **Application status** (not applied … under review … approved/rejected/withdrawn) and an optional **application
  date**, tracked separately from the relationship status ("Under review" can be recorded without a date).

| Resources section | Types |
|---|---|
| Catalogs and pricing | catalog, availability list, quote, price sheet |
| Gift options and terms | sample option, minimum quantity, customization, lead time, shipping method, order cutoff, other term |
| Assets and documents | product photos, logo, packaging guide, proof, order form, other document |
| Decisions and follow-ups | decision, follow-up |

Each resource: title, type, link, note, source message link, effective date (only when stated), last confirmed date.
**Replace** marks the earlier version **Superseded** (kept in history). Views: **By marketplace**, **Review queue**,
**Tasks**, **Sample boxes**, **Slack scans**.

## Slack scans (format `sbcg-slack-v2`)

A scanner reads `#seo` and `#teammarketing` (thread replies included) and imports one file per channel:
Marketplace Resources → Slack scans → **Import a scan** (signed in; Preview, then Save), or the optional bearer
route `POST /api/ingest/slack-findings` when `CORPORATE_SLACK_INGEST_SECRET` is set. Both apply the same rules.

```json
{ "schema": "sbcg-slack-v2", "channel": "seo", "through_ts": "…", "messages": [{ "ts": "…", "thread_ts": "…" }],
  "findings": [
    { "key": "stable-event-key", "type": "status", "role": "selling", "certainty": "confirmed", "partner": { "names": ["…"] },
      "title": "…", "relationship_status": "application_submitted", "application_status": "under_review", "application_date": "YYYY-MM-DD", "reason": "product_fit",
      "sources": [{ "channel": "seo", "ts": "…", "permalink": "https://<workspace>.slack.com/archives/…" }] },
    { "type": "resource", "partner": { "id": "<marketplace uuid>" }, "resource_type": "price_sheet", "series": "…", "effective_date": "…", "link_url": "https://…", "summary": "…" },
    { "type": "task", "task_id": "stable-action-id", "partners": [{ "names": ["…"] }, { "names": ["…"] }], "title": "Send … the catalog", "owner": "…", "due": "YYYY-MM-DD", "task_status": "open" },
    { "type": "conflict", "partner": { "names": ["…"] }, "field": "relationship_status|application_status|application_date", "values": [{ "value": "live" }, { "value": "on_hold" }] }
  ] }
```

| Finding | Result |
|---|---|
| Confirmed status | Updates the record's relationship status (history kept; inactive statuses need a `reason`) and/or application status and date. |
| Useful, confirmed information | Adds or updates a resource under the partner, with source link and date. A newer confirmed version in the same `series` supersedes the earlier one. |
| Explicit, open Corporate Gifts action (one partner or a named group) | Creates or updates a **Corporate Gifts task**. The Marketing Dashboard reads it, the planning owner assigns and sends it, and it appears in **Marketing Tasks** (Task Tracker). |
| Conflicting evidence that blocks one field change | One review item with the partner, field, current value, competing values and sources. Actions: **Apply status: …** / **Apply date: …** / **Dismiss**. |
| `role: "supplier"`, a company not in Marketplaces (or ambiguous), unclear sales role, not confirmed, or a done/cancelled action with no task | **Skipped before anything is written**; counted (by reason) but never listed. A Slack mention never creates a partner. |

- Eligibility is checked on the server for every route, not only by the scanner.
- `key` identifies the event and `task_id` the action: rescans, edits, corrected replies and the same event in the
  other channel update the same record or task (sources merged). Existing records and tasks (same partner and
  title) are matched before anything is created. Older evidence read later never overwrites newer evidence (a status
  set by hand after the message is kept).
- Delivered tasks belong to Task Tracker: Slack updates never change their owner or completion; a new due date is
  passed on.
- **Preview** shows the partner fields, resources, tasks and conflicts the scan would change and writes nothing.
  **Save** records the signed-in account, typed name and source links in the audit history.
- A channel's position advances only after its pass is saved; a failed pass saves nothing and keeps the last
  successful scan time.

### Cleanup of scans imported before Marketplace Resources

Slack scans → **Clean up earlier imports** (Preview cleanup, then Apply cleanup): closes the old open review items
(marked *replaced* when they concern an eligible partner, *out of scope* otherwise) and hides imported records about
product suppliers or unlisted companies from views and summaries (`excluded_at`; nothing is deleted). Then import the
rebuilt v2 scan files. Running the cleanup twice changes nothing the second time.

## Corporate Gifts tasks and the Marketing Dashboard (reporting credential)

| Endpoint | Purpose |
|---|---|
| `GET /api/reporting/v1/corporate-tasks[?since=ISO]` | Requests to deliver or update: title, brief, owner hint, due date, Slack status, partner names with their Corporate Gifts links. Never Slack links or terms. |
| `POST /api/reporting/v1/corporate-task-receipts` | The only write on this connection: `in_review`, `delivered` (requires the Task Tracker task id), `failed`, `dismissed`. A delivered request is never downgraded. |
| `GET /api/reporting/v1/corporate-workflow` | Summary: sample progress, open and overdue Corporate Gifts work, recent decisions and blockers. Excluded records are not counted. |

Tasks: **Tasks** view lists each request with its delivery state (waiting for the dashboard, in review, in Task
Tracker, delivery failed with **Retry delivery**, dismissed). A retry reuses the same id, so Task Tracker never gets
a second copy. Google Form signups and revenue/order reporting are independent of Slack.
