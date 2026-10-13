// Pricing file upload (.xlsx or .csv): safe parsing (plain values only), worksheet + header-row selection,
// column suggestions and the optional template. The file itself is never stored — only parsed plain values
// and file metadata.
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createHash } from "node:crypto";

export type FieldKey =
  | "channel" | "variant_id" | "sku" | "gift_name" | "pricing_model"
  | "supplier_price" | "selling_price" | "agreed_price" | "proposed_supplier_price"
  | "commission_pct" | "fixed_fee" | "commission_basis" | "commission_basis_note" | "custom_terms"
  | "customer_shipping_charge" | "moq" | "fulfillment_format" | "status"
  | "effective_from" | "effective_to" | "approved_by" | "notes" | "retail_override" | "cost_override" | "override_note";

export type FieldDef = { key: FieldKey; header: string; group: string; optional?: boolean; help: string; synonyms: string[] };

/** Everything a pricing file column can mean. Headers are matched to these as SUGGESTIONS only; the team confirms. */
export const TEMPLATE_COLUMNS: FieldDef[] = [
  { key: "channel", group: "Channel & gift", header: "Channel", help: "Channel name as shown in the app. Not needed when the whole file is for one channel (choose it in the preview).", synonyms: ["channel", "marketplace", "channel name", "provider", "partner"] },
  { key: "variant_id", group: "Channel & gift", header: "Shopify variant ID", help: "Preferred stable identifier. Use this or Gift SKU.", synonyms: ["shopify variant id", "variant id", "shopify variant", "variant"] },
  { key: "sku", group: "Channel & gift", header: "Gift SKU", help: "Used when no variant ID is given. Must identify exactly one gift.", synonyms: ["gift sku", "sku", "variant sku", "item sku", "vendor sku", "supplier sku", "product sku"] },
  { key: "gift_name", group: "Channel & gift", header: "Gift name (reference only)", help: "For your reference. Never used to match gifts.", synonyms: ["gift name (reference only)", "gift name", "gift", "product", "product name", "name", "item", "item name", "title", "product title"] },
  { key: "pricing_model", group: "Pricing model", header: "Pricing model", optional: true, help: "Fixed supplier price / Commission-based / Other-custom. Optional: the model can be chosen for the whole file in the preview.", synonyms: ["pricing model", "price model", "model", "arrangement", "pricing type"] },
  { key: "supplier_price", group: "Prices", header: "Agreed supplier price (SB receives)", help: "Fixed supplier price model: the agreed amount SB receives per gift. Nothing is deducted from it.", synonyms: ["agreed supplier price (sb receives)", "agreed supplier price", "supplier price", "wholesale price", "wholesale", "wholesale cost", "vendor price", "vendor cost", "net price", "net cost", "net to supplier", "net to vendor", "supplier payout", "payout", "price to sb", "cost price", "purchase price", "dropship price", "drop ship price"] },
  { key: "selling_price", group: "Prices", header: "Marketplace selling price", help: "Commission-based model: the price the marketplace sells the gift at (what its customer pays).", synonyms: ["marketplace selling price", "selling price", "sale price", "sales price", "listing price", "list price", "marketplace price", "customer price", "consumer price", "sell price"] },
  { key: "agreed_price", group: "Prices", header: "Agreed price (custom terms)", help: "Other/custom terms (or the direct website's customer price): the agreed price. Explain the terms in “Custom terms”.", synonyms: ["agreed price (custom terms)", "agreed price", "agreed customer price"] },
  { key: "proposed_supplier_price", group: "Prices", header: "Proposed supplier price", optional: true, help: "Optional. SB's offer before agreement.", synonyms: ["proposed supplier price", "proposed price", "offer price", "quoted price", "quote"] },
  { key: "commission_pct", group: "Commission (optional)", header: "Commission % (optional)", optional: true, help: "Optional. Commission-based model only. 0–100, e.g. 15 for 15%. Blank = not specified (never assumed 0%).", synonyms: ["commission % (optional)", "commission %", "marketplace commission %", "marketplace commission percentage", "commission", "commission pct", "commission rate", "take rate", "fee %", "marketplace fee %", "margin %"] },
  { key: "fixed_fee", group: "Commission (optional)", header: "Fixed fee per unit (optional)", optional: true, help: "Optional. Commission-based model only. USD per unit. Blank = not specified.", synonyms: ["fixed fee per unit (optional)", "fixed fee per unit", "fixed fee", "per-unit fee", "per unit fee", "transaction fee", "listing fee"] },
  { key: "commission_basis", group: "Commission (optional)", header: "Commission basis (optional)", optional: true, help: "Optional. What the commission is calculated on: Selling price / Retail price / Other. Can be set for the whole file in the preview.", synonyms: ["commission basis (optional)", "commission basis", "commission on", "fee basis", "commission calculated on"] },
  { key: "commission_basis_note", group: "Commission (optional)", header: "Commission basis note", optional: true, help: "Required only when the basis is Other.", synonyms: ["commission basis note", "basis note"] },
  { key: "custom_terms", group: "Terms", header: "Custom terms", optional: true, help: "Other/custom terms model: explain the arrangement (required when agreed).", synonyms: ["custom terms", "terms", "special terms", "arrangement terms", "deal terms"] },
  { key: "customer_shipping_charge", group: "Terms", header: "Customer shipping charge", optional: true, help: "USD. Blank = unspecified.", synonyms: ["customer shipping charge", "shipping charge", "customer shipping", "shipping price"] },
  { key: "moq", group: "Terms", header: "MOQ", optional: true, help: "Whole number ≥ 1.", synonyms: ["moq", "minimum order quantity", "minimum order", "min qty", "minimum quantity"] },
  { key: "fulfillment_format", group: "Terms", header: "Fulfillment format", help: "Individual / Corporate — separate addresses / Bulk — one location / Bulk — multiple shipments. Can be set for the whole file in the preview.", synonyms: ["fulfillment format", "fulfilment format", "fulfillment", "fulfilment"] },
  { key: "status", group: "Terms", header: "Status", help: "Draft / Proposed / Agreed / Active. Can be set for the whole file in the preview (default Draft).", synonyms: ["status", "price status"] },
  { key: "effective_from", group: "Terms", header: "Effective from", optional: true, help: "Date. Required for Active.", synonyms: ["effective from", "start date", "from", "valid from", "effective date"] },
  { key: "effective_to", group: "Terms", header: "Effective to", optional: true, help: "Date, on or after Effective from.", synonyms: ["effective to", "end date", "to", "valid to", "valid until", "expiry date"] },
  { key: "approved_by", group: "Other", header: "Approved by", optional: true, help: "Optional. For Agreed/Active rows; blank = the name that confirms the import.", synonyms: ["approved by", "approver"] },
  { key: "notes", group: "Other", header: "Notes", optional: true, help: "Optional agreement notes.", synonyms: ["notes", "note", "agreement notes", "other agreement notes", "comments", "comment"] },
  { key: "retail_override", group: "Reference overrides", header: "SB retail price override", optional: true, help: "Optional. SB's own website retail price, only to replace the website value. Stored as a MANUAL value.", synonyms: ["sb retail price override", "retail reference override", "retail override", "retail reference", "sb retail price"] },
  { key: "cost_override", group: "Reference overrides", header: "Internal gift cost override", optional: true, help: "Optional. Leave blank to use Product Master. Stored as a MANUAL value.", synonyms: ["internal gift cost override", "cost override", "internal gift cost"] },
  { key: "override_note", group: "Reference overrides", header: "Override source / note", optional: true, help: "Required when an override is used: where the value comes from.", synonyms: ["override source / note", "override source", "override note"] },
];
export const FIELD_KEYS = TEMPLATE_COLUMNS.map((c) => c.key);

