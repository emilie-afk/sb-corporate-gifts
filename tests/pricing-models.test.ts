// FIXTURE TESTS — pricing models (fixed supplier / commission / custom / direct) and .xlsx/.csv imports
// with marketplace-style layouts. Synthetic gifts and in-memory files only.
import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { resetDb, call, S } from "./helpers";
import { getPool } from "../server/db";
import { interpretPricing, checkPricingModel } from "../shared/pricingModel";

let ch: Record<string, any>;
let gA: any, gB: any, gC: any;

const csv = (text: string, name = "prices.csv", bom = false) =>
  ({ filename: name, file_base64: Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]).toString("base64") });
const byRef = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.ref, r]));

beforeAll(async () => {
  await resetDb();
  ch = Object.fromEntries((await call("GET", "/channels")).body.channels.map((c: any) => [c.name, c]));
  const ins = async (vid: number, name: string, sku: string, price: number) => (await getPool().query(
    `insert into products (source, shopify_product_id, shopify_variant_id, name, variant, sku, web_price_cents, selected, family)
     values ('shopify', 7, $1, $2, 'Simple', $3, $4, true, 'live_to_give_box') returning *`, [vid, name, sku, price])).rows[0];
  gA = await ins(92000001, "Model Test Box A", "MOD-A", 4000);
  gB = await ins(92000002, "Model Test Box B", "MOD-B", 5000);
  gC = await ins(92000003, "Model Test Box C", "MOD-C", 6000);
});

describe("shared pricing-model rules", () => {
  it("only requires the fields of the chosen model, and only when agreed", () => {
    expect(checkPricingModel({ pricing_model: "fixed_supplier", status: "draft" }).errors).toEqual({});
    expect(checkPricingModel({ pricing_model: "fixed_supplier", status: "agreed" }).errors).toHaveProperty("supplier_price_cents");
    expect(checkPricingModel({ pricing_model: "commission", status: "draft", selling_price_cents: 4000 }).errors).toEqual({});
    expect(Object.keys(checkPricingModel({ pricing_model: "commission", status: "agreed" }).errors).sort()).toEqual(["commission_basis", "commission_pct", "selling_price_cents"]);
    expect(Object.keys(checkPricingModel({ pricing_model: "custom", status: "agreed" }).errors).sort()).toEqual(["agreed_price_cents", "custom_terms"]);
  });
  it("never deducts a marketplace margin from a fixed supplier price", () => {
    const e = checkPricingModel({ pricing_model: "fixed_supplier", supplier_price_cents: 2400, commission_pct: 15 }).errors;
    expect(e.commission_pct).toMatch(/already what SB receives/);
    const i = interpretPricing({ pricing_model: "fixed_supplier", supplier_price_cents: 2400, selling_price_cents: 4000 });
    expect(i.sbReceivesCents).toBe(2400);
    expect(i.notes.join()).toMatch(/informational/);
  });
  it("calculates commission from the stated basis; blank commission is unknown, not 0%", () => {
    expect(interpretPricing({ pricing_model: "commission", selling_price_cents: 4000, commission_basis: "selling_price", commission_pct: 15 }).sbReceivesCents).toBe(3400);
    expect(interpretPricing({ pricing_model: "commission", selling_price_cents: 4000, commission_basis: "selling_price", commission_pct: 10, fixed_fee_cents: 150 }).sbReceivesCents).toBe(3450);
    expect(interpretPricing({ pricing_model: "commission", selling_price_cents: 4500, commission_basis: "retail_price", commission_pct: 20, retail_ref_cents: 5000 }).sbReceivesCents).toBe(4000);
    const blank = interpretPricing({ pricing_model: "commission", selling_price_cents: 4000, commission_basis: "selling_price" });
    expect(blank.sbReceivesCents).toBeNull();
    expect(blank.explanation).toMatch(/not specified/);
    expect(interpretPricing({ pricing_model: "custom", agreed_price_cents: 3000, commission_pct: 5, custom_terms: "Quarterly rebate" }).sbReceivesCents).toBeNull();
    expect(interpretPricing({ agreed_price_cents: 3000 }).modelLabel).toBe("Model not specified");
  });
});

