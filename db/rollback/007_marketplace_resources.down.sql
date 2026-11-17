-- Rollback for 007_marketplace_resources.sql. Run only after redeploying code from before migration 007.
-- Export first (npm run private:export): this drops the task requests, application status, aliases, sales role,
-- exclusion marks and the actionable review fields. Earlier imports and history stay.
begin;
drop table if exists corporate_task_requests;
alter table review_items drop column if exists resolution, drop column if exists options, drop column if exists current_value,
  drop column if exists field, drop column if exists marketplace_id, drop column if exists format;
alter table slack_findings drop column if exists evidence_ts, drop column if exists scope, drop column if exists format;
alter table sample_requests drop column if exists excluded_reason, drop column if exists excluded_at;
alter table corporate_actions drop column if exists excluded_reason, drop column if exists excluded_at;
alter table supplier_resources drop column if exists excluded_reason, drop column if exists excluded_at;
alter table marketplaces drop column if exists status_evidence_at, drop column if exists application_updated_at, drop column if exists application_date,
  drop column if exists application_status, drop column if exists aliases, drop column if exists sales_role;
delete from schema_migrations where version = '007_marketplace_resources.sql';
commit;
