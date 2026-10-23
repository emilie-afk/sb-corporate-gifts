// Read-only Product Master access, server-side only.
//
// Default ("public" mode): the sheet is shared "Anyone with the link can view", so each vendor tab is read
// from Google's CSV export for that tab (needs the tab's gid). No credentials are involved.
// Optional: if GOOGLE_SERVICE_ACCOUNT_JSON is set, the Sheets API is used instead (for a private sheet
// shared with the service account as Viewer).
import { SignJWT, importPKCS8 } from "jose";

export type TabRef = { spreadsheetId: string; tabName: string; gid: string | null; headerRow: number; lastColumn: string };
/** Returns rows starting at the header row (first row = headers). */
export type SheetsReader = (tab: TabRef) => Promise<unknown[][]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- restricted fetching
/**
 * The only hosts this module ever contacts. Google's CSV export answers from docs.google.com and redirects
 * to a *.googleusercontent.com download host. Nothing else is fetched, so this is never a URL-fetch proxy.
 */
const SHEET_HOSTS = [/^docs\.google\.com$/, /^[a-z0-9-]+\.googleusercontent\.com$/];
const API_HOSTS = [/^sheets\.googleapis\.com$/, /^oauth2\.googleapis\.com$/];
const MAX_REDIRECTS = 4;
const MAX_SHEET_BYTES = 15 * 1024 * 1024;
export const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,100}$/;

export class SheetFetchError extends Error {
  constructor(message: string, public final = false) { super(message); }
}

export function hostAllowed(u: URL, hosts: RegExp[]) {
  return u.protocol === "https:" && !u.username && !u.password && (u.port === "" || u.port === "443") && hosts.some((h) => h.test(u.hostname));
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let sheetFetcher: Fetcher = (u, i) => fetch(u, i);
/** Tests only. */
export function _setSheetFetcherForTests(f: Fetcher | null) { sheetFetcher = f ?? ((u, i) => fetch(u, i)); }

/** GET with manual redirects: every hop must stay on an allowed https host. Error messages never contain URLs. */
export async function restrictedGet(start: string, hosts: RegExp[], init: RequestInit = {}): Promise<Response> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!hostAllowed(url, hosts)) throw new SheetFetchError("Blocked: the sheet address points outside Google Sheets.", true);
    const res = await sheetFetcher(url.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new SheetFetchError("Google returned a redirect without a destination.", true);
      url = new URL(loc, url);
      continue;
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_SHEET_BYTES) throw new SheetFetchError("The sheet tab is too large to read.", true);
    return res;
  }
  throw new SheetFetchError("Too many redirects while reading the sheet.", true);
}

// --------------------------------------------------------------- public CSV
/** RFC 4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const publicReader: SheetsReader = async (tab) => {
  if (!tab.gid || !/^\d{1,12}$/.test(tab.gid))
    throw new Error(`Tab "${tab.tabName}" needs its gid (the number after "gid=" in the tab's link).`);
  if (!SHEET_ID_RE.test(tab.spreadsheetId)) throw new Error(`Tab "${tab.tabName}" has an invalid spreadsheet reference.`);
  const url = `https://docs.google.com/spreadsheets/d/${tab.spreadsheetId}/export?format=csv&gid=${tab.gid}`;
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await restrictedGet(url, SHEET_HOSTS, { signal: ctrl.signal });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.includes("text/csv")) {
        const body = await res.text();
        if (body.length > MAX_SHEET_BYTES) throw Object.assign(new Error("The sheet tab is too large to read."), { final: true });
        const rows = parseCsv(body);
        return rows.slice(tab.headerRow - 1);
      }
      // A non-CSV 200 is Google's sign-in page: the sheet/tab is not publicly viewable.
      if (res.ok || res.status === 401 || res.status === 403 || res.status === 404)
        throw Object.assign(new Error(`Tab "${tab.tabName}" is not publicly readable (check "Anyone with the link can view" and the gid).`), { final: true });
      last = `HTTP ${res.status}`;
    } catch (e: any) {
      if (e?.final) throw e;
      last = e?.name === "AbortError" ? "timeout" : "network error"; // never echo raw errors (they can contain URLs)
    } finally {
      clearTimeout(t);
    }
    await sleep(700 * (attempt + 1));
  }
  throw new Error(`Could not read tab "${tab.tabName}" (${last}).`);
};

// -------------------------------------------------- optional: service account
let token: { value: string; exp: number } | null = null;

async function serviceAccountToken(raw: string): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const sa = JSON.parse(raw) as { client_email: string; private_key: string };
  const key = await importPKCS8(sa.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/spreadsheets.readonly" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await restrictedGet("https://oauth2.googleapis.com/token", API_HOSTS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token request failed (HTTP ${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

const serviceAccountReader = (raw: string): SheetsReader => async (tab) => {
  const t = await serviceAccountToken(raw);
  const range = a1Range(tab.tabName, tab.headerRow, tab.lastColumn);
  const u = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(tab.spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`;
  if (!SHEET_ID_RE.test(tab.spreadsheetId)) throw new Error(`Tab "${tab.tabName}" has an invalid spreadsheet reference.`);
  const res = await restrictedGet(u, API_HOSTS, { headers: { authorization: `Bearer ${t}` } });
  if (res.status === 403 || res.status === 404) throw new Error(`No read access to the sheet/tab (HTTP ${res.status}). Share it with the service account as Viewer and check the tab name.`);
  if (!res.ok) throw new Error(`Sheets read failed (HTTP ${res.status})`);
  const j = (await res.json()) as { values?: unknown[][] };
  return j.values ?? [];
};

// ------------------------------------------------------------------- facade
let override: SheetsReader | null = null;
export function setSheetsReader(r: SheetsReader | null) {
  override = r;
}
export function readSheet(tab: TabRef) {
  if (override) return override(tab);
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  return sa ? serviceAccountReader(sa)(tab) : publicReader(tab);
}

export function a1Range(tab: string, headerRow: number, lastColumn: string) {
  return `'${tab.replace(/'/g, "''")}'!A${headerRow}:${lastColumn}`;
}

/** Accepts a spreadsheet link or bare ID; returns the ID or null. */
export function spreadsheetIdFrom(input: string): string | null {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/.exec(input) ?? /^([A-Za-z0-9_-]{20,100})$/.exec(input.trim());
  return m ? m[1] : null;
}

/** The tab gid from a pasted tab link (…#gid=123 or ?gid=123), if present. */
export function gidFrom(input: string): string | null {
  const m = /[#?&]gid=(\d{1,12})/.exec(input);
  return m ? m[1] : null;
}
