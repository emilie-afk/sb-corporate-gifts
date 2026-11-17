// Corporate sample box signups: one all-time count from the private Google Form response sheet.
//
// The sheet is private. It is read through the team's existing Apps Script spreadsheet reader (the same small web
// app the Marketing Dashboard uses; it runs as a team account that can open the sheet and only serves file ids on
// its allow-list). Server-side settings only, never sent to the browser or committed:
//   SAMPLE_SIGNUP_SHEET_ID  the response spreadsheet's id
//   SAMPLE_SIGNUP_TAB       the response tab's name (default "Sheet1")
//   SHEET_READER_URL        the reader web app address (https://script.google.com/macros/s/<id>/exec)
//   SHEET_READER_KEY        the reader's key (at least 32 characters)
//
// The reader returns the workbook; only columns A (Timestamp) and B (First name) of the configured tab are looked
// at, and the workbook is discarded straight away. Nothing from the sheet is stored, logged or returned except the
// count. A signup is a row with a valid submission timestamp; blank rows and rows whose first name is "TEST"
// (trimmed, any case) are skipped. Any read or format problem is an error, never a count of zero.
import ExcelJS from "exceljs";
import { HttpError } from "../http";
import { SHEET_ID_RE } from "./sheets";

const READER_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,120}\/exec$/;
const RESULT_HOST = "script.googleusercontent.com";
const TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4096;
const MAX_ROWS = 100_000;
const CACHE_MS = 2 * 60_000;

export type SampleSignupsReport = { ok: true; schema_version: 1; source: "sb-corporate-gifts"; id: "cg:sample-signups"; count: number; checked_at: string };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetcher = (u, i) => fetch(u, i);
let cache: { at: number; report: SampleSignupsReport } | null = null;
/** Tests only. */
export function _setSampleSignupFetchForTests(f: Fetcher | null) { fetchImpl = f ?? ((u, i) => fetch(u, i)); cache = null; }

export function sampleSignupsConfig(env: NodeJS.ProcessEnv = process.env) {
  const sheetId = env.SAMPLE_SIGNUP_SHEET_ID?.trim() ?? "";
  const tab = env.SAMPLE_SIGNUP_TAB?.trim() || "Sheet1";
  const url = env.SHEET_READER_URL?.trim() ?? "";
  const key = env.SHEET_READER_KEY ?? "";
  const ok = SHEET_ID_RE.test(sheetId) && READER_URL.test(url) && key.length >= 32 && tab.length <= 100;
  return ok ? { sheetId, tab, url, key } : null;
}

// ---------------------------------------------------------------------------------------------- counting

/** Google Forms writes the submission time; in the exported workbook it is a date, a serial number or M/D/YYYY h:mm:ss text. */
export function validTimestamp(v: unknown): boolean {
  if (v instanceof Date) return Number.isFinite(v.getTime()) && v.getUTCFullYear() >= 2000;
  if (typeof v === "number") return Number.isFinite(v) && v > 36526; // after 2000-01-01 as a spreadsheet serial
  if (typeof v === "string") {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
    if (!m) return false;
    const [mo, d, y, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return y >= 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && s <= 59;
  }
  return false;
}

const text = (v: unknown) => (v == null ? "" : String(v)).trim();

/** rows: [timestamp, firstName] pairs, header first. Throws if the header is not the form's. */
export function countSampleSignups(rows: unknown[][]): number {
  const header = (rows[0] ?? []).map((v) => text(v).toLowerCase());
  if (header[0] !== "timestamp" || header[1] !== "first name") throw new Error("unexpected_headers");
  let n = 0;
  for (const [timestamp, firstName] of rows.slice(1)) {
    if (!validTimestamp(timestamp)) continue;                 // blank or not a submitted row
    if (text(firstName).toLowerCase() === "test") continue;  // test submissions
    n++;
  }
  return n;
}

/** Columns A and B of one tab; every other column of the workbook is ignored. */
export async function columnsAB(buf: Buffer, tab: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets.find((w) => w.name === tab);
  if (!ws) throw new Error("tab_not_found");
  if (ws.rowCount > MAX_ROWS) throw new Error("too_many_rows");
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push([cellValue(row.getCell(1).value), cellValue(row.getCell(2).value)]);
  });
  return rows;
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return (v as any).result;                                   // formula
    if ("richText" in v) return (v as any).richText.map((r: any) => r.text).join(""); // rich text
    if ("text" in v) return (v as any).text;                                       // hyperlink
  }
  return v;
}

// ---------------------------------------------------------------------------------------------- reading

/** POSTs the key once; follows only 301/302/303 to script.googleusercontent.com (as GET, without the key). */
async function fetchWorkbook(cfg: NonNullable<ReturnType<typeof sampleSignupsConfig>>, signal: AbortSignal): Promise<Buffer> {
  let res = await fetchImpl(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: cfg.key, fileId: cfg.sheetId, kind: "google_sheet" }),
    redirect: "manual",
    signal,
  });
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    await res.body?.cancel().catch(() => {});
    if (![301, 302, 303].includes(res.status) || hops >= 2) throw new Error("redirect_refused");
    const next = new URL(res.headers.get("location") ?? "", cfg.url);
    if (next.protocol !== "https:" || next.hostname !== RESULT_HOST || next.username || next.password || (next.port && next.port !== "443")) throw new Error("redirect_refused");
    res = await fetchImpl(next.toString(), { method: "GET", redirect: "manual", signal });
  }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error("read_failed"); }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await res.body?.cancel().catch(() => {}); throw new Error("too_large"); }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) throw new Error("too_large");
  let j: { ok?: boolean; data?: unknown };
  try { j = JSON.parse(body.toString("utf8")); } catch { throw new Error("bad_response"); }
  if (!j?.ok || typeof j.data !== "string" || !j.data) throw new Error("reader_refused");
  const buf = Buffer.from(j.data, "base64");
  if (buf.length > MAX_FILE_BYTES) throw new Error("too_large");
  return buf;
}

export async function sampleSignupsReport(now = Date.now()): Promise<SampleSignupsReport> {
  const cfg = sampleSignupsConfig();
  if (!cfg) throw new HttpError(503, "sample_signups_unconfigured", "Sample box signup reporting is not configured.");
  if (cache && now - cache.at < CACHE_MS) return cache.report;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const rows = await columnsAB(await fetchWorkbook(cfg, ctrl.signal), cfg.tab);
    const report: SampleSignupsReport = { ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:sample-signups", count: countSampleSignups(rows), checked_at: new Date(now).toISOString() };
    cache = { at: now, report };
    return report;
  } catch {
    // The reason is deliberately not passed on: it could name the sheet or the reader.
    throw new HttpError(502, "sample_signups_unavailable", "Sample box signup data could not be read.");
  } finally {
    clearTimeout(timer);
  }
}