describe("pricing API by model", () => {
  it("fixed supplier price: agreed price = supplier price; commission refused; typed agreed price refused", async () => {
    const base = { ...S, channel_id: ch["Demo Market Delta"].id, product_id: gA.id, fulfillment_format: "individual", pricing_model: "fixed_supplier" };
    const withFee = await call("POST", "/pricing", { ...base, supplier_price_cents: 2400, commission_pct: 15 });
    expect(withFee.status).toBe(400);
    expect(withFee.body.error.details.fields.commission_pct).toMatch(/no commission or fee is deducted/);
    const typed = await call("POST", "/pricing", { ...base, supplier_price_cents: 2400, agreed_price_cents: 3000 });
    expect(typed.status).toBe(400);
    expect((await call("POST", "/pricing", { ...base, status: "agreed", approved_by: "Lead" })).body.error.details.fields).toHaveProperty("supplier_price_cents");
    const ok = await call("POST", "/pricing", { ...base, status: "agreed", supplier_price_cents: 2400, selling_price_cents: 3900, approved_by: "Lead" });
    expect(ok.status).toBe(200);
    expect(ok.body.record).toMatchObject({ pricing_model: "fixed_supplier", supplier_price_cents: 2400, agreed_price_cents: 2400, commission_pct: null, fixed_fee_cents: null });
    // database refuses a margin on a fixed supplier price even outside the API
    await expect(getPool().query("update pricing_records set commission_pct = 10 where id = $1", [ok.body.record.id])).rejects.toThrow();
  });

  it("commission-based: commission optional for drafts (blank stays null), required to agree", async () => {
    const base = { ...S, channel_id: ch["Demo Market Alpha"].id, product_id: gA.id, fulfillment_format: "individual", pricing_model: "commission" };
    const draft = (await call("POST", "/pricing", { ...base, selling_price_cents: 4000 })).body.record;
    expect(draft).toMatchObject({ commission_pct: null, fixed_fee_cents: null, agreed_price_cents: 4000 });
    const noComm = await call("PATCH", `/pricing/${draft.id}`, { ...S, status: "agreed", approved_by: "Lead", commission_basis: "selling_price", version: draft.version });
    expect(noComm.status).toBe(400);
    expect(noComm.body.error.details.fields.commission_pct).toMatch(/0 if there is none/);
    const agreed = await call("PATCH", `/pricing/${draft.id}`, { ...S, status: "agreed", approved_by: "Lead", commission_basis: "selling_price", commission_pct: 15, version: draft.version });
    expect(agreed.status).toBe(200);
    expect(agreed.body.record).toMatchObject({ agreed_price_cents: 4000, commission_basis: "selling_price" });
    expect(Number(agreed.body.record.commission_pct)).toBe(15);
    const basisOther = await call("POST", "/pricing", { ...base, channel_id: ch["Demo Market Echo"].id, selling_price_cents: 4000, commission_basis: "other" });
    expect(basisOther.body.error.details.fields).toHaveProperty("commission_basis_note");
  });

  it("other / custom terms: agreed price + explained terms; direct model only on the direct website", async () => {
    const base = { ...S, channel_id: ch["Demo Market Foxtrot"].id, product_id: gA.id, fulfillment_format: "bulk_one_location", pricing_model: "custom" };
    expect((await call("POST", "/pricing", { ...base, status: "agreed", agreed_price_cents: 3100, approved_by: "Lead" })).body.error.details.fields).toHaveProperty("custom_terms");
    const ok = await call("POST", "/pricing", { ...base, status: "agreed", agreed_price_cents: 3100, approved_by: "Lead", custom_terms: "Price includes a 5% year-end rebate paid by SB", commission_pct: 5 });
    expect(ok.status).toBe(200);
    const wrongDirect = await call("POST", "/pricing", { ...S, channel_id: ch["Demo Market Delta"].id, product_id: gB.id, fulfillment_format: "individual", pricing_model: "direct" });
    expect(wrongDirect.body.error.details.fields.pricing_model).toMatch(/only for the direct website/);
    const wrongMarket = await call("POST", "/pricing", { ...S, channel_id: ch["Direct website"].id, product_id: gB.id, fulfillment_format: "individual", pricing_model: "fixed_supplier" });
    expect(wrongMarket.body.error.details.fields.pricing_model).toMatch(/Direct sale/);
    expect((await call("POST", "/pricing", { ...S, channel_id: ch["Demo Market Delta"].id, product_id: gB.id, fulfillment_format: "individual" })).body.error.details.fields.pricing_model).toBeTruthy();
  });

  it("older records without a model stay readable; revising one requires choosing a model", async () => {
    const legacy = (await getPool().query(
      `insert into pricing_records (channel_id, product_id, status, agreed_price_cents, fulfillment_format, entered_by, approved_by, approved_at)
       values ($1, $2, 'agreed', 2500, 'individual', 'Old entry', 'Lead', now()) returning *`, [ch["Demo Market Echo"].id, gC.id])).rows[0];
    const r = (await call("GET", `/pricing/${legacy.id}`)).body.record;
    expect(r).toMatchObject({ pricing_model: null, agreed_price_cents: 2500 });
    expect((await call("POST", `/pricing/${legacy.id}/revisions`, { ...S })).status).toBe(400);
    const rev = await call("POST", `/pricing/${legacy.id}/revisions`, { ...S, pricing_model: "fixed_supplier", supplier_price_cents: 2500 });
    expect(rev.status).toBe(200);
    expect(rev.body.record).toMatchObject({ pricing_model: "fixed_supplier", agreed_price_cents: 2500, previous_record_id: legacy.id });
  });
});

