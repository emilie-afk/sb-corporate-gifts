// FIXTURE TESTS — propose several gifts (category / collection link / picked) and add several requirements.
// Synthetic gifts and a fake storefront; no real services.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, call, S } from "./helpers";
import { getPool } from "../server/db";
import { setShopifyFetcher } from "../server/lib/shopify";

let mid: string;
let gA: any, gB: any, gC: any, pots: any;
const seen: string[] = [];

beforeAll(async () => {
  await resetDb();
  mid = (await call("GET", "/marketplaces")).body.marketplaces.find((m: any) => m.name === "Goody").id;
  const ins = async (pid: number, vid: number, name: string, family: string, selected = true) => (await getPool().query(
    `insert into products (source, shopify_product_id, shopify_variant_id, name, variant, sku, web_price_cents, selected, family)
     values ('shopify', $1, $2, $3, 'Simple', $4, 3000, $5, $6) returning *`, [pid, vid, name, `SYN-${vid}`, selected, family])).rows[0];
  gA = await ins(93000001, 93100001, "Synthetic LTG Box A", "live_to_give_box");
  gB = await ins(93000002, 93100002, "Synthetic LTG Box B", "live_to_give_box");
  gC = await ins(93000003, 93100003, "Synthetic LTG Box C (not selected)", "live_to_give_box", false);
  pots = (await getPool().query("select * from products where family = 'pots_plus_succulents' limit 1")).rows[0];
  setShopifyFetcher(async (url) => {
    seen.push(url);
    const u = new URL(url);
    if (!u.pathname.startsWith("/collections/corporate-picks/")) return new Response("not found", { status: 404 });
    const page = Number(u.searchParams.get("page"));
    return new Response(JSON.stringify({ products: page === 1 ? [{ id: 93000002 }, { id: 93000003 }, { id: 99999999 }] : [] }), { status: 200 });
  });
});
afterAll(() => setShopifyFetcher(null));

const cand = (b: any) => call("POST", `/marketplaces/${mid}/products/candidates`, { ...S, ...b });

describe("propose several gifts", () => {
  it("finds gifts by category (selected only by default)", async () => {
    const r = await cand({ source: "family", family: "live_to_give_box" });
    const names = r.body.gifts.map((g: any) => g.name);
    expect(names).toEqual(expect.arrayContaining(["Synthetic LTG Box A", "Synthetic LTG Box B"]));
    expect(names).not.toContain("Synthetic LTG Box C (not selected)");
    const all = await cand({ source: "family", family: "live_to_give_box", selected_only: false });
    expect(all.body.gifts.map((g: any) => g.name)).toContain("Synthetic LTG Box C (not selected)");
  });

  it("finds gifts from a pasted succulentsbox.com collection link, matched to gifts in the app", async () => {
    const r = await cand({ source: "collection", collection_url: "https://succulentsbox.com/collections/Corporate-Picks?sort_by=price", selected_only: false });
    expect(r.status).toBe(200);
    expect(r.body.gifts.map((g: any) => g.id).sort()).toEqual([gB.id, gC.id].sort()); // 99999999 is not in the app
    expect(r.body.note).toMatch(/3 product\(s\).*corporate-picks/);
    expect(seen.some((u) => u.startsWith("https://succulentsbox.com/collections/corporate-picks/products.json"))).toBe(true);
    expect((await cand({ source: "collection", collection_url: "https://example.com/collections/x" })).status).toBe(400);
    expect((await cand({ source: "collection", collection_url: "https://succulentsbox.com/collections/missing" })).status).toBe(502);
  });

  it("saves several proposals at once; flags already-proposed gifts and bulk-only pots; all-or-nothing", async () => {
    const dry = await call("POST", `/marketplaces/${mid}/products/bulk`, { ...S, dry_run: true, items: [
      { product_id: gA.id, offer_type: "individual" }, { product_id: pots.id, offer_type: "individual" },
    ] });
    expect(dry.body.rows[1].errors.join()).toMatch(/bulk orders only/);
    const blocked = await call("POST", `/marketplaces/${mid}/products/bulk`, { ...S, items: [
      { product_id: gA.id, offer_type: "individual" }, { product_id: pots.id, offer_type: "individual" },
    ] });
    expect(blocked.status).toBe(400);
    expect((await call("GET", `/marketplaces/${mid}/products`)).body.proposals ?? (await call("GET", `/marketplaces/${mid}`)).body.products).toHaveLength(0);

    const ok = await call("POST", `/marketplaces/${mid}/products/bulk`, { ...S, proposal_status: "submitted", submitted_on: "2026-10-10", offer_note: "Q4 holiday catalog", items: [
      { product_id: gA.id, offer_type: "individual" }, { product_id: gB.id, offer_type: "bulk_customized" }, { product_id: pots.id, offer_type: "bulk" },
    ] });
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(3);
    const props = (await call("GET", `/marketplaces/${mid}`)).body.products;
    expect(props.map((p: any) => [p.product_id, p.offer_type, p.proposal_status, p.submitted_on, p.offer_note]).sort()).toEqual([
      [gA.id, "individual", "submitted", "2026-10-10", "Q4 holiday catalog"],
      [gB.id, "bulk_customized", "submitted", "2026-10-10", "Q4 holiday catalog"],
      [pots.id, "bulk", "submitted", "2026-10-10", "Q4 holiday catalog"],
    ].sort());
    // candidates now show them as already proposed; proposing again is refused
    const again = await cand({ source: "picked", product_ids: [gA.id, gC.id] });
    expect(again.body.gifts.find((g: any) => g.id === gA.id).existing_status).toBe("submitted");
    expect(again.body.gifts.find((g: any) => g.id === gC.id).existing_status).toBeNull();
    expect((await call("POST", `/marketplaces/${mid}/products/bulk`, { ...S, items: [{ product_id: gA.id, offer_type: "bulk" }] })).status).toBe(400);
  });
});

describe("add several requirements", () => {
  it("adds one requirement per line with its category; flags repeats and existing ones; shared state and source", async () => {
    const items = [
      { category: "fulfillment", requirement: "Ship within 2 business days" },
      { category: "payment", requirement: "Net 30 payment terms" },
      { category: "fulfillment", requirement: "ship within  2 business DAYS" },
    ];
    const dry = await call("POST", `/marketplaces/${mid}/requirements/bulk`, { ...S, dry_run: true, items });
    expect(dry.body.rows[2].errors.join()).toMatch(/Repeated \(same as line 1\)/);
    expect((await call("POST", `/marketplaces/${mid}/requirements/bulk`, { ...S, items })).status).toBe(400);
    const ok = await call("POST", `/marketplaces/${mid}/requirements/bulk`, { ...S, items: items.slice(0, 2),
      confirmation_state: "confirmed", source_ref: "Vendor guide v3 (synthetic)", verified_on: "2026-10-12" });
    expect(ok.body.created).toBe(2);
    const reqs = (await call("GET", `/marketplaces/${mid}/requirements`)).body.requirements;
    const net = reqs.find((r: any) => r.requirement === "Net 30 payment terms");
    expect(net).toMatchObject({ category: "payment", confirmation_state: "confirmed", confirmed_by: S.signer_name, source_ref: "Vendor guide v3 (synthetic)", verified_on: "2026-10-12" });
    const later = await call("POST", `/marketplaces/${mid}/requirements/bulk`, { ...S, dry_run: true, items: [{ category: "other", requirement: "Net 30 Payment Terms" }] });
    expect(later.body.rows[0].errors.join()).toMatch(/Already recorded/);
  });
});
