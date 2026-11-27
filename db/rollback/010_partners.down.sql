-- Rollback for 010_partners.sql. Run by hand, in one transaction, ONLY after a private export (npm run private:export)
-- and only together with deploying the previous app version. See docs/PARTNERS_MIGRATION.md.
--
-- It refuses to run while any partner is in a stage the previous version does not know ('contacted', 'skipped'):
-- move those records to a known stage first (the guard lists them), so nothing is discarded silently.
-- Dropping the new tables and columns removes Partner contacts, routes, categories, priorities and import batches;
-- the private export taken beforehand is the copy of that data.
begin;

do $$
declare n int; names text;
begin
  select count(*), string_agg(name, ', ' order by name) into n, names from marketplaces where status in ('contacted', 'skipped');
  if n > 0 then
    raise exception 'Rollback stopped: % partner(s) use the new stages contacted/skipped: %. Change their stage first.', n, names;
  end if;
end $$;

alter table requirements drop constraint if exists requirements_batch_fk;
alter table requirements drop column if exists import_batch_id;
alter table requirements drop column if exists verification;
alter table requirements drop column if exists sb_readiness;
alter table requirements drop column if exists applicability;
alter table requirements drop column if exists kind;

drop table if exists partner_applications;
drop table if exists partner_contacts;
drop table if exists partner_import_items;
drop table if exists partner_import_batches;

alter table marketplaces drop column if exists owner;
alter table marketplaces drop column if exists contact_next_step;
alter table marketplaces drop column if exists next_action_due;
alter table marketplaces drop column if exists next_action;
alter table marketplaces drop column if exists opportunity_summary;
alter table marketplaces drop column if exists parent_company;
alter table marketplaces drop column if exists research_state;
alter table marketplaces drop column if exists priority;
alter table marketplaces drop column if exists occasion_tags;
alter table marketplaces drop column if exists channel_models;
alter table marketplaces drop column if exists category;

alter table marketplaces drop constraint if exists marketplaces_status_check;
alter table marketplaces add constraint marketplaces_status_check check (status in (
  'prospect', 'reconnecting', 'preparing_application', 'in_discussion',
  'application_submitted', 'approved', 'setting_up_listings', 'live',
  'on_hold', 'rejected', 'not_qualified', 'inactive'));

delete from schema_migrations where version = '010_partners.sql';
commit;
