-- 010 — Partners.
-- Marketplaces and researched companies are managed as Partners: companies that buy, sell, promote or distribute
-- Succulents Box gifts. Product vendors (vendors table) are unchanged.
--
-- ADDITIVE ONLY. The table and API names (marketplaces, /api/marketplaces) and every record ID stay the same, so
-- pricing, revenue attribution, Partner Resources, Slack matching, task links and bookmarked URLs keep working.
-- Existing statuses are all kept. Two new stages are added: 'contacted' and 'skipped'. Display labels group the
-- stages ("Live" shows as Active, "Rejected" as Declined, …) without changing the stored value.
-- Rollback: db/rollback/010_partners.down.sql (see docs/PARTNERS_MIGRATION.md).

-- ------------------------------------------------------------------ stages
alter table marketplaces drop constraint if exists marketplaces_status_check;
alter table marketplaces add constraint marketplaces_status_check check (status in (
  'prospect', 'contacted', 'reconnecting', 'preparing_application', 'in_discussion',
  'application_submitted', 'approved', 'setting_up_listings', 'live',
  'on_hold', 'rejected', 'not_qualified', 'skipped', 'inactive'));

-- ------------------------------------------------------------ classification
-- One primary category. Existing records start as 'uncategorized'; they are categorised with the bulk update (with
-- preview) or by an import that fills empty fields only.
alter table marketplaces add column category text not null default 'uncategorized' check (category in (
  'corporate_gifting_platforms', 'retail_marketplaces', 'employee_recognition', 'events_promo',
  'weddings_registries', 'real_estate_mortgage', 'relocation_resident', 'sympathy_memorial',
  'veterinary_pet_memorial', 'healthcare_hospital_retail', 'caregiving_community', 'direct_corporate_buyers',
  'uncategorized'));
-- How SB would work with the partner (several allowed). Separate from the pricing model on each price.
alter table marketplaces add column channel_models text[] not null default '{}' check (channel_models <@ array[
  'catalog_dropship', 'wholesale', 'direct_purchasing', 'referral', 'employee_discount', 'vendor_directory', 'integration']::text[]);
alter table marketplaces add column occasion_tags text[] not null default '{}' check (occasion_tags <@ array[
  'employee_onboarding', 'employee_appreciation', 'work_anniversary', 'client_appreciation', 'closing_housewarming',
  'resident_welcome_renewal', 'sympathy_memorial', 'get_well', 'new_baby', 'events_conferences', 'wedding_favors',
  'holiday_gifting', 'other']::text[]);
-- Priority is independent of the stage: an active partner keeps its stage whatever priority it has.
alter table marketplaces add column priority text not null default 'not_assessed' check (priority in ('a', 'b', 'c', 'not_assessed'));
-- Research readiness (who to reach), separate from relationship progress. NULL = not recorded.
alter table marketplaces add column research_state text check (research_state in (
  'not_researched', 'route_published', 'contact_needed', 'responsible_not_identified', 'verify_contact', 'contact_identified', 'no_contact_needed'));
alter table marketplaces add column parent_company text check (parent_company is null or length(parent_company) <= 500);
alter table marketplaces add column opportunity_summary text check (opportunity_summary is null or length(opportunity_summary) <= 4000);
alter table marketplaces add column next_action text check (next_action is null or length(next_action) <= 2000);
alter table marketplaces add column next_action_due date;
alter table marketplaces add column contact_next_step text check (contact_next_step is null or length(contact_next_step) <= 2000);
alter table marketplaces add column owner text check (owner is null or length(owner) <= 80);

-- Priority is migrated only from an explicit priority label in the existing note: "Priority A", "Priority: B",
-- "priority - C" (the word "priority" followed by a single letter). A note that merely begins with A, B or C, or any
-- other wording ("First new application", "Secondary"…), stays 'not_assessed' and keeps its note.
update marketplaces set priority = lower(substring(priority_note from '(?i)\mpriority\s*[:=-]?\s*([abc])(?![a-z0-9])'))
 where priority_note ~* '\mpriority\s*[:=-]?\s*[abc](?![a-z0-9])';

create index on marketplaces (priority, status);
create index on marketplaces (category);
create index on marketplaces (next_action_due);

