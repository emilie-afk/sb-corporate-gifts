// Database contents that do not come from the team's own work.
//
// - Baseline (every environment): the "Direct website" sales channel must exist. Its direct-customer
//   discount and corporate MOQ come from PRIVATE settings (BASELINE_DIRECT_DISCOUNT_PCT,
//   BASELINE_CORPORATE_MOQ) or are entered in the app. An existing channel is never changed.
// - Demo data (local development and tests only): fictional marketplaces and products from
//   db/seed/demo.ts, only when SEED_DEMO_DATA=1, never on a deployed runtime and never in a database
//   that already holds real data.
//
// Real operational data is never read from Git. To copy it between environments use scripts/private-data.ts.
import type pg from "pg";
import { tx, closePool } from "../server/db";
import { isDeployedRuntime } from "../server/runtime";
import { OPERATIONAL_TABLES, TRANSIENT_TABLES } from "../server/lib/operationalTables";
import { DEFAULT_MILESTONES, DEMO_PROVIDERS, DEMO_PRODUCTS, DEMO_DIRECT_TERMS } from "../db/seed/demo";

const SEED_SIGNER = "System seed";
/** Marks the automatically created Direct website row (scripts/private-data.ts may replace it while unused). */
export const BASELINE_SIGNER = "System baseline";
/** Marker of the original (pre-2026-10-23) initial data: a database carrying it holds real data. */
export const LEGACY_SEED_MARKER = "seed_initial_data";
export const DEMO_SEED_MARKER = "seed_demo_data";

