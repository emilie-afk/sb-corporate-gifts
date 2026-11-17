-- Supplier Resources and the Slack-to-Corporate Gifts workflow.
-- Additive only: new tables plus two nullable columns on requirements and communications. No existing row changes.
--
-- "Supplier" = an existing partner record (marketplaces: marketplace or supplier opportunity) OR a product vendor
-- (new vendors table; vendors already appear by name on gifts and cost sources). Every resource, sample and action
-- links to exactly one of them by ID, or to none where noted.

-- ------------------------------------------------------------------ vendors
create table vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  website_url text,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index vendors_name_key on vendors (lower(btrim(name)));

-- --------------------------------------- open actions, blockers and general decisions
create table corporate_actions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('action', 'blocker', 'decision')),
  title text not null check (length(btrim(title)) between 1 and 300),
  note text,
  owner text,
  due_date date,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  marketplace_id uuid references marketplaces(id) on delete restrict,
  vendor_id uuid references vendors(id) on delete restrict,
  requirement_id uuid references requirements(id) on delete restrict,
  source_url text,
  origin text not null default 'manual' check (origin in ('manual', 'slack')),
  finding_key text unique,
  closed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (marketplace_id is null or vendor_id is null)
);
create index on corporate_actions (status, due_date);

-- ---------------------------------------------------------- supplier resources
create table supplier_resources (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid references marketplaces(id) on delete restrict,
  vendor_id uuid references vendors(id) on delete restrict,
  section text not null check (section in ('catalogs_pricing', 'gift_terms', 'assets_documents', 'decisions_followups')),
  resource_type text not null check (resource_type in (
    'catalog', 'availability_list', 'quote', 'price_sheet',
    'sample_option', 'minimum_quantity', 'customization', 'lead_time', 'shipping_method', 'order_cutoff', 'other_term',
    'product_photos', 'logo', 'packaging_guide', 'proof', 'order_form', 'other_document',
    'decision', 'follow_up')),
  title text not null check (length(btrim(title)) between 1 and 200),
  link_url text,
  note text,
  source_url text,                 -- supporting message link (private)
  effective_date date,             -- only when explicitly stated
  last_confirmed_on date,
  series_key text,                 -- versions of the same resource (e.g. one price sheet) share a series
  status text not null default 'current' check (status in ('current', 'superseded')),
  superseded_by uuid references supplier_resources(id) on delete restrict,
  superseded_at timestamptz,
  requirement_id uuid references requirements(id) on delete restrict,
  action_id uuid references corporate_actions(id) on delete restrict,
  origin text not null default 'manual' check (origin in ('manual', 'slack')),
  finding_key text unique,
  removed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check ((marketplace_id is null) <> (vendor_id is null)),
  check (status = 'current' or superseded_at is not null)
);
create index on supplier_resources (marketplace_id, section, status);
create index on supplier_resources (vendor_id, section, status);

-- ------------------------------------------------------------- sample boxes
-- Workflow status of sample requests (prospects or partner platforms). Separate from the Google Form signup
-- count, which is read from the form's sheet and never changed by this table. No contact details are stored.
create table sample_requests (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) between 1 and 200),
  marketplace_id uuid references marketplaces(id) on delete restrict,
  vendor_id uuid references vendors(id) on delete restrict,
  status text not null check (status in ('requested', 'approved', 'shipped', 'delivered', 'cancelled')),
  status_on date,
  note text,
  source_url text,
  origin text not null default 'manual' check (origin in ('manual', 'slack')),
  finding_key text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (marketplace_id is null or vendor_id is null)
);

-- Existing records can be matched to Slack findings (retries and cross-channel duplicates update the same row).
alter table requirements add column finding_key text unique;
alter table communications add column finding_key text unique;

-- --------------------------------------------------------- review queue
create table review_items (
  id uuid primary key default gen_random_uuid(),
  finding_key text not null unique,
  kind text not null,
  title text not null,
  summary text,
  question text not null,
  supplier_hint text,
  sources jsonb not null default '[]',
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index on review_items (status, created_at desc);

-- ------------------------------------------------------ Slack scan bookkeeping
-- One row per channel (separate progress). position_ts advances only after a pass is saved.
create table slack_scan_state (
  channel_key text primary key check (channel_key in ('seo', 'teammarketing')),
  position_ts text,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  last_counts jsonb
);
insert into slack_scan_state (channel_key) values ('seo'), ('teammarketing');

-- Every finding ever applied, keyed by its stable event key, with the target it updated and all supporting messages.
create table slack_findings (
  key text primary key,
  kind text not null,
  content_hash text not null,
  target_type text not null,
  target_id uuid,
  sources jsonb not null default '[]',
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Messages examined per channel (identifiers only), so retries and edits are recognised.
create table slack_messages (
  channel_key text not null check (channel_key in ('seo', 'teammarketing')),
  ts text not null,
  thread_ts text,
  edited_ts text,
  finding_keys text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (channel_key, ts)
);
