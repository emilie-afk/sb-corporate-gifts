// FIXTURE TESTS — synthetic orders only (#91xxxx, example.test). No real Shopify data.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetDb, call, app, S } from "./helpers";
import { parseCsvObjects, prepareCorporateOrdersPayload, reduceShopifyOrderRows } from "../shared/corporateOrders.js";

const SECRET = "test-ingest-secret-test-ingest-secret-0001";
const csv = readFileSync(join(import.meta.dirname, "fixtures", "shopify-orders-SYNTHETIC.csv"), "utf8");

function payload(over: { exportedAt?: string; coverageFrom?: string; coverageTo?: string; mutate?: (o: any[]) => void } = {}) {
  const { headers, rows } = parseCsvObjects(csv);
  const r = prepareCorporateOrdersPayload(rows, { headers, exportedAt: over.exportedAt ?? "2026-10-05T08:00:00.000Z", coverageFrom: over.coverageFrom ?? "2026-08-10", coverageTo: over.coverageTo ?? "2026-10-04", fileName: "synthetic.csv" });
  if (r.refused) throw new Error("refused");
  const p = JSON.parse(JSON.stringify(r.payload));
  over.mutate?.(p.orders);
  return p;
}

async function ingest(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await app(new Request("http://localhost/api/ingest/shopify-orders", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

const order = async (name: string) => (await call("GET", `/revenue/orders?q=${encodeURIComponent(name)}`)).body.orders.find((o: any) => o.order_name === name);
let channels: Record<string, any>;

beforeAll(async () => {
  await resetDb();
  channels = Object.fromEntries((await call("GET", "/channels")).body.channels.map((c: any) => [c.name, c]));
});

describe("payload reduction (runs in the browser and is proposed for the collector)", () => {
  it("keeps only allowed fields, groups line rows into orders, drops personal-looking tags", () => {
    const { headers, rows } = parseCsvObjects(csv);
    const r = reduceShopifyOrderRows(rows, headers);
    expect(r.orders).toHaveLength(5);
    const o1 = r.orders.find((o) => o.name === "#910001")!;
    expect(o1.lines).toHaveLength(2);
    expect(o1.tags).toEqual(["Corporate", "postal"]);
    expect(o1.billingCompany).toBe("Postal.io");
    const text = JSON.stringify(r.orders);
    for (const forbidden of ["example.test", "Synthetic Person", "Example St", "555-555", "call me", "THANKS10", "Channel: web"]) expect(text).not.toContain(forbidden);
    expect(r.fields.sort()).toEqual(["billing_company", "source", "tags"]);
  });
  it("refuses an export without the required columns", () => {
    const r = prepareCorporateOrdersPayload([{ Name: "#1" }], { headers: ["Name"], exportedAt: "2026-10-01T00:00:00Z", coverageFrom: "2026-09-01", coverageTo: "2026-09-30" });
    expect(r.refused).toBe("missing_columns");
  });
});

describe("ingestion endpoint security", () => {
  it("is disabled without a configured secret and rejects wrong credentials", async () => {
    delete process.env.CORPORATE_INGEST_SECRET;
    expect((await ingest(payload())).status).toBe(503);
    process.env.CORPORATE_INGEST_SECRET = SECRET;
    expect((await ingest(payload(), null)).status).toBe(401);
    expect((await ingest(payload(), "Bearer wrong-wrong-wrong-wrong-wrong-wrong")).status).toBe(401);
  });
  it("does not accept the Google session cookie as the collector credential", async () => {
    const r = await call("POST", "/ingest/shopify-orders", payload());
    expect(r.status).toBe(401);
  });
  it("rejects privacy/contract violations entirely and records the failure", async () => {
    const bad = payload({ mutate: (o) => { o[0].email = "someone@example.test"; } });
    const r = await ingest(bad);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("someone@example.test"); // paths only, never values
    const bad2 = payload({ mutate: (o) => { o[0].tags = ["buyer@example.test"]; } });
    expect((await ingest(bad2)).status).toBe(400);
    const runs = (await call("GET", "/revenue/imports")).body.runs;
    expect(runs[0].status).toBe("failed");
    expect((await call("GET", "/revenue/orders")).body.total).toBe(0);
  });
});

describe("revenue arithmetic and canonical orders", () => {
  it("imports one canonical order per Shopify order without summing repeated line rows", async () => {
    const r = await ingest(payload());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "completed", received: 5, new: 5 });
    const o1 = await order("#910001");
    // Subtotal 282 (already after the $20 discount) − Route line 2 = 280; taxes excluded; discount not subtracted again.
    expect(o1).toMatchObject({ gift_sales_cents: 28000, shipping_cents: 0, net_revenue_cents: 28000, units: 10, revenue_status: "counted" });
    const o2 = await order("#910002");
    expect(o2).toMatchObject({ gift_sales_cents: 15000, shipping_cents: 1200, refund_applied_cents: 4000, net_revenue_cents: 12200, units: 7, order_month: "2026-09-01" });
  });
  it("handles cancelled, refunded beyond revenue, pending, gift-card lines and LA month boundaries", async () => {
    const o3 = await order("#910003");
    expect(o3.revenue_status).toBe("cancelled");
    expect(o3.refund_applied_cents).toBe(5800); // capped at gift sales + shipping; tax part not deducted
    expect(o3.warnings.join(" ")).toMatch(/excess is not deducted/);
    const o4 = await order("#910004");
    expect(o4.order_date).toBe("2026-09-30"); // 01:00 UTC Oct 1 = Sep 30 in Los Angeles
    expect(o4.awaiting_payment).toBe(true);
    expect(o4.revenue_status).toBe("counted");
    const o5 = await order("#910005");
    expect(o5).toMatchObject({ gift_sales_cents: 0, net_revenue_cents: 700, units: 0 }); // gift-card purchase excluded
  });
  it("treats an identical re-sent report as a no-op", async () => {
    const r = await ingest(payload());
    expect(r.body.status).toBe("duplicate");
    expect((await call("GET", "/revenue/orders")).body.total).toBe(5);
  });
  it("newer overlapping report updates changed orders, never deletes missing ones", async () => {
    const newer = payload({ exportedAt: "2026-10-09T08:00:00.000Z", coverageFrom: "2026-08-17", coverageTo: "2026-10-11",
      mutate: (o) => { const x = o.find((y: any) => y.name === "#910002"); x.refundedAmount = "60.00"; o.splice(o.findIndex((y: any) => y.name === "#910005"), 1); } });
    const r = await ingest(newer);
    expect(r.body).toMatchObject({ status: "completed", updated: 1, unchanged: 3, new: 0 });
    expect((await order("#910002")).net_revenue_cents).toBe(10200);
    expect(await order("#910005")).toBeTruthy(); // not in the later report → kept
    const hist = (await call("GET", `/revenue/orders/${(await order("#910002")).id}`)).body.history;
    expect(hist[0]).toMatchObject({ action: "import_update" });
    expect(hist[0].before.refunded_cents).toBe(4000);
  });
  it("an older snapshot never overwrites a newer one; equal-time conflicts are flagged", async () => {
    const older = payload({ exportedAt: "2026-10-06T08:00:00.000Z", mutate: (o) => { o.find((y: any) => y.name === "#910002").refundedAmount = "0.00"; } });
    const r = await ingest(older);
    expect(r.body.stale).toBeGreaterThan(0);
    expect((await order("#910002")).net_revenue_cents).toBe(10200);
    const same = payload({ exportedAt: "2026-10-09T08:00:00.000Z", coverageFrom: "2026-08-17", coverageTo: "2026-10-11", mutate: (o) => { o.find((y: any) => y.name === "#910002").refundedAmount = "1.00"; } });
    const r2 = await ingest(same);
    expect(r2.body.stale).toBeGreaterThan(0);
    const runs = (await call("GET", "/revenue/imports")).body.runs;
    expect(JSON.stringify(runs[0].warnings)).toMatch(/chronology uncertain/);
  });
  it("manual upload uses the same validation and import logic", async () => {
    const p = payload({ exportedAt: "2026-10-10T08:00:00.000Z", coverageFrom: "2026-09-01", coverageTo: "2026-10-12" });
    const r = await call("POST", "/revenue/imports/manual", { ...S, payload: p });
    expect(r.status).toBe(200);
    expect(r.body.run.chronology).toBe("declared");
    const bad = await call("POST", "/revenue/imports/manual", { ...S, payload: { ...p, orders: [{ ...p.orders[0], notes: "x" }] } });
    expect(bad.status).toBe(400);
  });
});

describe("matching rules and classification", () => {
  let token: string;
  it("only offers fields present in imported reports", async () => {
    const f = (await call("GET", "/revenue/rules/fields")).body.fields.map((x: any) => x.field);
    expect(f.sort()).toEqual(["billing_company", "source", "tags"]);
  });
  it("previews with normalisation before saving, and requires the preview token + name", async () => {
    const rule = { channel_id: channels["Postal.io / Postal"].id, source_field: "billing_company", operator: "equals", match_value: "  POSTAL.IO " };
    const pv = await call("POST", "/revenue/rules/preview", { op: "create", rule });
    expect(pv.status).toBe(200);
    expect(pv.body.rule_matches.count).toBe(1);
    expect(pv.body.moved.sample[0]).toMatchObject({ order: "#910001", from: "Unclassified", to: "Postal.io / Postal" });
    expect(pv.body.affected_months).toEqual(["2026-09-01"]);
    expect((await order("#910001")).class_status).toBe("unclassified"); // nothing saved by a preview
    expect((await call("POST", "/revenue/rules/apply", { op: "create", rule, token: "0".repeat(64), ...S })).status).toBe(409);
    expect((await call("POST", "/revenue/rules/apply", { op: "create", rule, token: pv.body.token })).status).toBe(400); // name required
    const ap = await call("POST", "/revenue/rules/apply", { op: "create", rule, token: pv.body.token, ...S });
    expect(ap.body.orders_reclassified).toBe(1);
    expect((await order("#910001")).class_status).toBe("assigned");
    token = pv.body.token;
  });
  it("same-channel alternative rules are fine; cross-channel matches are conflicts", async () => {
    const same = { channel_id: channels["Postal.io / Postal"].id, source_field: "tags", operator: "contains", match_value: "post" };
    let pv = await call("POST", "/revenue/rules/preview", { op: "create", rule: same });
    await call("POST", "/revenue/rules/apply", { op: "create", rule: same, token: pv.body.token, ...S });
    expect((await order("#910001")).class_status).toBe("assigned");
    const other = { channel_id: channels["Goody"].id, source_field: "tags", operator: "equals", match_value: "corporate" };
    pv = await call("POST", "/revenue/rules/preview", { op: "create", rule: other });
    expect(pv.body.new_conflicts.count).toBe(1);
    await call("POST", "/revenue/rules/apply", { op: "create", rule: other, token: pv.body.token, ...S });
    const o1 = await order("#910001");
    expect(o1.class_status).toBe("conflict");
    expect(o1.channel_id).toBeNull(); // never silently picks the first rule
  });
  it("manual assignment wins until cleared; exclusion is explicit", async () => {
    let o1 = await order("#910001");
    const as = await call("POST", `/revenue/orders/${o1.id}/classify`, { ...S, action: "assign", channel_id: channels["Postal.io / Postal"].id, reason: "Confirmed with Postal invoice", version: o1.version });
    expect(as.status).toBe(200);
    expect((await order("#910001")).class_status).toBe("assigned");
    const rules = (await call("GET", "/revenue/rules")).body.rules;
    const goody = rules.find((r: any) => r.channel_name === "Goody");
    const pv = await call("POST", "/revenue/rules/preview", { op: "disable", rule_id: goody.id });
    expect(pv.body.manual_overrides_kept.count).toBe(1);
    await call("POST", "/revenue/rules/apply", { op: "disable", rule_id: goody.id, token: pv.body.token, ...S });
    o1 = await order("#910001");
    expect(o1.class_manual).toBe(true);
    await call("POST", `/revenue/orders/${o1.id}/classify`, { ...S, action: "clear", version: o1.version });
    expect((await order("#910001")).class_status).toBe("assigned"); // back to rules (Postal only now)
    const o5 = await order("#910005");
    expect((await call("POST", `/revenue/orders/${o5.id}/classify`, { ...S, action: "exclude", version: o5.version })).status).toBe(400); // reason required
    await call("POST", `/revenue/orders/${o5.id}/classify`, { ...S, action: "exclude", reason: "Ordinary retail gift card", version: o5.version });
    expect((await order("#910005")).class_status).toBe("excluded");
    const h = (await call("GET", `/revenue/orders/${o5.id}`)).body.history;
    expect(h[0]).toMatchObject({ action: "manual_exclude", signer_name: "Test Person" });
  });
  it("rule preview tokens expire when data changes", async () => {
    const rule = { channel_id: channels["Reachdesk"].id, source_field: "tags", operator: "equals", match_value: "reachdesk" };
    const pv = await call("POST", "/revenue/rules/preview", { op: "create", rule });
    await ingest(payload({ exportedAt: "2026-10-11T08:00:00.000Z", mutate: (o) => { o.find((y: any) => y.name === "#910004").refundedAmount = "5.00"; } }));
    expect((await call("POST", "/revenue/rules/apply", { op: "create", rule, token: pv.body.token, ...S })).status).toBe(409);
    expect(token).toBeTruthy();
  });
});

describe("summary and reconciliation", () => {
  it("combines Shopify-derived and manual revenue without blindly adding legacy totals", async () => {
    const postal = channels["Postal.io / Postal"].id;
    // Legacy manual monthly total that may duplicate Shopify sales
    const legacy = await call("POST", "/revenue/monthly", { ...S, channel_id: postal, reporting_month: "2026-09", order_count: 1, units_sold: 10, gift_sales_cents: 28000, shipping_revenue_cents: 0, refunds_cents: 0, marketplace_fees_cents: 0 });
    let sm = (await call("GET", "/revenue/summary?from=2026-09&to=2026-09")).body;
    let row = sm.rows.find((r: any) => r.channel_id === postal && r.month === "2026-09");
    expect(row.shopify.net_cents).toBe(28000);
    expect(row.manual_cents).toBe(0);
    expect(row.combined_cents).toBe(28000);
    expect(row.warnings.join(" ")).toMatch(/need review/);
    expect(row.fees_cents).toBeNull(); // "Fees not recorded"
    // reconcile as covered by Shopify → still excluded, but its recorded fee (0) counts
    const rec = await call("POST", `/revenue/monthly/${legacy.body.record.id}/reconcile`, { ...S, reconciliation: "covered_by_shopify", note: "Same order #910001", version: legacy.body.record.version });
    expect(rec.status).toBe(200);
    // off-Shopify sale + actual fee
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: postal, reporting_month: "2026-09", kind: "off_shopify_sale", gift_sales_cents: 50000, reason: "Invoice paid by bank transfer", reference: "INV-SYN-1", entry_date: "2026-09-20" })).status).toBe(200);
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: postal, reporting_month: "2026-09", kind: "off_shopify_sale", gift_sales_cents: 50000, reason: "dup", reference: "inv-syn-1 ", entry_date: "2026-09-20" })).status).toBe(409);
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: postal, reporting_month: "2026-09", kind: "fee", marketplace_fees_cents: 3500, reason: "Postal statement fee", reference: "STMT-SYN-9", entry_date: "2026-09-30" })).status).toBe(200);
    sm = (await call("GET", "/revenue/summary?from=2026-09&to=2026-09")).body;
    row = sm.rows.find((r: any) => r.channel_id === postal && r.month === "2026-09");
    expect(row.manual_cents).toBe(50000);
    expect(row.combined_cents).toBe(78000);
    expect(row.fees_cents).toBe(3500);
    expect(row.after_fees_cents).toBe(74500);
    const m = sm.months.find((x: any) => x.month === "2026-09");
    expect(m.complete).toBe(true);
    expect(m.conflicts).toBe(0);
  });
  it("flags partial coverage and keeps imported history beyond the rolling window", async () => {
    const sm = (await call("GET", "/revenue/summary?from=2026-10&to=2026-10")).body;
    expect(sm.months.every((m: any) => m.month !== "2026-10" || !m.complete)).toBe(true);
  });
  it("never lets a price change recalculate imported revenue", async () => {
    const before = (await call("GET", "/revenue/summary?from=2026-09&to=2026-09")).body.totals.combined_cents;
    const g = (await call("POST", "/products", { ...S, name: "Synthetic gift", selected: true })).body.product;
    await call("POST", "/pricing", { ...S, channel_id: channels["Postal.io / Postal"].id, product_id: g.id, fulfillment_format: "individual", pricing_model: "fixed_supplier", proposed_supplier_cents: 999 });
    expect((await call("GET", "/revenue/summary?from=2026-09&to=2026-09")).body.totals.combined_cents).toBe(before);
  });
});
