// Reproducible, idempotent seed. Usage: DATABASE_URL=... npm run db:seed
import { tx, closePool } from "../server/db";
import { DEFAULT_MILESTONES, PROVIDERS, SEED_PRODUCTS } from "../db/seed/providers";

const SEED_SIGNER = "System seed";

export async function seed(log = true) {
  await tx(async (c) => {
    // Direct website: a sales channel, not a marketplace record (no setup checklist).
    await c.query(
      `insert into channels (name, type, default_discount_pct, corporate_moq, terms_note, terms_updated_by, terms_updated_at)
       values ('Direct website', 'direct', 20, 10, $1, $2, now())
       on conflict (name) do nothing`,
      [
        "Internal terms: direct corporate customers currently get 20% off retail. Corporate orders start at 10 gifts. " +
          "Standard individual gifts keep their own ordering context — MOQ 10 is not a blanket restriction.",
        SEED_SIGNER,
      ],
    );

    for (const p of PROVIDERS) {
      const exists = await c.query("select 1 from marketplaces where name = $1", [p.name]);
      if (exists.rowCount) continue;
      const ch = await c.query(
        "insert into channels (name, type) values ($1, $2) returning id",
        [p.name, p.providerType === "marketplace" ? "marketplace" : "sourcing"],
      );
      const description =
        `Initial proposed gifts (examples only — not proof of acceptance, stock or approved terms): ${p.proposedGifts}` +
        (p.routeNote ? `\n${p.routeNote}` : "");
      const m = await c.query(
        `insert into marketplaces (channel_id, name, provider_type, status, priority_note, initial_action, website_url, description)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ch.rows[0].id, p.name, p.providerType, p.status, p.priority, p.initialAction, p.websiteUrl, description],
      );
      const mid = m.rows[0].id;
      await c.query(
        "insert into status_history (marketplace_id, from_status, to_status, reason, signer_name) values ($1, null, $2, 'Initial seed', $3)",
        [mid, p.status, SEED_SIGNER],
      );
      for (const [i, title] of DEFAULT_MILESTONES.entries()) {
        await c.query(
          "insert into setup_milestones (marketplace_id, title, sort_order, is_default) values ($1,$2,$3,true)",
          [mid, title, (i + 1) * 10],
        );
      }
      for (const r of p.requirements) {
        await c.query(
          `insert into requirements (marketplace_id, category, requirement, response, confirmation_state, source_ref, created_by)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [mid, r.category, r.requirement, r.response ?? null, r.state, r.source, SEED_SIGNER],
        );
      }
    }

    for (const sp of SEED_PRODUCTS) {
      for (const v of sp.variants) {
        let family: string = sp.family;
        let plants: string = "plantsIncluded" in sp ? sp.plantsIncluded : "unknown";
        let individual: string = "individual" in sp ? sp.individual : "unknown";
        let fulfillmentNote: string | null = null;
        let availability: string | null = "available"; // team-confirmed for custom pots and watering cans
        let customization: string | null = "customizationNote" in sp ? sp.customizationNote : null;
        if (sp.family === "by_variant") {
          if (/with succulent/i.test(v.title)) {
            family = "pots_plus_succulents";
            plants = "yes";
            individual = "no";
            availability = null; // not stated by the team — left unset
            fulfillmentNote = "Bulk only, delivered in multiple shipments. No individual recipient fulfillment by SB. Packing/assembly details not confirmed.";
          } else {
            family = "custom_pots";
            plants = "no";
            individual = "unknown";
            fulfillmentNote = "Custom pots only — no plants included.";
          }
          customization = "Personalized pots; confirm exact customization scope by quote.";
        }
        await c.query(
          `insert into products (source, shopify_product_id, shopify_variant_id, name, variant, sku, handle, product_url,
             web_price_cents, web_currency, selected, family, availability, plants_included,
             individual_recipient_fulfillment, fulfillment_note, customization_note, website_vendor)
           values ('shopify',$1,$2,$3,$4,$5,$6,$7,$8,'USD',true,$9,$14,$10,$11,$12,$13,'Calathea Collective')
           on conflict (shopify_variant_id) do nothing`,
          [
            sp.shopifyProductId, v.id, sp.name, v.title, v.sku, sp.handle,
            `https://succulentsbox.com/products/${sp.handle}?variant=${v.id}`, v.price,
            family, plants, individual, fulfillmentNote, customization, availability,
          ],
        );
      }
    }

    await c.query(
      `insert into collection_references (name, url, note, created_by)
       select 'Bulk corporate plant gifts', 'https://succulentsbox.com/collections/bulk-corporate-plant-gifts',
              'Grouping/reference only — not a sellable gift or cost record.', $1
       where not exists (select 1 from collection_references where url = 'https://succulentsbox.com/collections/bulk-corporate-plant-gifts')`,
      [SEED_SIGNER],
    );
  });
  if (log) console.log("seed complete");
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed().then(() => closePool()).catch((e) => { console.error(e); process.exit(1); });
}