const numOrNull = (v: string | undefined, min: number, max: number) => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid baseline setting value (expected ${min}–${max}).`);
  return n;
};

/** Creates the Direct website channel if it does not exist yet. Never modifies an existing channel. */
export async function ensureBaseline(c: pg.PoolClient, env: NodeJS.ProcessEnv = process.env) {
  const discount = numOrNull(env.BASELINE_DIRECT_DISCOUNT_PCT, 0, 100);
  const moq = numOrNull(env.BASELINE_CORPORATE_MOQ, 1, 1_000_000);
  await c.query(
    `insert into channels (name, type, default_discount_pct, corporate_moq, terms_updated_by, terms_updated_at)
     values ('Direct website', 'direct', $1, $2, $3, case when $1::numeric is null and $2::int is null then null else now() end)
     on conflict (name) do nothing`,
    [discount, moq, BASELINE_SIGNER],
  );
}

export function demoSeedAllowed(env: NodeJS.ProcessEnv = process.env) {
  return env.SEED_DEMO_DATA === "1" && !isDeployedRuntime(env);
}

/** Fictional demo data, once per database. Refuses on deployed runtimes and in databases with real data. */
export async function seedDemo(log = true, env: NodeJS.ProcessEnv = process.env) {
  if (!demoSeedAllowed(env)) throw new Error("Demo data is only for local development/tests (SEED_DEMO_DATA=1, not on Netlify/production).");
  const applied = await tx(async (c) => {
    await c.query("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
    await c.query("lock table schema_migrations in exclusive mode");
    if ((await c.query("select 1 from schema_migrations where version = $1", [LEGACY_SEED_MARKER])).rowCount)
      throw new Error("This database already holds real data; demo data is never added to it.");
    if ((await c.query("select 1 from schema_migrations where version = $1", [DEMO_SEED_MARKER])).rowCount) return false;
    // Every operational table must be empty (NULL-safe: a row with a NULL signer or name counts as real data). The only row allowed is the automatically created, untouched
    // Direct website channel, which the demo replaces. Anything else (products, prices, revenue, audit …) refuses.
    for (const t of [...OPERATIONAL_TABLES, ...TRANSIENT_TABLES]) {
      const n = t === "channels"
        ? (await c.query("select count(*)::int as n from channels where (name = 'Direct website' and terms_updated_by = $1 and terms_note is null) is not true", [BASELINE_SIGNER])).rows[0].n
        : (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n;
      if (n > 0) throw new Error(`This database already holds records (${t}); demo data is never added to it.`);
    }
    await c.query("delete from channels where name = 'Direct website' and terms_updated_by = $1 and terms_note is null", [BASELINE_SIGNER]);

    await c.query(
      `insert into channels (name, type, default_discount_pct, corporate_moq, terms_note, terms_updated_by, terms_updated_at)
       values ('Direct website', 'direct', $1, $2, 'Demo terms (fictional).', $3, now()) on conflict (name) do nothing`,
      [DEMO_DIRECT_TERMS.defaultDiscountPct, DEMO_DIRECT_TERMS.corporateMoq, SEED_SIGNER],
    );
    for (const p of DEMO_PROVIDERS) {
      const ch = await c.query("insert into channels (name, type) values ($1, $2) returning id", [p.name, p.providerType === "marketplace" ? "marketplace" : "sourcing"]);
      const m = await c.query(
        `insert into marketplaces (channel_id, name, provider_type, status, priority_note, initial_action, website_url, description)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ch.rows[0].id, p.name, p.providerType, p.status, p.priority, p.initialAction, p.websiteUrl, p.description],
      );
      const mid = m.rows[0].id;
      await c.query("insert into status_history (marketplace_id, from_status, to_status, reason, signer_name) values ($1, null, $2, 'Demo data', $3)", [mid, p.status, SEED_SIGNER]);
      for (const [i, title] of DEFAULT_MILESTONES.entries())
        await c.query("insert into setup_milestones (marketplace_id, title, sort_order, is_default) values ($1,$2,$3,true)", [mid, title, (i + 1) * 10]);
      for (const r of p.requirements)
        await c.query(
          `insert into requirements (marketplace_id, category, requirement, response, confirmation_state, source_ref, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
          [mid, r.category, r.requirement, r.response ?? null, r.state, r.source, SEED_SIGNER],
        );
    }
    for (const sp of DEMO_PRODUCTS) {
      for (const v of sp.variants) {
        let family: string = sp.family;
        let plants: string = "plantsIncluded" in sp ? sp.plantsIncluded : "unknown";
        let individual: string = "individual" in sp ? sp.individual : "unknown";
        let fulfillmentNote: string | null = null;
        let customization: string | null = "customizationNote" in sp ? sp.customizationNote : null;
        if (sp.family === "by_variant") {
          if (/with succulent/i.test(v.title)) {
            family = "pots_plus_succulents"; plants = "yes"; individual = "no";
            fulfillmentNote = "Complete gift (custom pots with succulents). Bulk orders only; individual recipient shipping is unavailable.";
          } else {
            family = "custom_pots"; plants = "no"; individual = "unknown";
            fulfillmentNote = "Custom pots on their own — no plants included. Also offered with succulents as a complete gift (bulk only).";
          }
          customization = "Demo: personalized pots; customization scope by quote.";
        }
        await c.query(
          `insert into products (source, shopify_product_id, shopify_variant_id, name, variant, sku, handle, product_url, web_price_cents, web_currency,
             selected, family, availability, plants_included, individual_recipient_fulfillment, fulfillment_note, customization_note, website_vendor)
           values ('shopify',$1,$2,$3,$4,$5,$6,$7,$8,'USD',true,$9,'available',$10,$11,$12,$13,'Demo Vendor')
           on conflict (shopify_variant_id) do nothing`,
          [sp.shopifyProductId, v.id, sp.name, v.title, v.sku, sp.handle, `https://example.com/demo/products/${sp.handle}?variant=${v.id}`, v.price,
            family, plants, individual, fulfillmentNote, customization],
        );
      }
    }
    await c.query(
      `insert into collection_references (name, url, note, created_by) values ('Demo collection', 'https://example.com/demo/collections/demo', 'Fictional demo collection.', $1)`,
      [SEED_SIGNER],
    );
    await c.query("insert into schema_migrations (version) values ($1)", [DEMO_SEED_MARKER]);
    return true;
  });
  if (log) console.log(applied ? "demo data applied" : "demo data already present — skipped");
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seedDemo().then(() => closePool()).catch((e) => { console.error(e instanceof Error ? e.message : "seed failed"); process.exit(1); });
}
