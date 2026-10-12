import { describe, it, expect, beforeAll } from "vitest";
import { resetDb, call, S } from "./helpers";
import { readFileSync } from "node:fs";
import { getPool } from "../server/db";

let channels: Record<string, any>;
let products: any[];
let gift: any;

beforeAll(async () => {
  await resetDb();
  channels = Object.fromEntries((await call("GET", "/channels")).body.channels.map((c: any) => [c.name, c]));
  const g = await call("POST", "/products", {
    ...S, name: "Live to Give Thank You Box", variant: "Standard", family: "live_to_give_box", availability: "available",
    card_eligible: "yes", plants_included: "yes", individual_recipient_fulfillment: "yes", selected: true,
  });
  gift = g.body.product;
  products = (await call("GET", "/products?limit=200")).body.products;
});

const potsSucc = () => products.find((p) => p.family === "pots_plus_succulents");
const potsOnly = () => products.find((p) => p.family === "custom_pots");

describe("product fulfillment rules", () => {
  it("pots-only records show plants not included; seeded pots and watering cans are Available, not Planned", () => {
    expect(potsOnly().plants_included).toBe("no");
    expect(potsOnly().availability).toBe("available");
    expect(products.find((p) => p.family === "watering_can").availability).toBe("available");
    expect(products.some((p) => p.availability === "planned")).toBe(false);
  });
  it("pots with succulents are seeded as an Available complete gift, bulk only, no individual recipient shipping", () => {
    const all = products.filter((p) => p.family === "pots_plus_succulents");
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.availability).toBe("available");
      expect(p.plants_included).toBe("yes");
      expect(p.individual_recipient_fulfillment).toBe("no");
      expect(p.fulfillment_note).toMatch(/complete gift/i);
      expect(p.fulfillment_note).not.toMatch(/multiple shipments|assembly/i);
    }
  });
  it("migration 003 upgrades v1-seeded pots with succulents and leaves team-edited notes alone", async () => {
    const pool = getPool();
    const [p1, p2] = products.filter((p) => p.family === "pots_plus_succulents");
    const oldNote = "Bulk only, delivered in multiple shipments. No individual recipient fulfillment by SB. Packing/assembly details not confirmed.";
    await pool.query("update products set availability = null, fulfillment_note = $2 where id = $1", [p1.id, oldNote]);
    if (p2) await pool.query("update products set availability = 'paused', fulfillment_note = 'Team note' where id = $1", [p2.id]);
    await pool.query("begin");
    await pool.query(readFileSync("db/migrations/003_pots_with_succulents_complete_gift.sql", "utf8"));
    await pool.query("commit");
    const r1 = (await pool.query("select * from products where id = $1", [p1.id])).rows[0];
    expect(r1.availability).toBe("available");
    expect(r1.fulfillment_note).toMatch(/complete gift/i);
    expect(r1.version).toBe(p1.version + 1);
    const ev = (await pool.query("select * from audit_events where entity_id = $1 and signer_name = 'System migration'", [p1.id])).rows[0];
    expect(ev.before.availability).toBeNull();
    expect(ev.after.availability).toBe("available");
    if (p2) {
      const r2 = (await pool.query("select * from products where id = $1", [p2.id])).rows[0];
      expect(r2.availability).toBe("paused");
      expect(r2.fulfillment_note).toBe("Team note");
      await pool.query("update products set availability = 'available', fulfillment_note = $2 where id = $1", [p2.id, p2.fulfillment_note]);
    }
    products = (await call("GET", "/products?limit=200")).body.products;
  });
  it("rejects individual fulfillment for pots + succulents on product, pricing and proposal", async () => {
    const p = potsSucc();
    expect((await call("PATCH", `/products/${p.id}`, { ...S, individual_recipient_fulfillment: "yes", version: p.version })).status).toBe(400);
    for (const fmt of ["individual", "corporate_separate_addresses"]) {
      const r = await call("POST", "/pricing", { ...S, channel_id: channels["CorporateGift.com"].id, product_id: p.id, fulfillment_format: fmt });
      expect(r.status).toBe(400);
    }
    const bulk = await call("POST", "/pricing", { ...S, channel_id: channels["CorporateGift.com"].id, product_id: p.id, fulfillment_format: "bulk_multiple_shipments" });
    expect(bulk.status).toBe(200);
    const mid = channels["CorporateGift.com"].marketplace_id;
    expect((await call("POST", `/marketplaces/${mid}/products`, { ...S, product_id: p.id, offer_type: "individual" })).status).toBe(400);
    expect((await call("POST", `/marketplaces/${mid}/products`, { ...S, product_id: p.id, offer_type: "bulk_customized", offer_note: "Partner handles distribution?" })).status).toBe(200);
  });
  it("rejects plants on custom pots", async () => {
    const p = potsOnly();
    expect((await call("PATCH", `/products/${p.id}`, { ...S, plants_included: "yes", version: p.version })).status).toBe(400);
  });
  it("product decline does not change marketplace status", async () => {
    const mid = channels["Goody"].marketplace_id;
    const prop = await call("POST", `/marketplaces/${mid}/products`, { ...S, product_id: gift.id, offer_type: "individual", offer_note: "Individual Live to Give box" });
    expect(prop.body.proposal.offer_type).toBe("individual");
    await call("PATCH", `/marketplaces/${mid}/products/${prop.body.proposal.id}`, { ...S, proposal_status: "declined", version: 1 });
    const d = (await call("GET", `/marketplaces/${mid}`)).body;
    expect(d.marketplace.status).toBe("prospect");
    expect(d.products[0].product_name).toBe("Live to Give Thank You Box"); // names, not only IDs
  });
});

