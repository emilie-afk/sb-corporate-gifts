-- Rolls back 008. Deploy the previous build first (it neither shows nor accepts "resolved"), and roll the Marketing
-- Dashboard back to a build that does not send "resolved" receipts (see docs/SHARED_RESOLVED.md).
-- Resolved requests become dismissed: in the previous build that is the closest state (no task, never reopened).
begin;
alter table corporate_task_requests drop constraint if exists corporate_task_requests_resolved_fields;
alter table corporate_task_requests drop constraint corporate_task_requests_delivery_status_check;
update corporate_task_requests set delivery_status = 'dismissed', updated_at = now(), version = version + 1 where delivery_status = 'resolved';
alter table corporate_task_requests add constraint corporate_task_requests_delivery_status_check
  check (delivery_status in ('pending', 'in_review', 'delivered', 'failed', 'dismissed'));
alter table corporate_task_requests drop column if exists resolved_in, drop column if exists resolved_by, drop column if exists resolved_at;
delete from schema_migrations where version = '008_shared_resolved.sql';
commit;
