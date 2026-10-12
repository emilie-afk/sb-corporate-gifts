// Excel pricing upload: template, safe parsing (plain values only) and column recognition.
// The workbook itself is never stored — only parsed plain values plus file metadata.
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createHash } from "node:crypto";

export type FieldKey =
  | "channel" | "variant_id" | "sku" | "gift_name" | "proposed_supplier_price" | "agreed_selling_price"
  | "customer_shipping_charge" | "commission_pct" | "fixed_fee" | "moq" | "fulfillment_format" | "status"
  | "effective_from" | "effective_to" | "approved_by" | "notes" | "retail_override" | "cost_override" | "override_note";

export const TEMPLATE_COLUMNS: { key: FieldKey; header: string; required?: boolean; help: string; synonyms: string[] }[] = [
  { key: "channel", header: "Channel", required: true, help: "Exact channel name as shown in the app (e.g. Direct website, Reachdesk).", synonyms: ["channel", "marketplace", "channel name", "provider"] },
  { key: "variant_id", header: "Shopify variant ID", help: "Preferred stable identifier. Use this or Gift SKU.", synonyms: ["shopify variant id", "variant id", "shopify variant"] },
  { key: "sku", header: "Gift SKU", help: "Used when no variant ID is given. Must identify exactly one gift.", synonyms: ["gift sku", "sku", "variant sku"] },
  { key: "gift_name", header: "Gift name (reference only)", help: "For your reference. Never used to match gifts.", synonyms: ["gift name (reference only)", "gift name", "gift", "product", "product name", "name"] },
  { key: "proposed_supplier_price", header: "Proposed supplier price", help: "USD. Blank = unspecified.", synonyms: ["proposed supplier price", "proposed price", "supplier price"] },
  { key: "agreed_selling_price", header: "Agreed selling price", help: "USD. Required for Agreed/Active.", synonyms: ["agreed selling price", "agreed price", "agreed supplier price"] },
  { key: "customer_shipping_charge", header: "Customer shipping charge", help: "USD. Blank = unspecified.", synonyms: ["customer shipping charge", "shipping charge", "customer shipping"] },
  { key: "commission_pct", header: "Marketplace commission %", help: "0–100, e.g. 15 for 15%.", synonyms: ["marketplace commission %", "marketplace commission percentage", "commission %", "commission", "commission pct"] },
  { key: "fixed_fee", header: "Fixed fee per unit", help: "USD per unit.", synonyms: ["fixed fee per unit", "fixed fee", "per-unit fee"] },
  { key: "moq", header: "MOQ", help: "Whole number ≥ 1.", synonyms: ["moq", "minimum order quantity", "minimum order"] },
  { key: "fulfillment_format", header: "Fulfillment format", required: true, help: "Individual / Corporate — separate addresses / Bulk — one location / Bulk — multiple shipments.", synonyms: ["fulfillment format", "fulfilment format", "fulfillment"] },
  { key: "status", header: "Status", required: true, help: "Draft / Proposed / Agreed / Active.", synonyms: ["status", "price status"] },
  { key: "effective_from", header: "Effective from", help: "Date. Required for Active.", synonyms: ["effective from", "start date", "from"] },
  { key: "effective_to", header: "Effective to", help: "Date, on or after Effective from.", synonyms: ["effective to", "end date", "to"] },
  { key: "approved_by", header: "Approved by", help: "Optional. For Agreed/Active rows; blank = the name that confirms the import.", synonyms: ["approved by", "approver"] },
  { key: "notes", header: "Notes", help: "Optional agreement notes.", synonyms: ["notes", "note", "agreement notes", "other agreement notes"] },
  { key: "retail_override", header: "Retail reference override", help: "Optional. Leave blank to use the current website price. A value here is stored as a MANUAL value.", synonyms: ["retail reference override", "retail override", "retail reference"] },
  { key: "cost_override", header: "Internal gift cost override", help: "Optional. Leave blank to use Product Master. A value here is stored as a MANUAL value.", synonyms: ["internal gift cost override", "cost override", "internal gift cost"] },
  { key: "override_note", header: "Override source / note", help: "Required when an override is used: where the value comes from.", synonyms: ["override source / note", "override source", "override note"] },
];

