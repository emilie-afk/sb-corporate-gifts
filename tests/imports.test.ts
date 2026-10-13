import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, call, S } from "./helpers";
import { computeComponent, giftCost, parseSheet, parseAmount, type Mapping, type Link } from "../server/lib/costs";
import { setSheetsReader } from "../server/lib/sheets";
import { setShopifyFetcher } from "../server/lib/shopify";

const M = (over: Partial<Mapping> = {}): Mapping => ({
  id: "m1", label: "Test", vendor: "Vendor A", tab_name: "Tab", header_row: 1, match_columns: ["SKU"], cost_column: "Cost",
  cost_basis: "per_piece", quantity_column: null, retail_column: null, mapping_version: 1, ...over,
});
const L = (over: Partial<Link> = {}): Link => ({ id: "l1", product_id: "p1", source_mapping_id: "m1", match_values: { SKU: "A1" }, component_label: null, quantity_per_gift: null, ...over });

describe("cost quantity rule (pure)", () => {
  const sheet = parseSheet([["SKU", "Cost", "Qty"], ["A1", "$4.00", 5], ["B2", 20, ""], ["DUP", 1, 1], ["DUP", 2, 1], ["BAD", "n/a", 1]], 1);
  it("per-piece 4.00 × 5 = 20.00", () => {
    const c = computeComponent(sheet, M(), L({ quantity_per_gift: 5 }));
    expect(giftCost([c]).cents).toBe(2000);
  });
  it("per-piece with quantity column", () => {
    const c = computeComponent(sheet, M({ quantity_column: "Qty" }), L());
    expect(c.quantity_source).toBe("sheet");
    expect(giftCost([c]).cents).toBe(2000);
  });
  it("complete-pack 20.00 stays 20.00 (never multiplied)", () => {
    const c = computeComponent(sheet, M({ cost_basis: "per_pack" }), L({ match_values: { SKU: "B2" }, quantity_per_gift: 5 }));
    expect(giftCost([c]).cents).toBe(2000);
  });
  it("missing quantity, duplicates, malformed and missing rows are errors — never zero", () => {
    for (const c of [
      computeComponent(sheet, M(), L()),
      computeComponent(sheet, M(), L({ match_values: { SKU: "DUP" }, quantity_per_gift: 1 })),
      computeComponent(sheet, M(), L({ match_values: { SKU: "BAD" }, quantity_per_gift: 1 })),
      computeComponent(sheet, M(), L({ match_values: { SKU: "NOPE" }, quantity_per_gift: 1 })),
    ]) {
      const g = giftCost([c]);
      expect(g.error).toBeTruthy();
      expect(g.cents).toBeNull();
    }
  });
  it("no fuzzy matching", () => {
    expect(computeComponent(sheet, M(), L({ match_values: { SKU: "A" }, quantity_per_gift: 1 })).error).toMatch(/No row/);
  });
  it("composite gifts sum distinct components", () => {
    const a = computeComponent(sheet, M(), L({ quantity_per_gift: 5 }));
    const b = computeComponent(sheet, M({ cost_basis: "per_pack" }), L({ id: "l2", match_values: { SKU: "B2" } }));
    expect(giftCost([a, b]).cents).toBe(4000);
  });
  it("parses amounts strictly", () => {
    expect(parseAmount("1,234.50")).toBe(1234.5);
    expect(parseAmount("-1")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("12abc")).toBeNull();
  });
});

