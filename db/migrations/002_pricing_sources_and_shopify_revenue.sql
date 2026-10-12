-- 002: source-backed pricing references, Excel pricing import, Shopify-derived revenue.
-- Additive only: existing rows keep their values; nothing is backfilled or recalculated.

-- ------------------------------------------------- pricing reference sources
alter table pricing_records
  add column retail_source text check (retail_source in ('shopify', 'manual')),
  add column retail_source_detail jsonb,
  add column cost_source text check (cost_source in ('product_master', 'manual')),
  add column cost_source_detail jsonb,
  add column import_batch_id uuid,
  add column import_row_ref text;

-- A manual reference value must say why and where it came from.
alter table pricing_records add constraint pricing_manual_retail_reason check (
  retail_source is distinct from 'manual'
  or (retail_ref_cents is not null and length(btrim(coalesce(retail_source_detail->>'reason', ''))) > 0
      and length(btrim(coalesce(retail_source_detail->>'source', ''))) > 0));
alter table pricing_records add constraint pricing_manual_cost_reason check (
  cost_source is distinct from 'manual'
  or (internal_cost_cents is not null and length(btrim(coalesce(cost_source_detail->>'reason', ''))) > 0
      and length(btrim(coalesce(cost_source_detail->>'source', ''))) > 0));

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
        new.previous_record_id, new.cost_inclusions_note,
        new.retail_source, new.retail_source_detail, new.cost_source, new.cost_source_detail,
        new.import_batch_id, new.import_row_ref)
       is distinct from
       (old.channel_id, old.product_id, old.currency, old.retail_ref_cents, old.internal_cost_cents,
        old.customer_discount_pct, old.proposed_supplier_cents, old.agreed_price_cents,
        old.customer_shipping_cents, old.expected_shipping_cents, old.extra_cost_cents,
        old.commission_pct, old.fixed_fee_cents, old.moq, old.fulfillment_format,
        old.shipping_responsibility, old.payment_terms, old.dispatch_requirement,
        old.pricing_basis_note, old.agreement_notes, old.evidence_ref, old.entered_by,
        old.previous_record_id, old.cost_inclusions_note,
        old.retail_source, old.retail_source_detail, old.cost_source, old.cost_source_detail,
        old.import_batch_id, old.import_row_ref) then
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

-- ------------------------------------------------------ Excel pricing import
-- The original workbook is NOT stored: only parsed plain values, validation results and metadata.
create table pricing_import_batches (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  file_sha256 text not null,
  file_size integer not null,
  sheet_name text,
  column_mapping jsonb not null,
  rows jsonb not null,
  summary jsonb not null default '{}'::jsonb,
  status text not null default 'previewed' check (status in ('previewed', 'confirmed', 'discarded')),
  previewed_by text not null,
  auth_subject text,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
alter table pricing_records add constraint pricing_records_import_batch_fk
  foreign key (import_batch_id) references pricing_import_batches(id) on delete restrict;
create index on pricing_records (import_batch_id);

-- ----------------------------------------------------- Shopify revenue import
create table shopify_import_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('collector', 'manual')),
  file_name text,
  payload_sha256 text not null,
  exported_at timestamptz not null,
  chronology text not null check (chronology in ('reported', 'declared')),
  coverage_from date not null,
  coverage_to date not null,
  available_fields text[] not null default '{}',
  status text not null check (status in ('processing', 'completed', 'no_change', 'duplicate', 'failed')),
  duplicate_of uuid references shopify_import_runs(id),
  orders_received integer not null default 0,
  orders_new integer not null default 0,
  orders_updated integer not null default 0,
  orders_unchanged integer not null default 0,
  orders_stale integer not null default 0,
  orders_rejected integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  signer_name text not null,
  auth_subject text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (coverage_to >= coverage_from)
);
create index on shopify_import_runs (payload_sha256);
create index on shopify_import_runs (started_at desc);

