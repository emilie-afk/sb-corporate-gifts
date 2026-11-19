-- Rollback for 009_links_and_resolution.sql. Run only after redeploying code from before migration 009.
-- Export first (npm run private:export): this drops library resources, reused references, link-needed marks, the
-- owner directory, routing, resolve requests, completion dates and evidence. Library resources are deleted (they have
-- no marketplace) and resources using the new types become "Other document". The shared "resolved" status of 008 and
-- every request already resolved stay as they are.
begin;
alter table review_items drop column if exists task_request_ids;
alter table corporate_task_requests drop constraint if exists corporate_task_requests_completion_check;
drop index if exists corporate_task_requests_feed;
-- A claimed request goes back to review (the dashboard settles it by its id); 008 knows no "sending".
update corporate_task_requests set delivery_status = 'in_review' where delivery_status = 'sending';
alter table corporate_task_requests drop constraint if exists corporate_task_requests_delivery_status_check;
alter table corporate_task_requests add constraint corporate_task_requests_delivery_status_check
  check (delivery_status in ('pending', 'in_review', 'delivered', 'failed', 'dismissed', 'resolved'));
-- Completions recorded from Task Tracker are not resolutions in 008's sense (its delivered + resolved_at means "resolved
-- while the task existed"): cleared. The task keeps its done status.
update corporate_task_requests set resolved_at = null, resolved_by = null, resolved_in = null where resolved_in = 'task_tracker';
update corporate_task_requests set resolved_in = 'dashboard' where delivery_status <> 'resolved' and resolved_in is not null and resolved_at is null;
alter table corporate_task_requests drop constraint if exists corporate_task_requests_resolved_in_check;
alter table corporate_task_requests add constraint corporate_task_requests_resolved_in_check
  check (resolved_in is null or resolved_in in ('corporate_gifts', 'dashboard'));
alter table corporate_task_requests drop column if exists evidence, drop column if exists resolve_error, drop column if exists resolve_requested_in,
  drop column if exists resolve_requested_by, drop column if exists resolve_requested_at, drop column if exists completion_source, drop column if exists completed_on,
  drop column if exists owner_team, drop column if exists owner_name, drop column if exists route_decided_by,
  drop column if exists route_reason, drop column if exists route;
drop table if exists corporate_owners;
update supplier_resources set shared_from_id = null where shared_from_id is not null;
delete from supplier_resources where scope = 'library';
update supplier_resources set resource_type = 'other_document', section = 'assets_documents'
  where resource_type in ('one_sheet', 'onboarding_form', 'listings_spreadsheet', 'listing_instructions', 'sales_assets', 'shared_folder');
drop index if exists supplier_resources_link_partner;
drop index if exists supplier_resources_link_library;
alter table supplier_resources drop constraint if exists supplier_resources_owner_check;
alter table supplier_resources drop constraint if exists supplier_resources_link_needed_check;
alter table supplier_resources drop column if exists shared_from_id, drop column if exists internal, drop column if exists partner_specific,
  drop column if exists link_needed, drop column if exists link_key, drop column if exists link_kind, drop column if exists scope;
alter table supplier_resources add constraint supplier_resources_check check ((marketplace_id is null) <> (vendor_id is null));
alter table supplier_resources drop constraint if exists supplier_resources_resource_type_check;
alter table supplier_resources add constraint supplier_resources_resource_type_check check (resource_type in (
  'catalog', 'availability_list', 'quote', 'price_sheet',
  'sample_option', 'minimum_quantity', 'customization', 'lead_time', 'shipping_method', 'order_cutoff', 'other_term',
  'product_photos', 'logo', 'packaging_guide', 'proof', 'order_form', 'other_document',
  'decision', 'follow_up'));
delete from schema_migrations where version = '009_links_and_resolution.sql';
commit;
