// FIXTURE TESTS — fictional marketplaces, links and Slack identifiers only (example.test, Demo Market …).
// Marketplace Resources (manual), the Slack-to-Corporate Gifts workflow v2 (eligibility, status updates, resources,
// tasks for Marketing Tasks, conflicts, preview, idempotent and cross-channel passes), task delivery receipts,
// the cleanup of earlier imports, and the dashboard's workflow summary.
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
  schema: "sbcg-slack-v2", channel,
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
  // Fictional owner directory: one Marketing team member (tasks for her go to the dashboard).
  expect((await call("POST", "/owners", { ...S, name: "Example Owner", team: "marketing" })).status).toBe(200);
});
afterAll(() => { delete process.env.CORPORATE_SLACK_INGEST_SECRET; _setSampleSignupFetchForTests(null); });

describe("Marketplace Resources (manual)", () => {
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

const sel = { role: "selling" as const, certainty: "confirmed" as const };
const imp = (p: any, dry = false) => call("POST", "/slack/import", { ...S, pass: p, dry_run: dry });
const counts = async () => (await q(`select (select count(*) from marketplaces)::int as m, (select count(*) from review_items)::int as r,
  (select count(*) from corporate_task_requests)::int as t, (select count(*) from supplier_resources)::int as res, (select count(*) from status_history)::int as h`))[0];
const mp = async (name: string) => (await q("select * from marketplaces where name = $1", [name]))[0];
const receipt = async (body: unknown, auth = `Bearer ${REPORTING}`) => {
  const res = await app(new Request("http://localhost/api/reporting/v1/corporate-task-receipts", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("Slack workflow v2: eligibility", () => {
  it("applies an eligible marketplace status update; preview shows it and writes nothing", async () => {
    const t = ts();
    const f = { ...sel, key: "alpha-under-review", type: "status", partner: { names: ["demo market alpha"] }, title: "Alpha application under review",
      application_status: "under_review", relationship_status: "application_submitted", sources: [src("seo", t)] };
    const before = await counts();
    const prev = await imp(pass("seo", [f]), true);
    expect(prev.status).toBe(200);
    expect(prev.body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "status", field: "application_status", from: null, to: "under_review", partner: expect.objectContaining({ name: "Demo Market Alpha" }) }),
      expect.objectContaining({ type: "status", field: "relationship_status", from: "reconnecting", to: "application_submitted" }),
    ]));
    expect(await counts()).toEqual(before);
    expect((await mp("Demo Market Alpha")).application_status).toBeNull();

    const saved = await imp(pass("seo", [f]));
    expect(saved.body).toMatchObject({ updated: 1, skipped: 0 });
    const m = await mp("Demo Market Alpha");
    expect(m).toMatchObject({ status: "application_submitted", application_status: "under_review", application_date: null });
    // Recorded under the signed-in person, with the source link.
    const h = await q("select signer_name, auth_subject, detail from status_history where marketplace_id = $1 order by created_at desc limit 1", [m.id]);
    expect(h[0]).toMatchObject({ signer_name: "Test Person", auth_subject: "google-sub-123" });
    expect(h[0].detail).toContain("example-workspace.slack.com");
    // Replay: unchanged.
    expect((await imp(pass("seo", [f]))).body).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it("older evidence read later, or a newer manual change, is never overwritten", async () => {
    const alpha = await mp("Demo Market Alpha");
    const old = { ...sel, key: "alpha-old-status", type: "status", partner: { id: alpha.id }, title: "Old: Alpha in discussion",
      relationship_status: "in_discussion", sources: [src("seo", "1780000000.000100")] };
    const r = await imp(pass("seo", [old]));
    expect(r.body.changes).toEqual([]);
    expect((await mp("Demo Market Alpha")).status).toBe("application_submitted");
  });

  it("skips product-supplier findings and unlisted companies before writing anything", async () => {
    const before = await counts();
    const r = await imp(pass("teammarketing", [
      { ...sel, role: "supplier", key: "alpha-as-supplier", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "price_sheet", title: "Pot price list", sources: [src("teammarketing", ts())] },
      { ...sel, key: "unlisted-market", type: "status", partner: { names: ["Unlisted Gifts Co"] }, title: "Unlisted live", relationship_status: "live", sources: [src("teammarketing", ts())] },
      { ...sel, key: "unlisted-task", type: "task", task_id: "unlisted-task", partners: [{ names: ["Unlisted Gifts Co"] }], title: "Email Unlisted", sources: [src("teammarketing", ts())] },
      { ...sel, certainty: "tentative", key: "alpha-maybe", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "quote", title: "Maybe a quote", sources: [src("teammarketing", ts())] },
    ]));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 0, updated: 0, flagged: 0, skipped: 4, skipped_reasons: { supplier_role: 1, not_listed: 2, not_confirmed: 1 } });
    expect(r.body.changes).toEqual([]);
    expect(r.body.findings).toEqual([]);
    const after = await counts();
    expect(after).toEqual(before);   // no partner, review item, task, resource or status written
    expect(await q("select count(*)::int as n from slack_findings where key in ('alpha-as-supplier','unlisted-market','unlisted-task','alpha-maybe')")).toEqual([{ n: 0 }]);
    expect(JSON.stringify(r.body)).not.toContain("Unlisted Gifts");  // out-of-scope items are counted, not listed
  });

  it("a company that is both a supplier and a seller: only the selling-role finding applies", async () => {
    await call("POST", "/vendors", { ...S, name: "Demo Market Charlie" });
    const r = await imp(pass("seo", [
      { ...sel, role: "supplier", key: "charlie-pots", type: "resource", partner: { names: ["Demo Market Charlie"] }, resource_type: "price_sheet", title: "Charlie pot prices", sources: [src("seo", ts())] },
      { ...sel, key: "charlie-catalog", type: "resource", partner: { names: ["Demo Market Charlie"] }, resource_type: "catalog", title: "Charlie corporate catalog", link_url: "https://docs.example.test/charlie", sources: [src("seo", ts())] },
    ]));
    expect(r.body).toMatchObject({ added: 1, skipped: 1, skipped_reasons: { supplier_role: 1 } });
    const res = await q("select r.title, r.marketplace_id, r.vendor_id, r.source_url, r.last_confirmed_on from supplier_resources r where finding_key in ('charlie-pots','charlie-catalog')");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ title: "Charlie corporate catalog", vendor_id: null, marketplace_id: (await mp("Demo Market Charlie")).id });
    expect(res[0].source_url).toContain("slack.com");
  });

  it("a record whose sales role is unclear stays out until confirmed; verified aliases match", async () => {
    const delta = await mp("Demo Market Delta");
    expect((await call("PATCH", `/marketplaces/${delta.id}`, { ...S, sales_role: "unclear", aliases: ["DMD Gifting"], version: delta.version })).status).toBe(200);
    const f = { ...sel, key: "delta-live", type: "status", partner: { names: ["DMD gifting"] }, title: "Delta live", relationship_status: "live", sources: [src("seo", ts())] };
    expect((await imp(pass("seo", [f]))).body).toMatchObject({ skipped: 1, skipped_reasons: { role_unclear: 1 } });
    const d2 = await mp("Demo Market Delta");
    await call("PATCH", `/marketplaces/${d2.id}`, { ...S, sales_role: "confirmed", version: d2.version });
    expect((await imp(pass("seo", [{ ...f, sources: [src("seo", ts())] }]))).body).toMatchObject({ updated: 1 });
    expect((await mp("Demo Market Delta")).status).toBe("live");
  });

  it("the optional script route applies the same eligibility check", async () => {
    const r = await post(pass("seo", [{ ...sel, key: "script-unlisted", type: "status", partner: { names: ["Nobody Market"] }, title: "x", relationship_status: "live", sources: [src("seo", ts())] }]));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ skipped: 1, skipped_reasons: { not_listed: 1 } });
    expect((await post({ ...pass("seo", []), schema: "sbcg-slack-v1" })).status).toBe(400);   // old format must be rebuilt
  });
});