describe("Product Master refresh (fake read-only sheet)", () => {
  let sheetValues: unknown[][];
  let gift: any;
  let source: any;
  let failRead = false;
  beforeAll(async () => {
    await resetDb();
    sheetValues = [["SKU", "Variant", "Unit cost"], ["LTG-1", "Std", 4], ["LTG-2", "Std", 7.5]];
    setSheetsReader(async () => { if (failRead) throw new Error("No read access"); return sheetValues; });
    gift = (await call("POST", "/products", { ...S, name: "Live to Give Birthday Box", family: "live_to_give_box", selected: true })).body.product;
    source = (await call("POST", "/sources", {
      ...S, label: "Live to Give tab", spreadsheet: "https://docs.google.com/spreadsheets/d/example_spreadsheet_id_for_tests/edit#gid=0",
      vendor: "Live to Give", tab_name: "Live to Give", match_columns: ["SKU", "Variant"], cost_column: "Unit cost", cost_basis: "per_piece",
    })).body.source;
  });
  afterAll(() => setSheetsReader(null));

  it("lookup shows candidate rows for explicit selection", async () => {
    const r = await call("POST", `/sources/${source.id}/lookup`, { query: "ltg" });
    expect(r.body.rows).toHaveLength(2);
    expect(r.body.missing_headers).toEqual([]);
  });

  it("missing quantity is reported and does not save a cost", async () => {
    await call("POST", `/products/${gift.id}/source-links`, { ...S, source_mapping_id: source.id, match_values: { SKU: "LTG-1", Variant: "Std" } });
    const pv = (await call("POST", "/imports/product-master", S)).body.run;
    expect(pv.preview.items[0].status).toBe("error");
    expect(pv.preview.items[0].error).toMatch(/quantity/i);
    const cf = await call("POST", `/imports/product-master/${pv.id}/confirm`, S);
    expect(cf.body.saved).toBe(0);
    const p = (await call("GET", `/products/${gift.id}`)).body.product;
    expect(p.current_cost_cents).toBeNull();
  });

  it("preview → confirm saves dated snapshot; repeat refresh is no_change", async () => {
    const link = (await call("GET", `/products/${gift.id}/source-links`)).body.links[0];
    await call("PATCH", `/products/${gift.id}/source-links/${link.id}`, { ...S, quantity_per_gift: 5, version: link.version });
    const pv = (await call("POST", "/imports/product-master", S)).body.run;
    expect(pv.preview.items[0]).toMatchObject({ status: "changed", new_cents: 2000, old_cents: null });
    expect((await call("GET", `/products/${gift.id}`)).body.product.current_cost_cents).toBeNull(); // nothing saved before confirmation
    const cf = await call("POST", `/imports/product-master/${pv.id}/confirm`, S);
    expect(cf.body).toMatchObject({ status: "confirmed", saved: 1 });
    expect((await call("GET", `/products/${gift.id}`)).body.product.current_cost_cents).toBe(2000);
    const pv2 = (await call("POST", "/imports/product-master", S)).body.run;
    expect(pv2.preview.items[0].status).toBe("unchanged");
    expect((await call("POST", `/imports/product-master/${pv2.id}/confirm`, S)).body.status).toBe("no_change");
  });

  it("agreed prices keep their cost snapshot after a cost change; failures keep the last cost", async () => {
    const ch = (await call("GET", "/channels")).body.channels.find((c: any) => c.name === "Goody");
    const pr = (await call("POST", "/pricing", { ...S, channel_id: ch.id, product_id: gift.id, fulfillment_format: "individual", pricing_model: "fixed_supplier", status: "agreed", supplier_price_cents: 1800, approved_by: "Lead" })).body.record;
    expect(pr.snapshot_cost_cents).toBe(2000);

    sheetValues = [["SKU", "Variant", "Unit cost"], ["LTG-1", "Std", 2.8]]; // $14 gift cost
    const pv = (await call("POST", "/imports/product-master", S)).body.run;
    expect(pv.preview.items[0]).toMatchObject({ old_cents: 2000, new_cents: 1400 });
    await call("POST", `/imports/product-master/${pv.id}/confirm`, S);
    const after = (await call("GET", `/pricing/${pr.id}`)).body.record;
    expect(after.agreed_price_cents).toBe(1800);
    expect(after.snapshot_cost_cents).toBe(2000);
    expect(after.current_cost_cents).toBe(1400);

    // malformed / duplicate / failed access never overwrite
    for (const vals of [[["SKU", "Variant", "Unit cost"], ["LTG-1", "Std", "TBD"]], [["SKU", "Variant", "Unit cost"], ["LTG-1", "Std", 3], ["LTG-1", "Std", 3]]]) {
      sheetValues = vals;
      const x = (await call("POST", "/imports/product-master", S)).body.run;
      expect(x.preview.items[0].status).toBe("error");
      await call("POST", `/imports/product-master/${x.id}/confirm`, S);
    }
    failRead = true;
    const f = (await call("POST", "/imports/product-master", S)).body.run;
    expect(f.errors[0].message).toMatch(/access/);
    await call("POST", `/imports/product-master/${f.id}/confirm`, S);
    failRead = false;
    expect((await call("GET", `/products/${gift.id}`)).body.product.current_cost_cents).toBe(1400);
  });
});

