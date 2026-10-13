// Pricing file import (.xlsx or .csv, any column layout):
// upload → choose worksheet / header row → confirm suggested column meanings + file-level settings
// (channel, pricing model, …) → match gifts by stable identifiers → preview interpreted prices and terms →
// team selects rows, types their name, confirms → saved with batch + row reference.
import { z } from "zod";
import type pg from "pg";
import { Router, updateVersioned } from "../router";
import { query, one, tx, getPool, type Db } from "../db";
import { audit, type Actor } from "../audit";
import { HttpError, badRequest, notFound, conflict } from "../http";
import { parse, assertUuid, version } from "../validate";
import {
  parseUpload, tableOf, detectHeaderRow, defaultSheet, autoMapping, missingRequired, buildTemplate, isAmbiguousHeader,
  WorkbookRejected, TEMPLATE_COLUMNS, FIELD_KEYS, FORMAT_VALUES, STATUS_VALUES, MODEL_VALUES, BASIS_VALUES,
  parseMoneyCell, parsePctCell, parseIntCell, parseDateCell, parseIdCell, norm,
  type FieldKey, type RawRow, type Sheet, type FileSettings,
} from "../lib/pricingExcel";
import { insertRecord, activateRecord, snapshotFields, checkProductRules, PRICE_FIELD_KEYS } from "./pricing";
import { resolveReferenceFields, type Override } from "../lib/pricingRefs";
import { checkPricingModel, interpretPricing, PRICING_MODELS, MODEL_LABEL, type Interpretation } from "../../shared/pricingModel";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Mapping = Partial<Record<FieldKey, string>>;
type Resolutions = Record<string, string>; // row ref → product id chosen by the team
type RowModels = Record<string, string>;   // row ref → pricing model chosen by the team

export type PlannedRow = {
  ref: string;
  row: number;
  values: Record<string, unknown>;
  channel: { id: string; name: string } | null;
  product: { id: string; name: string; variant: string | null; sku: string | null; family: string | null } | null;
  candidates: { id: string; name: string; variant: string | null; sku: string | null }[];
  match: "variant_id" | "sku" | "resolved" | null;
  model: string | null;
  model_source: "row" | "column" | "file" | null;
  input: Record<string, any> | null;
  interpretation: Interpretation | null;
  action: "create" | "update_draft" | "new_version" | "no_change" | null;
  existing: { id: string; status: string; version: number; agreed_price_cents: number | null; effective_from: string | null; effective_to: string | null } | null;
  changes: { field: string; from: unknown; to: unknown }[];
  errors: string[];
  warnings: string[];
  valid: boolean;
};

/** Compared with the existing record to decide new / update / new version / no change. */
const COMPARE: [string, string][] = [
  ["pricing_model", "Pricing model"], ["supplier_price_cents", "Agreed supplier price"], ["selling_price_cents", "Marketplace selling price"],
  ["agreed_price_cents", "Agreed price"], ["proposed_supplier_cents", "Proposed supplier price"],
  ["commission_pct", "Commission %"], ["fixed_fee_cents", "Fixed fee"], ["commission_basis", "Commission basis"],
  ["commission_basis_note", "Commission basis note"], ["custom_terms", "Custom terms"],
  ["customer_shipping_cents", "Customer shipping charge"], ["moq", "MOQ"], ["effective_from", "Effective from"],
  ["effective_to", "Effective to"], ["agreement_notes", "Notes"],
];
/** Fields of an existing record that no longer apply when the model changes. */
const CLEAR_FOR_MODEL: Record<string, string[]> = {
  fixed_supplier: ["commission_pct", "fixed_fee_cents", "commission_basis", "commission_basis_note"],
  commission: ["supplier_price_cents"],
  custom: ["supplier_price_cents"],
  direct: ["commission_pct", "fixed_fee_cents", "commission_basis", "commission_basis_note", "supplier_price_cents", "selling_price_cents"],
};
const FIELD_LABEL: Record<string, string> = {
  pricing_model: "Pricing model", supplier_price_cents: "Agreed supplier price", selling_price_cents: "Marketplace selling price",
  agreed_price_cents: "Agreed price", commission_pct: "Commission %", fixed_fee_cents: "Fixed fee", commission_basis: "Commission basis",
  commission_basis_note: "Commission basis note", custom_terms: "Custom terms",
};
const STATUS_RANK: Record<string, number> = { draft: 0, proposed: 1, agreed: 2, active: 3 };

const settingsSchema = z.object({
  channel_id: z.union([z.string().uuid(), z.null()]).optional(),
  pricing_model: z.union([z.enum(PRICING_MODELS), z.null()]).optional(),
  commission_basis: z.union([z.enum(["selling_price", "retail_price", "other"]), z.null()]).optional(),
  fulfillment_format: z.union([z.enum(["individual", "corporate_separate_addresses", "bulk_one_location", "bulk_multiple_shipments"]), z.null()]).optional(),
  status: z.union([z.enum(["draft", "proposed", "agreed", "active"]), z.null()]).optional(),
});