/**
 * Headers that are NEVER mapped automatically because they don't say whose price it is.
 * "Price" could be what SB earns, what the marketplace charges or SB's retail price.
 */
export const AMBIGUOUS_HEADERS = ["price", "unit price", "amount", "cost", "unit cost", "rate", "retail", "retail price", "msrp", "rrp",
  "srp", "agreed selling price", "item price", "price (usd)", "usd", "value", "total", "fee", "fees"];

export const FORMAT_VALUES: Record<string, string> = {
  individual: "individual",
  "corporate — separate addresses": "corporate_separate_addresses", "corporate - separate addresses": "corporate_separate_addresses",
  "corporate separate addresses": "corporate_separate_addresses", corporate_separate_addresses: "corporate_separate_addresses",
  "bulk — one location": "bulk_one_location", "bulk - one location": "bulk_one_location", "bulk one location": "bulk_one_location", bulk_one_location: "bulk_one_location",
  "bulk — multiple shipments": "bulk_multiple_shipments", "bulk - multiple shipments": "bulk_multiple_shipments", "bulk multiple shipments": "bulk_multiple_shipments",
  bulk_multiple_shipments: "bulk_multiple_shipments",
};
export const STATUS_VALUES = ["draft", "proposed", "agreed", "active"];
export const MODEL_VALUES: Record<string, string> = {
  fixed: "fixed_supplier", "fixed supplier price": "fixed_supplier", "fixed price": "fixed_supplier", "fixed supplier": "fixed_supplier",
  fixed_supplier: "fixed_supplier", wholesale: "fixed_supplier", "supplier price": "fixed_supplier",
  commission: "commission", "commission-based": "commission", "commission based": "commission", "commission model": "commission",
  custom: "custom", other: "custom", "other / custom terms": "custom", "other/custom terms": "custom", "custom terms": "custom", "other / custom": "custom",
  direct: "direct", "direct sale": "direct", "direct sale (website)": "direct",
};
export const BASIS_VALUES: Record<string, string> = {
  "selling price": "selling_price", selling: "selling_price", "sale price": "selling_price", "marketplace selling price": "selling_price",
  "list price": "selling_price", selling_price: "selling_price",
  retail: "retail_price", "retail price": "retail_price", "sb retail price": "retail_price", "website retail price": "retail_price",
  "sb website retail price": "retail_price", msrp: "retail_price", retail_price: "retail_price",
  other: "other", "other (explained in note)": "other",
};

