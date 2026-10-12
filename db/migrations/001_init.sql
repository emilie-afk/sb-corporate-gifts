-- Succulents Box corporate gifting tracker — initial schema.
-- Money: integer cents (bigint). Percentages: numeric(5,2) validated 0–100.
-- NULL always means "unknown / not entered" — never coerce to zero.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- channels
create table channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 120),
  type text not null check (type in ('direct', 'marketplace', 'sourcing')),
  active boolean not null default true,
  -- Common (channel-level) terms. Gift-specific overrides live on pricing_records.
  default_discount_pct numeric(5,2) check (default_discount_pct between 0 and 100),
  corporate_moq integer check (corporate_moq >= 1),
  payment_terms text,
  shipping_responsibility text,
  fee_note text,
  dispatch_requirement text,
  terms_note text,
  terms_updated_by text,
  terms_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

-- ------------------------------------------------------------ marketplaces
create table marketplaces (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null unique references channels(id) on delete restrict,
  name text not null unique check (length(btrim(name)) between 1 and 120),
  provider_type text not null check (provider_type in ('marketplace', 'supplier_opportunity')),
  status text not null check (status in (
    'prospect', 'reconnecting', 'preparing_application', 'in_discussion',
    'application_submitted', 'approved', 'setting_up_listings', 'live',
    'on_hold', 'rejected', 'not_qualified', 'inactive')),
  priority_note text,
  initial_action text,
  contact_name text,
  contact_email text,
  website_url text,
  portal_url text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table status_history (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  from_status text,
  to_status text not null,
  reason text,
  detail text,
  unmet_requirement text,
  what_would_change text,
  revisit_date date,
  signer_name text not null,
  auth_subject text,
  created_at timestamptz not null default now()
);
create index on status_history (marketplace_id, created_at desc);

create table setup_milestones (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  note text,
  state text not null default 'pending' check (state in ('pending', 'done', 'not_applicable')),
  completed_by text,
  completed_at timestamptz,
  completed_auth_subject text,
  not_applicable_reason text,
  sort_order integer not null default 0,
  is_default boolean not null default false,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (state <> 'not_applicable' or length(btrim(coalesce(not_applicable_reason, ''))) > 0),
  check (state = 'pending' or completed_by is not null)
);
create index on setup_milestones (marketplace_id, sort_order);

create table requirements (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  category text not null check (category in ('fulfillment', 'product', 'customization', 'pricing', 'payment', 'technical', 'other')),
  requirement text not null,
  response text,
  confirmation_state text not null default 'unverified' check (confirmation_state in ('unverified', 'awaiting_clarification', 'confirmed')),
  source_ref text,
  verified_on date,             -- research verification date (not a confirmation)
  confirmed_by text,
  confirmed_at timestamptz,
  removed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (confirmation_state <> 'confirmed' or confirmed_by is not null)
);
create index on requirements (marketplace_id);

create table communications (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  occurred_on date not null,
  signer_name text not null,
  contact_name text,
  method text not null check (method in ('email', 'call', 'meeting', 'portal', 'other')),
  summary text not null,
  reference_url text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index on communications (marketplace_id, occurred_on desc);

-- ------------------------------------------------------------- products
create table products (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'manual' check (source in ('shopify', 'manual')),
  shopify_product_id bigint,
  shopify_variant_id bigint unique,
  name text not null check (length(btrim(name)) between 1 and 300),
  variant text,
  sku text,
  handle text,
  product_url text,
  image_url text,
  website_vendor text,          -- website label only; NOT a Product Master vendor mapping
  web_price_cents bigint check (web_price_cents >= 0),   -- current retail reference (applied)
  web_currency text,
  web_availability text not null default 'unknown' check (web_availability in ('available', 'unavailable', 'unknown')),
  -- team-maintained fields (never overwritten by import)
  selected boolean not null default false,
  vendor text,
  family text check (family in ('live_to_give_box', 'succulent_arrangement', 'airplant_gift_set', 'plant_only',
                                'custom_pots', 'pots_plus_succulents', 'watering_can', 'other')),
  contents_summary text,
  availability text check (availability in ('available', 'planned', 'paused')),
  card_eligible text not null default 'unknown' check (card_eligible in ('yes', 'no', 'unknown')),
  customization_note text,
  plants_included text not null default 'unknown' check (plants_included in ('yes', 'no', 'unknown')),
  individual_recipient_fulfillment text not null default 'unknown' check (individual_recipient_fulfillment in ('yes', 'no', 'unknown')),
  fulfillment_note text,
  cost_source_note text,
  -- import metadata
  last_seen_at timestamptz,
  last_seen_run_id uuid,
  not_seen_since timestamptz,   -- set only after a complete successful import that did not include it
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (source <> 'shopify' or shopify_variant_id is not null),
  -- custom pots are pots only; pots + succulents can never be individually fulfilled
  check (family <> 'custom_pots' or plants_included <> 'yes'),
  check (family <> 'pots_plus_succulents' or individual_recipient_fulfillment <> 'yes')
);
create index on products (selected);
create index on products (lower(name));

create table collection_references (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text,
  note text,
  created_by text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table product_collections (
  product_id uuid not null references products(id) on delete restrict,
  collection_id uuid not null references collection_references(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (product_id, collection_id)
);

create table marketplace_products (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  product_id uuid not null references products(id) on delete restrict,
  proposal_status text not null default 'proposed' check (proposal_status in ('proposed', 'submitted', 'approved', 'declined', 'withdrawn')),
  offer_type text not null default 'individual' check (offer_type in ('individual', 'bulk_customized', 'bulk')),
  offer_note text,
  submitted_on date,
  listing_url text,
  approval_note text,
  created_by text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index on marketplace_products (marketplace_id);

-- ------------------------------------------------- Product Master cost sources
create table source_mappings (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  spreadsheet_id text not null check (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  vendor text not null,
  tab_name text not null,
  tab_gid text,
  header_row integer not null default 1 check (header_row >= 1),
  last_column text not null default 'ZZ' check (last_column ~ '^[A-Z]{1,3}$'),
  match_columns text[] not null check (cardinality(match_columns) between 1 and 4),
  cost_column text not null,
  cost_basis text not null check (cost_basis in ('per_piece', 'per_pack')),
  quantity_column text,
  retail_column text,
  currency text not null default 'USD' check (currency = 'USD'),
  cost_inclusions_note text,
  active boolean not null default true,
  mapping_version integer not null default 1,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table gift_source_links (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete restrict,
  source_mapping_id uuid not null references source_mappings(id) on delete restrict,
  match_values jsonb not null,          -- {"<match column header>": "<exact value>"}
  component_label text,                 -- for composite gifts: one link per distinct component
  quantity_per_gift integer check (quantity_per_gift >= 1),  -- explicit, team-confirmed
  note text,
  removed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index on gift_source_links (product_id);

create table import_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('shopify', 'product_master')),
  status text not null check (status in ('fetching', 'previewed', 'confirmed', 'no_change', 'failed', 'discarded')),
  complete boolean not null default false,
  next_page integer,
  pages_fetched integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  preview jsonb,
  started_by text not null,
  started_auth_subject text,
  confirmed_by text,
  confirmed_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  version integer not null default 1
);
create index on import_runs (kind, started_at desc);

create table import_run_items (
  run_id uuid not null references import_runs(id) on delete cascade,
  page integer not null,
  items jsonb not null,
  primary key (run_id, page)
);

create table cost_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete restrict,
  import_run_id uuid references import_runs(id) on delete restrict,
  gift_cost_cents bigint not null check (gift_cost_cents >= 0),
  gift_cost_exact numeric(14,4) not null,
  detail jsonb not null,   -- per component: source cost, basis, quantity, calc, identifiers, vendor/tab, mapping version, row locator
  confirmed_by text not null,
  auth_subject text,
  created_at timestamptz not null default now()
);
create index on cost_snapshots (product_id, created_at desc);

-- -------------------------------------------------------------- pricing
create table pricing_records (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete restrict,
  product_id uuid not null references products(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'proposed', 'agreed', 'active', 'expired')),
  currency text not null default 'USD' check (currency = 'USD'),
  retail_ref_cents bigint check (retail_ref_cents >= 0),
  internal_cost_cents bigint check (internal_cost_cents >= 0),
  cost_inclusions_note text,
  customer_discount_pct numeric(5,2) check (customer_discount_pct between 0 and 100),
  proposed_supplier_cents bigint check (proposed_supplier_cents >= 0),
  agreed_price_cents bigint check (agreed_price_cents >= 0),
  customer_shipping_cents bigint check (customer_shipping_cents >= 0),
  expected_shipping_cents bigint check (expected_shipping_cents >= 0),
  extra_cost_cents bigint check (extra_cost_cents >= 0),   -- card / handling / customization
  commission_pct numeric(5,2) check (commission_pct between 0 and 100),
  fixed_fee_cents bigint check (fixed_fee_cents >= 0),
  pricing_basis_note text,
  moq integer check (moq >= 1),
  fulfillment_format text not null check (fulfillment_format in ('individual', 'corporate_separate_addresses', 'bulk_one_location', 'bulk_multiple_shipments')),
  shipping_responsibility text,     -- gift-specific override of channel common terms
  payment_terms text,
  dispatch_requirement text,
  agreement_notes text,
  effective_from date,
  effective_to date,
  evidence_ref text,
  entered_by text not null,
  entered_auth_subject text,
  approved_by text,
  approved_at timestamptz,
  previous_record_id uuid references pricing_records(id) on delete restrict,
  superseded_by_id uuid references pricing_records(id) on delete restrict,
  -- snapshots taken when the record becomes agreed/active
  cost_snapshot_id uuid references cost_snapshots(id) on delete restrict,
  snapshot_cost_cents bigint,
  snapshot_retail_cents bigint,
  terms_snapshot jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (status not in ('agreed', 'active') or agreed_price_cents is not null),
  check (status <> 'active' or (effective_from is not null and approved_by is not null)),
  exclude using gist (
    channel_id with =, product_id with =, fulfillment_format with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (status = 'active')
);
create index on pricing_records (channel_id, product_id);

-- Agreed / active / expired versions are immutable business records.
-- Only lifecycle columns may change (status, effective dates when previously null,
-- effective_to when superseded, superseded_by_id, approval, snapshots on activation).
create or replace function pricing_records_guard() returns trigger as $$
declare fam text;
begin
  select family into fam from products where id = new.product_id;
  if fam = 'pots_plus_succulents' and new.fulfillment_format in ('individual', 'corporate_separate_addresses') then
    raise exception 'pots_plus_succulents_bulk_only' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.status in ('agreed', 'active', 'expired') then
    if (new.channel_id, new.product_id, new.currency, new.retail_ref_cents, new.internal_cost_cents,
        new.customer_discount_pct, new.proposed_supplier_cents, new.agreed_price_cents,
        new.customer_shipping_cents, new.expected_shipping_cents, new.extra_cost_cents,
        new.commission_pct, new.fixed_fee_cents, new.moq, new.fulfillment_format,
        new.shipping_responsibility, new.payment_terms, new.dispatch_requirement,
        new.pricing_basis_note, new.agreement_notes, new.evidence_ref, new.entered_by,
        new.previous_record_id, new.cost_inclusions_note)
       is distinct from
       (old.channel_id, old.product_id, old.currency, old.retail_ref_cents, old.internal_cost_cents,
        old.customer_discount_pct, old.proposed_supplier_cents, old.agreed_price_cents,
        old.customer_shipping_cents, old.expected_shipping_cents, old.extra_cost_cents,
        old.commission_pct, old.fixed_fee_cents, old.moq, old.fulfillment_format,
        old.shipping_responsibility, old.payment_terms, old.dispatch_requirement,
        old.pricing_basis_note, old.agreement_notes, old.evidence_ref, old.entered_by,
        old.previous_record_id, old.cost_inclusions_note) then
      raise exception 'pricing_record_immutable' using errcode = '23514';
    end if;
    if old.status = 'expired' and new.status <> 'expired' then
      raise exception 'pricing_record_immutable' using errcode = '23514';
    end if;
    if old.effective_from is not null and new.effective_from is distinct from old.effective_from then
      raise exception 'pricing_record_immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end $$ language plpgsql;

create trigger pricing_records_guard before insert or update on pricing_records
  for each row execute function pricing_records_guard();

-- ------------------------------------------------------------- revenue
create table monthly_revenue (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete restrict,
  reporting_month date not null check (extract(day from reporting_month) = 1),
  order_count integer check (order_count >= 0),
  units_sold integer check (units_sold >= 0),
  gift_sales_cents bigint check (gift_sales_cents >= 0),
  shipping_revenue_cents bigint check (shipping_revenue_cents >= 0),
  refunds_cents bigint check (refunds_cents >= 0),
  marketplace_fees_cents bigint check (marketplace_fees_cents >= 0),
  payment_received_cents bigint check (payment_received_cents >= 0),
  notes text,
  recorded_by text not null,
  auth_subject text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (channel_id, reporting_month)
);

-- --------------------------------------------------------------- audit
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  marketplace_id uuid,
  action text not null,
  before jsonb,
  after jsonb,
  signer_name text not null,
  auth_subject text,
  created_at timestamptz not null default now()
);
create index on audit_events (entity_type, entity_id, created_at desc);
create index on audit_events (marketplace_id, created_at desc);