function cellOf(raw: RawRow, mapping: Mapping, key: FieldKey) {
  const h = mapping[key];
  return h ? raw.cells[h] ?? null : null;
}
const num = (v: unknown) => (v == null ? null : Number(v));

/** Validate and match every row against the CURRENT database state. Pure read. */
export async function planRows(
  db: Db, rawRows: RawRow[], mapping: Mapping, settings: FileSettings, resolutions: Resolutions, rowModels: RowModels, filename: string,
): Promise<PlannedRow[]> {
  const channels = (await db.query("select id, name, type from channels")).rows as { id: string; name: string; type: string }[];
  const byChannel = new Map<string, { id: string; name: string; type: string }>();
  for (const c of channels) { byChannel.set(norm(c.name), c); byChannel.set(c.id, c); }
  const fileChannel = settings.channel_id ? byChannel.get(settings.channel_id) ?? null : null;

  const vids = rawRows.map((r) => parseIdCell(cellOf(r, mapping, "variant_id"))).filter(Boolean) as string[];
  const skus = rawRows.map((r) => parseIdCell(cellOf(r, mapping, "sku"))).filter(Boolean).map((s) => s!.toLowerCase());
  const resolvedIds = Object.values(resolutions).filter((x) => z.string().uuid().safeParse(x).success);
  const prodRows = (await db.query(
    `select id, name, variant, sku, family, web_price_cents, shopify_variant_id::text as vid from products
     where archived_at is null and (shopify_variant_id::text = any($1) or lower(sku) = any($2) or id = any($3::uuid[]))`,
    [vids.filter((v) => /^\d{1,20}$/.test(v)), skus, resolvedIds],
  )).rows;
  const byVid = new Map(prodRows.filter((p) => p.vid).map((p) => [p.vid, p]));
  const bySku = new Map<string, any[]>();
  for (const p of prodRows) if (p.sku) bySku.set(p.sku.toLowerCase(), [...(bySku.get(p.sku.toLowerCase()) ?? []), p]);
  const byId = new Map(prodRows.map((p) => [p.id, p]));
  const productOf = new Map<string, any>();

  const planned: PlannedRow[] = rawRows.map((raw) => {
    const ref = `row ${raw.row}`;
    const errors: string[] = [], warnings: string[] = [];
    const values: Record<string, unknown> = {};
    for (const k of FIELD_KEYS) if (mapping[k]) values[k] = cellOf(raw, mapping, k);

    // channel: the row's column, else the file's channel
    const chText = parseIdCell(cellOf(raw, mapping, "channel"));
    const channel = chText ? byChannel.get(norm(chText)) ?? byChannel.get(chText) ?? null : fileChannel;
    if (chText && !channel) errors.push(`Unknown channel "${chText}"`);
    else if (!channel) errors.push("Channel is blank — map a channel column or choose one channel for the file");

    // gift — stable identifiers only, never the name
    const vid = parseIdCell(cellOf(raw, mapping, "variant_id"));
    const sku = parseIdCell(cellOf(raw, mapping, "sku"));
    let product: any = null, match: PlannedRow["match"] = null;
    let candidates: any[] = [];
    if (vid) {
      if (!/^\d{1,20}$/.test(vid)) errors.push("Shopify variant ID must be digits");
      else if (byVid.has(vid)) { product = byVid.get(vid); match = "variant_id"; }
      else errors.push(`No gift with Shopify variant ID ${vid}`);
      if (product && sku && (product.sku ?? "").toLowerCase() !== sku.toLowerCase()) errors.push(`Variant ID and SKU point to different gifts (SKU of ${vid} is ${product.sku ?? "blank"})`);
    } else if (sku) {
      const found = bySku.get(sku.toLowerCase()) ?? [];
      if (found.length === 1) { product = found[0]; match = "sku"; }
      else candidates = found;
    } else errors.push("Give a Shopify variant ID or Gift SKU");
    const chosen = resolutions[ref];
    if (!product && chosen) {
      if (candidates.length && !candidates.some((c) => c.id === chosen)) errors.push("The chosen gift is not one of the matching candidates");
      else if (byId.has(chosen)) { product = byId.get(chosen); match = "resolved"; }
    }
    if (!product && !vid && sku) {
      if (candidates.length > 1) errors.push(`SKU "${sku}" matches ${candidates.length} gifts — choose one`);
      else if (!candidates.length) errors.push(`No gift with SKU "${sku}" — choose the gift or fix the SKU`);
    }
    // A gift chosen by the team for an unmatched/invalid identifier replaces the identifier error.
    if (match === "resolved") for (let i = errors.length - 1; i >= 0; i--) if (/^No gift with|SKU ".*" matches|Shopify variant ID must/.test(errors[i])) errors.splice(i, 1);
    const nameRef = parseIdCell(cellOf(raw, mapping, "gift_name"));
    if (product && nameRef) {
      const full = norm([product.name, product.variant].filter(Boolean).join(" "));
      if (!full.includes(norm(nameRef)) && !norm(nameRef).includes(norm(product.name))) warnings.push(`Name "${nameRef}" differs from the matched gift (matched by ${match === "sku" ? "SKU" : match === "variant_id" ? "variant ID" : "your choice"}, not by name)`);
    }
    if (product) productOf.set(ref, product);

    // pricing model: the team's per-row choice, else the row's column, else the file's model
    const modelText = parseIdCell(cellOf(raw, mapping, "pricing_model"));
    const modelFromCol = modelText ? MODEL_VALUES[norm(modelText)] ?? null : null;
    if (modelText && !modelFromCol && !rowModels[ref]) errors.push(`Unknown pricing model "${modelText}" (Fixed supplier price / Commission-based / Other / custom terms)`);
    const model = rowModels[ref] || modelFromCol || settings.pricing_model || null;
    const model_source: PlannedRow["model_source"] = rowModels[ref] ? "row" : modelFromCol ? "column" : settings.pricing_model ? "file" : null;
    if (!model) errors.push("Choose the pricing model — for the whole file or for this row");

    // values (blank = unspecified)
    const take = <T,>(label: string, r: { ok: true; value: T | null } | { ok: false; error: string }) => { if (!r.ok) { errors.push(`${label}: ${r.error}`); return null; } return r.value; };
    const input: Record<string, any> = {
      pricing_model: model,
      supplier_price_cents: take("Agreed supplier price", parseMoneyCell(cellOf(raw, mapping, "supplier_price"))),
      selling_price_cents: take("Marketplace selling price", parseMoneyCell(cellOf(raw, mapping, "selling_price"))),
      agreed_price_cents: take("Agreed price", parseMoneyCell(cellOf(raw, mapping, "agreed_price"))),
      proposed_supplier_cents: take("Proposed supplier price", parseMoneyCell(cellOf(raw, mapping, "proposed_supplier_price"))),
      commission_pct: take("Commission %", parsePctCell(cellOf(raw, mapping, "commission_pct"))),
      fixed_fee_cents: take("Fixed fee", parseMoneyCell(cellOf(raw, mapping, "fixed_fee"))),
      custom_terms: parseIdCell(cellOf(raw, mapping, "custom_terms")),
      customer_shipping_cents: take("Customer shipping charge", parseMoneyCell(cellOf(raw, mapping, "customer_shipping_charge"))),
      moq: take("MOQ", parseIntCell(cellOf(raw, mapping, "moq"))),
      effective_from: take("Effective from", parseDateCell(cellOf(raw, mapping, "effective_from"))),
      effective_to: take("Effective to", parseDateCell(cellOf(raw, mapping, "effective_to"))),
      agreement_notes: parseIdCell(cellOf(raw, mapping, "notes")),
      approved_by: parseIdCell(cellOf(raw, mapping, "approved_by")),
    };
    for (const [k, max, label] of [["agreement_notes", 4000, "Notes"], ["custom_terms", 4000, "Custom terms"], ["approved_by", 80, "Approved by"]] as const)
      if (input[k] && input[k].length > max) errors.push(`${label} is longer than ${max} characters`);
    // commission basis: only read for commission-based / custom rows
    const basisText = parseIdCell(cellOf(raw, mapping, "commission_basis"));
    const basisNote = parseIdCell(cellOf(raw, mapping, "commission_basis_note"));
    if (model === "commission" || model === "custom") {
      const basis = basisText ? BASIS_VALUES[norm(basisText)] ?? null : null;
      if (basisText && !basis) errors.push(`Unknown commission basis "${basisText}" (Selling price / Retail price / Other)`);
      input.commission_basis = basis ?? (model === "commission" ? settings.commission_basis ?? null : null);
      input.commission_basis_note = basisNote;
    } else if (basisText || basisNote) warnings.push(`Commission basis ignored — it does not apply to ${model ? MODEL_LABEL[model as keyof typeof MODEL_LABEL] : "this row"}`);
    if ((model === "fixed_supplier" || model === "commission") && input.agreed_price_cents != null)
      errors.push(model === "fixed_supplier"
        ? "“Agreed price (custom terms)” is filled — for a fixed supplier price put the amount SB receives in the supplier price column"
        : "“Agreed price (custom terms)” is filled — for a commission-based price use the marketplace selling price column");

    const fmtText = parseIdCell(cellOf(raw, mapping, "fulfillment_format"));
    const fmt = fmtText ? FORMAT_VALUES[norm(fmtText)] : settings.fulfillment_format ?? undefined;
    if (fmtText && !fmt) errors.push(`Unknown fulfillment format "${fmtText}"`);
    else if (!fmt) errors.push("Fulfillment format is blank — map a column or choose one format for the file");
    input.fulfillment_format = fmt ?? null;
    const stText = parseIdCell(cellOf(raw, mapping, "status"));
    const status = stText ? norm(stText) : settings.status ?? "";
    if (stText && !STATUS_VALUES.includes(status)) errors.push(`Unknown status "${stText}"`);
    else if (!status) errors.push("Status is blank — map a column or choose one status for the file");
    input.status = STATUS_VALUES.includes(status) ? status : null;
    if (input.effective_from && input.effective_to && input.effective_to < input.effective_from) errors.push("Effective to is before Effective from");
    if (input.status === "active" && !input.effective_from) errors.push("Active rows need an Effective from date");
    if (product?.family === "pots_plus_succulents" && ["individual", "corporate_separate_addresses"].includes(fmt ?? ""))
      errors.push("Pots with succulents are bulk-only (individual recipient shipping is unavailable): individual / separate-address fulfillment is not allowed");

    // optional manual overrides of the reference values
    const retailOv = take("SB retail price override", parseMoneyCell(cellOf(raw, mapping, "retail_override")));
    const costOv = take("Internal gift cost override", parseMoneyCell(cellOf(raw, mapping, "cost_override")));
    const ovNote = parseIdCell(cellOf(raw, mapping, "override_note"));
    if ((retailOv != null || costOv != null) && !ovNote) errors.push("An override needs “Override source / note”");
    const today = new Date().toISOString().slice(0, 10);
    const mk = (cents: number | null): Override => cents == null ? null : { cents, reason: ovNote ?? "", source: `File ${filename}, ${ref}${ovNote ? ` — ${ovNote}` : ""}`, date: today };
    input.retail_override = mk(retailOv);
    input.cost_override = mk(costOv);
    if (retailOv != null) warnings.push("SB retail price will be stored as a MANUAL value (not the website price)");
    if (costOv != null) warnings.push("Internal gift cost will be stored as a MANUAL value (not Product Master)");

    return {
      ref, row: raw.row, values, channel: channel ? { id: channel.id, name: channel.name } : null,
      product: product ? { id: product.id, name: product.name, variant: product.variant, sku: product.sku, family: product.family } : null,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name, variant: c.variant, sku: c.sku })), match, model, model_source,
      input: channel && product ? { ...input, channel_id: channel.id, product_id: product.id, _channel_type: channel.type } : null,
      interpretation: null, action: null, existing: null, changes: [], errors, warnings, valid: false,
    };
  });

  // duplicates inside the file (same channel + gift + fulfillment format)
  const keyOf = (p: PlannedRow) => p.input ? `${p.input.channel_id}|${p.input.product_id}|${p.input.fulfillment_format}` : null;
  const groups = new Map<string, PlannedRow[]>();
  for (const p of planned) { const k = keyOf(p); if (k && p.input?.fulfillment_format) groups.set(k, [...(groups.get(k) ?? []), p]); }
  for (const g of groups.values()) if (g.length > 1) for (const p of g) p.errors.push(`Duplicate of ${g.filter((x) => x !== p).map((x) => x.ref).join(", ")} (same channel, gift and fulfillment format) — keep one`);

  // compare with existing records, then validate the RESULTING record for its pricing model
  for (const p of planned) {
    if (!p.input || p.errors.length) { p.valid = false; continue; }
    const inp = p.input;
    const recs = (await db.query(
      `select * from pricing_records where channel_id = $1 and product_id = $2 and fulfillment_format = $3 and archived_at is null
         and status in ('draft', 'proposed', 'agreed', 'active') order by created_at desc`,
      [inp.channel_id, inp.product_id, inp.fulfillment_format],
    )).rows;
    const draft = recs.find((r) => r.status === "draft" || r.status === "proposed");
    const settledRec = recs.find((r) => r.status === "active") ?? recs.find((r) => r.status === "agreed");
    const base = draft ?? settledRec ?? null;
    const provided = (k: string) => inp[k] !== null && inp[k] !== undefined;

    // resulting record = existing values (draft, or the agreed version being revised) + provided values
    const result: Record<string, any> = {};
    if (base) for (const k of PRICE_FIELD_KEYS) result[k] = k === "commission_pct" ? num(base[k]) : base[k] ?? null;
    if (base && base !== draft) { result.effective_from = null; result.effective_to = null; result.approved_by = null; }
    for (const k of PRICE_FIELD_KEYS) if (provided(k)) result[k] = inp[k];
    result.pricing_model = inp.pricing_model;
    if (base && base.pricing_model !== inp.pricing_model)
      for (const k of CLEAR_FOR_MODEL[inp.pricing_model] ?? []) if (!provided(k) && result[k] != null) { result[k] = null; }
    if (inp.pricing_model === "fixed_supplier" || inp.pricing_model === "commission") result.agreed_price_cents = null;
    result.status = inp.status === "active" ? "active" : inp.status;
    const { errors, agreedPriceCents } = checkPricingModel(result, { channelType: inp._channel_type, requireModel: true });
    for (const [k, msg] of Object.entries(errors)) p.errors.push(`${FIELD_LABEL[k] ?? k}: ${msg}`);
    if (inp.pricing_model === "fixed_supplier" || inp.pricing_model === "commission") result.agreed_price_cents = agreedPriceCents;
    if (inp.pricing_model === "fixed_supplier" && result.supplier_price_cents == null) p.warnings.push("No agreed supplier price in this row (blank = not yet known)");
    if (inp.pricing_model === "commission" && result.selling_price_cents == null) p.warnings.push("No marketplace selling price in this row (blank = not yet known)");
    if (inp.pricing_model === "commission" && result.commission_pct == null && result.fixed_fee_cents == null && !["agreed", "active"].includes(inp.status))
      p.warnings.push("Commission not specified (blank is not 0%) — SB's amount can't be calculated yet");

    const retail = inp.retail_override?.cents ?? (base?.retail_source === "manual" ? num(base.retail_ref_cents) : productOf.get(p.ref)?.web_price_cents ?? null);
    p.interpretation = interpretPricing({ ...result, retail_ref_cents: retail });

    if (base) {
      for (const [k, label] of COMPARE) {
        const from = k === "commission_pct" ? num(base[k]) : base[k] ?? null;
        if ((result[k] ?? null) !== from) p.changes.push({ field: label, from, to: result[k] ?? null });
      }
      if (inp.retail_override && (base.retail_source !== "manual" || Number(base.retail_ref_cents) !== inp.retail_override.cents))
        p.changes.push({ field: "SB retail price (manual)", from: base.retail_ref_cents, to: inp.retail_override.cents });
      if (inp.cost_override && (base.cost_source !== "manual" || Number(base.internal_cost_cents) !== inp.cost_override.cents))
        p.changes.push({ field: "Internal gift cost (manual)", from: base.internal_cost_cents, to: inp.cost_override.cents });
      // a revision of an agreed price only counts as a change when a price/term field differs
      if (base !== draft) p.changes = p.changes.filter((c) => !["Effective from", "Effective to"].includes(c.field) || c.to != null);
      const statusUp = STATUS_RANK[inp.status] > STATUS_RANK[base.status];
      if (statusUp) p.changes.push({ field: "Status", from: base.status, to: inp.status });
      p.existing = { id: base.id, status: base.status, version: base.version, agreed_price_cents: base.agreed_price_cents, effective_from: base.effective_from, effective_to: base.effective_to };
      if (!p.changes.length) p.action = "no_change";
      else if (base === draft) p.action = "update_draft";
      else p.action = "new_version";
      if (p.action === "new_version") p.warnings.push(`Creates a new version; the ${base.status} price stays unchanged in history`);
    } else p.action = "create";
    p.input = { ...inp, ...result, status: inp.status, approved_by: inp.approved_by ?? (base === draft ? result.approved_by : null) };

    // effective-period checks against active prices
    const from = p.input.effective_from, to = p.input.effective_to;
    if (from && p.action !== "no_change") {
      const actives = recs.filter((r) => r.status === "active" && (r.effective_to == null || r.effective_to >= from) && (to == null || r.effective_from <= to));
      for (const a of actives) {
        if (inp.status === "active") {
          if (a.effective_from >= from) p.errors.push(`Overlaps the active price from ${a.effective_from}${a.effective_to ? ` to ${a.effective_to}` : ""}; choose a later Effective from`);
          else p.warnings.push(`Will close the active price from ${a.effective_from} on the day before ${from}`);
        } else p.warnings.push(`Effective period overlaps the active price from ${a.effective_from}${a.effective_to ? ` to ${a.effective_to}` : ""}`);
      }
    }
    if (["agreed", "active"].includes(inp.status) && !inp.approved_by) p.warnings.push("Approved by will be recorded as the name that confirms this import");
    p.valid = p.errors.length === 0;
  }
  return planned;
}