export const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export type Plain = string | number | boolean | { date: string } | null;
export type RawRow = { row: number; cells: Record<string, Plain> };
export type Sheet = { name: string; grid: Plain[][]; formulaCells: string[]; badCells: string[]; truncated: boolean };
export type Upload = { kind: "xlsx" | "csv"; sha256: string; sheets: Sheet[] };

export class WorkbookRejected extends Error {
  constructor(message: string, public details?: unknown) { super(message); }
}

export const MAX_ROWS = 2000;
const MAX_COLS = 80;
const MAX_SHEETS = 20;

// ------------------------------------------------------------------ parsing
export async function parseUpload(buf: Buffer, filename: string): Promise<Upload> {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (/\.(xlsm|xltm|xlam|xlsb|xls)$/i.test(filename)) throw new WorkbookRejected("Only .xlsx and .csv files are accepted (macro-enabled and legacy Excel formats are rejected).");
  if (/\.csv$/i.test(filename)) return { kind: "csv", sha256, sheets: [parseCsvSheet(buf)] };
  if (!/\.xlsx$/i.test(filename)) throw new WorkbookRejected("Upload an .xlsx or .csv file.");
  return { kind: "xlsx", sha256, sheets: await parseXlsxSheets(buf) };
}

async function parseXlsxSheets(buf: Buffer): Promise<Sheet[]> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new WorkbookRejected("The file is not a valid .xlsx workbook.");
  const zip = await JSZip.loadAsync(buf).catch(() => { throw new WorkbookRejected("The file is not a valid .xlsx workbook."); });
  const names = Object.keys(zip.files);
  if (names.some((n) => /vbaproject\.bin$/i.test(n) || (/\.bin$/i.test(n) && /macro|vba/i.test(n))))
    throw new WorkbookRejected("Macro-enabled content found. Save the workbook as a plain .xlsx without macros.");
  const ct = await zip.file("[Content_Types].xml")?.async("string");
  if (ct && /macroEnabled/i.test(ct)) throw new WorkbookRejected("Macro-enabled workbook. Save as a plain .xlsx without macros.");

  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new WorkbookRejected("The workbook could not be read."); }
  const sheets: Sheet[] = [];
  for (const ws of wb.worksheets.filter((w) => w.state === "visible").slice(0, MAX_SHEETS)) {
    const formulaCells: string[] = [], badCells: string[] = [];
    const grid: Plain[][] = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > MAX_ROWS + 50) { truncated = true; return; }
      const out: Plain[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (col > MAX_COLS) return;
        out[col - 1] = toPlain(cell, formulaCells, badCells);
      });
      grid[n - 1] = Array.from({ length: out.length }, (_, i) => out[i] ?? null);
    });
    for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
    sheets.push({ name: ws.name, grid, formulaCells, badCells, truncated });
  }
  if (!sheets.length) throw new WorkbookRejected("The workbook has no visible worksheet.");
  return sheets;
}