create table shopify_orders (
  id uuid primary key default gen_random_uuid(),
  store text not null,
  order_key text not null,                 -- Shopify order Name (#1234): present in every export; unique per store
  order_id text,
  order_name text not null,
  created_at_raw text not null,
  created_at timestamptz not null,
  order_date date not null,                -- America/Los_Angeles business date
  order_month date not null check (extract(day from order_month) = 1),
  financial_status text,
  cancelled_at_raw text,
  currency text,
  subtotal_cents bigint,
  shipping_cents bigint,
  taxes_cents bigint,
  duties_cents bigint,
  total_cents bigint,
  discount_cents bigint,
  refunded_cents bigint,
  excluded_lines_cents bigint not null default 0,
  gift_sales_cents bigint not null,
  refund_applied_cents bigint not null default 0,
  net_revenue_cents bigint not null,
  units integer not null default 0,
  revenue_status text not null check (revenue_status in ('counted', 'cancelled', 'voided')),
  awaiting_payment boolean not null default false,
  warnings text[] not null default '{}',
  match_fields jsonb not null default '{}'::jsonb,
  lines jsonb not null default '[]'::jsonb,
  content_hash text not null,
  snapshot_at timestamptz not null,
  chronology text not null,
  first_import_id uuid not null references shopify_import_runs(id),
  last_import_id uuid not null references shopify_import_runs(id),
  rule_channel_id uuid references channels(id),
  rule_status text not null default 'unclassified' check (rule_status in ('assigned', 'unclassified', 'conflict')),
  rule_conflict_channel_ids uuid[] not null default '{}',
  manual_state text check (manual_state in ('assigned', 'excluded')),
  manual_channel_id uuid references channels(id),
  manual_reason text,
  manual_by text,
  manual_at timestamptz,
  created_at_row timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (store, order_key),
  check (manual_state is distinct from 'assigned' or manual_channel_id is not null),
  check (manual_state is null or length(btrim(coalesce(manual_reason, ''))) > 0)
);
create index on shopify_orders (order_month);
create index on shopify_orders (rule_status);

create view shopify_orders_effective as
  select o.*,
    case when o.manual_state = 'excluded' then 'excluded'
         when o.manual_state = 'assigned' then 'assigned'
         else o.rule_status end as class_status,
    case when o.manual_state = 'excluded' then null
         when o.manual_state = 'assigned' then o.manual_channel_id
         when o.rule_status = 'assigned' then o.rule_channel_id
         else null end as channel_id,
    (o.manual_state is not null) as class_manual
  from shopify_orders o;

create table match_rules (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete restrict,
  source_field text not null check (source_field in ('source', 'tags', 'billing_company')),
  operator text not null check (operator in ('equals', 'contains')),
  match_value text not null check (length(btrim(match_value)) between 1 and 200),
  enabled boolean not null default true,
  note text,
  entered_by text not null,
  auth_subject text,
  updated_by text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

-- ------------------------------------------------ manual revenue / reconciliation
alter table monthly_revenue
  add column reconciliation text not null default 'needs_review'
    check (reconciliation in ('needs_review', 'additional', 'covered_by_shopify')),
  add column reconciliation_note text,
  add column reconciled_by text,
  add column reconciled_at timestamptz;

create table revenue_adjustments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete restrict,
  reporting_month date not null check (extract(day from reporting_month) = 1),
  kind text not null check (kind in ('off_shopify_sale', 'correction', 'fee')),
  order_count integer check (order_count >= 0),
  units_sold integer check (units_sold >= 0),
  gift_sales_cents bigint,
  shipping_revenue_cents bigint,
  refunds_cents bigint,
  marketplace_fees_cents bigint,
  reason text not null check (length(btrim(reason)) > 0),
  reference text not null check (length(btrim(reference)) > 0),
  entry_date date not null,
  signer_name text not null,
  auth_subject text,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  -- sales cannot be negative; corrections may be (explicit negative adjustment)
  check (kind = 'correction' or (coalesce(gift_sales_cents, 0) >= 0 and coalesce(shipping_revenue_cents, 0) >= 0 and coalesce(refunds_cents, 0) >= 0)),
  check (marketplace_fees_cents is null or kind = 'correction' or marketplace_fees_cents >= 0),
  check (kind <> 'fee' or marketplace_fees_cents is not null),
  check (kind = 'fee' or gift_sales_cents is not null or shipping_revenue_cents is not null or refunds_cents is not null)
);
create unique index revenue_adjustments_no_dup on revenue_adjustments (channel_id, reporting_month, kind, lower(btrim(reference))) where voided_at is null;
