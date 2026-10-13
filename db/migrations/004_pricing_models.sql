-- 004: explicit pricing models (fixed supplier price / commission-based / other-custom / direct sale).
-- Additive only. Existing records keep pricing_model = null and are shown as "Model not specified";
-- nothing is backfilled or reinterpreted.

alter table pricing_records
  add column pricing_model text check (pricing_model in ('fixed_supplier', 'commission', 'custom', 'direct')),
  add column supplier_price_cents bigint check (supplier_price_cents >= 0),   -- what SB receives per gift (fixed model)
  add column selling_price_cents bigint check (selling_price_cents >= 0),     -- what the marketplace's customer pays
  add column commission_basis text check (commission_basis in ('selling_price', 'retail_price', 'other')),
  add column commission_basis_note text,
  add column custom_terms text;

-- A fixed supplier price is already what SB receives: no marketplace commission or fee is deducted again.
alter table pricing_records add constraint pricing_fixed_no_deduction check (
  pricing_model is distinct from 'fixed_supplier'
  or (commission_pct is null and fixed_fee_cents is null and commission_basis is null));
-- Commission fields only belong to commission-based (or custom, informational) arrangements.
alter table pricing_records add constraint pricing_basis_only_commission check (
  commission_basis is null or pricing_model in ('commission', 'custom'));
alter table pricing_records add constraint pricing_basis_other_note check (
  commission_basis is distinct from 'other' or length(btrim(coalesce(commission_basis_note, ''))) > 0);
-- The headline agreed price is the model's own price, never a different column.
alter table pricing_records add constraint pricing_agreed_matches_model check (
  agreed_price_cents is null
  or (pricing_model = 'fixed_supplier' and agreed_price_cents = supplier_price_cents)
  or (pricing_model = 'commission' and agreed_price_cents = selling_price_cents)
  or pricing_model is null or pricing_model in ('custom', 'direct'));
alter table pricing_records add constraint pricing_custom_terms check (
  pricing_model is distinct from 'custom' or status not in ('agreed', 'active') or length(btrim(coalesce(custom_terms, ''))) > 0);

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
        new.import_batch_id, new.import_row_ref,
        new.pricing_model, new.supplier_price_cents, new.selling_price_cents,
        new.commission_basis, new.commission_basis_note, new.custom_terms)
       is distinct from
       (old.channel_id, old.product_id, old.currency, old.retail_ref_cents, old.internal_cost_cents,
        old.customer_discount_pct, old.proposed_supplier_cents, old.agreed_price_cents,
        old.customer_shipping_cents, old.expected_shipping_cents, old.extra_cost_cents,
        old.commission_pct, old.fixed_fee_cents, old.moq, old.fulfillment_format,
        old.shipping_responsibility, old.payment_terms, old.dispatch_requirement,
        old.pricing_basis_note, old.agreement_notes, old.evidence_ref, old.entered_by,
        old.previous_record_id, old.cost_inclusions_note,
        old.retail_source, old.retail_source_detail, old.cost_source, old.cost_source_detail,
        old.import_batch_id, old.import_row_ref,
        old.pricing_model, old.supplier_price_cents, old.selling_price_cents,
        old.commission_basis, old.commission_basis_note, old.custom_terms) then
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

-- Import files: .xlsx or .csv, chosen worksheet and header row, file-level defaults (channel, model …).
alter table pricing_import_batches
  add column file_kind text not null default 'xlsx' check (file_kind in ('xlsx', 'csv')),
  add column settings jsonb not null default '{}'::jsonb;