-- ------------------------------------------------------------------ contacts
-- People connected with one partner opportunity. "Responsible person not identified" and "Not researched" are
-- research states (marketplaces.research_state), never names, so name is required here.
create table partner_contacts (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  title text check (title is null or length(title) <= 500),
  company text check (company is null or length(company) <= 200),
  role text not null check (role in ('supplier_sourcing', 'relevant_partnerships', 'routing', 'customer_sales', 'support',
    'press', 'advertising_only', 'historical', 'executive_fallback')),
  rank text not null default 'other' check (rank in ('primary', 'backup', 'other')),
  email text check (email is null or length(email) <= 200),        -- published business email only
  phone text check (phone is null or length(phone) <= 80),         -- published business phone only
  profile_url text check (profile_url is null or length(profile_url) <= 1000),
  source_urls text[] not null default '{}' check (cardinality(source_urls) <= 12),
  checked_on date,
  role_verification text not null default 'needs_verification' check (role_verification in ('current_verified', 'needs_verification', 'historical', 'former')),
  confidence text check (confidence in ('high', 'medium', 'low')),
  note text check (note is null or length(note) <= 2000),          -- why this person fits, limitations
  source_key text,                                                 -- stable key for repeatable imports
  import_batch_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  version integer not null default 1
);
create index on partner_contacts (marketplace_id) where removed_at is null;
create unique index partner_contacts_source_key on partner_contacts (marketplace_id, source_key) where source_key is not null;

-- Published contact routes and applications (forms, portals, inboxes), stored apart from people.
create table partner_applications (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete restrict,
  purpose text not null check (purpose in ('supplier_application', 'partnership', 'self_serve_app', 'general_contact',
    'customer_sales', 'support', 'press', 'portal_admin', 'other')),
  label text check (label is null or length(label) <= 200),
  url text check (url is null or length(url) <= 1000),
  detail text check (detail is null or length(detail) <= 2000),     -- the route as published (form, inbox, phone)
  verification text check (verification is null or length(verification) <= 2000),
  checked_on date,
  source_key text,
  import_batch_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  version integer not null default 1
);
create index on partner_applications (marketplace_id) where removed_at is null;
create unique index partner_applications_source_key on partner_applications (marketplace_id, source_key) where source_key is not null;

-- -------------------------------------------------------- requirements & terms
-- kind keeps published requirements, negotiated terms, expected ordering patterns (assumptions), open questions and
-- SB capability notes apart. Existing rows become 'published' (their confirmation state is unchanged).
alter table requirements add column kind text not null default 'published' check (kind in
  ('published', 'negotiated', 'ordering_assumption', 'open_question', 'sb_capability'));
alter table requirements add column applicability text check (applicability is null or length(applicability) <= 500);
alter table requirements add column sb_readiness text check (sb_readiness in ('meets', 'needs_confirmation', 'cannot_meet', 'not_applicable'));
alter table requirements add column verification text check (verification is null or length(verification) <= 2000);
alter table requirements add column import_batch_id uuid;

-- ------------------------------------------------------------- import batches
-- Each partner import is recorded so it can be audited and reversed. Rows keep the parsed source row (private data
-- lives only in the database, never in Git).
create table partner_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (length(source_name) between 1 and 200),
  source_hash text not null,
  row_count integer not null,
  status text not null default 'applied' check (status in ('applied', 'reversed')),
  summary jsonb not null default '{}',
  created_by text not null,
  auth_subject text,
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by text
);

create table partner_import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references partner_import_batches(id) on delete restrict,
  line integer not null,
  company text not null,
  outcome text not null check (outcome in ('new', 'existing_match', 'possible_duplicate', 'conflict', 'skipped_by_decision', 'invalid', 'not_imported')),
  marketplace_id uuid references marketplaces(id) on delete restrict,
  created_partner boolean not null default false,
  field_changes jsonb not null default '[]',   -- [{field, before, after}] filled by this batch
  created_rows jsonb not null default '{}',    -- {contacts:[ids], applications:[ids], requirements:[ids]}
  conflicts jsonb not null default '[]',
  decision jsonb,
  row_data jsonb not null,
  post_import_version integer,                  -- partner version right after this import (reversal guard)
  created_at timestamptz not null default now()
);
create index on partner_import_items (batch_id, line);
create index on partner_import_items (marketplace_id);

alter table partner_contacts add constraint partner_contacts_batch_fk foreign key (import_batch_id) references partner_import_batches(id) on delete restrict;
alter table partner_applications add constraint partner_applications_batch_fk foreign key (import_batch_id) references partner_import_batches(id) on delete restrict;
alter table requirements add constraint requirements_batch_fk foreign key (import_batch_id) references partner_import_batches(id) on delete restrict;