describe("Slack workflow v2: resources, tasks and conflicts", () => {
  it("a confirmed replacement in the same series supersedes the earlier resource", async () => {
    const bravo = (await mp("Demo Market Bravo")).id;
    const q1 = { ...sel, key: "bravo-quote-1", type: "resource", partner: { id: bravo }, resource_type: "quote", series: "bravo-pack-quote", title: "Bravo pack quote", effective_date: "2026-10-01", sources: [src("seo", ts())] };
    const q2 = { ...q1, key: "bravo-quote-2", title: "Bravo pack quote (holiday)", effective_date: "2026-11-15", sources: [src("seo", ts())] };
    await imp(pass("seo", [q1]));
    const r = await imp(pass("seo", [q2]));
    expect(r.body.changes[0]).toMatchObject({ type: "resource", action: "add", supersedes: 1 });
    const rows = await q("select title, status from supplier_resources where marketplace_id = $1 and series_key = 'bravo-pack-quote' order by created_at", [bravo]);
    expect(rows).toEqual([{ title: "Bravo pack quote", status: "superseded" }, { title: "Bravo pack quote (holiday)", status: "current" }]);
  });

  it("the same action in both channels gives one task and one status update", async () => {
    const t1 = ts(), t2 = ts();
    const task = (channel: "seo" | "teammarketing", t: string) => ({ ...sel, key: "echo-send-catalog", type: "task", task_id: "echo-send-catalog",
      partners: [{ names: ["Demo Market Echo"] }], title: "Send Echo the holiday catalog", owner: "Example Owner", due: "2026-12-01", sources: [src(channel, t)] });
    const status = (channel: "seo" | "teammarketing", t: string) => ({ ...sel, key: "echo-approved", type: "status", partner: { names: ["Demo Market Echo"] }, title: "Echo approved", relationship_status: "approved", sources: [src(channel, t)] });
    const a = await imp(pass("seo", [task("seo", t1), status("seo", t1)]));
    expect(a.body).toMatchObject({ added: 1, updated: 1 });
    expect(a.body.changes.find((c: any) => c.type === "task")).toMatchObject({ action: "create", title: "Send Echo the holiday catalog", due_date: "2026-12-01", owner: "Example Owner" });
    const b = await imp(pass("teammarketing", [task("teammarketing", t2), status("teammarketing", t2)]));
    expect(b.body).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(await q("select count(*)::int as n from corporate_task_requests where task_key = 'echo-send-catalog'")).toEqual([{ n: 1 }]);
    expect(await q("select count(*)::int as n from status_history where marketplace_id = $1 and to_status = 'approved'", [(await mp("Demo Market Echo")).id])).toEqual([{ n: 1 }]);
    const src2 = (await q("select sources from slack_findings where key = 'echo-send-catalog'"))[0].sources;
    expect(src2.map((x: any) => x.channel).sort()).toEqual(["seo", "teammarketing"]);
  });

  it("a group task names several eligible marketplaces; a done action with no task creates nothing", async () => {
    const r = await imp(pass("seo", [
      { ...sel, key: "group-followup", type: "task", task_id: "group-followup", partners: [{ names: ["Demo Market Charlie"] }, { names: ["Demo Market Foxtrot"] }], title: "Follow up with Charlie and Foxtrot", sources: [src("seo", ts())] },
      { ...sel, key: "old-blocker-done", type: "task", task_id: "old-blocker-done", task_status: "done", partners: [{ names: ["Demo Market Charlie"] }], title: "Fix images (done)", sources: [src("seo", ts())] },
    ]));
    expect(r.body).toMatchObject({ added: 1, skipped: 1, skipped_reasons: { not_open: 1 } });
    const t = (await q("select marketplace_ids from corporate_task_requests where task_key = 'group-followup'"))[0];
    expect(t.marketplace_ids).toHaveLength(2);
  });

  it("matches an existing task request before adding one", async () => {
    const echo = (await mp("Demo Market Echo")).id;
    const manual = await call("POST", "/task-requests", { ...S, title: "Ask Echo for listing specs", marketplace_ids: [echo] });
    expect(manual.status).toBe(200);
    const r = await imp(pass("seo", [{ ...sel, key: "echo-specs", type: "task", task_id: "echo-specs", partners: [{ id: echo }], title: "Ask Echo for listing specs", due: "2026-12-05", sources: [src("seo", ts())] }]));
    expect(r.body).toMatchObject({ updated: 1, added: 0 });
    expect(await q("select count(*)::int as n from corporate_task_requests where title = 'Ask Echo for listing specs'")).toEqual([{ n: 1 }]);
    expect((await q("select origin, due_date::text from corporate_task_requests where id = $1", [manual.body.task.id]))[0]).toEqual({ origin: "manual", due_date: "2026-12-05" });
  });

  it("conflicting evidence becomes one review item with actions that apply the change", async () => {
    const fox = await mp("Demo Market Foxtrot");
    const t1 = ts(), t2 = ts();
    const r = await imp(pass("seo", [{ ...sel, certainty: "conflicting", key: "foxtrot-status-conflict", type: "conflict", partner: { id: fox.id }, field: "relationship_status",
      title: "Foxtrot: live or still setting up?", values: [{ value: "live", sources: [src("seo", t1)] }, { value: "setting_up_listings", sources: [src("seo", t2)] }], sources: [src("seo", t1), src("seo", t2)] }]));
    expect(r.body).toMatchObject({ flagged: 1 });
    expect(r.body.changes[0]).toMatchObject({ type: "conflict", field: "relationship_status", current: "prospect", values: ["live", "setting_up_listings"] });
    const items = (await call("GET", "/review-items?status=open")).body.items.filter((i: any) => i.finding_key === "foxtrot-status-conflict");
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0).toMatchObject({ format: 2, field: "relationship_status", current_value: "prospect", supplier_hint: "Demo Market Foxtrot" });
    expect(it0.options.map((o: any) => o.label)).toEqual(["Apply status: live", "Apply status: setting up listings"]);
    expect(it0.options[0].sources[0].permalink).toContain("slack.com");
    // The generic resolve is gone; applying closes the item only once the change is saved.
    expect((await call("PATCH", `/review-items/${it0.id}`, { ...S, status: "resolved", resolution_note: "x", version: it0.version })).status).toBe(404);
    const applied = await call("POST", `/review-items/${it0.id}/apply`, { ...S, option: 0, version: it0.version });
    expect(applied.status).toBe(200);
    expect(applied.body.item).toMatchObject({ status: "resolved", resolution: "applied" });
    expect((await mp("Demo Market Foxtrot")).status).toBe("live");
    expect((await call("POST", `/review-items/${it0.id}/dismiss`, { ...S, version: applied.body.item.version })).status).toBe(400);
  });

  it("an inactive status needs a reason to apply; dismiss closes without a change", async () => {
    const golf = await mp("Demo Supplier Golf");
    await imp(pass("seo", [{ ...sel, certainty: "conflicting", key: "golf-conflict", type: "conflict", partner: { id: golf.id }, field: "relationship_status",
      title: "Golf rejected?", values: [{ value: "rejected" }, { value: "in_discussion" }], sources: [src("seo", ts())] }]));
    const item = (await call("GET", "/review-items?status=open")).body.items.find((i: any) => i.finding_key === "golf-conflict");
    expect((await call("POST", `/review-items/${item.id}/apply`, { ...S, option: 0, version: item.version })).status).toBe(400);
    expect((await mp("Demo Supplier Golf")).status).toBe("prospect");
    const d = await call("POST", `/review-items/${item.id}/dismiss`, { ...S, note: "Asked the partner", version: item.version });
    expect(d.body.item).toMatchObject({ status: "dismissed", resolution: "dismissed" });
    expect((await mp("Demo Supplier Golf")).status).toBe("prospect");
  });

  it("a failed pass saves nothing and keeps the channel's last successful scan", async () => {
    const before = (await q("select position_ts, last_success_at from slack_scan_state where channel_key = 'seo'"))[0];
    const bad = await imp(pass("seo", [
      { ...sel, key: "will-roll-back", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "logo", title: "Alpha logo", sources: [src("seo", ts())] },
      { ...sel, certainty: "conflicting", key: "bad-conflict", type: "conflict", partner: { names: ["Demo Market Alpha"] }, field: "application_status", title: "x", values: [{ value: "nonsense" }, { value: "approved" }], sources: [src("seo", ts())] },
    ]));
    expect(bad.status).toBe(400);
    expect(await q("select count(*)::int as n from supplier_resources where finding_key = 'will-roll-back'")).toEqual([{ n: 0 }]);
    const after = (await q("select position_ts, last_success_at, last_error from slack_scan_state where channel_key = 'seo'"))[0];
    expect(after.position_ts).toBe(before.position_ts);
    expect(after.last_success_at).toEqual(before.last_success_at);
    expect(after.last_error).toBeTruthy();
  });
});