function toPlain(cell: ExcelJS.Cell, formulaCells: string[], badCells: string[]): Plain {
  const v: any = cell.value;
  if (v === null || v === undefined) return null;
  if (cell.type === ExcelJS.ValueType.Formula || (typeof v === "object" && ("formula" in v || "sharedFormula" in v))) {
    formulaCells.push(cell.address);
    return null;
  }
  if (typeof v === "number") {
    // A cell formatted as a percentage holds 0.15 for "15%".
    if (/%/.test(String(cell.numFmt ?? ""))) return Math.round(v * 100 * 1e6) / 1e6;
    return v;
  }
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return { date: v.toISOString().slice(0, 10) };
  if (typeof v === "object" && "richText" in v) return (v.richText as any[]).map((t) => t.text).join("").trim() || null;
  if (typeof v === "object" && "text" in v && "hyperlink" in v) return String(v.text).trim() || null;
  badCells.push(cell.address);
  return null;
}

/** CSV: UTF-8 (BOM ok, Latin-1 fallback); delimiter comma, semicolon or tab; quoted fields. */
export function parseCsvSheet(buf: Buffer): Sheet {
  if (buf.includes(0)) throw new WorkbookRejected("The file is not a text CSV.");
  let text = buf.toString("utf8");
  if (text.includes("�")) text = buf.toString("latin1");
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === "") q = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      if (rows.length > MAX_ROWS + 50) break;
    } else field += ch;
  }
  if (q) throw new WorkbookRejected("The CSV has an unterminated quoted value.");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const formulaCells: string[] = [];
  const grid: Plain[][] = rows.map((r, ri) => r.slice(0, MAX_COLS).map((c, ci) => {
    const t = c.trim();
    if (/^=/.test(t)) { formulaCells.push(`${colLetter(ci)}${ri + 1}`); return null; }
    return t === "" ? null : t;
  }));
  return { name: "CSV", grid, formulaCells, badCells: [], truncated: rows.length > MAX_ROWS + 50 };
}

const colLetter = (i: number) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const KNOWN = new Set([...TEMPLATE_COLUMNS.flatMap((c) => c.synonyms), ...AMBIGUOUS_HEADERS]);
const cellText = (p: Plain) => (p == null ? "" : typeof p === "object" ? p.date : String(p).replace(/\s+/g, " ").trim());

/** The header row: the first of the top 20 rows that best looks like column titles (1-based row number). */
export function detectHeaderRow(sheet: Sheet): number {
  let best = 1, bestScore = -1;
  for (let i = 0; i < Math.min(20, sheet.grid.length); i++) {
    const cells = (sheet.grid[i] ?? []).map(cellText).filter(Boolean);
    const texty = (sheet.grid[i] ?? []).filter((p) => typeof p === "string" && !/^[\d.,$%\s-]+$/.test(p)).length;
    if (texty < 2) continue;
    const score = texty + 3 * cells.filter((c) => KNOWN.has(norm(c))).length;
    if (score > bestScore) { best = i + 1; bestScore = score; }
  }
  return best;
}

/** Headers + data rows of a sheet, given its header row. Duplicate header names get " (2)", " (3)". */
export function tableOf(sheet: Sheet, headerRow: number) {
  if (sheet.formulaCells.length) {
    const fc = sheet.formulaCells;
    throw new WorkbookRejected(`Formulas are not accepted. Paste values only (worksheet “${sheet.name}”, cells: ${fc.slice(0, 15).join(", ")}${fc.length > 15 ? "…" : ""}).`, { formulaCells: fc });
  }
  if (sheet.badCells.length) throw new WorkbookRejected(`Unsupported cell contents (errors or objects) in “${sheet.name}”: ${sheet.badCells.slice(0, 15).join(", ")}.`);
  if (sheet.truncated) throw new WorkbookRejected(`Too many rows in “${sheet.name}”; the limit is ${MAX_ROWS}.`);
  const hdr = sheet.grid[headerRow - 1] ?? [];
  const seen = new Map<string, number>();
  const headers: (string | null)[] = hdr.map((p) => {
    const t = cellText(p);
    if (!t) return null;
    const n = (seen.get(norm(t)) ?? 0) + 1;
    seen.set(norm(t), n);
    return n > 1 ? `${t} (${n})` : t;
  });
  if (!headers.some(Boolean)) throw new WorkbookRejected(`Row ${headerRow} of “${sheet.name}” has no column headers. Choose the header row.`);
  const rows: RawRow[] = [];
  for (let i = headerRow; i < sheet.grid.length; i++) {
    const r = sheet.grid[i] ?? [];
    const cells: Record<string, Plain> = {};
    let any = false;
    headers.forEach((h, ci) => { if (!h) return; const p = r[ci] ?? null; if (p !== null) any = true; cells[h] = p; });
    if (any) rows.push({ row: i + 1, cells });
  }
  if (rows.length > MAX_ROWS) throw new WorkbookRejected(`Too many rows (${rows.length}); the limit is ${MAX_ROWS}.`);
  return { headers: headers.filter(Boolean) as string[], rows };
}

