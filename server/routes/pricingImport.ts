// "Import pricing Excel": upload → recognise/map columns → match by stable identifiers → preview →
// team selects rows, types their name, confirms → saved with batch + row reference.
import { z } from "zod";
import type pg from "pg";
import { Router, updateVersioned } from "../router";
import { query, one, tx, getPool, type Db } from "../db";
import { audit, type Actor } from "../audit";
import { HttpError, badRequest, notFound, conflict } from "../http";
import { parse, assertUuid, version } from "../validate";
import {
  parseWorkbook, autoMapping, missingRequired, buildTemplate, WorkbookRejected, TEMPLATE_COLUMNS, FORMAT_VALUES, STATUS_VALUES,
  parseMoneyCell, parsePctCell, parseIntCell, parseDateCell, parseIdCell, norm, type FieldKey, type RawRow,
} from "../lib/pricingExcel";
import { insertRecord, activateRecord, snapshotFields, checkProductRules } from "./pricing";
import { resolveReferenceFields, type Override } from "../lib/pricingRefs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Mapping = Partial<Record<FieldKey, string>>;
type Resolutions = Record<string, string>; // row ref → product id chosen by the team

export type PlannedRow = {
  ref: string;
  row: number;
  values: Record<string, unknown>;
  channel: { id: string; name: string } | null;
  product: { id: string; name: string; variant: string | null; sku: string | null; family: string | null } | null;
  candidates: { id: string; name: string; variant: string | null; sku: string | null }[];
  match: "variant_id" | "sku" | "resolved" | null;
  input: Record<string, any> | null;
  action: "create" | "update_draft" | "new_version" | "no_change" | null;
  existing: { id: string; status: string; version: number; agreed_price_cents: number | null; effective_from: string | null; effective_to: string | null } | null;
  changes: { field: string; from: unknown; to: unknown }[];
  errors: string[];
  warnings: string[];
  valid: boolean;
};

const COMPARE: [string, string][] = [
  ["proposed_supplier_cents", "Proposed supplier price"], ["agreed_price_cents", "Agreed selling price"],
  ["customer_shipping_cents", "Customer shipping charge"], ["commission_pct", "Commission %"], ["fixed_fee_cents", "Fixed fee"],
  ["moq", "MOQ"], ["effective_from", "Effective from"], ["effective_to", "Effective to"], ["agreement_notes", "Notes"],
];
const STATUS_RANK: Record<string, number> = { draft: 0, proposed: 1, agreed: 2, active: 3 };

function cellOf(raw: RawRow, mapping: Mapping, key: FieldKey) {
  const h = mapping[key];
  return h ? raw.cells[h] ?? null : null;
}