function summarize(rows: PlannedRow[]) {
  const s: Record<string, number> = { total: rows.length, valid: 0, errors: 0, create: 0, update_draft: 0, new_version: 0, no_change: 0 };
  for (const r of rows) {
    if (r.valid) s.valid++; else s.errors++;
    if (r.valid && r.action) s[r.action]++;
  }
  return s;
}

/** File-level hints about the chosen columns (not errors). */
function mappingNotes(headers: string[], mapping: Mapping, settings: FileSettings) {
  const mapped = new Set(Object.values(mapping));
  const notes: string[] = [];
  const amb = headers.filter((h) => !mapped.has(h) && isAmbiguousHeader(h));
  if (amb.length) notes.push(`Not mapped automatically: ${amb.map((h) => `“${h}”`).join(", ")} — the header doesn't say whose price it is. Choose what it means (supplier price SB receives, marketplace selling price, or SB retail price), or ignore it.`);
  const m = settings.pricing_model;
  if (m === "fixed_supplier" && !mapping.supplier_price) notes.push("Fixed supplier price: map the column with the amount SB receives per gift.");
  if (m === "fixed_supplier" && (mapping.commission_pct || mapping.fixed_fee)) notes.push("Fixed supplier price: commission/fee columns don't apply — rows with a value there are rejected. Unmap them, or use per-row models.");
  if (m === "commission" && !mapping.selling_price) notes.push("Commission-based: map the marketplace selling price column.");
  if (m === "commission" && !mapping.commission_pct && !mapping.fixed_fee) notes.push("Commission-based: no commission % or fixed fee column — prices stay drafts until the commission is entered (blank is not 0%).");
  if (m === "custom" && !mapping.agreed_price) notes.push("Other / custom terms: map the agreed price column and describe the terms.");
  return notes;
}