/** Default worksheet: one named "Pricing", else the first with data. */
export function defaultSheet(u: Upload) {
  return (u.sheets.find((s) => norm(s.name) === "pricing") ?? u.sheets.find((s) => s.grid.some((r) => r.some((c) => c !== null))) ?? u.sheets[0]).name;
}

/**
 * Suggested mapping (field → header). Exact synonym match first, then "contains" for longer headers
 * (e.g. "Wholesale price (USD)"). Ambiguous headers such as "Price" are never suggested.
 */
export function autoMapping(headers: string[]): Partial<Record<FieldKey, string>> {
  const out: Partial<Record<FieldKey, string>> = {};
  const used = new Set<string>();
  const clean = (h: string) => norm(h).replace(/\s*\((usd|\$|us\$|per unit|each|ea)\)\s*$/, "").replace(/\s*\$$/, "").trim();
  const ambiguous = (h: string) => AMBIGUOUS_HEADERS.includes(clean(h));
  for (const pass of ["exact", "contains"] as const) {
    for (const col of TEMPLATE_COLUMNS) {
      if (out[col.key]) continue;
      const h = headers.find((x) => !used.has(x) && !ambiguous(x) && (pass === "exact"
        ? col.synonyms.includes(clean(x))
        : col.synonyms.some((s) => s.length >= 6 && clean(x).includes(s))));
      if (h) { out[col.key] = h; used.add(h); }
    }
  }
  return out;
}

export const isAmbiguousHeader = (h: string) => AMBIGUOUS_HEADERS.includes(norm(h).replace(/\s*\((usd|\$)\)\s*$/, ""));

export type FileSettings = {
  channel_id?: string | null; pricing_model?: string | null; commission_basis?: string | null;
  fulfillment_format?: string | null; status?: string | null;
};

/** What still has to be decided before rows can be checked. */
export function missingRequired(mapping: Partial<Record<FieldKey, string>>, settings: FileSettings = {}) {
  const miss: string[] = [];
  if (!mapping.variant_id && !mapping.sku) miss.push("a Shopify variant ID or Gift SKU column");
  if (!mapping.channel && !settings.channel_id) miss.push("the channel (a column or one channel for the file)");
  if (!mapping.fulfillment_format && !settings.fulfillment_format) miss.push("the fulfillment format (a column or one format for the file)");
  if (!mapping.status && !settings.status) miss.push("the status (a column or one status for the file)");
  return miss;
}

// ------------------------------------------------------------- value parsing
export type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string };

export function parseMoneyCell(v: Plain): Parsed<number> {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v === "boolean" || (typeof v === "object")) return { ok: false, error: "not a number" };
  const s = typeof v === "number" ? String(v) : v.replace(/^(us)?\$\s*/i, "").replace(/\s*(usd)$/i, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: "must be a non-negative amount" };
  const n = Number(s);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) return { ok: false, error: "more than 2 decimal places" };
  if (cents > 1e11) return { ok: false, error: "too large" };
  return { ok: true, value: cents };
}

export function parsePctCell(v: Plain): Parsed<number> {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v === "boolean" || typeof v === "object") return { ok: false, error: "not a percentage" };
  const s = typeof v === "number" ? String(v) : v.replace(/%$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: "must be 0–100" };
  const n = Number(s);
  if (n < 0 || n > 100 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { ok: false, error: "must be 0–100 with at most 2 decimals" };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function parseIntCell(v: Plain): Parsed<number> {
  if (v === null || v === "") return { ok: true, value: null };
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : "";
  if (!/^\d+$/.test(s) || Number(s) < 1) return { ok: false, error: "must be a whole number ≥ 1" };
  return { ok: true, value: Number(s) };
}

export function parseDateCell(v: Plain): Parsed<string> {
  if (v === null || v === "") return { ok: true, value: null };
  let iso: string | null = null;
  if (typeof v === "object" && v && "date" in v) iso = v.date;
  else if (typeof v === "string") {
    const s = v.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) iso = s;
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if (!iso) return { ok: false, error: "use a date or YYYY-MM-DD" };
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return { ok: false, error: "invalid date" };
  return { ok: true, value: iso };
}

export function parseIdCell(v: Plain): string | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? String(v) : String(BigInt(Math.round(v)));
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && "date" in v) return v.date;
  return null;
}

