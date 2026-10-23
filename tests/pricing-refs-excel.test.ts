// FIXTURE TESTS — synthetic gifts, a fake read-only sheet and in-memory workbooks. No real services.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { resetDb, call, raw, S } from "./helpers";
import { setSheetsReader } from "../server/lib/sheets";
import { getPool } from "../server/db";

let ch: Record<string, any>;
let giftA: any, giftB: any, dupSku1: any, potsSucc: any;
let sheetValues: unknown[][];

async function xlsx(rows: (string | number | Date | null | { formula: string })[][], name = "pricing.xlsx", tamper?: (z: JSZip) => void) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Pricing");
  for (const r of rows) ws.addRow(r as any[]);
  let buf = Buffer.from(await wb.xlsx.writeBuffer());
  if (tamper) { const z = await JSZip.loadAsync(buf); tamper(z); buf = Buffer.from(await z.generateAsync({ type: "nodebuffer" })); }
  return { filename: name, file_base64: buf.toString("base64") };
}
const HEAD = ["Channel", "Shopify variant ID", "Gift SKU", "Gift name (reference only)", "Pricing model", "Agreed supplier price (SB receives)",
  "Marketplace selling price", "Agreed price (custom terms)", "Proposed supplier price", "Commission % (optional)", "Fixed fee per unit (optional)",
  "Commission basis (optional)", "Custom terms", "Customer shipping charge", "MOQ", "Fulfillment format", "Status", "Effective from", "Effective to",
  "Approved by", "Notes", "SB retail price override", "Internal gift cost override", "Override source / note"];
const SUP = "Agreed supplier price (SB receives)";
const row = (o: Partial<Record<string, any>>) => HEAD.map((h) => (h in o ? o[h] : h === "Pricing model" ? "Fixed supplier price" : null));

beforeAll(async () => {
  await resetDb();
  ch = Object.fromEntries((await call("GET", "/channels")).body.channels.map((c: any) => [c.name, c]));
  const pool = getPool();
  // Synthetic website products (as a website refresh would create them)
  const ins = async (vid: number, name: string, variant: string, sku: string, price: number, family = "live_to_give_box") =>
    (await pool.query(
      `insert into products (source, shopify_product_id, shopify_variant_id, name, variant, sku, web_price_cents, selected, family) values ('shopify', 1, $1, $2, $3, $4, $5, true, $6) returning *`,
      [vid, name, variant, sku, price, family])).rows[0];
  giftA = await ins(91000001, "Synthetic Thank You Box", "Simple", "SYN-TY-S", 2800);
  giftB = await ins(91000002, "Synthetic Birthday Box", "Simple", "SYN-BD-S", 3000);
  dupSku1 = await ins(91000003, "Synthetic Duplicate SKU A", "One", "SYN-DUP", 1000);
  await ins(91000004, "Synthetic Duplicate SKU B", "Two", "SYN-DUP", 1100);
  potsSucc = (await pool.query("select * from products where family = 'pots_plus_succulents' limit 1")).rows[0];

  // Product Master: per-piece cost × confirmed quantity
  sheetValues = [["SKU", "Unit cost"], ["SYN-TY-S", 4]];
  setSheetsReader(async () => sheetValues);
  const src = (await call("POST", "/sources", { ...S, label: "Synthetic tab", spreadsheet: "https://docs.google.com/spreadsheets/d/example_spreadsheet_id_for_tests/edit#gid=123",
    vendor: "Synthetic vendor", tab_name: "Synthetic", match_columns: ["SKU"], cost_column: "Unit cost", cost_basis: "per_piece", cost_inclusions_note: "Includes handwritten card" })).body.source;
  await call("POST", `/products/${giftA.id}/source-links`, { ...S, source_mapping_id: src.id, match_values: { SKU: "SYN-TY-S" }, quantity_per_gift: 5 });
  const pv = (await call("POST", "/imports/product-master", S)).body.run;
  await call("POST", `/imports/product-master/${pv.id}/confirm`, S);
});
afterAll(() => setSheetsReader(null));

