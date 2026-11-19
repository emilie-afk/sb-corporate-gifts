-- "Resolved": handled without creating a Task Tracker task. One status shared with the Marketing Dashboard for the same
-- request id (its migration 015): resolved in either app, the request leaves "To review" in both and is never reopened
-- by a rescan, a repeated click or a stale receipt. A task that already exists in Task Tracker wins (it is reported
-- "delivered" and keeps resolved_at as history). Rollback: db/rollback/008_shared_resolved.down.sql
alter table corporate_task_requests drop constraint corporate_task_requests_delivery_status_check;
alter table corporate_task_requests add constraint corporate_task_requests_delivery_status_check
  check (delivery_status in ('pending', 'in_review', 'delivered', 'failed', 'dismissed', 'resolved'));
alter table corporate_task_requests
  add column resolved_at timestamptz,
  add column resolved_by text check (resolved_by is null or length(resolved_by) <= 120),
  add column resolved_in text check (resolved_in is null or resolved_in in ('corporate_gifts', 'dashboard')),
  add constraint corporate_task_requests_resolved_fields check (delivery_status <> 'resolved' or (resolved_at is not null and resolved_in is not null));
