// Source-backed reference values for pricing records.
//
// Retail reference = the gift/variant's current website price from the last website refresh (Shopify).
// Internal gift cost = the latest confirmed Product Master cost snapshot.
// The team never retypes these. A manual value is allowed only as an explicit override with a reason,
// a source and a date. Missing values stay null (unknown) — never zero.
import { z } from "zod";
import type pg from "pg";
import { badRequest } from "../http";
import type { Db } from "../db";

export const overrideSchema = z
  .union([
    z.object({
      cents: z.number().int().min(0).max(1e12),
      reason: z.string().trim().min(1, "Reason required").max(500),
      source: z.string().trim().min(1, "Source required").max(500),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    }),
    z.null(),
  ])
  .optional();
export type Override = z.infer<typeof overrideSchema>;

export type References = {
  retail: null | { cents: number; source: "shopify"; refreshed_at: string | null; refresh: "website_refresh" | "seed_or_manual_product"; product_url: string | null };
  cost: null | {
    cents: number;
    exact: number;
    source: "product_master";
    snapshot_id: string;
    refreshed_at: string;
    confirmed_by: string;
    components: { label: string | null; vendor: string; tab: string; basis: string; quantity: number | null; source_cost: number | null; includes: string | null; base_price: number | null }[];
    includes: string | null;
  };
  channel: {
    id: string; name: string; type: string;
    corporate_moq: number | null; default_discount_pct: number | null;
    payment_terms: string | null; shipping_responsibility: string | null; dispatch_requirement: string | null; fee_note: string | null; terms_note: string | null;
  } | null;
  suggested_direct_price_cents: number | null;
  product: { id: string; name: string; variant: string | null; family: string | null; sku: string | null } | null;
};

export async function currentReferences(db: Db, productId: string, channelId?: string | null): Promise<References> {
  const p = (await db.query(
    `select p.id, p.name, p.variant, p.family, p.sku, p.web_price_cents, p.product_url, p.source, p.last_seen_run_id, p.updated_at,
            r.confirmed_at as refresh_confirmed_at
     from products p left join import_runs r on r.id = p.last_seen_run_id where p.id = $1`,
    [productId],
  )).rows[0];
  if (!p) throw badRequest("Unknown gift/variant", { fields: { product_id: "Unknown" } });
  const snap = (await db.query(
    `select s.id, s.gift_cost_cents, s.gift_cost_exact, s.detail, s.created_at, s.confirmed_by from cost_snapshots s
     where s.product_id = $1 order by s.created_at desc limit 1`,
    [productId],
  )).rows[0];
  const ch = channelId ? (await db.query("select * from channels where id = $1", [channelId])).rows[0] : null;
  if (channelId && !ch) throw badRequest("Unknown channel", { fields: { channel_id: "Unknown" } });

  let cost: References["cost"] = null;
  if (snap) {
    const comps = (Array.isArray(snap.detail) ? snap.detail : []) as any[];
    // Older snapshots may not carry the inclusions note; read it from the mapping that produced them.
    const mappingIds = comps.filter((c) => c.includes === undefined && c.mapping_id).map((c) => c.mapping_id);
    const notes = mappingIds.length
      ? new Map((await db.query("select id, cost_inclusions_note from source_mappings where id = any($1)", [mappingIds])).rows.map((r: any) => [r.id, r.cost_inclusions_note]))
      : new Map();
    const components = comps.map((c) => ({
      label: c.component_label ?? null, vendor: c.vendor, tab: c.tab, basis: c.basis, quantity: c.quantity ?? null,
      source_cost: c.source_cost ?? null, includes: c.includes !== undefined ? c.includes : notes.get(c.mapping_id) ?? null, base_price: c.base_price ?? null,
    }));
    const includes = [...new Set(components.map((c) => c.includes).filter(Boolean))].join("; ") || null;
    cost = {
      cents: Number(snap.gift_cost_cents), exact: Number(snap.gift_cost_exact), source: "product_master", snapshot_id: snap.id,
      refreshed_at: new Date(snap.created_at).toISOString(), confirmed_by: snap.confirmed_by, components, includes,
    };
  }
  const retail: References["retail"] = p.web_price_cents == null ? null : {
    cents: Number(p.web_price_cents), source: "shopify",
    refreshed_at: p.refresh_confirmed_at ? new Date(p.refresh_confirmed_at).toISOString() : null,
    refresh: p.last_seen_run_id ? "website_refresh" : "seed_or_manual_product",
    product_url: p.product_url,
  };
  const channel = ch ? {
    id: ch.id, name: ch.name, type: ch.type, corporate_moq: ch.corporate_moq, default_discount_pct: ch.default_discount_pct == null ? null : Number(ch.default_discount_pct),
    payment_terms: ch.payment_terms, shipping_responsibility: ch.shipping_responsibility, dispatch_requirement: ch.dispatch_requirement,
    fee_note: ch.fee_note, terms_note: ch.terms_note,
  } : null;
  // Direct website only: a labelled suggestion, never stored as an agreed price and never used for marketplaces.
  const suggested = channel?.type === "direct" && retail && channel.default_discount_pct != null
    ? Math.round(retail.cents * (1 - channel.default_discount_pct / 100)) : null;
  return {
    retail, cost, channel, suggested_direct_price_cents: suggested,
    product: { id: p.id, name: p.name, variant: p.variant, family: p.family, sku: p.sku },
  };
}

/** Columns written to a pricing record for the retail and cost references. */
export async function resolveReferenceFields(
  c: pg.PoolClient,
  productId: string,
  retailOverride: Override,
  costOverride: Override,
  importLabel?: string,
) {
  const refs = await currentReferences(c, productId, null);
  const out: Record<string, unknown> = {};
  if (retailOverride) {
    out.retail_ref_cents = retailOverride.cents;
    out.retail_source = "manual";
    out.retail_source_detail = JSON.stringify({ reason: retailOverride.reason, source: retailOverride.source, date: retailOverride.date, ...(importLabel ? { import: importLabel } : {}),
      source_value_at_entry: refs.retail?.cents ?? null });
  } else if (refs.retail) {
    out.retail_ref_cents = refs.retail.cents;
    out.retail_source = "shopify";
    out.retail_source_detail = JSON.stringify({ refreshed_at: refs.retail.refreshed_at, refresh: refs.retail.refresh });
  } else {
    out.retail_ref_cents = null; out.retail_source = null; out.retail_source_detail = null;
  }
  if (costOverride) {
    out.internal_cost_cents = costOverride.cents;
    out.cost_source = "manual";
    out.cost_source_detail = JSON.stringify({ reason: costOverride.reason, source: costOverride.source, date: costOverride.date, ...(importLabel ? { import: importLabel } : {}),
      source_value_at_entry: refs.cost?.cents ?? null });
  } else if (refs.cost) {
    out.internal_cost_cents = refs.cost.cents;
    out.cost_source = "product_master";
    out.cost_source_detail = JSON.stringify({ snapshot_id: refs.cost.snapshot_id, refreshed_at: refs.cost.refreshed_at, components: refs.cost.components });
  } else {
    out.internal_cost_cents = null; out.cost_source = null; out.cost_source_detail = null;
  }
  return { fields: out, refs };
}
