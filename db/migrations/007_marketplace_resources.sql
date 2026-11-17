-- Marketplace Resources: the Slack workflow works only with Marketplaces records that sell (or are being pursued to
-- sell) our corporate gifts, and turns findings into partner status updates, partner resources, or Corporate Gifts
-- tasks delivered to Task Tracker through the Marketing Dashboard.
-- Additive only: new columns (all with safe defaults; status_evidence_at is filled from the status history) and one
-- new table. No existing value is changed by this file;
-- the cleanup of earlier imports is a separate, reviewed step (Marketplace Resources -> Slack scans -> Cleanup).
-- Rollback: db/rollback/007_marketplace_resources.down.sql

-- ------------------------------------------------------------------ marketplaces
-- Sales role: every Marketplaces record is a sales partner (a marketplace that lists our gifts, or a company we could
-- supply gifts to for its corporate clients). "unclear" keeps a record out of the Slack scan until someone confirms it.
alter table marketplaces add column sales_role text not null default 'confirmed' check (sales_role in ('confirmed', 'unclear'));
-- Verified alternative names a Slack message may use (exact match after normalising case, spacing and punctuation).
alter table marketplaces add column aliases text[] not null default '{}' check (cardinality(aliases) <= 10);
-- Application status is tracked separately from the relationship status; the date is optional ("Under review" can be
-- recorded without knowing when the application was sent).
alter table marketplaces add column application_status text check (application_status in
  ('not_applied', 'preparing', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn'));
alter table marketplaces add column application_date date;
alter table marketplaces add column application_updated_at timestamptz;   -- time of the evidence behind it (manual edits: now)
-- Time of the evidence behind the current relationship status (a Slack message's time, or the time of a manual
-- change). Older Slack evidence never overwrites it. Filled from the status history for existing records.
alter table marketplaces add column status_evidence_at timestamptz;
update marketplaces m set status_evidence_at = (select max(h.created_at) from status_history h where h.marketplace_id = m.id);

-- ------------------------------------------------- imported records outside the scope
-- Earlier Slack imports about product suppliers or companies outside Marketplaces are excluded from views and
-- summaries (history kept, nothing deleted).
alter table supplier_resources add column excluded_at timestamptz, add column excluded_reason text;
alter table corporate_actions add column excluded_at timestamptz, add column excluded_reason text;
alter table sample_requests add column excluded_at timestamptz, add column excluded_reason text;

-- ------------------------------------------------------------------ findings
alter table slack_findings add column format integer not null default 1;
alter table slack_findings add column scope text not null default 'in_scope' check (scope in ('in_scope', 'out_of_scope', 'replaced'));
-- Newest Slack timestamp behind the record: older evidence read later never overwrites newer evidence.
alter table slack_findings add column evidence_ts text;

-- ------------------------------------------------------------------ review queue
-- Format 2 items are conflicts that block one specific change on one partner. Each option is a change that can be
-- applied as is ("Apply status: Live"); the item closes only when a change is saved or someone dismisses it.
alter table review_items add column format integer not null default 1;
alter table review_items add column marketplace_id uuid references marketplaces(id) on delete restrict;
alter table review_items add column field text;
alter table review_items add column current_value text;
alter table review_items add column options jsonb not null default '[]';
alter table review_items add column resolution text check (resolution in ('applied', 'dismissed', 'replaced', 'out_of_scope'));

-- ------------------------------------------------------- Corporate Gifts tasks
-- Explicit, open Corporate Gifts actions for one or more eligible partners. They become real Task Tracker tasks
-- through the Marketing Dashboard: the dashboard reads pending requests over the reporting connection, its planning
-- owner reviews and assigns them, and it reports back. "delivered" is set only from the dashboard's receipt carrying
-- the Task Tracker task id. Task Tracker owns the task afterwards (assignee, completion).
create table corporate_task_requests (
  id uuid primary key default gen_random_uuid(),
  task_key text not null unique check (task_key ~ '^[a-z0-9][a-z0-9:._-]{2,119}$'),
  title text not null check (length(btrim(title)) between 1 and 300),
  brief text check (brief is null or length(brief) <= 1500),
  owner_hint text check (owner_hint is null or length(owner_hint) <= 80),
  due_date date,
  slack_status text not null default 'open' check (slack_status in ('open', 'done', 'cancelled')),
  marketplace_ids uuid[] not null check (cardinality(marketplace_ids) between 1 and 20),
  source_refs jsonb not null default '[]',          -- private Slack links (never sent to the dashboard)
  content_version integer not null default 1,       -- bumps when title, brief, owner, due date, partners or status change
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'in_review', 'delivered', 'failed', 'dismissed')),
  delivery_error text,
  delivered_version integer,
  tracker_task_id text,
  tracker_status text,
  tracker_assignee text,
  tracker_due_date date,
  tracker_open_url text,
  delivered_at timestamptz,
  receipt_at timestamptz,
  origin text not null default 'slack' check (origin in ('slack', 'manual')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (delivery_status <> 'delivered' or tracker_task_id is not null)
);
create index on corporate_task_requests (delivery_status, updated_at);
