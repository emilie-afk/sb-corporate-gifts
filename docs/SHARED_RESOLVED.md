# Resolved: shared with the Marketing Dashboard

A Corporate Gifts task request can be **Resolved**: handled without creating a Task Tracker task. The status is shared
with the Marketing Dashboard's Corporate Gifts queue, on the same request id.

## Behaviour

- **Resolve** on a request handled without a task (waiting for the dashboard, in review there, failed, a check-off
  item or an item waiting for routing) closes it here at once. The dashboard reads it on its next sync and closes its
  draft. **Dismiss** stays for requests that need no action.
- **Resolve on a task already in Task Tracker** (migration 009) is a request: the dashboard completes that task through
  Task Tracker's own completion rules, and the request shows Resolved once Task Tracker reports it done. There is one
  resolution, read the same way everywhere: `resolved` status, or delivered and done in Task Tracker.
- **Resolved in the dashboard** arrives as a delivery receipt with state `resolved` and closes the request here.
- **To review** (the default filter, with its count) lists requests waiting for the dashboard, in review there, or
  failed. Resolved and dismissed requests are not open work in the dashboard summary or the partner counts.
- **Nothing reopens a resolved request.** Repeated clicks, stale forms (version check), later Slack scans of the same
  task, and stale receipts (`in_review`, `failed`, `dismissed`, `resolved`) leave it resolved.
- **A task that already exists wins.** If the dashboard had already created the Task Tracker task (for example, its
  send was in flight when the request was resolved), it reports `delivered`. The request then shows the task's status
  and link, keeps the time it was resolved as history, and the resolution becomes a request to complete that task in
  Task Tracker (from 009). A request resolved that way before 009 keeps only the history: use Resolve to complete it.

## Contract

- `GET /api/reporting/v1/corporate-tasks` lists requests resolved here (`delivery_status: "resolved"`) to a read with
  `since`, and returns `capabilities: ["resolved"]`.
- `POST /api/reporting/v1/corporate-task-receipts` accepts `state: "resolved"`.
- From migration 009 the feed also advertises `routing`: `?v=2` adds every route, `resolution` (requested or resolved,
  with the completion date) and the `sending` claim state; without `v=2` the feed reads as before for an earlier
  dashboard build. Receipts may carry `resolved_by`, `completed_on`, `resolve_error` and `tracker.completed_on`.
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