describe("Shopify website refresh (fake storefront)", () => {
  const prod = (id: number, vids: number[], price = "25.00", title = `Gift ${id}`) => ({
    id, title, handle: `gift-${id}`, vendor: "Website label", images: [{ src: `https://cdn.shopify.com/${id}.png` }],
    variants: vids.map((v, i) => ({ id: v, title: vids.length > 1 ? `Size ${i}` : "Default Title", sku: `SKU-${v}`, price, available: true })),
  });
  let pages: any[][];
  let failOnPage: number | null = null;

  beforeAll(async () => {
    await resetDb();
    setShopifyFetcher(async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (failOnPage === page) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ products: pages[page - 1] ?? [] }), { status: 200 });
    });
  });
  afterAll(() => setShopifyFetcher(null));

  async function runImport() {
    let run = (await call("POST", "/imports/shopify", S)).body.run;
    for (let i = 0; i < 20 && run.status === "fetching"; i++) run = (await call("POST", `/imports/shopify/${run.id}/next`, S)).body.run;
    return run;
  }

  it("paginates, keeps variants distinct, dedupes and is idempotent", async () => {
    pages = [[prod(1, [11, 12]), prod(2, [21])], [prod(3, [31]), prod(2, [21])]]; // product 2 repeated across pages
    const run = await runImport();
    expect(run.status).toBe("previewed");
    expect(run.pages_fetched).toBe(2);
    expect(run.preview.new_count).toBe(4);
    const cf = await call("POST", `/imports/shopify/${run.id}/confirm`, S);
    expect(cf.body.summary.inserted).toBe(4);
    const again = await runImport();
    expect(again.preview.new_count).toBe(0);
    await call("POST", `/imports/shopify/${again.id}/confirm`, S);
    const all = (await call("GET", "/products?q=Gift&limit=200")).body;
    expect(all.total).toBe(4);
  });

  it("preserves team annotations; selected-gift price changes need confirmation", async () => {
    const p = (await call("GET", "/products?q=Gift 1&limit=200")).body.products.find((x: any) => x.shopify_variant_id === 11);
    await call("PATCH", `/products/${p.id}`, { ...S, selected: true, family: "succulent_arrangement", card_eligible: "no", individual_recipient_fulfillment: "yes", fulfillment_note: "Ships individually, no customization", version: p.version });
    pages = [[prod(1, [11, 12], "28.00", "Gift 1 renamed"), prod(2, [21], "30.00")], [prod(3, [31])]];
    const run = await runImport();
    expect(run.preview.selected_price_changes).toEqual([expect.objectContaining({ product_id: p.id, old_cents: 2500, new_cents: 2800 })]);
    await call("POST", `/imports/shopify/${run.id}/confirm`, { ...S, apply_price_for: [] }); // team declines the selected price change
    const after = (await call("GET", `/products/${p.id}`)).body.product;
    expect(after.name).toBe("Gift 1 renamed");
    expect(after.web_price_cents).toBe(2500);
    expect(after).toMatchObject({ selected: true, family: "succulent_arrangement", card_eligible: "no", individual_recipient_fulfillment: "yes" });
    const unselected = (await call("GET", "/products?q=Gift 2&limit=200")).body.products[0];
    expect(unselected.web_price_cents).toBe(3000);
  });

  it("failed/partial refresh changes nothing; missing items are only flagged after a complete import", async () => {
    pages = [[prod(1, [11, 12])], [prod(3, [31])]]; // product 2 gone
    failOnPage = 2;
    const failed = await runImport();
    expect(failed.status).toBe("failed");
    expect((await call("POST", `/imports/shopify/${failed.id}/confirm`, S)).status).toBe(400);
    let p2 = (await call("GET", "/products?q=Gift 2&limit=200")).body.products[0];
    expect(p2.not_seen_since).toBeNull();
    failOnPage = null;
    const ok = await runImport();
    expect(ok.preview.not_seen_count).toBe(1);
    await call("POST", `/imports/shopify/${ok.id}/confirm`, S);
    p2 = (await call("GET", "/products?q=Gift 2&limit=200")).body.products[0];
    expect(p2.not_seen_since).toBeTruthy();
    expect(p2.archived_at).toBeNull(); // never deleted or archived
  });
});

describe("public Product Master reading", () => {
  it("parses CSV with quoted commas, quotes and line breaks", async () => {
    const { parseCsv } = await import("../server/lib/sheets");
    expect(parseCsv('a,"b, c","say ""hi""","line1\nline2"\r\n1,2,3,4\n')).toEqual([
      ["a", "b, c", 'say "hi"', "line1\nline2"],
      ["1", "2", "3", "4"],
    ]);
  });
  it("matches headers that contain line breaks and extra spaces", () => {
    const sheet = parseSheet([["SKU", "Cost \n (what vendor receives)"], ["W-1", "$22.50"]], 1);
    const c = computeComponent(sheet, M({ cost_column: "Cost (what vendor receives)", cost_basis: "per_pack" }), L({ match_values: { SKU: "W-1" } }));
    expect(giftCost([c]).cents).toBe(2250);
  });
  it("takes the tab gid from a pasted tab link and requires it for public reads", async () => {
    const { gidFrom } = await import("../server/lib/sheets");
    expect(gidFrom("https://docs.google.com/spreadsheets/d/abc/edit?gid=1052830815#gid=1052830815")).toBe("1052830815");
    const { readSheet } = await import("../server/lib/sheets");
    await expect(readSheet({ spreadsheetId: "x".repeat(30), tabName: "T", gid: null, headerRow: 1, lastColumn: "Z" })).rejects.toThrow(/gid/);
  });
});
