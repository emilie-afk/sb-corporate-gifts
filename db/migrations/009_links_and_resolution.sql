-- Resource links and Corporate Gifts task resolution.
--  1. Resources keep the document or site link (resource URL) apart from the Slack message that mentions it
--     (source_url). A resource can wait for its link ("Link needed"), belong to the general corporate library
--     (no marketplace, attachable to eligible marketplaces by hand), and be reused on other marketplaces as a
--     reference to the same URL. One URL is held at most once per marketplace (and once in the library).
--  2. Corporate Gifts tasks are routed by owner: Marketing tasks go through the Marketing Dashboard to Task Tracker;
--     work owned outside Marketing becomes a check-off item; a missing or unclear owner waits for a routing decision.
--     Any open item can be resolved from either app; completions keep who, when, the completion date and the evidence.
--     Builds on 008_shared_resolved: delivery_status 'resolved' stays THE shared status for "closed without a Task
--     Tracker task" (both apps read it). resolution_state records completion for the weekly report: 'resolved' for
--     every completed item (resolved without a task, or a Task Tracker task done), 'requested' while a completion asked
--     for a task already in Task Tracker waits for Task Tracker. resolved_at, resolved_by and resolved_in come from 008.
-- Additive: new columns with safe defaults, wider check constraints, one new table. Existing rows keep their values
-- (every existing task request stays a Marketing task, so tasks already sent keep their Task Tracker link).
-- Rollback: db/rollback/009_links_and_resolution.down.sql

-- ------------------------------------------------------------------ resources
alter table supplier_resources drop constraint if exists supplier_resources_resource_type_check;
alter table supplier_resources add constraint supplier_resources_resource_type_check check (resource_type in (
  'catalog', 'availability_list', 'quote', 'price_sheet',
  'sample_option', 'minimum_quantity', 'customization', 'lead_time', 'shipping_method', 'order_cutoff', 'other_term',
  'product_photos', 'logo', 'packaging_guide', 'proof', 'order_form', 'other_document',
  'one_sheet', 'onboarding_form', 'listings_spreadsheet', 'listing_instructions', 'sales_assets', 'shared_folder',
  'decision', 'follow_up'));
-- Library resources (general corporate materials) have neither a marketplace nor a vendor.
alter table supplier_resources add column scope text not null default 'supplier' check (scope in ('supplier', 'library'));
alter table supplier_resources drop constraint if exists supplier_resources_check;
alter table supplier_resources add constraint supplier_resources_owner_check check (
  (scope = 'supplier' and (marketplace_id is null) <> (vendor_id is null))
  or (scope = 'library' and marketplace_id is null and vendor_id is null));
alter table supplier_resources add column link_kind text check (link_kind in ('url', 'slack_file'));
alter table supplier_resources add column link_key text;                         -- normalised resource URL (duplicate check)
alter table supplier_resources add column link_needed boolean not null default false;
alter table supplier_resources add constraint supplier_resources_link_needed_check check (not link_needed or link_url is null);
alter table supplier_resources add column partner_specific boolean not null default false;
alter table supplier_resources add column internal boolean not null default false;   -- internal reference (not for partners)
alter table supplier_resources add column shared_from_id uuid references supplier_resources(id) on delete restrict;
create unique index supplier_resources_link_partner on supplier_resources (marketplace_id, link_key)
  where link_key is not null and marketplace_id is not null and status = 'current' and removed_at is null and excluded_at is null;
create unique index supplier_resources_link_library on supplier_resources (link_key)
  where link_key is not null and scope = 'library' and status = 'current' and removed_at is null and excluded_at is null;
create index on supplier_resources (scope, status) where scope = 'library';

-- -------------------------------------------------------------- owner directory
-- Verified owner names (and other spellings) with their team. Routing uses only active entries.
create table corporate_owners (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 10),
  team text not null check (team in ('marketing', 'outside', 'external')),
  active boolean not null default true,
  note text check (note is null or length(note) <= 300),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index corporate_owners_name on corporate_owners (lower(btrim(name)));

-- ------------------------------------------------------- Corporate Gifts tasks
-- "sending": the dashboard has claimed the request (at its current content version) and is creating the Task Tracker
-- task. While sending, the request can't be rerouted or dismissed; a resolve then waits for the delivery receipt.
alter table corporate_task_requests drop constraint if exists corporate_task_requests_delivery_status_check;
alter table corporate_task_requests add constraint corporate_task_requests_delivery_status_check
  check (delivery_status in ('pending', 'in_review', 'sending', 'delivered', 'failed', 'dismissed', 'resolved'));
create index corporate_task_requests_feed on corporate_task_requests (updated_at, id);
alter table corporate_task_requests add column route text not null default 'marketing' check (route in ('marketing', 'checkoff', 'review'));
alter table corporate_task_requests add column route_reason text check (route_reason is null or length(route_reason) <= 200);
alter table corporate_task_requests add column route_decided_by text;            -- set when a reviewer chose the route
alter table corporate_task_requests add column owner_name text;                  -- the verified owner, when one matched
alter table corporate_task_requests add column owner_team text check (owner_team in ('marketing', 'outside', 'external'));
-- Resolution: 'requested' = resolve asked for a task already in Task Tracker (completed there by the dashboard, then
-- confirmed by its receipt); 'resolved' = done. completed_on is the date the work was done (report week).
alter table corporate_task_requests add column resolution_state text check (resolution_state in ('requested', 'resolved'));
alter table corporate_task_requests add column completed_on date;
alter table corporate_task_requests add column completion_source text check (completion_source in ('manual', 'slack'));
alter table corporate_task_requests add column resolve_requested_at timestamptz;
alter table corporate_task_requests add column resolve_requested_by text;
alter table corporate_task_requests add column resolve_error text check (resolve_error is null or length(resolve_error) <= 500);
alter table corporate_task_requests add column evidence jsonb not null default '[]';  -- [{source, at, date, permalink?, by?}]
-- Requests already resolved through 008 (without a task) are completed records too: completion date in the report
-- calendar (Vietnam), resolved by hand, with their resolution as evidence.
update corporate_task_requests
   set resolution_state = 'resolved', completed_on = (resolved_at at time zone 'Asia/Ho_Chi_Minh')::date, completion_source = 'manual',
       evidence = jsonb_build_array(jsonb_build_object('source', 'manual', 'at', to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'date', to_char(resolved_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'), 'by', coalesce(resolved_by, 'Corporate Gifts')))
 where delivery_status = 'resolved' and resolution_state is null;
alter table corporate_task_requests add constraint corporate_task_requests_resolved_check
  check (resolution_state is distinct from 'resolved' or (resolved_at is not null and completed_on is not null and completion_source is not null));
-- The shared status always means a completed record without a task.
alter table corporate_task_requests add constraint corporate_task_requests_resolved_is_complete
  check (delivery_status <> 'resolved' or resolution_state = 'resolved');
create index on corporate_task_requests (route, resolution_state);
create index on corporate_task_requests (completed_on) where resolution_state = 'resolved';

-- Review items may now also ask which open item a Slack completion confirms ("Confirm completion").
alter table review_items add column task_request_ids uuid[] not null default '{}';