// ------------------------------------------------------------------ template
/** Optional convenience template — any layout can be imported. */
export async function buildTemplate(channelNames: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SB Corporate Gifting";
  const cols = TEMPLATE_COLUMNS.filter((c) => c.key !== "commission_basis_note");
  const ws = wb.addWorksheet("Pricing", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 4) }));
  ws.getRow(1).font = { bold: true };
  cols.forEach((c, i) => {
    ws.getRow(1).getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.optional || c.key === "gift_name" ? "FFF2F2F2" : "FFE6F0EA" } };
    ws.getRow(1).getCell(i + 1).note = c.help;
  });
  const col = (k: FieldKey) => cols.findIndex((c) => c.key === k) + 1;
  const letter = (n: number) => ws.getColumn(n).letter;
  const ref = wb.addWorksheet("Lists");
  const lists: [string, string[]][] = [
    ["Channels", channelNames],
    ["Pricing model", ["Fixed supplier price", "Commission-based", "Other / custom terms"]],
    ["Commission basis", ["Selling price", "Retail price", "Other"]],
    ["Fulfillment format", ["Individual", "Corporate — separate addresses", "Bulk — one location", "Bulk — multiple shipments"]],
    ["Status", ["Draft", "Proposed", "Agreed", "Active"]],
  ];
  lists.forEach(([h, vals], i) => { ref.getColumn(i + 1).values = [h, ...vals]; });
  ref.getRow(1).font = { bold: true };
  ref.columns.forEach((c) => (c.width = 34));
  const listRef = (i: number, n: number) => `Lists!$${String.fromCharCode(65 + i)}$2:$${String.fromCharCode(65 + i)}$${n + 1}`;
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`${letter(col("channel"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [listRef(0, channelNames.length)], showErrorMessage: false };
    ws.getCell(`${letter(col("pricing_model"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [listRef(1, 3)] };
    ws.getCell(`${letter(col("commission_basis"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [listRef(2, 3)] };
    ws.getCell(`${letter(col("fulfillment_format"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [listRef(3, 4)] };
    ws.getCell(`${letter(col("status"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [listRef(4, 4)] };
    for (const k of ["effective_from", "effective_to"] as FieldKey[]) ws.getCell(`${letter(col(k))}${r}`).numFmt = "yyyy-mm-dd";
    for (const k of ["supplier_price", "selling_price", "agreed_price", "proposed_supplier_price", "customer_shipping_charge", "fixed_fee", "retail_override", "cost_override"] as FieldKey[])
      ws.getCell(`${letter(col(k))}${r}`).numFmt = "0.00";
    ws.getCell(`${letter(col("variant_id"))}${r}`).numFmt = "@";
  }
  const help = wb.addWorksheet("Instructions");
  help.columns = [{ header: "Column", width: 38 }, { header: "How to fill it", width: 110 }];
  help.getRow(1).font = { bold: true };
  for (const line of [
    "This template is optional. Marketplace price lists in other layouts (.xlsx or .csv) can be uploaded as they are — you confirm what each column means in the preview.",
    "Pricing models: Fixed supplier price = SB receives the agreed supplier price (nothing deducted). Commission-based = marketplace selling price minus commission % and/or fixed fee. Other / custom terms = agreed price + explanation.",
    "Fill only the price columns for the model you use. Commission and fee columns are optional and only apply to commission-based prices.",
    "Blank cells mean 'unspecified' — never zero. A blank commission is NOT 0%.",
    "Type plain values only. Formulas and macro-enabled files are rejected.",
    "Gifts are matched by Shopify variant ID or exact SKU only, never by name.",
    "Agreed and active prices are never overwritten: a changed row creates a new version only after you confirm it in the preview.",
  ]) help.addRow(["", line]);
  help.addRow([]);
  const need = (k: FieldKey, optional?: boolean) =>
    ["channel", "fulfillment_format", "status"].includes(k) ? " — required (or set once for the whole file)"
    : ["variant_id", "sku"].includes(k) ? " — variant ID or SKU required"
    : ["supplier_price", "selling_price", "agreed_price"].includes(k) ? " — required for its pricing model when agreed"
    : k === "gift_name" ? " — reference only" : optional ? " — optional" : "";
  for (const c of cols) help.addRow([c.header + need(c.key, c.optional), c.help]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