/** Validate and match every row against the CURRENT database state. Pure read. */
export async function planRows(db: Db, rawRows: RawRow[], mapping: Mapping, resolutions: Resolutions, filename: string): Promise<PlannedRow[]> {
  const channels = (await db.query("select id, name from channels")).rows as { id: string; name: string }[];
  const byChannel = new Map<string, { id: string; name: string }>();
  for (const c of channels) { byChannel.set(norm(c.name), c); byChannel.set(c.id, c); }

  const vids = rawRows.map((r) => parseIdCell(cellOf(r, mapping, "variant_id"))).filter(Boolean) as string[];
  const skus = rawRows.map((r) => parseIdCell(cellOf(r, mapping, "sku"))).filter(Boolean).map((s) => s!.toLowerCase());
  const resolvedIds = Object.values(resolutions).filter((x) => z.string().uuid().safeParse(x).success);
  const prodRows = (await db.query(
    `select id, name, variant, sku, family, shopify_variant_id::text as vid from products
     where archived_at is null and (shopify_variant_id::text = any($1) or lower(sku) = any($2) or id = any($3::uuid[]))`,
    [vids.filter((v) => /^\d{1,20}$/.test(v)), skus, resolvedIds],
  )).rows;
  const byVid = new Map(prodRows.filter((p) => p.vid).map((p) => [p.vid, p]));
  const bySku = new Map<string, any[]>();
  for (const p of prodRows) if (p.sku) bySku.set(p.sku.toLowerCase(), [...(bySku.get(p.sku.toLowerCase()) ?? []), p]);
  const byId = new Map(prodRows.map((p) => [p.id, p]));

  const planned: PlannedRow[] = rawRows.map((raw) => {
    const ref = `row ${raw.row}`;
    const errors: string[] = [], warnings: string[] = [];
    const values: Record<string, unknown> = {};
    for (const c of TEMPLATE_COLUMNS) if (mapping[c.key]) values[c.key] = cellOf(raw, mapping, c.key);

    // channel
    const chText = parseIdCell(cellOf(raw, mapping, "channel"));
    const channel = chText ? byChannel.get(norm(chText)) ?? byChannel.get(chText) ?? null : null;
    if (!chText) errors.push("Channel is blank");
    else if (!channel) errors.push(`Unknown channel "${chText}"`);

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
    const nameRef = parseIdCell(cellOf(raw, mapping, "gift_name"));
    if (product && nameRef) {
      const full = norm([product.name, product.variant].filter(Boolean).join(" "));
      if (!full.includes(norm(nameRef)) && !norm(nameRef).includes(norm(product.name))) warnings.push(`Name "${nameRef}" differs from the matched gift (matched by ${match === "sku" ? "SKU" : match === "variant_id" ? "variant ID" : "your choice"}, not by name)`);
    }

    // values
    const take = <T,>(label: string, r: { ok: true; value: T | null } | { ok: false; error: string }) => { if (!r.ok) { errors.push(`${label}: ${r.error}`); return null; } return r.value; };
    const input: Record<string, any> = {
      proposed_supplier_cents: take("Proposed supplier price", parseMoneyCell(cellOf(raw, mapping, "proposed_supplier_price"))),
      agreed_price_cents: take("Agreed selling price", parseMoneyCell(cellOf(raw, mapping, "agreed_selling_price"))),
      customer_shipping_cents: take("Customer shipping charge", parseMoneyCell(cellOf(raw, mapping, "customer_shipping_charge"))),
      commission_pct: take("Marketplace commission %", parsePctCell(cellOf(raw, mapping, "commission_pct"))),
      fixed_fee_cents: take("Fixed fee", parseMoneyCell(cellOf(raw, mapping, "fixed_fee"))),
      moq: take("MOQ", parseIntCell(cellOf(raw, mapping, "moq"))),
      effective_from: take("Effective from", parseDateCell(cellOf(raw, mapping, "effective_from"))),
      effective_to: take("Effective to", parseDateCell(cellOf(raw, mapping, "effective_to"))),
      agreement_notes: parseIdCell(cellOf(raw, mapping, "notes")),
      approved_by: parseIdCell(cellOf(raw, mapping, "approved_by")),
    };
    if (input.agreement_notes && input.agreement_notes.length > 4000) errors.push("Notes are longer than 4000 characters");
    if (input.approved_by && input.approved_by.length > 80) errors.push("Approved by is longer than 80 characters");
    const fmtText = parseIdCell(cellOf(raw, mapping, "fulfillment_format"));
    const fmt = fmtText ? FORMAT_VALUES[norm(fmtText)] : undefined;
    if (!fmtText) errors.push("Fulfillment format is blank");
    else if (!fmt) errors.push(`Unknown fulfillment format "${fmtText}"`);
    input.fulfillment_format = fmt ?? null;
    const stText = parseIdCell(cellOf(raw, mapping, "status"));
    const status = stText ? norm(stText) : "";
    if (!stText) errors.push("Status is blank");
    else if (!STATUS_VALUES.includes(status)) errors.push(`Unknown status "${stText}"`);
    input.status = STATUS_VALUES.includes(status) ? status : null;
    if (input.effective_from && input.effective_to && input.effective_to < input.effective_from) errors.push("Effective to is before Effective from");
    if (["agreed", "active"].includes(input.status) && input.agreed_price_cents == null) errors.push(`${stText} rows need an agreed selling price`);
    if (input.status === "active" && !input.effective_from) errors.push("Active rows need an Effective from date");
    if (product?.family === "pots_plus_succulents" && ["individual", "corporate_separate_addresses"].includes(fmt ?? ""))
      errors.push("Pots with succulents are bulk-only (individual recipient shipping is unavailable): individual / separate-address fulfillment is not allowed");

    // optional manual overrides of the reference values
    const retailOv = take("Retail reference override", parseMoneyCell(cellOf(raw, mapping, "retail_override")));
    const costOv = take("Internal gift cost override", parseMoneyCell(cellOf(raw, mapping, "cost_override")));
    const ovNote = parseIdCell(cellOf(raw, mapping, "override_note"));
    if ((retailOv != null || costOv != null) && !ovNote) errors.push("An override needs “Override source / note”");
    const today = new Date().toISOString().slice(0, 10);
    const mk = (cents: number | null): Override => cents == null ? null : { cents, reason: ovNote ?? "", source: `Excel ${filename}, ${ref}${ovNote ? ` — ${ovNote}` : ""}`, date: today };
    input.retail_override = mk(retailOv);
    input.cost_override = mk(costOv);
    if (retailOv != null) warnings.push("Retail reference will be stored as a MANUAL value (not the website price)");
    if (costOv != null) warnings.push("Internal gift cost will be stored as a MANUAL value (not Product Master)");

    return {
      ref, row: raw.row, values, channel: channel ? { id: channel.id, name: channel.name } : null,
      product: product ? { id: product.id, name: product.name, variant: product.variant, sku: product.sku, family: product.family } : null,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name, variant: c.variant, sku: c.sku })), match,
      input: channel && product ? { ...input, channel_id: channel.id, product_id: product.id } : null,
      action: null, existing: null, changes: [], errors, warnings, valid: false,
    };
  });

  // duplicates inside the file (same channel + gift + fulfillment format)
  const keyOf = (p: PlannedRow) => p.input ? `${p.input.channel_id}|${p.input.product_id}|${p.input.fulfillment_format}` : null;
  const groups = new Map<string, PlannedRow[]>();
  for (const p of planned) { const k = keyOf(p); if (k && p.input?.fulfillment_format) groups.set(k, [...(groups.get(k) ?? []), p]); }
  for (const g of groups.values()) if (g.length > 1) for (const p of g) p.errors.push(`Duplicate of ${g.filter((x) => x !== p).map((x) => x.ref).join(", ")} (same channel, gift and fulfillment format) — keep one`);

  // compare with existing records
  for (const p of planned) {
    if (!p.input || p.errors.length) { p.valid = false; continue; }
    const recs = (await db.query(
      `select * from pricing_records where channel_id = $1 and product_id = $2 and fulfillment_format = $3 and archived_at is null
         and status in ('draft', 'proposed', 'agreed', 'active') order by created_at desc`,
      [p.input.channel_id, p.input.product_id, p.input.fulfillment_format],
    )).rows;
    const draft = recs.find((r) => r.status === "draft" || r.status === "proposed");
    const settled = recs.find((r) => r.status === "active") ?? recs.find((r) => r.status === "agreed");
    const base = draft ?? settled ?? null;
    const provided = (k: string) => p.input![k] !== null && p.input![k] !== undefined;
    if (base) {
      for (const [k, label] of COMPARE) {
        if (!provided(k)) continue; // blank = unspecified: keeps the existing value
        const from = base[k] == null ? null : k === "commission_pct" ? Number(base[k]) : base[k];
        if (from !== p.input[k]) p.changes.push({ field: label, from, to: p.input[k] });
      }
      if (p.input.retail_override && (base.retail_source !== "manual" || Number(base.retail_ref_cents) !== p.input.retail_override.cents))
        p.changes.push({ field: "Retail reference (manual)", from: base.retail_ref_cents, to: p.input.retail_override.cents });
      if (p.input.cost_override && (base.cost_source !== "manual" || Number(base.internal_cost_cents) !== p.input.cost_override.cents))
        p.changes.push({ field: "Internal gift cost (manual)", from: base.internal_cost_cents, to: p.input.cost_override.cents });
      const statusUp = STATUS_RANK[p.input.status] > STATUS_RANK[base.status];
      if (statusUp) p.changes.push({ field: "Status", from: base.status, to: p.input.status });
      p.existing = { id: base.id, status: base.status, version: base.version, agreed_price_cents: base.agreed_price_cents, effective_from: base.effective_from, effective_to: base.effective_to };
      if (!p.changes.length) p.action = "no_change";
      else if (base === draft) p.action = "update_draft";
      else p.action = "new_version";
      if (p.action === "new_version") p.warnings.push(`Creates a new version; the ${base.status} price stays unchanged in history`);
    } else p.action = "create";

    // effective-period checks against active prices
    const from = p.input.effective_from ?? (p.action === "update_draft" ? p.existing?.effective_from : null);
    const to = p.input.effective_to ?? (p.action === "update_draft" ? p.existing?.effective_to : null);
    if (from && p.action !== "no_change") {
      const actives = recs.filter((r) => r.status === "active" && (r.effective_to == null || r.effective_to >= from) && (to == null || r.effective_from <= to));
      for (const a of actives) {
        if (p.input.status === "active") {
          if (a.effective_from >= from) p.errors.push(`Overlaps the active price from ${a.effective_from}${a.effective_to ? ` to ${a.effective_to}` : ""}; choose a later Effective from`);
          else p.warnings.push(`Will close the active price from ${a.effective_from} on the day before ${from}`);
        } else p.warnings.push(`Effective period overlaps the active price from ${a.effective_from}${a.effective_to ? ` to ${a.effective_to}` : ""}`);
      }
    }
    if (["agreed", "active"].includes(p.input.status) && !p.input.approved_by) p.warnings.push("Approved by will be recorded as the name that confirms this import");
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
    let wb;
    try { wb = await parseWorkbook(buf, d.filename); }
    catch (e) { if (e instanceof WorkbookRejected) throw badRequest(e.message); throw badRequest("The workbook could not be read."); }
    const mapping = autoMapping(wb.headers);
    const already = await one("select id, confirmed_at, confirmed_by from pricing_import_batches where file_sha256 = $1 and status = 'confirmed' order by confirmed_at desc limit 1", [wb.sha256]);
    const raw = wb.rows;
    const planned = missingRequired(mapping).length ? [] : await planRows(getPool(), raw, mapping, {}, d.filename);
    const batch = await one(
      `insert into pricing_import_batches (filename, file_sha256, file_size, sheet_name, column_mapping, rows, summary, previewed_by, auth_subject)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, version`,
      [d.filename, wb.sha256, buf.length, wb.sheetName, JSON.stringify(mapping), JSON.stringify({ raw, planned }), JSON.stringify(summarize(planned)), a.signer, a.sub],
    );
    return {
      batch_id: batch.id, version: batch.version, filename: d.filename, sheet: wb.sheetName, headers: wb.headers, mapping,
      missing: missingRequired(mapping), rows: planned, summary: summarize(planned),
      previously_imported: already ? { at: already.confirmed_at, by: already.confirmed_by } : null,
    };
  });

  /** Re-validate with a manual column mapping and/or gift resolutions (no re-upload). */
  r.post("/pricing-import/:id/preview", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ mapping: z.record(z.string(), z.string()).optional(), resolutions: z.record(z.string(), z.string().uuid()).optional() }), b);
    const batch = await one("select * from pricing_import_batches where id = $1", [params.id]);
    if (!batch) throw notFound("Import");
    if (batch.status !== "previewed") throw badRequest("This import was already confirmed or discarded.");
    const headers = Object.keys(batch.rows.raw[0]?.cells ?? {});
    const mapping: Mapping = d.mapping ? Object.fromEntries(Object.entries(d.mapping).filter(([k, v]) => v && TEMPLATE_COLUMNS.some((c) => c.key === k) && headers.includes(v))) as Mapping : batch.column_mapping;
    const used = Object.values(mapping);
    if (new Set(used).size !== used.length) throw badRequest("Each spreadsheet column can be mapped to one field only.");
    const planned = missingRequired(mapping).length ? [] : await planRows(getPool(), batch.rows.raw, mapping, d.resolutions ?? {}, batch.filename);
    const upd = await one(
      "update pricing_import_batches set column_mapping = $2, rows = $3, summary = $4, previewed_by = $5, version = version + 1 where id = $1 returning version",
      [params.id, JSON.stringify(mapping), JSON.stringify({ raw: batch.rows.raw, planned, resolutions: d.resolutions ?? {} }), JSON.stringify(summarize(planned)), a.signer],
    );
    return { batch_id: params.id, version: upd.version, filename: batch.filename, headers, mapping, missing: missingRequired(mapping), rows: planned, summary: summarize(planned) };
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
      // Re-plan against the current data so nothing stale is written.
      const planned = await planRows(c, batch.rows.raw, batch.column_mapping, batch.rows.resolutions ?? {}, batch.filename);
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
      await c.query(
        "update pricing_import_batches set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), summary = $3, rows = $4, version = version + 1 where id = $1",
        [batch.id, a.signer, JSON.stringify(summary), JSON.stringify({ ...batch.rows, planned, results })],
      );
      await audit(c, a, { entityType: "pricing_import", entityId: batch.id, action: "confirm", after: { filename: batch.filename, summary } });
      return { summary, results };
    });
  });

  r.post("/pricing-import/:id/discard", async ({ params, body, actor }) => {
    actor(await body());
    assertUuid(params.id);
    await query("update pricing_import_batches set status = 'discarded' where id = $1 and status = 'previewed'", [params.id]);
    return { ok: true };
  });

  r.get("/pricing-import", async () => ({
    imports: await query(
      `select id, filename, file_sha256, file_size, status, summary, previewed_by, confirmed_by, confirmed_at, created_at
       from pricing_import_batches order by created_at desc limit 20`,
    ),
  }));
}