export const FORMAT_VALUES: Record<string, string> = {
  individual: "individual",
  "corporate — separate addresses": "corporate_separate_addresses", "corporate - separate addresses": "corporate_separate_addresses",
  "corporate separate addresses": "corporate_separate_addresses", corporate_separate_addresses: "corporate_separate_addresses",
  "bulk — one location": "bulk_one_location", "bulk - one location": "bulk_one_location", "bulk one location": "bulk_one_location", bulk_one_location: "bulk_one_location",
  "bulk — multiple shipments": "bulk_multiple_shipments", "bulk - multiple shipments": "bulk_multiple_shipments", "bulk multiple shipments": "bulk_multiple_shipments",
  bulk_multiple_shipments: "bulk_multiple_shipments",
};
export const STATUS_VALUES = ["draft", "proposed", "agreed", "active"];

export const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export type Plain = string | number | boolean | { date: string } | null;
export type RawRow = { row: number; cells: Record<string, Plain> };

export class WorkbookRejected extends Error {
  constructor(message: string, public details?: unknown) { super(message); }
}

const MAX_ROWS = 2000;

export async function parseWorkbook(buf: Buffer, filename: string) {
  if (/\.(xlsm|xltm|xlam|xlsb|xls)$/i.test(filename)) throw new WorkbookRejected("Only .xlsx files are accepted (macro-enabled and legacy formats are rejected).");
  if (!/\.xlsx$/i.test(filename)) throw new WorkbookRejected("Upload an .xlsx file.");
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new WorkbookRejected("The file is not a valid .xlsx workbook.");
  const zip = await JSZip.loadAsync(buf).catch(() => { throw new WorkbookRejected("The file is not a valid .xlsx workbook."); });
  const names = Object.keys(zip.files);
  if (names.some((n) => /vbaproject\.bin$/i.test(n) || /\.bin$/i.test(n) && /macro|vba/i.test(n)))
    throw new WorkbookRejected("Macro-enabled content found. Save the workbook as a plain .xlsx without macros.");
  const ct = await zip.file("[Content_Types].xml")?.async("string");
  if (ct && /macroEnabled/i.test(ct)) throw new WorkbookRejected("Macro-enabled workbook. Save as a plain .xlsx without macros.");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets.find((w) => norm(w.name) === "pricing") ?? wb.worksheets.find((w) => w.state === "visible") ?? wb.worksheets[0];
  if (!ws) throw new WorkbookRejected("The workbook has no worksheet.");

  const formulaCells: string[] = [];
  const badCells: string[] = [];
  const toPlain = (cell: ExcelJS.Cell): Plain => {
    const v: any = cell.value;
    if (v === null || v === undefined) return null;
    if (cell.type === ExcelJS.ValueType.Formula || (typeof v === "object" && ("formula" in v || "sharedFormula" in v))) {
      formulaCells.push(cell.address);
      return null;
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return typeof v === "string" ? v.trim() || null : v;
    if (v instanceof Date) return { date: v.toISOString().slice(0, 10) };
    if (typeof v === "object" && "richText" in v) return (v.richText as any[]).map((t) => t.text).join("").trim() || null;
    if (typeof v === "object" && "text" in v && "hyperlink" in v) return String(v.text).trim() || null;
    if (typeof v === "object" && "error" in v) { badCells.push(cell.address); return null; }
    badCells.push(cell.address);
    return null;
  };

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const p = toPlain(cell);
    headers[col - 1] = p == null ? "" : typeof p === "object" ? p.date : String(p).replace(/\s+/g, " ").trim();
  });
  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const cells: Record<string, Plain> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const p = toPlain(row.getCell(i + 1));
      if (p !== null) any = true;
      cells[h] = p;
    });
    if (any) rows.push({ row: n, cells });
  });
  if (formulaCells.length)
    throw new WorkbookRejected(`Formulas are not accepted. Paste values only (cells: ${formulaCells.slice(0, 15).join(", ")}${formulaCells.length > 15 ? "…" : ""}).`, { formulaCells });
  if (badCells.length) throw new WorkbookRejected(`Unsupported cell contents (errors or objects) in: ${badCells.slice(0, 15).join(", ")}.`);
  if (rows.length > MAX_ROWS) throw new WorkbookRejected(`Too many rows (${rows.length}); the limit is ${MAX_ROWS}.`);
  if (!headers.filter(Boolean).length) throw new WorkbookRejected("The first row must contain column headers.");
  return { sheetName: ws.name, headers: headers.filter(Boolean), rows, sha256: createHash("sha256").update(buf).digest("hex") };
}