describe("pricing form references", () => {
  it("prefills retail, cost (basis, quantity, inclusions) and channel defaults", async () => {
    const r = (await call("GET", `/pricing/references?product_id=${giftA.id}&channel_id=${ch["Direct website"].id}`)).body.references;
    expect(r.retail).toMatchObject({ cents: 2800, source: "shopify" });
    expect(r.cost).toMatchObject({ cents: 2000, source: "product_master", includes: "Includes handwritten card" });
    expect(r.cost.components[0]).toMatchObject({ basis: "per_piece", quantity: 5, source_cost: 4 });
    expect(r.channel).toMatchObject({ corporate_moq: 12, default_discount_pct: 15 });
    expect(r.suggested_direct_price_cents).toBe(2380); // 2800 × (1 − 15%) with the demo discount
    const m = (await call("GET", `/pricing/references?product_id=${giftA.id}&channel_id=${ch["Demo Market Alpha"].id}`)).body.references;
    expect(m.suggested_direct_price_cents).toBeNull(); // the direct discount never sets marketplace prices
  });
  it("keeps unknown cost unknown and rejects typed reference numbers", async () => {
    const rec = (await call("POST", "/pricing", { ...S, pricing_model: "fixed_supplier", channel_id: ch["Demo Market Delta"].id, product_id: giftB.id, fulfillment_format: "individual" })).body.record;
    expect(rec).toMatchObject({ retail_ref_cents: 3000, retail_source: "shopify", internal_cost_cents: null, cost_source: null });
    const typed = await call("POST", "/pricing", { ...S, pricing_model: "fixed_supplier", channel_id: ch["Demo Market Delta"].id, product_id: giftB.id, fulfillment_format: "individual", internal_cost_cents: 0 });
    expect(typed.status).toBe(400);
  });
  it("manual values need reason, source and date and are labelled manual", async () => {
    const bad = await call("POST", "/pricing", { ...S, pricing_model: "fixed_supplier", channel_id: ch["Demo Market Echo"].id, product_id: giftB.id, fulfillment_format: "individual", cost_override: { cents: 1500 } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", "/pricing", { ...S, pricing_model: "fixed_supplier", channel_id: ch["Demo Market Echo"].id, product_id: giftB.id, fulfillment_format: "individual",
      cost_override: { cents: 1500, reason: "Vendor quote before Product Master update", source: "Email quote Q-SYN-1", date: "2026-10-01" } });
    expect(ok.body.record).toMatchObject({ internal_cost_cents: 1500, cost_source: "manual" });
    expect(ok.body.record.cost_source_detail).toMatchObject({ reason: "Vendor quote before Product Master update", source: "Email quote Q-SYN-1" });
  });
  it("agreed prices snapshot references; later refreshes show current values separately; revise creates a new version", async () => {
    const rec = (await call("POST", "/pricing", { ...S, pricing_model: "fixed_supplier", channel_id: ch["Demo Market Alpha"].id, product_id: giftA.id, fulfillment_format: "individual",
      status: "agreed", supplier_price_cents: 1800, approved_by: "Lead", payment_terms: "Net 30" })).body.record;
    expect(rec).toMatchObject({ snapshot_cost_cents: 2000, snapshot_retail_cents: 2800, cost_source: "product_master" });
    // cost rises 12 → 14 per gift, retail 25 → 28 (example from the brief, scaled)
    sheetValues = [["SKU", "Unit cost"], ["SYN-TY-S", 4.4]];
    const pv = (await call("POST", "/imports/product-master", S)).body.run;
    await call("POST", `/imports/product-master/${pv.id}/confirm`, S);
    await getPool().query("update products set web_price_cents = 3200 where id = $1", [giftA.id]);
    const now = (await call("GET", `/pricing/${rec.id}`)).body.record;
    expect(now).toMatchObject({ agreed_price_cents: 1800, snapshot_cost_cents: 2000, snapshot_retail_cents: 2800, current_cost_cents: 2200, current_retail_cents: 3200 });
    const rev = (await call("POST", `/pricing/${rec.id}/revisions`, { ...S, supplier_price_cents: 2000 })).body.record;
    expect(rev).toMatchObject({ previous_record_id: rec.id, internal_cost_cents: 2200, retail_ref_cents: 3200, status: "draft" });
    expect((await call("GET", `/pricing/${rec.id}`)).body.record.internal_cost_cents).toBe(2000);
  });
});