type Stored = { sheets?: Sheet[]; sheet: string; header_row: number; raw: RawRow[]; planned: PlannedRow[]; resolutions?: Resolutions; row_models?: RowModels; results?: unknown; sheet_error?: string | null };

function sheetSummary(sheets: Sheet[] | undefined) {
  return (sheets ?? []).map((s) => ({ name: s.name, rows: s.grid.filter((r) => r.some((c) => c !== null)).length }));
}

async function buildView(st: { sheets: Sheet[]; sheet: string; header_row?: number | null; mapping?: Mapping | null; settings: FileSettings; resolutions: Resolutions; row_models: RowModels }, filename: string, db: Db) {
  const sheet = st.sheets.find((s) => s.name === st.sheet) ?? st.sheets[0];
  const headerRow = st.header_row ?? detectHeaderRow(sheet);
  let table: { headers: string[]; rows: RawRow[] } = { headers: [], rows: [] };
  let sheet_error: string | null = null;
  try { table = tableOf(sheet, headerRow); } catch (e) { if (e instanceof WorkbookRejected) sheet_error = e.message; else throw e; }
  const suggested = autoMapping(table.headers);
  const mapping: Mapping = st.mapping ?? suggested;
  const missing = sheet_error ? [] : missingRequired(mapping, st.settings);
  const planned = sheet_error || missing.length ? [] : await planRows(db, table.rows, mapping, st.settings, st.resolutions, st.row_models, filename);
  return { sheet: sheet.name, header_row: headerRow, headers: table.headers, raw: table.rows, suggested, mapping, missing, planned, sheet_error,
    notes: sheet_error ? [] : mappingNotes(table.headers, mapping, st.settings) };
}