describe("pricing", () => {
  it("never prefills marketplace supplier prices from the direct discount; unknown stays null", async () => {
    const r = await call("POST", "/pricing", { ...S, channel_id: channels["Goody"].id, product_id: gift.id, fulfillment_format: "individual" });
    expect(r.body.record.proposed_supplier_cents).toBeNull();
    expect(r.body.record.customer_discount_pct).toBeNull();
    expect(r.body.record.expected_shipping_cents).toBeNull();
    expect(r.body.record.commission_pct).toBeNull();
  });

  it("agreed versions are immutable; revision keeps history; activation supersedes; overlaps rejected", async () => {
    const ch = channels["Reachdesk"].id;
    const d = await call("POST", "/pricing", { ...S, channel_id: ch, product_id: gift.id, fulfillment_format: "individual", proposed_supplier_cents: 1900, moq: 1 });
    const rec = d.body.record;
    // agree without price → rejected
    expect((await call("PATCH", `/pricing/${rec.id}`, { ...S, status: "agreed", approved_by: "Lead", version: rec.version })).status).toBe(400);
    const agreed = await call("PATCH", `/pricing/${rec.id}`, { ...S, status: "agreed", agreed_price_cents: 1800, approved_by: "Lead", payment_terms: "Net 30", version: rec.version });
    expect(agreed.status).toBe(200);
    expect(agreed.body.record.terms_snapshot.payment_terms).toEqual({ value: "Net 30", source: "gift_override" });
    expect(agreed.body.record.terms_snapshot.dispatch_requirement.source).toBe("unspecified");
    // immutable
    const edit = await call("PATCH", `/pricing/${rec.id}`, { ...S, agreed_price_cents: 1700, version: agreed.body.record.version });
    expect(edit.status).toBe(409);
    // activation needs start date
    expect((await call("POST", `/pricing/${rec.id}/activate`, { ...S, version: agreed.body.record.version })).status).toBe(400);
    const act = await call("POST", `/pricing/${rec.id}/activate`, { ...S, effective_from: "2026-10-01", version: agreed.body.record.version });
    expect(act.status).toBe(200);
    expect(act.body.record.status).toBe("active");

    // revise → new draft linked to previous; old version untouched
    const rev = await call("POST", `/pricing/${rec.id}/revisions`, { ...S, agreed_price_cents: 2000 });
    expect(rev.body.record.previous_record_id).toBe(rec.id);
    expect(rev.body.record.status).toBe("draft");
    const ag2 = await call("PATCH", `/pricing/${rev.body.record.id}`, { ...S, status: "agreed", approved_by: "Lead", version: 1 });
    // later start → supersedes and closes the previous period
    const act2 = await call("POST", `/pricing/${rev.body.record.id}/activate`, { ...S, effective_from: "2026-11-01", version: ag2.body.record.version });
    expect(act2.status).toBe(200);
    expect(act2.body.superseded).toEqual([rec.id]);
    const old = (await call("GET", `/pricing/${rec.id}`)).body.record;
    expect(old.status).toBe("expired");
    expect(old.effective_to).toBe("2026-10-31");
    expect(old.agreed_price_cents).toBe(1800);

    // a third version starting before the current active one is rejected
    const rev3 = await call("POST", `/pricing/${rev.body.record.id}/revisions`, { ...S, agreed_price_cents: 2100 });
    const ag3 = await call("PATCH", `/pricing/${rev3.body.record.id}`, { ...S, status: "agreed", approved_by: "Lead", version: 1 });
    const bad = await call("POST", `/pricing/${rev3.body.record.id}/activate`, { ...S, effective_from: "2026-10-15", version: ag3.body.record.version });
    expect(bad.status).toBe(409);

    const hist = (await call("GET", `/pricing/${rev.body.record.id}/history`)).body.versions;
    expect(hist.map((h: any) => h.agreed_price_cents)).toEqual([1800, 2000, 2100]);
  });

  it("validates end >= start", async () => {
    const r = await call("POST", "/pricing", { ...S, channel_id: channels["Snappy"].id, product_id: gift.id, fulfillment_format: "individual", effective_from: "2026-10-10", effective_to: "2026-10-01" });
    expect(r.status).toBe(400);
  });

  it("direct website pricing stores discount but agreed price only when explicitly entered", async () => {
    const r = await call("POST", "/pricing", { ...S, channel_id: channels["Direct website"].id, product_id: gift.id, fulfillment_format: "corporate_separate_addresses", customer_discount_pct: 20, moq: 10 });
    expect(r.body.record.agreed_price_cents).toBeNull();
    expect(Number(r.body.record.customer_discount_pct)).toBe(20);
  });
});