describe("Excel pricing import", () => {
  it("serves a template whose columns are recognised automatically", async () => {
    const res = await raw("GET", "/pricing-import/template");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.getWorksheet("Pricing")!;
    expect((ws.getRow(1).values as any[]).filter(Boolean)).toEqual(HEAD);
    const lists = wb.getWorksheet("Lists")!;
    expect((lists.getColumn(1).values as any[]).filter(Boolean)).toContain("Demo Supplier Golf");
    // fill one row in the downloaded template and upload it: columns need no manual mapping
    ws.getRow(2).values = row({ Channel: "Demo Market Foxtrot", "Shopify variant ID": "91000002", "Fulfillment format": "Individual", Status: "Draft" });
    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await call("POST", "/pricing-import/preview", { ...S, filename: "template-filled.xlsx", file_base64: out.toString("base64") });
    expect(r.body.missing).toEqual([]);
    expect(r.body.rows[0]).toMatchObject({ valid: true, action: "create" });
    await call("POST", `/pricing-import/${r.body.batch_id}/discard`, S);
  });
  it("rejects formulas and macro-enabled files", async () => {
    const f = await call("POST", "/pricing-import/preview", { ...S, ...(await xlsx([HEAD, row({ Channel: "Demo Market Delta", "Gift SKU": "SYN-TY-S", [SUP]: { formula: "1+1" }, "Fulfillment format": "Individual", Status: "Draft" })])) });
    // the worksheet is refused (another worksheet could still be chosen); nothing can be saved from it
    expect(f.status).toBe(200);
    expect(f.body.sheet_error).toMatch(/Formulas are not accepted/);
    expect(f.body.rows).toEqual([]);
    const cf = await call("POST", `/pricing-import/${f.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: f.body.version });
    expect(cf.status).toBe(400);
    const m = await call("POST", "/pricing-import/preview", { ...S, ...(await xlsx([HEAD], "prices.xlsm")) });
    expect(m.body.error.message).toMatch(/macro/i);
    const vba = await call("POST", "/pricing-import/preview", { ...S, ...(await xlsx([HEAD], "prices.xlsx", (z) => z.file("xl/vbaProject.bin", "x"))) });
    expect(vba.body.error.message).toMatch(/Macro/);
  });
  let batch: any;
  it("previews matches, errors, ambiguity, duplicates and fulfilment restrictions", async () => {
    const file = await xlsx([
      HEAD,
      row({ Channel: "demo market delta ", "Shopify variant ID": "91000001", "Gift name (reference only)": "Synthetic Thank You Box", "Proposed supplier price": 19, "Fulfillment format": "Individual", Status: "Draft", "Customer shipping charge": "" }),
      row({ Channel: "Demo Market Delta", "Gift SKU": "SYN-DUP", "Fulfillment format": "Individual", Status: "Draft", "Proposed supplier price": 9 }),
      row({ Channel: "Demo Market Delta", "Gift SKU": "NOPE-1", "Fulfillment format": "Individual", Status: "Draft" }),
      row({ Channel: "Demo Market Delta", "Gift SKU": "SYN-BD-S", "Fulfillment format": "Individual", Status: "Draft", "Proposed supplier price": "-3" }),
      row({ Channel: "Unknown Co", "Gift SKU": "SYN-BD-S", "Fulfillment format": "Individual", Status: "Draft" }),
      row({ Channel: "Demo Market Charlie", "Shopify variant ID": String(potsSucc.shopify_variant_id), "Fulfillment format": "Individual", Status: "Proposed" }),
      row({ Channel: "Demo Market Foxtrot", "Gift SKU": "SYN-BD-S", "Fulfillment format": "Bulk — one location", Status: "Agreed", [SUP]: "21.50", "Commission % (optional)": 150 }),
      row({ Channel: "Demo Supplier Golf", "Gift SKU": "SYN-BD-S", "Fulfillment format": "Bulk — one location", Status: "Agreed", [SUP]: 22, "SB retail price override": 31, "Override source / note": "Wholesale list 2026" }),
      row({ Channel: "Demo Supplier Golf", "Gift SKU": "SYN-BD-S", "Fulfillment format": "Bulk — one location", Status: "Draft" }),
    ], "synthetic-pricing.xlsx");
    const r = await call("POST", "/pricing-import/preview", { ...S, ...file });
    expect(r.status).toBe(200);
    batch = r.body;
    const byRow = Object.fromEntries(r.body.rows.map((x: any) => [x.ref, x]));
    expect(byRow["row 2"]).toMatchObject({ valid: true, action: "create", match: "variant_id" });
    expect(byRow["row 2"].input.customer_shipping_cents).toBeNull(); // blank = unspecified, not zero
    expect(byRow["row 3"].errors.join()).toMatch(/matches 2 gifts/);
    expect(byRow["row 3"].candidates).toHaveLength(2);
    expect(byRow["row 4"].errors.join()).toMatch(/No gift with SKU/);
    expect(byRow["row 5"].errors.join()).toMatch(/non-negative/);
    expect(byRow["row 6"].errors.join()).toMatch(/Unknown channel/);
    expect(byRow["row 7"].errors.join()).toMatch(/bulk-only/);
    expect(byRow["row 8"].errors.join()).toMatch(/0–100/);
    expect(byRow["row 9"].errors.join()).toMatch(/Duplicate/);
    expect(byRow["row 10"].errors.join()).toMatch(/Duplicate/);
  });
  it("lets the team resolve an ambiguous gift (never by name) and confirms selected valid rows only", async () => {
    const re = await call("POST", `/pricing-import/${batch.batch_id}/preview`, { ...S, resolutions: { "row 3": dupSku1.id } });
    const r3 = re.body.rows.find((x: any) => x.ref === "row 3");
    expect(r3).toMatchObject({ valid: true, match: "resolved" });
    const noName = await call("POST", "/pricing-import/" + batch.batch_id + "/confirm", { selected: ["row 2"], version: re.body.version });
    expect(noName.status).toBe(400); // name required
    const cf = await call("POST", `/pricing-import/${batch.batch_id}/confirm`, { ...S, selected: ["row 2", "row 3", "row 4"], version: re.body.version });
    expect(cf.status).toBe(200);
    expect(cf.body.summary.results).toMatchObject({ create: 2, skipped_invalid: 1 });
    const created = (await call("GET", `/pricing?channel_id=${ch["Demo Market Delta"].id}`)).body.pricing.filter((p: any) => p.import_batch_id === batch.batch_id);
    expect(created).toHaveLength(2);
    expect(created[0].import_row_ref).toMatch(/synthetic-pricing\.xlsx row/);
  });
  it("re-uploading the same rows creates nothing", async () => {
    const file = await xlsx([HEAD, row({ Channel: "Demo Market Delta", "Shopify variant ID": "91000001", "Proposed supplier price": 19, "Fulfillment format": "Individual", Status: "Draft" })], "again.xlsx");
    const r = await call("POST", "/pricing-import/preview", { ...S, ...file });
    expect(r.body.rows[0]).toMatchObject({ valid: true, action: "no_change" });
    const before = (await call("GET", "/pricing")).body.pricing.length;
    await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: r.body.version });
    expect((await call("GET", "/pricing")).body.pricing.length).toBe(before);
  });
  it("updates drafts only through the previewed action; agreed prices get a new version only after explicit confirmation", async () => {
    // draft update
    let r = await call("POST", "/pricing-import/preview", { ...S, ...(await xlsx([HEAD, row({ Channel: "Demo Market Delta", "Shopify variant ID": "91000001", "Proposed supplier price": 20.5, "Fulfillment format": "Individual", Status: "Proposed" })], "upd.xlsx")) });
    expect(r.body.rows[0].action).toBe("update_draft");
    expect(r.body.rows[0].changes.map((c: any) => c.field)).toEqual(expect.arrayContaining(["Proposed supplier price", "Status"]));
    await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: r.body.version });
    const draft = (await call("GET", `/pricing?channel_id=${ch["Demo Market Delta"].id}&product_id=${giftA.id}`)).body.pricing[0];
    expect(draft).toMatchObject({ proposed_supplier_cents: 2050, status: "proposed" });

    // agreed record (Demo Market Alpha, created earlier in the form tests) → changed price needs version confirmation
    r = await call("POST", "/pricing-import/preview", { ...S, ...(await xlsx([HEAD, row({ Channel: "Demo Market Alpha", "Gift SKU": "SYN-TY-S", [SUP]: 19, "Fulfillment format": "Individual", Status: "Agreed" })], "ver.xlsx")) });
    expect(r.body.rows[0].action).toBe("update_draft"); // the open revision draft is the head
  });
  it("flags overlapping active periods and supersedes an earlier active price only when valid", async () => {
    const mk = (from: string, price: number, name: string) => xlsx([HEAD, row({ Channel: "Demo Market Echo", "Shopify variant ID": "91000001", [SUP]: price, "Fulfillment format": "Bulk — one location", Status: "Active", "Effective from": from })], name);
    let r = await call("POST", "/pricing-import/preview", { ...S, ...(await mk("2026-10-01", 18, "a1.xlsx")) });
    expect(r.body.rows[0]).toMatchObject({ valid: true, action: "create" });
    await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: r.body.version });
    let recs = (await call("GET", `/pricing?channel_id=${ch["Demo Market Echo"].id}&product_id=${giftA.id}`)).body.pricing;
    expect(recs.find((x: any) => x.fulfillment_format === "bulk_one_location").status).toBe("active");

    r = await call("POST", "/pricing-import/preview", { ...S, ...(await mk("2026-09-15", 17, "a2.xlsx")) });
    expect(r.body.rows[0].errors.join()).toMatch(/Overlaps the active price/);

    r = await call("POST", "/pricing-import/preview", { ...S, ...(await mk("2026-11-01", 19, "a3.xlsx")) });
    expect(r.body.rows[0]).toMatchObject({ valid: true, action: "new_version" });
    expect(r.body.rows[0].warnings.join()).toMatch(/Will close the active price/);
    const skip = await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: r.body.version });
    expect(skip.body.summary.results).toMatchObject({ skipped_needs_version_confirmation: 1 });
    r = await call("POST", "/pricing-import/preview", { ...S, ...(await mk("2026-11-01", 19, "a3.xlsx")) });
    await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], confirm_versions: ["row 2"], version: r.body.version });
    recs = (await call("GET", `/pricing?channel_id=${ch["Demo Market Echo"].id}&product_id=${giftA.id}&include_expired=1`)).body.pricing.filter((x: any) => x.fulfillment_format === "bulk_one_location");
    expect(recs.map((x: any) => [x.status, x.agreed_price_cents]).sort()).toEqual([["active", 1900], ["expired", 1800]]);
    expect(recs.find((x: any) => x.status === "expired").effective_to).toBe("2026-10-31");
  });
  it("maps an unknown layout manually and labels Excel overrides as manual values", async () => {
    const file = await xlsx([
      ["Partner", "Variant", "Deal price", "Format", "Stage", "List price", "Where from"],
      ["Demo Supplier Hotel", "91000002", 25, "Bulk — multiple shipments", "Proposed", 33, "Partner catalog Oct"],
    ], "partner-layout.xlsx");
    let r = await call("POST", "/pricing-import/preview", { ...S, ...file });
    expect(r.body.missing.length).toBeGreaterThan(0);
    r = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S, mapping: { channel: "Partner", variant_id: "Variant", proposed_supplier_price: "Deal price", fulfillment_format: "Format", status: "Stage", retail_override: "List price", override_note: "Where from" }, settings: { pricing_model: "fixed_supplier" } });
    expect(r.body.missing).toEqual([]);
    expect(r.body.rows[0]).toMatchObject({ valid: true, action: "create" });
    await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: r.body.version });
    const rec = (await call("GET", `/pricing?channel_id=${ch["Demo Supplier Hotel"].id}`)).body.pricing[0];
    expect(rec).toMatchObject({ retail_ref_cents: 3300, retail_source: "manual", proposed_supplier_cents: 2500 });
    expect(rec.retail_source_detail.source).toMatch(/File partner-layout\.xlsx, row 2/);
    // Shopify/Product Master values are untouched
    expect((await call("GET", `/products/${giftB.id}`)).body.product.web_price_cents).toBe(3000);
  });
});