async function applyRow(c: pg.PoolClient, p: PlannedRow, a: Actor, o: { batchId: string; rowRef: string; label: string }) {
  const inp = p.input!;
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
    for (const k of ["proposed_supplier_cents", "agreed_price_cents", "customer_shipping_cents", "commission_pct", "fixed_fee_cents", "moq", "effective_from", "effective_to", "agreement_notes"])
      if (inp[k] !== null && inp[k] !== undefined) fields[k] = inp[k];
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
    const prev = (await c.query("select * from pricing_records where id = $1", [p.existing!.id])).rows[0];
    const copy: any = {
      channel_id: prev.channel_id, product_id: prev.product_id, fulfillment_format: prev.fulfillment_format,
      cost_inclusions_note: prev.cost_inclusions_note, customer_discount_pct: prev.customer_discount_pct,
      proposed_supplier_cents: prev.proposed_supplier_cents, agreed_price_cents: prev.agreed_price_cents,
      customer_shipping_cents: prev.customer_shipping_cents, expected_shipping_cents: prev.expected_shipping_cents,
      extra_cost_cents: prev.extra_cost_cents, commission_pct: prev.commission_pct, fixed_fee_cents: prev.fixed_fee_cents,
      pricing_basis_note: prev.pricing_basis_note, moq: prev.moq, shipping_responsibility: prev.shipping_responsibility,
      payment_terms: prev.payment_terms, dispatch_requirement: prev.dispatch_requirement, agreement_notes: prev.agreement_notes,
      evidence_ref: prev.evidence_ref, effective_from: null, effective_to: null,
    };
    for (const [k, v] of Object.entries(inp)) if (v !== null && v !== undefined && k !== "status") copy[k] = v;
    copy.status = saveStatus;
    copy.approved_by = approvedBy;
    rec = await insertRecord(c, copy, a, prev.id, { importBatchId: o.batchId, importRowRef: o.rowRef, importLabel: o.label });
  }
  if (wantActive) {
    const fresh = (await c.query("select * from pricing_records where id = $1 for update", [rec.id])).rows[0];
    rec = (await activateRecord(c, fresh, { effective_from: inp.effective_from, effective_to: inp.effective_to, approved_by: approvedBy }, a)).record;
  }
  return rec;
}