function respond(batch: any, v: Awaited<ReturnType<typeof buildView>>, sheets: Sheet[], extra: Record<string, unknown> = {}) {
  return {
    batch_id: batch.id, version: batch.version, filename: batch.filename, file_kind: batch.file_kind,
    sheets: sheetSummary(sheets), sheet: v.sheet, header_row: v.header_row, sheet_error: v.sheet_error,
    headers: v.headers, mapping: v.mapping, suggested: v.suggested, settings: batch.settings, missing: v.missing, notes: v.notes,
    rows: v.planned, summary: summarize(v.planned), row_models: {},
    fields: TEMPLATE_COLUMNS.map(({ key, header, group, optional, help }) => ({ key, label: header, group, optional: !!optional, help })),
    samples: Object.fromEntries(v.headers.map((h) => [h, v.raw.slice(0, 3).map((r) => r.cells[h]).filter((x) => x !== null).map((x) => typeof x === "object" && x ? (x as any).date : String(x)).slice(0, 2)])),
    ...extra,
  };
}

export function pricingImportRoutes(r: Router) {
  r.get("/pricing-import/template", async () => {
    const names = (await query("select name from channels order by (type = 'direct') desc, name")).map((x) => x.name);
    const buf = await buildTemplate(names);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="sb-pricing-import-template.xlsx"',
        "cache-control": "no-store",
      },
    });
  });

  r.post("/pricing-import/preview", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ filename: z.string().trim().min(1).max(200), file_base64: z.string().min(1) }), b);
    const buf = Buffer.from(d.file_base64, "base64");
    if (buf.length > MAX_FILE_BYTES) throw badRequest("The file is larger than 2 MB.");
    let up;
    try { up = await parseUpload(buf, d.filename); }
    catch (e) { if (e instanceof WorkbookRejected) throw badRequest(e.message); throw badRequest("The file could not be read."); }
    const settings: FileSettings = {};
    const v = await buildView({ sheets: up.sheets, sheet: defaultSheet(up), settings, resolutions: {}, row_models: {} }, d.filename, getPool());
    if (!v.mapping.status) { settings.status = "draft"; Object.assign(v, await buildView({ sheets: up.sheets, sheet: v.sheet, header_row: v.header_row, mapping: v.mapping, settings, resolutions: {}, row_models: {} }, d.filename, getPool())); }
    const already = await one("select id, confirmed_at, confirmed_by from pricing_import_batches where file_sha256 = $1 and status = 'confirmed' order by confirmed_at desc limit 1", [up.sha256]);
    const stored: Stored = { sheets: up.sheets, sheet: v.sheet, header_row: v.header_row, raw: v.raw, planned: v.planned, resolutions: {}, row_models: {}, sheet_error: v.sheet_error };
    const batch = await one(
      `insert into pricing_import_batches (filename, file_sha256, file_size, file_kind, sheet_name, column_mapping, settings, rows, summary, previewed_by, auth_subject)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, version, filename, file_kind, settings`,
      [d.filename, up.sha256, buf.length, up.kind, v.sheet, JSON.stringify(v.mapping), JSON.stringify(settings), JSON.stringify(stored), JSON.stringify(summarize(v.planned)), a.signer, a.sub],
    );
    return respond(batch, v, up.sheets, { previously_imported: already ? { at: already.confirmed_at, by: already.confirmed_by } : null });
  });

  /** Re-check with another worksheet / header row, column meanings, file settings, gift choices or per-row models. */
  r.post("/pricing-import/:id/preview", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({
      sheet: z.string().max(200).optional(),
      header_row: z.number().int().min(1).max(50).optional(),
      mapping: z.record(z.string(), z.string()).optional(),
      settings: settingsSchema.optional(),
      resolutions: z.record(z.string(), z.string().uuid()).optional(),
      row_models: z.record(z.string(), z.union([z.enum(PRICING_MODELS), z.literal("")])).optional(),
    }), b);
    const batch = await one("select * from pricing_import_batches where id = $1", [params.id]);
    if (!batch) throw notFound("Import");
    if (batch.status !== "previewed") throw badRequest("This import was already confirmed or discarded.");
    const st: Stored = batch.rows;
    if (!st.sheets) throw badRequest("Upload the file again.");
    if (d.sheet && !st.sheets.some((s) => s.name === d.sheet)) throw badRequest("Unknown worksheet.");
    const sheetChanged = !!d.sheet && d.sheet !== st.sheet;
    const headerChanged = !sheetChanged && d.header_row !== undefined && d.header_row !== st.header_row;
    const layoutChanged = sheetChanged || headerChanged;
    const settings: FileSettings = d.settings ? { ...batch.settings, ...d.settings } : batch.settings;
    let mapping: Mapping | null = layoutChanged ? null : batch.column_mapping;
    if (d.mapping && !layoutChanged) {
      const headers = Object.keys(st.raw[0]?.cells ?? {});
      mapping = Object.fromEntries(Object.entries(d.mapping).filter(([k, v]) => v && (FIELD_KEYS as string[]).includes(k) && headers.includes(v))) as Mapping;
      const used = Object.values(mapping);
      if (new Set(used).size !== used.length) throw badRequest("Each column can have one meaning only.");
    }
    const rowModels = layoutChanged ? {} : Object.fromEntries(Object.entries({ ...(st.row_models ?? {}), ...(d.row_models ?? {}) }).filter(([, v]) => v)) as RowModels;
    const resolutions = layoutChanged ? {} : d.resolutions ?? st.resolutions ?? {};
    const v = await buildView({ sheets: st.sheets, sheet: d.sheet ?? st.sheet, header_row: sheetChanged ? null : d.header_row ?? st.header_row, mapping, settings, resolutions, row_models: rowModels }, batch.filename, getPool());
    const stored: Stored = { sheets: st.sheets, sheet: v.sheet, header_row: v.header_row, raw: v.raw, planned: v.planned, resolutions, row_models: rowModels, sheet_error: v.sheet_error };
    const upd = await one(
      `update pricing_import_batches set sheet_name = $2, column_mapping = $3, settings = $4, rows = $5, summary = $6, previewed_by = $7, version = version + 1
       where id = $1 returning id, version, filename, file_kind, settings`,
      [params.id, v.sheet, JSON.stringify(v.mapping), JSON.stringify(settings), JSON.stringify(stored), JSON.stringify(summarize(v.planned)), a.signer],
    );
    return respond(upd, v, st.sheets, { row_models: rowModels });
  });

  r.post("/pricing-import/:id/confirm", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ selected: z.array(z.string()).min(1, "Select at least one row"), confirm_versions: z.array(z.string()).default([]), version }), b);
    return tx(async (c) => {
      const batch = (await c.query("select * from pricing_import_batches where id = $1 for update", [params.id])).rows[0];
      if (!batch) throw notFound("Import");
      if (batch.status !== "previewed") throw badRequest("This import was already confirmed or discarded.");
      if (batch.version !== d.version) throw conflict("The preview changed. Review the latest preview before confirming.");
      const st: Stored = batch.rows;
      if (st.sheet_error) throw badRequest(st.sheet_error);
      if (!st.raw?.length) throw badRequest("No data rows to save.");
      if (missingRequired(batch.column_mapping, batch.settings).length) throw badRequest("Finish the column mapping and file settings first.");
      // Re-plan against the current data so nothing stale is written.
      const planned = await planRows(c, st.raw, batch.column_mapping, batch.settings, st.resolutions ?? {}, st.row_models ?? {}, batch.filename);
      const sel = new Set(d.selected);
      const results: { ref: string; outcome: string; record_id?: string; detail?: string }[] = [];
      const label = `${batch.filename} (import ${String(batch.id).slice(0, 8)})`;
      for (const p of planned) {
        if (!sel.has(p.ref)) continue;
        if (!p.valid) { results.push({ ref: p.ref, outcome: "skipped_invalid", detail: p.errors.join("; ") }); continue; }
        if (p.action === "no_change") { results.push({ ref: p.ref, outcome: "no_change", record_id: p.existing?.id }); continue; }
        if (p.action === "new_version" && !d.confirm_versions.includes(p.ref)) { results.push({ ref: p.ref, outcome: "skipped_needs_version_confirmation" }); continue; }
        const rec = await applyRow(c, p, a, { batchId: batch.id, rowRef: `${batch.filename} ${p.ref}`, label });
        results.push({ ref: p.ref, outcome: p.action!, record_id: rec.id });
      }
      const summary = { ...summarize(planned), results: results.reduce((m: Record<string, number>, x) => ((m[x.outcome] = (m[x.outcome] ?? 0) + 1), m), {}) };
      // Keep only the rows of the chosen worksheet; other worksheets' values are dropped.
      const kept: Stored = { sheet: st.sheet, header_row: st.header_row, raw: st.raw, planned, resolutions: st.resolutions, row_models: st.row_models, results };
      await c.query(
        "update pricing_import_batches set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), summary = $3, rows = $4, version = version + 1 where id = $1",
        [batch.id, a.signer, JSON.stringify(summary), JSON.stringify(kept)],
      );
      await audit(c, a, { entityType: "pricing_import", entityId: batch.id, action: "confirm", after: { filename: batch.filename, sheet: st.sheet, settings: batch.settings, summary } });
      return { summary, results };
    });
  });

  r.post("/pricing-import/:id/discard", async ({ params, body, actor }) => {
    actor(await body());
    assertUuid(params.id);
    await query("update pricing_import_batches set status = 'discarded', rows = rows - 'sheets' where id = $1 and status = 'previewed'", [params.id]);
    return { ok: true };
  });

  r.get("/pricing-import", async () => ({
    imports: await query(
      `select id, filename, file_kind, sheet_name, file_sha256, file_size, status, summary, previewed_by, confirmed_by, confirmed_at, created_at
       from pricing_import_batches order by created_at desc limit 20`,
    ),
  }));
}

