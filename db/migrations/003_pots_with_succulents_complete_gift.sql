-- Team clarification: custom pots are available on their own or with succulents as a complete gift.
-- Pots with succulents are available for bulk orders only; individual recipient shipping is unavailable.
-- Data-only update of rows still holding the original seed values; anything the team already edited is left alone.

with old_note as (
  select 'Bulk only, delivered in multiple shipments. No individual recipient fulfillment by SB. Packing/assembly details not confirmed.'::text as v
), changed as (
  update products p
     set availability = coalesce(p.availability, 'available'),
         fulfillment_note = case when p.fulfillment_note is not distinct from (select v from old_note)
                                 then 'Complete gift (custom pots with succulents). Bulk orders only; individual recipient shipping is unavailable.'
                                 else p.fulfillment_note end,
         individual_recipient_fulfillment = 'no',
         updated_at = now(),
         version = p.version + 1
   where p.family = 'pots_plus_succulents'
     and (p.availability is null
          or p.fulfillment_note is not distinct from (select v from old_note)
          or p.individual_recipient_fulfillment <> 'no')
  returning p.id,
            (select jsonb_build_object('availability', o.availability, 'fulfillment_note', o.fulfillment_note,
                                       'individual_recipient_fulfillment', o.individual_recipient_fulfillment)
               from products o where o.id = p.id) as before_row,  -- pre-update snapshot
            p.availability, p.fulfillment_note, p.individual_recipient_fulfillment
)
insert into audit_events (entity_type, entity_id, action, before, after, signer_name)
select 'product', id, 'update', before_row,
       jsonb_build_object('availability', availability, 'fulfillment_note', fulfillment_note,
                          'individual_recipient_fulfillment', individual_recipient_fulfillment,
                          'reason', 'Team clarification: pots with succulents are a complete gift, bulk orders only'),
       'System migration'
  from changed;

update products
   set fulfillment_note = 'Custom pots on their own — no plants included. Also offered with succulents as a complete gift (bulk only).',
       updated_at = now(), version = version + 1
 where family = 'custom_pots' and fulfillment_note = 'Custom pots only — no plants included.';