describe("Corporate Gifts tasks: delivery through the Marketing Dashboard", () => {
  const tasksReport = (qs = "") => report(`/reporting/v1/corporate-tasks${qs}`);

  it("offers pending tasks with partner links only (no Slack links), and needs the reporting credential", async () => {
    const r = await tasksReport();
    expect(r.status).toBe(200);
    const echo = r.body.tasks.find((t: any) => t.title === "Send Echo the holiday catalog");
    expect(echo).toMatchObject({ delivery_status: "pending", slack_status: "open", owner_hint: "Example Owner", due_date: "2026-12-01", content_version: 1 });
    expect(echo.partners).toEqual([{ name: "Demo Market Echo", url: expect.stringMatching(/\?tab=marketplaces&m=[0-9a-f-]{36}$/) }]);
    expect(r.text).not.toContain("slack.com");
    expect((await report("/reporting/v1/corporate-tasks", "Bearer wrong")).status).toBe(401);
    expect((await report("/reporting/v1/corporate-tasks", `Bearer ${SLACK}`)).status).toBe(401);
    expect((await tasksReport("?x=1")).status).toBe(400);
  });

  it("marks delivered only with Task Tracker's task id; completed tasks stay completed on replay", async () => {
    const t = (await q("select * from corporate_task_requests where task_key = 'echo-send-catalog'"))[0];
    expect((await receipt({ receipts: [{ id: t.id, content_version: 1, state: "delivered" }] })).status).toBe(400);
    expect((await receipt({ receipts: [{ id: t.id, content_version: 1, state: "in_review" }] })).body).toMatchObject({ applied: 1 });
    expect((await q("select delivery_status from corporate_task_requests where id = $1", [t.id]))[0].delivery_status).toBe("in_review");
    const ok = await receipt({ receipts: [{ id: t.id, content_version: 1, state: "delivered", tracker: { task_id: "trk-1", status: "open", assignee: "Example Staff", due_date: "2026-12-01", open_url: "https://tracker.example.test/t/1" } }] });
    expect(ok.body).toMatchObject({ applied: 1 });
    // Task Tracker reports it done; a later "failed" never downgrades a delivered task.
    await receipt({ receipts: [{ id: t.id, content_version: 1, state: "delivered", tracker: { task_id: "trk-1", status: "done" } }] });
    expect((await receipt({ receipts: [{ id: t.id, content_version: 1, state: "failed", error: "x" }] })).body).toMatchObject({ ignored: 1 });
    // Replaying the Slack finding (both channels) changes nothing: still one task, delivered, done.
    const replay = await imp(pass("seo", [{ ...sel, key: "echo-send-catalog", type: "task", task_id: "echo-send-catalog", partners: [{ names: ["Demo Market Echo"] }],
      title: "Send Echo the holiday catalog", owner: "Example Owner", due: "2026-12-01", sources: [src("seo", ts())] }]));
    expect(replay.body).toMatchObject({ unchanged: 1, added: 0 });
    const row = (await q("select delivery_status, tracker_status, tracker_task_id, content_version from corporate_task_requests where task_key = 'echo-send-catalog'"))[0];
    expect(row).toEqual({ delivery_status: "delivered", tracker_status: "done", tracker_task_id: "trk-1", content_version: 1 });
    expect((await tasksReport()).body.tasks.find((x: any) => x.id === t.id)).toBeUndefined();
    // A new due date from Slack is offered again for the update; Task Tracker keeps the owner and completion.
    const moved = await imp(pass("seo", [{ ...sel, key: "echo-send-catalog", type: "task", task_id: "echo-send-catalog", partners: [{ names: ["Demo Market Echo"] }],
      title: "Send Echo the holiday catalog", owner: "Example Owner", due: "2026-12-08", sources: [src("seo", ts())] }]));
    expect(moved.body.changes[0]).toMatchObject({ type: "task", action: "update", due_date: "2026-12-08" });
    expect(moved.body.changes[0].note).toMatch(/due date will be updated/);
    const offered = (await tasksReport()).body.tasks.find((x: any) => x.id === t.id);
    expect(offered).toMatchObject({ delivery_status: "delivered", content_version: 2, delivered_version: 1, tracker_task_id: "trk-1" });
  });

  it("a failed delivery can be retried without creating a duplicate", async () => {
    const t0 = (await q("select * from corporate_task_requests where task_key = 'group-followup'"))[0];
    // No owner named in Slack: it waits for a routing decision and is not offered to the dashboard until then.
    expect(t0.route).toBe("review");
    expect((await tasksReport()).body.tasks.some((x: any) => x.id === t0.id)).toBe(false);
    expect((await call("POST", `/task-requests/${t0.id}/route`, { ...S, route: "marketing", version: t0.version })).status).toBe(200);
    const t = (await q("select * from corporate_task_requests where id = $1", [t0.id]))[0];
    await receipt({ receipts: [{ id: t.id, content_version: 1, state: "failed", error: "Task Tracker unavailable" }] });
    let row = (await q("select * from corporate_task_requests where id = $1", [t.id]))[0];
    expect(row).toMatchObject({ delivery_status: "failed", delivery_error: "Task Tracker unavailable" });
    const retried = await call("POST", `/task-requests/${t.id}/retry`, { ...S, version: row.version });
    expect(retried.body.task.delivery_status).toBe("pending");
    expect((await tasksReport()).body.tasks.filter((x: any) => x.id === t.id)).toHaveLength(1);
    for (let i = 0; i < 2; i++) await receipt({ receipts: [{ id: t.id, content_version: 1, state: "delivered", tracker: { task_id: "trk-2", status: "open" } }] });
    expect(await q("select count(*)::int as n from corporate_task_requests where task_key = 'group-followup'")).toEqual([{ n: 1 }]);
    row = (await q("select * from corporate_task_requests where id = $1", [t.id]))[0];
    expect(row).toMatchObject({ delivery_status: "delivered", tracker_task_id: "trk-2" });
    expect((await call("POST", `/task-requests/${t.id}/dismiss`, { ...S, version: row.version })).status).toBe(400);
  });

  it("Resolve here: handled without a task; leaves To review; the dashboard reads it on the same id; nothing reopens it", async () => {
    const echo = partners["Demo Market Echo"].id;
    const t = (await call("POST", "/task-requests", { ...S, title: "Answer Echo's packaging question", marketplace_ids: [echo] })).body.task;
    const before = (await call("GET", "/task-requests?status=review")).body.to_review;
    expect((await call("POST", `/task-requests/${t.id}/resolve`, { ...S, version: t.version + 1 })).status).toBe(409);   // stale form
    const r = await call("POST", `/task-requests/${t.id}/resolve`, { ...S, version: t.version });
    expect(r.body.task).toMatchObject({ delivery_status: "resolved", resolved_in: "corporate_gifts", resolved_by: "Test Person" });
    const after = (await call("GET", "/task-requests?status=review")).body;
    expect(after.to_review).toBe(before - 1);
    expect(after.tasks.map((x: any) => x.id)).not.toContain(t.id);
    expect((await call("GET", "/task-requests?status=active")).body.tasks.find((x: any) => x.id === t.id)).toMatchObject({ delivery_status: "resolved" });   // shown under Resolved
    // The dashboard's next read (since its last one) gets the same request as resolved, and the shared capability.
    const feed = (await tasksReport(`?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).body;
    expect(feed.capabilities).toEqual(["resolved"]);
    expect(feed.tasks.find((x: any) => x.id === t.id)).toMatchObject({ delivery_status: "resolved" });
    expect((await tasksReport()).body.tasks.find((x: any) => x.id === t.id)).toBeUndefined();          // not offered as pending
    // Repeated clicks and stale receipts never reopen it.
    const repeat = await call("POST", `/task-requests/${t.id}/resolve`, { ...S, version: r.body.task.version });
    expect(repeat.body).toMatchObject({ outcome: "already_resolved", task: { delivery_status: "resolved" } });
    expect((await call("POST", `/task-requests/${t.id}/dismiss`, { ...S, version: r.body.task.version })).status).toBe(400);
    for (const state of ["in_review", "failed", "dismissed", "resolved"])
      expect((await receipt({ receipts: [{ id: t.id, content_version: 1, state, ...(state === "failed" ? { error: "x" } : {}) }] })).body).toMatchObject({ ignored: 1 });
    expect((await q("select delivery_status from corporate_task_requests where id = $1", [t.id]))[0].delivery_status).toBe("resolved");
  });

  it("Resolve in the dashboard: a 'resolved' receipt on the same id closes it here; a stale form can't act on it", async () => {
    const echo = partners["Demo Market Echo"].id;
    const t = (await call("POST", "/task-requests", { ...S, title: "Check Echo's invoice format", marketplace_ids: [echo] })).body.task;
    await receipt({ receipts: [{ id: t.id, content_version: 1, state: "in_review" }] });
    const before = (await call("GET", "/task-requests?status=review")).body.to_review;
    expect((await receipt({ receipts: [{ id: t.id, content_version: 1, state: "resolved" }] })).body).toMatchObject({ applied: 1 });
    const row = (await q("select * from corporate_task_requests where id = $1", [t.id]))[0];
    expect(row).toMatchObject({ delivery_status: "resolved", resolved_in: "dashboard", resolved_by: "Marketing Dashboard" });
    expect((await call("GET", "/task-requests?status=review")).body.to_review).toBe(before - 1);
    expect((await call("POST", `/task-requests/${t.id}/resolve`, { ...S, version: t.version })).status).toBe(409);          // opened before the receipt
    expect((await receipt({ receipts: [{ id: t.id, content_version: 1, state: "resolved" }] })).body).toMatchObject({ ignored: 1 });
  });

  it("racing with task creation: a task that already exists in Task Tracker wins over a resolution, with its status and link", async () => {
    const echo = partners["Demo Market Echo"].id;
    const t = (await call("POST", "/task-requests", { ...S, title: "Ship Echo's November samples", marketplace_ids: [echo] })).body.task;
    await call("POST", `/task-requests/${t.id}/resolve`, { ...S, version: t.version });
    // The dashboard had already created the task (its send was in flight): it reports the task.
    await receipt({ receipts: [{ id: t.id, content_version: 1, state: "delivered", tracker: { task_id: "trk-race", status: "open", open_url: "https://tracker.example.test/#/tasks/trk-race" } }] });
    const row = (await q("select * from corporate_task_requests where id = $1", [t.id]))[0];
    expect(row).toMatchObject({ delivery_status: "delivered", tracker_task_id: "trk-race", tracker_status: "open", tracker_open_url: "https://tracker.example.test/#/tasks/trk-race",
      resolved_in: "corporate_gifts", resolution_state: null, completed_on: null });
    expect(row.resolved_at).not.toBeNull();
    // Completion belongs to the Task Tracker task: Mark done asks the dashboard to complete it there.
    expect((await call("POST", `/task-requests/${row.id}/resolve`, { ...S, version: row.version })).body.outcome).toBe("requested");
    expect((await q("select count(*)::int as n from corporate_task_requests where title = $1", ["Ship Echo's November samples"]))).toEqual([{ n: 1 }]);
  });

  it("receipts accept only delivery facts, with the reporting credential", async () => {
    expect((await receipt({ receipts: [] })).status).toBe(400);
    expect((await receipt({ receipts: [{ id: "00000000-0000-4000-8000-000000000001", content_version: 1, state: "dismissed", title: "x" }] })).status).toBe(400);
    expect((await receipt({ receipts: [{ id: "00000000-0000-4000-8000-000000000001", content_version: 1, state: "dismissed" }] }, `Bearer ${SLACK}`)).status).toBe(401);
    expect((await receipt({ receipts: [{ id: "00000000-0000-4000-8000-000000000001", content_version: 1, state: "dismissed" }] })).body).toMatchObject({ unknown: 1 });
    const get = await app(new Request("http://localhost/api/reporting/v1/corporate-task-receipts", { headers: { authorization: `Bearer ${REPORTING}` } }));
    expect(get.status).toBe(405);
  });
});

describe("cleanup of imports made before Marketplace Resources", () => {
  it("previews, then closes old review items and hides out-of-scope records; history kept; idempotent", async () => {
    const alpha = (await mp("Demo Market Alpha")).id;
    // Earlier-format records (as the first import created them).
    await q(`insert into supplier_resources (vendor_id, section, resource_type, title, origin, finding_key, created_by)
             values ($1, 'catalogs_pricing', 'price_sheet', 'Old vendor price sheet', 'slack', 'v1-vendor-sheet', 'Slack workflow')`, [vendor.id]);
    await q(`insert into corporate_actions (kind, title, origin, finding_key, created_by) values ('decision', 'Old general decision', 'slack', 'v1-general', 'Slack workflow')`);
    await q(`insert into corporate_actions (kind, title, marketplace_id, origin, finding_key, created_by) values ('action', 'Old Alpha action', $1, 'slack', 'v1-alpha-action', 'Slack workflow')`, [alpha]);
    await q(`insert into review_items (finding_key, kind, title, question, supplier_hint) values ('v1-alpha-review', 'outreach', 'Old Alpha question', 'q', 'Demo Market Alpha'),
             ('v1-vendor-review', 'terms', 'Old vendor question', 'q', 'Some Pottery Vendor')`);
    for (const [k, tt] of [["v1-vendor-sheet", "supplier_resource"], ["v1-general", "corporate_action"], ["v1-alpha-action", "corporate_action"], ["v1-alpha-review", "review_item"], ["v1-vendor-review", "review_item"]])
      await q("insert into slack_findings (key, kind, content_hash, target_type) values ($1, 'x', 'h', $2)", [k, tt]);

    const before = (await report("/reporting/v1/corporate-workflow")).body;
    const dry = await call("POST", "/slack/cleanup", { ...S, dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, review_closed_replaced: 1, review_closed_out_of_scope: 1, resources_excluded: 1, actions_replaced: 1, actions_excluded: 1 });
    expect(await q("select count(*)::int as n from review_items where finding_key like 'v1-%' and status = 'open'")).toEqual([{ n: 2 }]);

    const done = await call("POST", "/slack/cleanup", { ...S, dry_run: false });
    expect(done.body).toMatchObject({ dry_run: false, review_closed_replaced: 1, review_closed_out_of_scope: 1, findings_out_of_scope: 3, findings_replaced: 2 });
    expect(await q("select resolution from review_items where finding_key like 'v1-%' order by finding_key")).toEqual([{ resolution: "replaced" }, { resolution: "out_of_scope" }]);
    // Nothing deleted; hidden from views and the summary.
    expect(await q("select count(*)::int as n from supplier_resources where finding_key = 'v1-vendor-sheet' and excluded_at is not null")).toEqual([{ n: 1 }]);
    const list = await call("GET", `/supplier-resources?supplier=vendor:${vendor.id}`);
    expect(list.body.resources.map((r: any) => r.title)).not.toContain("Old vendor price sheet");
    const after = (await report("/reporting/v1/corporate-workflow")).body;
    expect(after.recent.map((r: any) => r.title)).not.toContain("Old general decision");
    expect(after.follow_ups.open).toBe(before.follow_ups.open - 1);
    // A second run changes nothing.
    expect((await call("POST", "/slack/cleanup", { ...S, dry_run: false })).body).toMatchObject({ review_closed_replaced: 0, review_closed_out_of_scope: 0, resources_excluded: 0, actions_replaced: 0, actions_excluded: 0 });
  });
});

describe("dashboard summary", () => {
  it("returns only the intended summary fields, counting open Corporate Gifts tasks", async () => {
    await call("POST", "/actions", { ...S, kind: "action", title: "Overdue follow-up", due_date: "2026-01-02" });
    await call("POST", "/actions", { ...S, kind: "blocker", title: "Vendor images missing" });
    const r = await report("/reporting/v1/corporate-workflow");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "follow_ups", "id", "ok", "recent", "sample_progress", "schema_version", "source", "today"]);
    expect(r.body.follow_ups.overdue).toBeGreaterThanOrEqual(1);
    const openTasks = (await q("select count(*)::int as n from corporate_task_requests where slack_status = 'open' and delivery_status not in ('dismissed', 'resolved') and coalesce(tracker_status, 'open') = 'open'"))[0].n;
    expect(openTasks).toBeLessThan((await q("select count(*)::int as n from corporate_task_requests where slack_status = 'open' and delivery_status <> 'dismissed' and coalesce(tracker_status, 'open') = 'open'"))[0].n);   // resolved ones are not open work
    const openActions = (await q("select count(*)::int as n from corporate_actions where kind = 'action' and status = 'open' and excluded_at is null"))[0].n;
    expect(r.body.follow_ups.open).toBe(openTasks + openActions);
    for (const x of r.body.recent) expect(Object.keys(x).sort()).toEqual(["at", "id", "kind", "status", "supplier", "title"]);
    expect(r.body.recent.map((x: any) => x.kind)).toContain("blocker");
    for (const leak of ["slack.com", "docs.example.test", "Example Owner"]) expect(r.text).not.toContain(leak);
    expect((await report("/reporting/v1/corporate-workflow?x=1")).status).toBe(400);
  });

  it("Slack imports never change the Google Form signup count", async () => {
    let calls = 0;
    _setSampleSignupFetchForTests(async () => { calls++; throw new Error("not used"); });
    await imp(pass("seo", [{ ...sel, key: "alpha-sample-info", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "sample_option", title: "Alpha sample box option", sources: [src("seo", ts())] }]));
    expect(calls).toBe(0);
    _setSampleSignupFetchForTests(null);
  });
});
