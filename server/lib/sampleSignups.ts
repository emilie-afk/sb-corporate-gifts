import { HttpError } from "../http";
import { readSheet, SHEET_ID_RE } from "./sheets";

export function countSampleSignups(rows: unknown[][]) {
  const header = rows[0]?.map(value => String(value ?? "").trim().toLowerCase());
  if (header?.[0] !== "timestamp" || header[1] !== "first name") {
    throw new Error("Unexpected signup sheet headers.");
  }
  return rows.slice(1).filter(([timestamp, firstName]) => {
    const submitted = (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0)
      || (typeof timestamp === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/.test(timestamp.trim()));
    return submitted && String(firstName ?? "").trim().toLowerCase() !== "test";
  }).length;
}

export async function sampleSignupsReport() {
  const spreadsheetId = process.env.SAMPLE_SIGNUP_SHEET_ID?.trim() ?? "";
  const tabName = process.env.SAMPLE_SIGNUP_TAB?.trim() || "Sheet1";
  if (!SHEET_ID_RE.test(spreadsheetId) || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new HttpError(503, "sample_signups_unconfigured", "Sample box signup reporting is not configured.");
  }

  try {
    const rows = await readSheet({ spreadsheetId, tabName, gid: null, headerRow: 1, lastColumn: "B" });
    return { ok: true, schema_version: 1, count: countSampleSignups(rows), checked_at: new Date().toISOString() };
  } catch {
    throw new HttpError(502, "sample_signups_unavailable", "Sample box signup data could not be read.");
  }
}