/** Recognise template (and common alternative) headers. Unknown layouts are mapped by the team. */
export function autoMapping(headers: string[]): Partial<Record<FieldKey, string>> {
  const out: Partial<Record<FieldKey, string>> = {};
  const used = new Set<string>();
  for (const col of TEMPLATE_COLUMNS) {
    const h = headers.find((x) => !used.has(x) && col.synonyms.includes(norm(x)));
    if (h) { out[col.key] = h; used.add(h); }
  }
  return out;
}

export function missingRequired(mapping: Partial<Record<FieldKey, string>>) {
  const miss = TEMPLATE_COLUMNS.filter((c) => c.required && !mapping[c.key]).map((c) => c.header);
  if (!mapping.variant_id && !mapping.sku) miss.push("Shopify variant ID or Gift SKU");
  return miss;
}

// ------------------------------------------------------------- value parsing
export type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string };

export function parseMoneyCell(v: Plain): Parsed<number> {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v === "boolean" || (typeof v === "object")) return { ok: false, error: "not a number" };
  const s = typeof v === "number" ? String(v) : v.replace(/^\$\s*/, "").replace(/,/g, "").trim();
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
  if (n < 0 || n > 100 || Math.round(n * 100) !== n * 100) return { ok: false, error: "must be 0–100 with at most 2 decimals" };
  return { ok: true, value: n };
}

export function parseIntCell(v: Plain): Parsed<number> {
  if (v === null || v === "") return { ok: true, value: null };
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
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
  return null;
}

// ------------------------------------------------------------------ template
export async function buildTemplate(channelNames: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SB Corporate Gifting";
  const ws = wb.addWorksheet("Pricing", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F0EA" } };
  const col = (k: FieldKey) => TEMPLATE_COLUMNS.findIndex((c) => c.key === k) + 1;
  const letter = (n: number) => ws.getColumn(n).letter;
  const lists: [FieldKey, string[]][] = [
    ["fulfillment_format", ["Individual", "Corporate — separate addresses", "Bulk — one location", "Bulk — multiple shipments"]],
    ["status", ["Draft", "Proposed", "Agreed", "Active"]],
  ];
  const ref = wb.addWorksheet("Lists");
  ref.getColumn(1).values = ["Channels", ...channelNames];
  ref.getColumn(2).values = ["Fulfillment format", ...lists[0][1]];
  ref.getColumn(3).values = ["Status", ...lists[1][1]];
  ref.getRow(1).font = { bold: true };
  ref.columns.forEach((c) => (c.width = 34));
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`${letter(col("channel"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`Lists!$A$2:$A$${channelNames.length + 1}`], showErrorMessage: false };
    ws.getCell(`${letter(col("fulfillment_format"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ["Lists!$B$2:$B$5"] };
    ws.getCell(`${letter(col("status"))}${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ["Lists!$C$2:$C$5"] };
    for (const k of ["effective_from", "effective_to"] as FieldKey[]) ws.getCell(`${letter(col(k))}${r}`).numFmt = "yyyy-mm-dd";
    for (const k of ["proposed_supplier_price", "agreed_selling_price", "customer_shipping_charge", "fixed_fee", "retail_override", "cost_override"] as FieldKey[])
      ws.getCell(`${letter(col(k))}${r}`).numFmt = "0.00";
    ws.getCell(`${letter(col("variant_id"))}${r}`).numFmt = "@";
  }
  const help = wb.addWorksheet("Instructions");
  help.columns = [{ header: "Column", width: 30 }, { header: "How to fill it", width: 110 }];
  help.getRow(1).font = { bold: true };
  for (const c of TEMPLATE_COLUMNS) help.addRow([c.header + (c.required ? " (required)" : ""), c.help]);
  help.addRow([]);
  for (const line of [
    "Blank cells mean 'unspecified' — never zero.",
    "Type plain values only. Formulas and macro-enabled files are rejected.",
    "Gifts are matched by Shopify variant ID or exact SKU only, never by name. Ambiguous or unmatched gifts must be resolved in the preview.",
    "Retail reference and internal gift cost come from the website refresh and Product Master automatically. Overrides are stored as manual values with this file as their source.",
    "Agreed and active prices are never overwritten: a changed row creates a new version only after you confirm it in the preview.",
    "Re-uploading the same rows creates nothing new.",
  ]) help.addRow(["", line]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
