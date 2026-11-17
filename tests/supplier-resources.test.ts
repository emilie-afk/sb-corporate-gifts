// FIXTURE TESTS — fictional suppliers, links and Slack identifiers only (example.test, Demo Market …).
// Supplier Resources (manual), the Slack-to-Corporate Gifts workflow (idempotent passes, cross-channel events,
// corrections, replacements, review queue, failures), and the dashboard's workflow summary.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { resetDb, call, app, S } from "./helpers";
import { getPool } from "../server/db";
import { _setSampleSignupFetchForTests } from "../server/lib/sampleSignups";

const SLACK = "test-slack-ingest-secret-test-slack-ingest-01";
const REPORTING = "test-reporting-secret-test-reporting-secret-01";
const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;

let tsN = 1790000000;
const ts = () => `${++tsN}.000100`;
const src = (channel: "seo" | "teammarketing", t: string, thread?: string) => ({
  channel, ts: t, ...(thread ? { thread_ts: thread } : {}),
  permalink: `https://example-workspace.slack.com/archives/CEXAMPLE${channel === "seo" ? "1" : "2"}/p${t.replace(".", "")}`,
});
const pass = (channel: "seo" | "teammarketing", findings: any[], messages?: string[]) => ({
  schema: "sbcg-slack-v1", channel,
  through_ts: [...(messages ?? []), ...findings.flatMap((f) => f.sources.map((s: any) => s.ts))].sort().at(-1) ?? ts(),
  messages: (messages ?? findings.flatMap((f) => f.sources.filter((s: any) => s.channel === channel).map((s: any) => s.ts))).map((t) => ({ ts: t })),
  findings,
});
async function post(body: unknown, opts: { auth?: string | null; dry?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== null) headers.authorization = `Bearer ${opts.auth ?? SLACK}`;
  const res = await app(new Request(`http://localhost/api/ingest/slack-findings${opts.dry ? "?dry_run=1" : ""}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function report(path: string, auth = `Bearer ${REPORTING}`) {
  const res = await app(new Request(`http://localhost/api${path}`, { headers: { authorization: auth } }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

let partners: Record<string, any>;
let vendor: any;
beforeAll(async () => {
  await resetDb();
  process.env.CORPORATE_SLACK_INGEST_SECRET = SLACK;
  process.env.CORPORATE_REPORTING_SECRET = REPORTING;
  partners = Object.fromEntries((await call("GET", "/marketplaces?include_inactive=1")).body.marketplaces.map((m: any) => [m.name, m]));
  vendor = (await call("POST", "/vendors", { ...S, name: "Example Pottery Co", website_url: "https://pottery.example.test" })).body.vendor;
});
afterAll(() => { delete process.env.CORPORATE_SLACK_INGEST_SECRET; _setSampleSignupFetchForTests(null); });

describe("Supplier Resources (manual)", () => {
  it("lists partners and vendors by their existing IDs, with unlinked vendor names", async () => {
    const r = await call("GET", "/suppliers");
    expect(r.status).toBe(200);
    expect(r.body.partners.find((p: any) => p.name === "Demo Market Alpha").ref).toBe(`partner:${partners["Demo Market Alpha"].id}`);
    expect(r.body.vendors.map((v: any) => v.ref)).toContain(`vendor:${vendor.id}`);
    expect((await call("POST", "/vendors", { ...S, name: "  example pottery co " })).status).toBe(400); // duplicate name
  });

  it("adds, edits and supersedes a resource; the earlier one stays in history", async () => {
    const supplier = `vendor:${vendor.id}`;
    const v1 = await call("POST", "/supplier-resources", { ...S, supplier, resource_type: "price_sheet", title: "Pack price sheet",
      link_url: "https://docs.example.test/v1", effective_date: "2026-10-01", last_confirmed_on: "2026-10-02" });
    expect(v1.status).toBe(200);
    expect(v1.body.resource.section).toBe("catalogs_pricing");
    const edited = await call("PATCH", `/supplier-resources/${v1.body.resource.id}`, { ...S, note: "Packs of 5 and 10", version: 1 });
    expect(edited.body.resource.note).toBe("Packs of 5 and 10");
    const v2 = await call("POST", "/supplier-resources", { ...S, supplier, resource_type: "price_sheet", title: "Pack price sheet (December)",
      link_url: "https://docs.example.test/v2", effective_date: "2026-12-01", supersedes_id: v1.body.resource.id });
    expect(v2.status).toBe(200);
    const list = await call("GET", `/supplier-resources?supplier=${supplier}`);
    const old = list.body.resources.find((r: any) => r.id === v1.body.resource.id);
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(v2.body.resource.id);
    expect(list.body.resources.filter((r: any) => r.status === "current")).toHaveLength(1);
    // A superseded resource cannot be superseded again; a replacement must be for the same supplier.
    expect((await call("POST", "/supplier-resources", { ...S, supplier, resource_type: "quote", title: "x", supersedes_id: v1.body.resource.id })).status).toBe(400);
    expect((await call("POST", "/supplier-resources", { ...S, supplier: `partner:${partners["Demo Market Alpha"].id}`, resource_type: "quote", title: "x", supersedes_id: v2.body.resource.id })).status).toBe(400);
  });

  it("links only the partner's own requirements and refuses unknown suppliers", async () => {
    const alpha = partners["Demo Market Alpha"].id, bravo = partners["Demo Market Bravo"].id;
    const reqB = (await call("POST", `/marketplaces/${bravo}/requirements`, { ...S, category: "other", requirement: "Bravo onboarding form" })).body.requirement;
    expect((await call("POST", "/supplier-resources", { ...S, supplier: `partner:${alpha}`, resource_type: "order_form", title: "Form", requirement_id: reqB.id })).status).toBe(400);
    expect((await call("POST", "/supplier-resources", { ...S, supplier: `partner:${bravo}`, resource_type: "order_form", title: "Vendor onboarding form", requirement_id: reqB.id })).status).toBe(200);
    expect((await call("POST", "/supplier-resources", { ...S, supplier: "vendor:00000000-0000-4000-8000-000000000009", resource_type: "logo", title: "Logo" })).status).toBe(404);
    expect((await call("POST", "/supplier-resources", { ...S, supplier: "Demo Market Alpha", resource_type: "logo", title: "Logo" })).status).toBe(400);
    expect((await call("POST", "/supplier-resources", { ...S, supplier: `partner:${alpha}`, resource_type: "logo", title: "Logo", link_url: "javascript:alert(1)" })).status).toBe(400);
  });

  it("matches a supplier by any of its names, and refuses ambiguous names", async () => {
    const { matchSupplier } = await import("../server/lib/suppliers");
    await call("POST", "/marketplaces", { ...S, name: "Example Gifts.io / Example Gifts", provider_type: "marketplace" });
    const one = await matchSupplier(getPool(), ["example gifts", "Example Gifts.io"]);
    expect(one.ref && "name" in one ? one.name : null).toBe("Example Gifts.io / Example Gifts");
    await call("POST", "/vendors", { ...S, name: "Example Gifts Inc." });
    const two = await matchSupplier(getPool(), ["Example Gifts"]);
    expect(two.ref).toBeNull();
    expect(two.ref === null && two.reason).toBe("several_matches");
    expect((await matchSupplier(getPool(), ["Example Gifts"], "vendor")).ref?.kind).toBe("vendor");
  });

  it("needs a signed-in session", async () => {
    expect((await call("GET", "/suppliers", undefined, { cookie: null })).status).toBe(401);
    expect((await call("GET", "/review-items", undefined, { cookie: null })).status).toBe(401);
  });
});

describe("Slack workflow", () => {
  const t1 = ts(), t2 = ts(), t3 = ts();
  const quote = (over: any = {}) => ({
    key: "pottery-holiday-quote", kind: "resource", certainty: "confirmed", supplier: { names: ["Example Pottery Co."] },
    title: "Holiday pack quote", summary: "Packs of 12 and 24", resource_type: "quote", series: "pottery-pack-quote",
    link_url: "https://docs.example.test/quote-1", sources: [src("seo", t1)], ...over,
  });

  it("adds a resource once; a rescan of the same messages changes nothing", async () => {
    const first = await post(pass("seo", [quote()]));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ added: 1, updated: 0, flagged: 0 });
    const again = await post(pass("seo", [quote()]));
    expect(again.body).toMatchObject({ added: 0, updated: 0, flagged: 0, unchanged: 1 });
    expect(await q("select count(*)::int as n from supplier_resources where finding_key = 'pottery-holiday-quote'")).toEqual([{ n: 1 }]);
    const state = await q("select position_ts, last_success_at from slack_scan_state where channel_key = 'seo'");
    expect(state[0].position_ts).toBe(t1);
  });

  it("the same event in the other channel supports the same record (one row, both sources)", async () => {
    const r = await post(pass("teammarketing", [quote({ sources: [src("teammarketing", t2)] })]));
    expect(r.body).toMatchObject({ added: 0, updated: 1 });
    const rows = await q("select * from supplier_resources where finding_key = 'pottery-holiday-quote'");
    expect(rows).toHaveLength(1);
    const f = (await q("select sources from slack_findings where key = 'pottery-holiday-quote'"))[0];
    expect(f.sources.map((s: any) => s.channel).sort()).toEqual(["seo", "teammarketing"]);
    // Separate progress per channel.
    const pos = Object.fromEntries((await q("select channel_key, position_ts from slack_scan_state")).map((x: any) => [x.channel_key, x.position_ts]));
    expect(pos).toEqual({ seo: t1, teammarketing: t2 });
  });

  it("a corrected thread reply updates the same record", async () => {
    const r = await post(pass("seo", [quote({ summary: "Packs of 12, 24 and 36", sources: [src("seo", t3, t1)] })]));
    expect(r.body).toMatchObject({ added: 0, updated: 1 });
    const rows = await q("select note, source_url from supplier_resources where finding_key = 'pottery-holiday-quote'");
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("Packs of 12, 24 and 36");
    expect(rows[0].source_url).toContain(t3.replace(".", ""));
  });

  it("a confirmed replacement quote supersedes the previous one", async () => {
    const t = ts();
    const r = await post(pass("seo", [quote({ key: "pottery-holiday-quote-v2", title: "Holiday pack quote (revised)", effective_date: "2026-12-01",
      link_url: "https://docs.example.test/quote-2", sources: [src("seo", t)] })]));
    expect(r.body).toMatchObject({ added: 1 });
    const rows = await q("select finding_key, status, superseded_by from supplier_resources where series_key = 'pottery-pack-quote' order by created_at");
    expect(rows.map((x: any) => [x.finding_key, x.status])).toEqual([["pottery-holiday-quote", "superseded"], ["pottery-holiday-quote-v2", "current"]]);
    const list = await call("GET", `/supplier-resources?supplier=vendor:${vendor.id}`);
    expect(list.body.resources.some((x: any) => x.finding_key === "pottery-holiday-quote" && x.status === "superseded")).toBe(true);
  });

  it("tentative, conflicting or unmatched findings go to review with their sources and question", async () => {
    const t = ts();
    const r = await post(pass("teammarketing", [
      { key: "cutoff-conflict", kind: "terms", certainty: "conflicting", supplier: { names: ["Demo Market Alpha"] }, title: "Holiday cutoff",
        question: "Dec 14 or Dec 20?", resource_type: "order_cutoff", sources: [src("teammarketing", t)] },
      { key: "unknown-vendor-moq", kind: "terms", certainty: "confirmed", supplier: { names: ["Nobody Ceramics"] }, title: "MOQ 50", resource_type: "minimum_quantity", sources: [src("teammarketing", t)] },
      { key: "vague-sample", kind: "sample", certainty: "confirmed", title: "Sample shipped", sample_status: "shipped", sources: [src("teammarketing", t)] },
    ]));
    expect(r.body).toMatchObject({ added: 0, flagged: 3 });
    const items = (await call("GET", "/review-items")).body.items;
    const conflict = items.find((i: any) => i.finding_key === "cutoff-conflict");
    expect(conflict.question).toBe("Dec 14 or Dec 20?");
    expect(conflict.sources[0].permalink).toContain("slack.com");
    expect(items.find((i: any) => i.finding_key === "unknown-vendor-moq").question).toMatch(/No partner or vendor record/);
    expect(items.find((i: any) => i.finding_key === "vague-sample").question).toMatch(/does not match a tracked request/);
    expect(await q("select count(*)::int as n from supplier_resources where finding_key in ('cutoff-conflict', 'unknown-vendor-moq')")).toEqual([{ n: 0 }]);
    // Once confirmed in a later message, the same key is applied and its review item closes.
    const t4 = ts();
    const ok = await post(pass("seo", [{ key: "cutoff-conflict", kind: "terms", certainty: "confirmed", supplier: { names: ["Demo Market Alpha"] },
      title: "Holiday cutoff", summary: "Dec 14", resource_type: "order_cutoff", effective_date: "2026-12-14", sources: [src("seo", t4)] }]));
    expect(ok.body).toMatchObject({ added: 1 });
    expect((await q("select status from review_items where finding_key = 'cutoff-conflict'"))[0].status).toBe("resolved");
  });

  it("sample updates move forward only, and never change the Google Form signup count", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Form Responses 1").addRows([["Timestamp", "First name"], [new Date("2026-11-14T17:00:00Z"), "Avery"]]);
    const data = Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
    Object.assign(process.env, { SAMPLE_SIGNUP_SHEET_ID: "example_signup_sheet_id_for_tests_0001", SAMPLE_SIGNUP_TAB: "Form Responses 1",
      SHEET_READER_URL: "https://script.google.com/macros/s/AKfycbExampleReaderForTests000001/exec", SHEET_READER_KEY: "k".repeat(40) });
    _setSampleSignupFetchForTests(async () => new Response(JSON.stringify({ ok: true, data })));
    const before = (await report("/reporting/v1/sample-signups")).body.count;
    const supplier = { names: ["Demo Market Alpha"] };
    const [a, b, c] = [ts(), ts(), ts()];
    expect((await post(pass("seo", [{ key: "alpha-samples", kind: "sample", certainty: "confirmed", supplier, title: "Alpha sample boxes", sample_status: "requested", sources: [src("seo", a)] }]))).body.added).toBe(1);
    expect((await post(pass("seo", [{ key: "alpha-samples", kind: "sample", certainty: "confirmed", supplier, title: "Alpha sample boxes", sample_status: "shipped", sources: [src("seo", b)] }]))).body.updated).toBe(1);
    // An older "approved" message read later does not move it back.
    await post(pass("teammarketing", [{ key: "alpha-samples", kind: "sample", certainty: "confirmed", supplier, title: "Alpha sample boxes", sample_status: "approved", sources: [src("teammarketing", c)] }]));
    expect((await q("select status from sample_requests where finding_key = 'alpha-samples'"))[0].status).toBe("shipped");
    _setSampleSignupFetchForTests(async () => new Response(JSON.stringify({ ok: true, data })));
    expect((await report("/reporting/v1/sample-signups")).body.count).toBe(before);
    expect(before).toBe(1);
  });

  it("outreach updates the partner (communication + status) and inactive statuses go to review", async () => {
    const charlie = partners["Demo Market Charlie"];
    const t = ts();
    const r = await post(pass("seo", [
      { key: "charlie-applied", kind: "outreach", certainty: "confirmed", supplier: { names: ["Demo Market Charlie"] }, title: "Application submitted",
        marketplace_status: "application_submitted", occurred_on: "2026-11-10", sources: [src("seo", t)] },
      { key: "delta-rejected", kind: "outreach", certainty: "confirmed", supplier: { names: ["Demo Market Delta"] }, title: "Rejected: no product fit",
        marketplace_status: "rejected", sources: [src("seo", t)] },
    ]));
    expect(r.body).toMatchObject({ added: 1, flagged: 1 });
    const m = (await call("GET", `/marketplaces/${charlie.id}`)).body;
    expect(m.marketplace.status).toBe("application_submitted");
    expect(m.statusHistory[0].signer_name).toBe("Slack workflow");
    expect(m.communications.some((x: any) => x.finding_key === "charlie-applied")).toBe(true);
    expect((await call("GET", `/marketplaces/${partners["Demo Market Delta"].id}`)).body.marketplace.status).toBe("prospect");
  });

  it("matches an existing requirement or action before creating one", async () => {
    const bravo = partners["Demo Market Bravo"].id;
    const act = (await call("POST", "/actions", { ...S, kind: "action", title: "Send the vendor form", supplier: `partner:${bravo}` })).body.action;
    const t = ts();
    const r = await post(pass("seo", [
      { key: "bravo-form-req", kind: "requirement", certainty: "confirmed", supplier: { names: ["Demo Market Bravo"] }, title: "BRAVO onboarding form", sources: [src("seo", t)] },
      { key: "bravo-form-action", kind: "action", certainty: "confirmed", supplier: { names: ["Demo Market Bravo"] }, title: "Send the vendor form",
        owner: "Example Owner", due: "2026-11-20", sources: [src("seo", t)] },
    ]));
    expect(r.body).toMatchObject({ added: 0, updated: 2 });
    const forms = await q("select finding_key from requirements where marketplace_id = $1 and removed_at is null and lower(requirement) like '%onboarding form%'", [bravo]);
    expect(forms).toEqual([{ finding_key: "bravo-form-req" }]); // the earlier manual requirement, matched (not a second one)
    const a = (await q("select owner, due_date, finding_key from corporate_actions where id = $1", [act.id]))[0];
    expect(a).toEqual({ owner: "Example Owner", due_date: "2026-11-20", finding_key: "bravo-form-action" });
  });

  it("a failed pass saves nothing and keeps the channel's last successful scan", async () => {
    const before = (await q("select position_ts, last_success_at from slack_scan_state where channel_key = 'teammarketing'"))[0];
    await getPool().query(`create or replace function fail_marker() returns trigger language plpgsql as $$ begin
      if new.title = 'FAIL-MARKER' then raise exception 'simulated failure'; end if; return new; end $$;
      create trigger fail_marker before insert on corporate_actions for each row execute function fail_marker();`);
    const t = ts();
    const r = await post(pass("teammarketing", [
      { key: "would-be-saved", kind: "blocker", certainty: "confirmed", title: "Images missing", sources: [src("teammarketing", t)] },
      { key: "will-fail", kind: "action", certainty: "confirmed", title: "FAIL-MARKER", sources: [src("teammarketing", t)] },
    ]));
    await getPool().query("drop trigger fail_marker on corporate_actions");
    expect(r.status).toBe(500);
    expect(await q("select count(*)::int as n from corporate_actions where finding_key in ('would-be-saved', 'will-fail')")).toEqual([{ n: 0 }]);
    const after = (await q("select position_ts, last_success_at, last_error from slack_scan_state where channel_key = 'teammarketing'"))[0];
    expect(after.position_ts).toBe(before.position_ts);
    expect(after.last_success_at).toEqual(before.last_success_at);
    expect(after.last_error).toBeTruthy();
    expect((await call("GET", "/slack/scans")).body.scans.find((s: any) => s.channel_key === "teammarketing").last_error).toBeTruthy();
  });

  it("a dry run reports outcomes and saves nothing", async () => {
    const t = ts();
    const r = await post(pass("seo", [{ key: "dry-only", kind: "decision", certainty: "confirmed", title: "Pitch small companies first", sources: [src("seo", t)] }]), { dry: true });
    expect(r.body).toMatchObject({ dry_run: true, added: 1 });
    expect(await q("select count(*)::int as n from corporate_actions where finding_key = 'dry-only'")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int as n from slack_findings where key = 'dry-only'")).toEqual([{ n: 0 }]);
  });

  it("rejects invalid payloads and the wrong credentials", async () => {
    expect((await post({ schema: "x" })).status).toBe(400);
    expect((await post(pass("seo", [{ ...quote(), key: "Bad Key" }]))).status).toBe(400);
    expect((await post(pass("seo", [quote(), quote()]))).status).toBe(400); // same key twice in one pass
    expect((await post(pass("seo", [quote({ sources: [{ channel: "seo", ts: ts(), permalink: "https://evil.example/p1" }] })]))).status).toBe(400);
    expect((await post(pass("seo", []), { auth: null })).status).toBe(401);
    expect((await post(pass("seo", []), { auth: REPORTING })).status).toBe(401);
    expect((await report("/reporting/v1/corporate-workflow", `Bearer ${SLACK}`)).status).toBe(401);
    process.env.CORPORATE_SLACK_INGEST_SECRET = REPORTING;
    expect((await post(pass("seo", []), { auth: REPORTING })).status).toBe(503);
    expect((await report("/reporting/v1/months")).status).toBe(503); // fail closed both ways
    process.env.CORPORATE_SLACK_INGEST_SECRET = SLACK;
    const state = await app(new Request("http://localhost/api/ingest/slack-state", { headers: { authorization: `Bearer ${SLACK}` } }));
    const sb = await state.json();
    expect(sb.channels.map((c: any) => c.channel_key)).toEqual(["seo", "teammarketing"]);
    expect(sb.tracked_threads.length).toBeGreaterThan(0);
  });
});

describe("dashboard summary", () => {
  it("returns only the intended summary fields", async () => {
    await call("POST", "/actions", { ...S, kind: "action", title: "Overdue follow-up", due_date: "2026-01-02" });
    await call("POST", "/actions", { ...S, kind: "blocker", title: "Vendor images missing" });
    const r = await report("/reporting/v1/corporate-workflow");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "follow_ups", "id", "ok", "recent", "sample_progress", "schema_version", "source", "today"]);
    expect(r.body.sample_progress).toEqual({ tracked: 1, by_status: { requested: 0, approved: 0, shipped: 1, delivered: 0, cancelled: 0 } });
    expect(r.body.follow_ups.overdue).toBe(1);
    expect(r.body.follow_ups.open).toBeGreaterThanOrEqual(2);
    for (const x of r.body.recent) expect(Object.keys(x).sort()).toEqual(["at", "id", "kind", "status", "supplier", "title"]);
    expect(r.body.recent.map((x: any) => x.kind)).toContain("blocker");
    for (const leak of ["slack.com", "docs.example.test", "Packs of 12", "Example Owner"]) expect(r.text).not.toContain(leak);
    expect((await report("/reporting/v1/corporate-workflow?x=1")).status).toBe(400);
  });
});