/** Price/term columns written from an import row. */
const WRITE_KEYS = [
  "pricing_model", "supplier_price_cents", "selling_price_cents", "agreed_price_cents", "proposed_supplier_cents",
  "commission_pct", "fixed_fee_cents", "commission_basis", "commission_basis_note", "custom_terms",
  "customer_shipping_cents", "moq", "effective_from", "effective_to", "agreement_notes",
];

async function applyRow(c: pg.PoolClient, p: PlannedRow, a: Actor, o: { batchId: string; rowRef: string; label: string }) {
  const { _channel_type, ...inp } = p.input!;
  const wantActive = inp.status === "active";
  const saveStatus = wantActive ? "agreed" : inp.status;
  const approvedBy = ["agreed", "active"].includes(inp.status) ? inp.approved_by ?? a.signer : null;
  await checkProductRules(c, inp.product_id, inp.fulfillment_format);
  let rec: any;
  if (p.action === "create") {
    rec = await insertRecord(c, { ...inp, status: saveStatus, approved_by: approvedBy }, a, null, { importBatchId: o.batchId, importRowRef: o.rowRef, importLabel: o.label });
  } else if (p.action === "update_draft") {
    const cur = (await c.query("select * from pricing_records where id = $1 for update", [p.existing!.id])).rows[0];
    if (!cur || cur.version !== p.existing!.version || !["draft", "proposed"].includes(cur.status)) throw new HttpError(409, "conflict", `${p.ref}: the draft changed since the preview. Preview again.`);
    const fields: Record<string, any> = {};
    for (const k of WRITE_KEYS) {
      const curV = k === "commission_pct" ? num(cur[k]) : cur[k] ?? null;
      if ((inp[k] ?? null) !== curV) fields[k] = inp[k] ?? null;
    }
    const keepRetail = inp.retail_override ?? (cur.retail_source === "manual" ? { cents: Number(cur.retail_ref_cents), ...cur.retail_source_detail } : null);
    const keepCost = inp.cost_override ?? (cur.cost_source === "manual" ? { cents: Number(cur.internal_cost_cents), ...cur.cost_source_detail } : null);
    Object.assign(fields, (await resolveReferenceFields(c, cur.product_id, keepRetail, keepCost, o.label)).fields);
    if (STATUS_RANK[saveStatus] > STATUS_RANK[cur.status]) fields.status = saveStatus;
    if (fields.status === "agreed") {
      fields.approved_by = cur.approved_by ?? approvedBy;
      fields.approved_at = new Date();
      Object.assign(fields, await snapshotFields(c, { ...cur, ...fields }));
    }
    const { before, after } = await updateVersioned(c, "pricing_records", cur.id, cur.version, fields);
    await audit(c, a, { entityType: "pricing_record", entityId: cur.id, action: "import_update", before, after: { ...after, import: o.rowRef } });
    rec = after;
  } else {
    rec = await insertRecord(c, { ...inp, status: saveStatus, approved_by: approvedBy }, a, p.existing!.id, { importBatchId: o.batchId, importRowRef: o.rowRef, importLabel: o.label });
  }
  if (wantActive) {
    const fresh = (await c.query("select * from pricing_records where id = $1 for update", [rec.id])).rows[0];
    rec = (await activateRecord(c, fresh, { effective_from: inp.effective_from, effective_to: inp.effective_to, approved_by: approvedBy }, a)).record;
  }
  return rec;
}

export { TEMPLATE_COLUMNS };
