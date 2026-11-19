# Resolved: shared with the Marketing Dashboard

A Corporate Gifts task request can be **Resolved**: handled without creating a Task Tracker task. The status is shared
with the Marketing Dashboard's Corporate Gifts queue, on the same request id.

## Behaviour

- **Resolve** (Tasks view, on a request waiting for the dashboard, in review there, or failed) closes it here at once.
  The dashboard reads it on its next sync and closes its draft. **Dismiss** stays for requests that need no action.
- **Resolved in the dashboard** arrives as a delivery receipt with state `resolved` and closes the request here.
- **To review** (the default filter, with its count) lists requests waiting for the dashboard, in review there, or
  failed. Resolved and dismissed requests are not open work in the dashboard summary or the partner counts.
- **Nothing reopens a resolved request.** Repeated clicks, stale forms (version check), later Slack scans of the same
  task, and stale receipts (`in_review`, `failed`, `dismissed`, `resolved`) leave it resolved.
- **A task that already exists wins.** If the dashboard had already created the Task Tracker task (for example, its
  send was in flight when the request was resolved), it reports `delivered`. The request then shows the task's status
  and link, keeps the time it was resolved as history, and is completed in Task Tracker.

## Contract

- `GET /api/reporting/v1/corporate-tasks` lists requests resolved here (`delivery_status: "resolved"`) to a read with
  `since`, and returns `capabilities: ["resolved"]`.
- `POST /api/reporting/v1/corporate-task-receipts` accepts `state: "resolved"`.
- The dashboard sends `resolved` only after it has seen that capability, so neither app sends a state the other can't
  read.

## Deployment order

1. Marketing Dashboard first (its PR adding occasion planning, with migration 015). It reads `resolved` in the feed
   and holds its own resolutions until Corporate Gifts advertises the capability.
2. Then this change: apply `db/migrations/008_shared_resolved.sql`, then deploy. From then on the feed advertises
   the capability and the dashboard starts sending `resolved`.

Deploying this side first is also safe: the earlier dashboard build skips feed rows with a status it doesn't know (it
never reopens them) until it is updated.

## Rollback

Deploy the previous build, then run `db/rollback/008_shared_resolved.down.sql` (resolved requests become dismissed).
Roll the dashboard back first, or it would keep sending `resolved` receipts this side then refuses.