describe("revenue", () => {
  it("computes net revenue, blocks duplicates, excludes incomplete records, includes inactive channels", async () => {
    const pwp = channels["Packed with Purpose"];
    const mp = (await call("GET", `/marketplaces/${pwp.marketplace_id}`)).body.marketplace;
    await call("POST", `/marketplaces/${pwp.marketplace_id}/status-transitions`, { ...S, to_status: "inactive", reason: "partnership_paused", version: mp.version });

    const a = await call("POST", "/revenue/monthly", {
      ...S, channel_id: channels["Direct website"].id, reporting_month: "2026-09",
      order_count: 3, units_sold: 40, gift_sales_cents: 100000, shipping_revenue_cents: 5000, refunds_cents: 2000, marketplace_fees_cents: 0,
    });
    expect(a.status).toBe(200);
    expect(a.body.record.net_revenue_cents).toBe(103000);
    expect(a.body.record.revenue_after_fees_cents).toBe(103000);

    const dup = await call("POST", "/revenue/monthly", { ...S, channel_id: channels["Direct website"].id, reporting_month: "2026-09", order_count: 1 });
    expect(dup.status).toBe(409);

    // refunds > sales → negative net allowed
    const neg = await call("POST", "/revenue/monthly", {
      ...S, channel_id: pwp.id, reporting_month: "2026-09", order_count: 0, units_sold: 0, gift_sales_cents: 0, shipping_revenue_cents: 0, refunds_cents: 3000, marketplace_fees_cents: 500,
    });
    expect(neg.body.record.net_revenue_cents).toBe(-3000);
    expect(neg.body.record.revenue_after_fees_cents).toBe(-3500);

    // missing (null) core field → saved but excluded
    const inc = await call("POST", "/revenue/monthly", { ...S, channel_id: channels["Goody"].id, reporting_month: "2026-09", order_count: 2, gift_sales_cents: 5000 });
    expect(inc.body.record.complete).toBe(false);
    expect(inc.body.record.missing_fields).toContain("refunds_cents");

    // negative counts / money rejected
    expect((await call("POST", "/revenue/monthly", { ...S, channel_id: channels["Snappy"].id, reporting_month: "2026-09", order_count: -1 })).status).toBe(400);
    expect((await call("POST", "/revenue/monthly", { ...S, channel_id: channels["Snappy"].id, reporting_month: "2026-13" })).status).toBe(400);

    const list = (await call("GET", "/revenue/monthly?month=2026-09")).body;
    expect(list.totals.records_included).toBe(2);
    expect(list.totals.records_incomplete).toBe(1);
    expect(list.totals.net_revenue_cents).toBe(100000);
    expect(list.byChannel.map((c: any) => c.channel_name)).toContain("Packed with Purpose");

    // correction with audit; stale version → conflict
    const fix = await call("PATCH", `/revenue/monthly/${a.body.record.id}`, { ...S, refunds_cents: 0, version: 1 });
    expect(fix.body.record.net_revenue_cents).toBe(105000);
    expect((await call("PATCH", `/revenue/monthly/${a.body.record.id}`, { ...S, refunds_cents: 10, version: 1 })).status).toBe(409);
    const h = (await call("GET", `/revenue/monthly/${a.body.record.id}/history`)).body.events;
    expect(h[0].action).toBe("correct");
    expect(h[0].before.refunds_cents).toBe(2000);
  });

  it("never returns the private authenticated subject to the browser", async () => {
    for (const p of ["/pricing", "/revenue/monthly", `/marketplaces/${channels["Goody"].marketplace_id}`]) {
      expect(JSON.stringify((await call("GET", p)).body)).not.toContain("auth_subject");
    }
  });

  it("price revisions never recalculate revenue", async () => {
    const before = (await call("GET", "/revenue/monthly?month=2026-09")).body.totals.net_revenue_cents;
    const recs = (await call("GET", "/pricing")).body.pricing;
    const draft = recs.find((r: any) => r.status === "draft");
    await call("PATCH", `/pricing/${draft.id}`, { ...S, proposed_supplier_cents: 99999, version: draft.version });
    expect((await call("GET", "/revenue/monthly?month=2026-09")).body.totals.net_revenue_cents).toBe(before);
  });
});