describe("pricing file import — any layout, .xlsx or .csv", () => {
  it("CSV marketplace layout: suggests Wholesale price → supplier price, never maps a bare “Price”", async () => {
    const r = await call("POST", "/pricing-import/preview", { ...S, ...csv(
      "SKU,Product,Wholesale price,MSRP,Price\r\nMOD-A,Model Test Box A,\"$24.00\",40,39.99\r\nmod-b,Box B,26,50,\r\n", "partner-prices.csv", true) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ file_kind: "csv", sheet: "CSV", header_row: 1 });
    expect(r.body.suggested).toMatchObject({ sku: "SKU", gift_name: "Product", supplier_price: "Wholesale price" });
    expect(Object.values(r.body.mapping)).not.toContain("Price");
    expect(Object.values(r.body.mapping)).not.toContain("MSRP");
    expect(r.body.notes.join(" ")).toMatch(/“MSRP”, “Price”/);
    expect(r.body.missing.join()).toMatch(/channel/); // the file has no channel column
    const re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S,
      settings: { channel_id: ch["Demo Market Delta"].id, pricing_model: "fixed_supplier", fulfillment_format: "individual" } });
    expect(re.body.missing).toEqual([]);
    const rows = byRef(re.body.rows);
    expect(rows["row 2"]).toMatchObject({ valid: true, action: "no_change", model: "fixed_supplier", model_source: "file" }); // same as the agreed API price
    expect(rows["row 2"].interpretation).toMatchObject({ sbReceivesCents: 2400, headlineLabel: "Agreed supplier price (SB receives)" });
    expect(rows["row 3"].product.sku).toBe("MOD-B"); // exact SKU, case-insensitive
    const cf = await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2", "row 3"], version: re.body.version });
    expect(cf.body.summary.results).toMatchObject({ create: 1, no_change: 1 });
    const recs = (await call("GET", `/pricing?channel_id=${ch["Demo Market Delta"].id}&product_id=${gB.id}`)).body.pricing;
    expect(recs[0]).toMatchObject({ pricing_model: "fixed_supplier", supplier_price_cents: 2600, commission_pct: null, status: "draft" });
  });

  it("commission layout (semicolon CSV): basis + commission interpreted; blank commission is not 0%; agreed rows need it", async () => {
    const r = await call("POST", "/pricing-import/preview", { ...S, ...csv(
      "Variant ID;Selling price;Commission %;Fee;Status\n92000002;45.00;15%;;Agreed\n92000003;60;;;Draft\n92000001;40;;;Agreed\n", "commission.csv") });
    expect(r.body.suggested).toMatchObject({ variant_id: "Variant ID", selling_price: "Selling price", commission_pct: "Commission %", status: "Status" });
    const re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S,
      mapping: { ...r.body.mapping, fixed_fee: "Fee" },
      settings: { channel_id: ch["Demo Market Echo"].id, pricing_model: "commission", commission_basis: "selling_price", fulfillment_format: "bulk_one_location" } });
    const rows = byRef(re.body.rows);
    expect(rows["row 2"]).toMatchObject({ valid: true });
    expect(rows["row 2"].interpretation).toMatchObject({ sbReceivesCents: 3825, basisLabel: "Marketplace selling price" });
    expect(rows["row 2"].input).toMatchObject({ commission_pct: 15, fixed_fee_cents: null, agreed_price_cents: 4500 });
    expect(rows["row 3"]).toMatchObject({ valid: true });
    expect(rows["row 3"].input.commission_pct).toBeNull();
    expect(rows["row 3"].warnings.join()).toMatch(/blank is not 0%/);
    expect(rows["row 4"].errors.join()).toMatch(/Commission %.*0 if there is none/);
  });

  it("per-row model overrides; fixed rows with a commission are rejected instead of deducted twice", async () => {
    const r = await call("POST", "/pricing-import/preview", { ...S, ...csv(
      "SKU,Net price,Selling price,Commission %,Terms\nMOD-A,22,,,\nMOD-B,,48,12,\nMOD-C,30,,10,\n", "mixed.csv") });
    const settings = { channel_id: ch["Demo Supplier Hotel"].id, pricing_model: "fixed_supplier", fulfillment_format: "bulk_multiple_shipments" };
    let re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S, settings });
    expect(re.body.suggested).toMatchObject({ supplier_price: "Net price", selling_price: "Selling price", commission_pct: "Commission %", custom_terms: "Terms" });
    let rows = byRef(re.body.rows);
    expect(rows["row 2"].valid).toBe(true);
    expect(rows["row 3"].errors.join()).toMatch(/already what SB receives/);
    expect(rows["row 4"].errors.join()).toMatch(/already what SB receives/);
    re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S, row_models: { "row 3": "commission", "row 4": "custom" } });
    rows = byRef(re.body.rows);
    expect(rows["row 3"]).toMatchObject({ valid: true, model: "commission", model_source: "row" });
    expect(rows["row 4"].errors.join()).toMatch(/supplier price/i); // custom terms don't use the supplier price column
    expect(re.body.notes.join()).toMatch(/commission\/fee columns don't apply/);
  });

  it("xlsx: choose the worksheet, detect a header row below title rows, read %-formatted cells", async () => {
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet("Summary");
    sum.addRow(["Total", { formula: "SUM(1,2)" }]);
    const ws = wb.addWorksheet("Q4 price list");
    ws.addRow(["Partner price list — Q4"]);
    ws.addRow([]);
    ws.addRow(["Item SKU", "Item name", "Sale price", "Take rate"]);
    ws.addRow(["MOD-C", "Box C", 50, 0.12]);
    ws.getCell("D4").numFmt = "0%";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await call("POST", "/pricing-import/preview", { ...S, filename: "partner.xlsx", file_base64: buf.toString("base64") });
    expect(r.body.sheets.map((s: any) => s.name)).toEqual(["Summary", "Q4 price list"]);
    expect(r.body.sheet).toBe("Summary");
    expect(r.body.sheet_error).toMatch(/Formulas are not accepted/);
    const re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S, sheet: "Q4 price list",
      settings: { channel_id: ch["Demo Market Foxtrot"].id, pricing_model: "commission", commission_basis: "selling_price", fulfillment_format: "bulk_one_location" } });
    expect(re.body).toMatchObject({ sheet: "Q4 price list", header_row: 3, sheet_error: null });
    expect(re.body.suggested).toMatchObject({ sku: "Item SKU", gift_name: "Item name", selling_price: "Sale price", commission_pct: "Take rate" });
    const row = re.body.rows[0];
    expect(row).toMatchObject({ ref: "row 4", valid: true });
    expect(row.input.commission_pct).toBe(12);
    expect(row.interpretation.sbReceivesCents).toBe(4400);
    const cf = await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 4"], version: re.body.version });
    expect(cf.body.summary.results).toMatchObject({ create: 1 });
    // only the chosen worksheet's values are kept after confirming
    const stored = (await getPool().query("select rows from pricing_import_batches where id = $1", [r.body.batch_id])).rows[0].rows;
    expect(stored.sheets).toBeUndefined();
    expect(stored.sheet).toBe("Q4 price list");
  });

  it("switching an existing draft to a fixed supplier price clears its commission instead of deducting it", async () => {
    const d = (await call("POST", "/pricing", { ...S, channel_id: ch["Demo Market Delta"].id, product_id: gC.id, fulfillment_format: "bulk_one_location",
      pricing_model: "commission", selling_price_cents: 6000, commission_pct: 20, commission_basis: "selling_price" })).body.record;
    const r = await call("POST", "/pricing-import/preview", { ...S, ...csv("SKU,Vendor price\nMOD-C,41\n", "switch.csv") });
    const re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S,
      settings: { channel_id: ch["Demo Market Delta"].id, pricing_model: "fixed_supplier", fulfillment_format: "bulk_one_location" } });
    const row = re.body.rows[0];
    expect(row).toMatchObject({ valid: true, action: "update_draft" });
    expect(row.changes.map((c: any) => c.field)).toEqual(expect.arrayContaining(["Pricing model", "Agreed supplier price", "Commission %", "Commission basis"]));
    expect(row.interpretation.sbReceivesCents).toBe(4100);
    await call("POST", `/pricing-import/${r.body.batch_id}/confirm`, { ...S, selected: ["row 2"], version: re.body.version });
    const after = (await call("GET", `/pricing/${d.id}`)).body.record;
    expect(after).toMatchObject({ pricing_model: "fixed_supplier", supplier_price_cents: 4100, agreed_price_cents: 4100, commission_pct: null, commission_basis: null, selling_price_cents: 6000 });
  });

  it("re-uploading the same commission rows creates nothing new", async () => {
    const file = csv("Item SKU,Sale price,Take rate\nMOD-C,50,12\n", "again.csv");
    const r = await call("POST", "/pricing-import/preview", { ...S, ...file });
    const re = await call("POST", `/pricing-import/${r.body.batch_id}/preview`, { ...S,
      settings: { channel_id: ch["Demo Market Foxtrot"].id, pricing_model: "commission", commission_basis: "selling_price", fulfillment_format: "bulk_one_location" } });
    expect(re.body.rows[0]).toMatchObject({ valid: true, action: "no_change" });
  });
});
