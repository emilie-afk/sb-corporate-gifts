// FIXTURE TESTS — synthetic orders only (#91xxxx, example.test). The read-only reporting API for the Marketing
// Dashboard: its own credential, the Revenue page's figures, completeness, revisions, pagination, and no customer,
// contact, note, signer or secret data.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetDb, call, app, S, cookieFor, APPROVED } from "./helpers";
import { prepareCorporateOrdersPayload, parseCsvObjects } from "../shared/corporateOrders.js";
import { monthsReport } from "../server/reportingEndpoint";
import { getPool } from "../server/db";

const INGEST = "test-ingest-secret-test-ingest-secret-0001";
const REPORTING = "test-reporting-secret-test-reporting-secret-01";
const csv = readFileSync(join(import.meta.dirname, "fixtures", "shopify-orders-SYNTHETIC.csv"), "utf8");

async function report(path: string, auth: string | null = `Bearer ${REPORTING}`, method = "GET") {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  const res = await app(new Request(`http://localhost/api${path}`, { method, headers }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

let channels: Record<string, any>;
beforeAll(async () => {
  await resetDb();
  process.env.CORPORATE_INGEST_SECRET = INGEST;
  process.env.CORPORATE_REPORTING_SECRET = REPORTING;
  channels = Object.fromEntries((await call("GET", "/channels")).body.channels.map((c: any) => [c.name, c]));
  const { headers, rows } = parseCsvObjects(csv);
  const p = prepareCorporateOrdersPayload(rows, { headers, exportedAt: "2026-10-05T08:00:00.000Z", coverageFrom: "2026-08-10", coverageTo: "2026-10-04", fileName: "synthetic.csv" });
  if (p.refused) throw new Error("refused");
  const r = await app(new Request("http://localhost/api/ingest/shopify-orders", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${INGEST}` }, body: JSON.stringify(p.payload) }));
  expect(r.status).toBe(200);
  const bravo = channels["Demo Market Bravo"].id;
  // A manual sale with a private note, signer and reference that must never be reported.
  expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: bravo, reporting_month: "2026-09", kind: "off_shopify_sale", gift_sales_cents: 50000,
    reason: "PRIVATE-REASON bank transfer", reference: "PRIVATE-REF-1", entry_date: "2026-09-20" })).status).toBe(200);
  expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: bravo, reporting_month: "2026-09", kind: "fee", marketplace_fees_cents: 3500, reason: "Statement fee", reference: "STMT-SYN-9", entry_date: "2026-09-30" })).status).toBe(200);
  // Manual sales in August and October, so those months exist (the synthetic orders are all in September).
  for (const [m, ref] of [["2026-08", "AUG-SYN-1"], ["2026-10", "OCT-SYN-1"]]) {
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: bravo, reporting_month: m, kind: "off_shopify_sale", gift_sales_cents: 10000, reason: "Invoice", reference: ref, entry_date: `${m}-15` })).status).toBe(200);
  }
});
afterEach(() => { process.env.CORPORATE_REPORTING_SECRET = REPORTING; });

describe("credential", () => {
  it("is disabled without its own secret, or when it equals another secret", async () => {
    delete process.env.CORPORATE_REPORTING_SECRET;
    expect((await report("/reporting/v1/months")).status).toBe(503);
    process.env.CORPORATE_REPORTING_SECRET = "short";
    expect((await report("/reporting/v1/months", "Bearer short")).status).toBe(503);
    process.env.CORPORATE_REPORTING_SECRET = INGEST;
    expect((await report("/reporting/v1/months", `Bearer ${INGEST}`)).status).toBe(503);
    // Fail closed both ways: the shared value cannot write imports either.
    const ing = await app(new Request("http://localhost/api/ingest/shopify-orders", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${INGEST}` }, body: "{}" }));
    expect(ing.status).toBe(503);
    process.env.CORPORATE_REPORTING_SECRET = process.env.SESSION_SECRET;
    expect((await report("/reporting/v1/months", `Bearer ${process.env.SESSION_SECRET}`)).status).toBe(503);
  });
  // Regression: a reporting (or ingest) secret equal to the session signing key would let its holder forge a session.
  it("a session signing key equal to the reporting or ingest secret refuses every session, including a forged one", async () => {
    const original = process.env.SESSION_SECRET!;
    for (const name of ["CORPORATE_REPORTING_SECRET", "CORPORATE_INGEST_SECRET"]) {
      const saved = process.env[name];
      process.env[name] = original;                          // the collision
      try {
        const forged = await cookieFor(APPROVED).catch(() => null);   // signing refuses too
        expect(forged).toBeNull();
        // A cookie signed with that key by the credential holder (the key is the shared value) is refused.
        const { SignJWT } = await import("jose");
        const token = await new SignJWT({ email: APPROVED }).setProtectedHeader({ alg: "HS256" }).setSubject("forged").setAudience("sbg-app")
          .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(original));
        const r = await app(new Request("http://localhost/api/revenue/summary", { headers: { cookie: `sbg_session=${token}` } }));
        expect(r.status).toBe(503);
        const s = await app(new Request("http://localhost/api/auth/session", { headers: { cookie: `sbg_session=${token}` } }));
        expect(await s.json()).toEqual({ authenticated: false });
      } finally {
        if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
      }
    }
    expect((await call("GET", "/revenue/summary")).status).toBe(200);   // distinct secrets: sessions work again
  });
  it("refuses a missing or wrong credential, the ingest secret and the Google session", async () => {
    expect((await report("/reporting/v1/months", null)).status).toBe(401);
    expect((await report("/reporting/v1/months", `Bearer ${INGEST}`)).status).toBe(401);
    expect((await report("/reporting/v1/months", "Bearer wrong-wrong-wrong-wrong-wrong-wrong")).status).toBe(401);
    const viaSession = await call("GET", "/reporting/v1/months");     // signed-in browser session, no bearer
    expect(viaSession.status).toBe(401);
  });
  it("opens nothing else: the reporting secret is not a session or ingest credential", async () => {
    const r = await app(new Request("http://localhost/api/revenue/summary", { headers: { authorization: `Bearer ${REPORTING}` } }));
    expect(r.status).toBe(401);
    const i = await app(new Request("http://localhost/api/ingest/shopify-orders", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${REPORTING}` }, body: "{}" }));
    expect(i.status).toBe(401);
    expect((await report("/reporting/v1/months", `Bearer ${REPORTING}`, "POST")).status).toBe(405);
    expect((await report("/reporting/v1/other")).status).toBe(404);
  });
});

describe("months", () => {
  it("reports exactly the Revenue page's figures per month, with dates, timezone, scope and revision", async () => {
    const r = await report("/reporting/v1/months?from=2026-09&to=2026-09");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
    const [m] = r.body.months;
    const page = (await call("GET", "/revenue/summary?from=2026-09&to=2026-09")).body;
    expect(m.id).toBe("cg:month:2026-09");
    expect(m.period).toEqual({ start: "2026-09-01", end: "2026-09-30", granularity: "month", timezone: "America/Los_Angeles" });
    expect(m.scope.key).toBe("channel:corporate");
    expect(m.totals.net_revenue_cents).toBe(page.totals.combined_cents);
    expect(m.totals.shopify_net_revenue_cents).toBe(page.totals.shopify_cents);
    expect(m.totals.manual_net_revenue_cents).toBe(page.totals.manual_cents);
    expect(m.totals.shopify_orders).toBe(page.totals.orders);
    expect(m.totals.marketplace_fees_cents).toBe(3500);
    expect(m.channels.reduce((t: number, c: any) => t + c.net_revenue_cents, 0)).toBe(m.totals.net_revenue_cents);
    expect(m.revision).toMatch(/^[0-9a-f]{16}$/);
  });
  it("completeness: a month still running is provisional; partial coverage or open review items make it partial", async () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const s = await monthsReport(new URLSearchParams({ from: "2026-08", to: "2026-10" }), now);
    const by = Object.fromEntries(s.months.map((m: any) => [m.period.start.slice(0, 7), m]));
    expect(by["2026-10"].completeness).toBe("provisional");
    expect(by["2026-10"].completeness_reasons).toContain("month_in_progress");
    expect(by["2026-08"].completeness).toBe("partial");                 // the fixture covers Aug 10 onwards only
    expect(by["2026-08"].completeness_reasons).toContain("shopify_coverage_partial");
    const later = await monthsReport(new URLSearchParams({ from: "2026-09", to: "2026-09" }), now);
    expect(["complete", "partial"]).toContain(later.months[0].completeness);
    if (later.months[0].completeness === "complete") expect(later.months[0].completeness_reasons).toEqual([]);
  });
  // Regression: a manual sale and a refund that cancel out leave manual net revenue at zero; the entry count shows them.
  it("reports manual entries as a count, so entries that cancel out are still visible", async () => {
    const bravo = channels["Demo Market Bravo"].id;
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: bravo, reporting_month: "2026-06", kind: "off_shopify_sale", gift_sales_cents: 20000, reason: "Invoice", reference: "JUN-SYN-1", entry_date: "2026-06-10" })).status).toBe(200);
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: bravo, reporting_month: "2026-06", kind: "correction", gift_sales_cents: -20000, reason: "Refunded", reference: "JUN-SYN-2", entry_date: "2026-06-20" })).status).toBe(200);
    const [jun] = (await report("/reporting/v1/months?from=2026-06&to=2026-06")).body.months;
    expect(jun.totals.manual_net_revenue_cents).toBe(0);
    expect(jun.totals.manual_entries).toBe(2);
    expect(jun.channels.find((c: any) => c.channel_id === bravo).manual_entries).toBe(2);
    const [sep] = (await report("/reporting/v1/months?from=2026-09&to=2026-09")).body.months;
    expect(sep.totals.manual_entries).toBeGreaterThanOrEqual(1);
  });
  it("a correction changes the revision of that month only, under the same record id", async () => {
    const before = (await report("/reporting/v1/months?from=2026-08&to=2026-09")).body.months;
    const bravo = channels["Demo Market Bravo"].id;
    expect((await call("POST", "/revenue/adjustments", { ...S, channel_id: bravo, reporting_month: "2026-09", kind: "correction", gift_sales_cents: -1000, reason: "Corrected invoice", reference: "COR-SYN-1", entry_date: "2026-10-01" })).status).toBe(200);
    const after = (await report("/reporting/v1/months?from=2026-08&to=2026-09")).body.months;
    const pick = (l: any[], id: string) => l.find((m) => m.id === id);
    expect(pick(after, "cg:month:2026-09").revision).not.toBe(pick(before, "cg:month:2026-09").revision);
    expect(pick(after, "cg:month:2026-09").totals.net_revenue_cents).toBe(pick(before, "cg:month:2026-09").totals.net_revenue_cents - 1000);
    expect(pick(after, "cg:month:2026-08").revision).toBe(pick(before, "cg:month:2026-08").revision);
  });
  it("pages by month with a cursor and checks parameters", async () => {
    const all = (await report("/reporting/v1/months")).body.months.map((m: any) => m.id);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const p1 = (await report("/reporting/v1/months?limit=1")).body;
    expect(p1.months.map((m: any) => m.id)).toEqual(all.slice(0, 1));
    const p2 = (await report(`/reporting/v1/months?limit=1&cursor=${p1.next_cursor}`)).body;
    expect(p2.months.map((m: any) => m.id)).toEqual(all.slice(1, 2));
    for (const q of ["?limit=0", "?limit=25", "?from=2026-9", "?cursor=x", "?from=2026-10&to=2026-09", "?channel_id=x"]) {
      expect((await report(`/reporting/v1/months${q}`)).status).toBe(400);
    }
  });
  it("never returns orders, customers, contacts, notes, signers, references or secrets", async () => {
    await getPool().query("update marketplaces set contact_name = 'PRIVATE-CONTACT', contact_email = 'private@example.test', portal_url = 'https://portal.example.test/private', priority_note = 'PRIVATE-NOTE'");
    const text = JSON.stringify((await report("/reporting/v1/months")).body) + JSON.stringify((await report("/reporting/v1/pipeline")).body);
    for (const s of ["#9100", "example.test", "Synthetic Person", "Bravo Gifting LLC", "PRIVATE", "STMT-SYN", "AUG-SYN", "JUN-SYN", "Test Person", "portal", "billing", "tags", REPORTING, INGEST]) {
      expect(text).not.toContain(s);
    }
  });
});

describe("pipeline", () => {
  it("returns counts by provider type and status only", async () => {
    const r = await report("/reporting/v1/pipeline");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("cg:pipeline");
    const total = r.body.counts.reduce((t: number, c: any) => t + c.n, 0);
    expect(total).toBe(Number((await getPool().query("select count(*) n from marketplaces")).rows[0].n));
    for (const c of r.body.counts) expect(Object.keys(c).sort()).toEqual(["n", "provider_type", "status"]);
    expect((await report("/reporting/v1/pipeline?x=1")).status).toBe(400);
  });
});
