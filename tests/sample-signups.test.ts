// FIXTURE TESTS — synthetic workbooks only (example.test addresses). Sample box signups: one all-time count read
// through the Apps Script reader, count only, credential-protected reporting, and failures never shown as zero.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { resetDb, call, app } from "./helpers";
import { countSampleSignups, validTimestamp, columnsAB, sampleSignupsReport, _setSampleSignupFetchForTests } from "../server/lib/sampleSignups";

const REPORTING = "test-reporting-secret-test-reporting-secret-01";
const SHEET_ID = "example_signup_sheet_id_for_tests_0001";
const READER = "https://script.google.com/macros/s/AKfycbExampleReaderForTests000001/exec";
const KEY = "test-sheet-reader-key-test-sheet-reader-key-01";
const TAB = "Form Responses 1";
const HEADER = ["Timestamp", "First name", "Last name", "Work email", "Company name"];
const TEST_ROW = [new Date(Date.UTC(2026, 10, 13, 21, 3, 55)), "TEST", "DO NOT PROCESS", "sampletest@example.test", "TEST COMPANY - IGNORE"];
const REAL_ROW = [new Date(Date.UTC(2026, 10, 14, 17, 0, 0)), "Avery", "Synthetic", "avery@example.test", "Example Co"];

async function workbook(rows: unknown[][], opts: { tab?: string; extraTab?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  if (opts.extraTab !== false) wb.addWorksheet("Sheet1");          // the empty default tab the real file also has
  const ws = wb.addWorksheet(opts.tab ?? TAB);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

type Reply = { status?: number; json?: unknown; location?: string; raw?: string };
let calls: { url: string; init?: RequestInit }[] = [];
function reader(...replies: Reply[]) {
  calls = [];
  let i = 0;
  _setSampleSignupFetchForTests(async (url, init) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.location) return new Response(null, { status: r.status ?? 302, headers: { location: r.location } });
    return new Response(r.raw ?? JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
}
const workbookReply = async (rows: unknown[][], opts?: { tab?: string; extraTab?: boolean }): Promise<Reply> =>
  ({ json: { ok: true, data: (await workbook(rows, opts)).toString("base64") } });

async function report(path: string, auth: string | null = `Bearer ${REPORTING}`) {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  const res = await app(new Request(`http://localhost/api${path}`, { headers }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
  await resetDb();
  process.env.CORPORATE_REPORTING_SECRET = REPORTING;
});
beforeEach(() => {
  Object.assign(process.env, { SAMPLE_SIGNUP_SHEET_ID: SHEET_ID, SAMPLE_SIGNUP_TAB: TAB, SHEET_READER_URL: READER, SHEET_READER_KEY: KEY });
  _setSampleSignupFetchForTests(null);
});
afterAll(() => {
  _setSampleSignupFetchForTests(null);
  for (const k of ["SAMPLE_SIGNUP_SHEET_ID", "SAMPLE_SIGNUP_TAB", "SHEET_READER_URL", "SHEET_READER_KEY"]) delete process.env[k];
});

describe("counting rules", () => {
  it("counts submitted rows, skipping blank rows and TEST first names (trimmed, any case)", () => {
    const rows = [["Timestamp", "First name"], TEST_ROW.slice(0, 2), ["", ""], [null, null], [REAL_ROW[0], "Avery"],
      ["11/15/2026 9:30:00", "  test "], ["11/15/2026 9:31:00", "Tess"], ["11/15/2026 9:32:00", "Testing"], ["11/15/2026 9:33:00", ""]];
    expect(countSampleSignups(rows)).toBe(4); // Avery, Tess, Testing, and a submitted row with no first name
  });
  it("the current source (header + one TEST submission) counts 0", () => {
    expect(countSampleSignups([HEADER.slice(0, 2), TEST_ROW.slice(0, 2)])).toBe(0);
  });
  it("only real timestamps make a row a signup", () => {
    for (const v of [new Date("2026-11-13T21:03:55Z"), 46339.88, "11/13/2026 13:03:55", "1/2/2026 9:05"]) expect(validTimestamp(v), String(v)).toBe(true);
    for (const v of ["", null, undefined, "hello", "2/30/2026 10:00:00", "13/1/2026 10:00", "11/13/2026", 0, -5, new Date("invalid")]) expect(validTimestamp(v), String(v)).toBe(false);
  });
  it("refuses a sheet that is not the form response tab (wrong headers)", () => {
    expect(() => countSampleSignups([])).toThrow();
    expect(() => countSampleSignups([["Name", "Email"], ["x", "y"]])).toThrow();
  });
  it("reads only columns A and B of the named tab", async () => {
    const rows = await columnsAB(await workbook([HEADER, TEST_ROW, REAL_ROW]), TAB);
    expect(rows.every((r) => r.length === 2)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("example.test");
    await expect(columnsAB(await workbook([HEADER]), "Missing tab")).rejects.toThrow();
  });
});

describe("report", () => {
  it("is 0 for the current source and counts a valid signup", async () => {
    reader(await workbookReply([HEADER, TEST_ROW]));
    expect((await sampleSignupsReport()).count).toBe(0);
    reader(await workbookReply([HEADER, TEST_ROW, REAL_ROW]));
    expect((await sampleSignupsReport()).count).toBe(1);
  });
  it("sends the key only in the first POST, for the configured sheet, and follows only Google's result host", async () => {
    reader({ status: 302, location: "https://script.googleusercontent.com/macros/echo?user_content_key=abc" }, await workbookReply([HEADER, REAL_ROW]));
    expect((await sampleSignupsReport()).count).toBe(1);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ key: KEY, fileId: SHEET_ID, kind: "google_sheet" });
    expect(calls[1].init?.body).toBeUndefined();
    expect(calls[1].init?.method).toBe("GET");
  });
  it("caches a successful count for two minutes", async () => {
    reader(await workbookReply([HEADER, REAL_ROW]));
    const t = Date.now();
    await sampleSignupsReport(t);
    await sampleSignupsReport(t + 60_000);
    expect(calls).toHaveLength(1);
    await sampleSignupsReport(t + 3 * 60_000);
    expect(calls).toHaveLength(2);
  });
  it("a source failure is an error (502), never a count of zero", async () => {
    const failures: Reply[][] = [
      [{ json: { ok: false, error: "not_allowed" } }],
      [{ json: { ok: false, error: "no_access" } }],
      [{ status: 500, raw: "oops" }],
      [{ raw: "<html>sign in</html>" }],
      [{ status: 302, location: "https://evil.example/steal" }],
      [{ status: 307, location: "https://script.googleusercontent.com/x" }],
      [await workbookReply([HEADER, REAL_ROW], { tab: "Other tab" })],
      [await workbookReply([["Name", "Email"], ["x", "y"]])],
    ];
    for (const replies of failures) {
      reader(...replies);
      const r = await report("/reporting/v1/sample-signups");
      expect(r.status, JSON.stringify(replies[0]).slice(0, 80)).toBe(502);
      expect(r.body.error.code).toBe("sample_signups_unavailable");
      expect(r.body.count).toBeUndefined();
      expect(r.text).not.toContain(SHEET_ID);
      expect(r.text).not.toContain("script.google");
    }
  });
  it("is unavailable (503) when not configured", async () => {
    for (const k of ["SAMPLE_SIGNUP_SHEET_ID", "SHEET_READER_URL", "SHEET_READER_KEY"]) {
      const saved = process.env[k];
      delete process.env[k];
      expect((await report("/reporting/v1/sample-signups")).status).toBe(503);
      process.env[k] = saved;
    }
    process.env.SHEET_READER_URL = "https://evil.example/exec";
    expect((await report("/reporting/v1/sample-signups")).status).toBe(503);
  });
});

describe("access", () => {
  it("reporting route requires its own credential and returns the count and metadata only", async () => {
    reader(await workbookReply([HEADER, TEST_ROW, REAL_ROW]));
    expect((await report("/reporting/v1/sample-signups", null)).status).toBe(401);
    expect((await report("/reporting/v1/sample-signups", "Bearer wrong-wrong-wrong-wrong-wrong-wrong-wrong")).status).toBe(401);
    expect((await report("/reporting/v1/sample-signups", `Bearer ${KEY}`)).status).toBe(401);
    expect((await report("/reporting/v1/sample-signups?x=1")).status).toBe(400);
    const ok = await report("/reporting/v1/sample-signups");
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(["checked_at", "count", "id", "ok", "schema_version", "source"]);
    expect(ok.body.count).toBe(1);
    for (const leak of ["Avery", "TEST", "example.test", SHEET_ID, KEY]) expect(ok.text).not.toContain(leak);
    const saved = process.env.CORPORATE_REPORTING_SECRET;
    delete process.env.CORPORATE_REPORTING_SECRET;
    expect((await report("/reporting/v1/sample-signups")).status).toBe(503);
    process.env.CORPORATE_REPORTING_SECRET = saved;
  });
  it("the app route needs a signed-in session", async () => {
    reader(await workbookReply([HEADER, TEST_ROW]));
    expect((await call("GET", "/sample-signups", undefined, { cookie: null })).status).toBe(401);
    const r = await call("GET", "/sample-signups");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(0);
  });
});
