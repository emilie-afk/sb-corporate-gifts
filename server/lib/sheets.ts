// Read-only Google Sheets access, server-side only.
// Default: a Google service account (GOOGLE_SERVICE_ACCOUNT_JSON) that the team shares onto the
// Product Master sheet as Viewer. The sheet never needs to be public. Swap the reader if the team
// prefers explicit OAuth Sheets authorization instead.
import { SignJWT, importPKCS8 } from "jose";

export type SheetsReader = (spreadsheetId: string, range: string) => Promise<unknown[][]>;

let token: { value: string; exp: number } | null = null;

async function serviceAccountToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Product Master access is not configured (GOOGLE_SERVICE_ACCOUNT_JSON missing).");
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
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token request failed (HTTP ${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

const defaultReader: SheetsReader = async (spreadsheetId, range) => {
  const t = await serviceAccountToken();
  const u = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`;
  const res = await fetch(u, { headers: { authorization: `Bearer ${t}` } });
  if (res.status === 403 || res.status === 404) throw new Error(`No read access to the sheet/tab (HTTP ${res.status}). Share it with the service account as Viewer and check the tab name.`);
  if (!res.ok) throw new Error(`Sheets read failed (HTTP ${res.status})`);
  const j = (await res.json()) as { values?: unknown[][] };
  return j.values ?? [];
};

let reader: SheetsReader = defaultReader;
export function setSheetsReader(r: SheetsReader | null) {
  reader = r ?? defaultReader;
}
export function readSheet(spreadsheetId: string, range: string) {
  return reader(spreadsheetId, range);
}

export function a1Range(tab: string, headerRow: number, lastColumn: string) {
  return `'${tab.replace(/'/g, "''")}'!A${headerRow}:${lastColumn}`;
}

/** Accepts a spreadsheet link or bare ID; returns the ID or null. */
export function spreadsheetIdFrom(input: string): string | null {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/.exec(input) ?? /^([A-Za-z0-9_-]{20,100})$/.exec(input.trim());
  return m ? m[1] : null;
}
