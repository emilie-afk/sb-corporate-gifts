// FIXTURE TESTS — fictional marketplaces, people, links and Slack identifiers only (example.test, Demo Market …).
// Resource links from Slack (resource URL apart from the source message, Slack attachments, link needed, library,
// "Use for other marketplaces"), task routing by owner, Resolve from either app, bulk Mark done, Slack completion
// confirmations, and the check-off feed for the dashboard's weekly report.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, call, app, S } from "./helpers";
import { getPool } from "../server/db";
import { linkKey } from "../server/lib/suppliers";
import { RESOLUTION_SQL } from "../server/lib/taskRouting";

const REPORTING = "test-reporting-secret-test-reporting-secret-02";
const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;
let tsN = 1791000000;
const ts = () => `${++tsN}.000200`;
const src = (channel: "seo" | "teammarketing", t: string) => ({ channel, ts: t, permalink: `https://example-workspace.slack.com/archives/CEX${channel === "seo" ? "1" : "2"}/p${t.replace(".", "")}` });
const pass = (channel: "seo" | "teammarketing", findings: any[]) => ({
  schema: "sbcg-slack-v2", channel, through_ts: findings.flatMap((f) => f.sources.map((s: any) => s.ts)).sort().at(-1),
  messages: [...new Set(findings.flatMap((f) => f.sources.filter((s: any) => s.channel === channel).map((s: any) => s.ts)))].map((t) => ({ ts: t })), findings,
});
const sel = { role: "selling" as const, certainty: "confirmed" as const };
const imp = (p: any, dry = false) => call("POST", "/slack/import", { ...S, pass: p, dry_run: dry });
const mp = async (name: string) => (await q("select * from marketplaces where name = $1", [name]))[0];
const rep = async (path: string, init: RequestInit = {}) => {
  const res = await app(new Request(`http://localhost/api/reporting/v1/${path}`, { ...init, headers: { authorization: `Bearer ${REPORTING}`, "content-type": "application/json", ...(init.headers ?? {}) } }));
  return { status: res.status, body: await res.json() };
};
const post = (path: string, body: unknown) => rep(path, { method: "POST", body: JSON.stringify(body) });
const task = (id: string) => q(`select t.*, ${RESOLUTION_SQL()} as resolution_state from corporate_task_requests t where task_key = $1`, [id]).then((r) => r[0]);

beforeAll(async () => {
  await resetDb();
  process.env.CORPORATE_REPORTING_SECRET = REPORTING;
  for (const [name, team, aliases] of [["Example Marketer", "marketing", []], ["Example Ops Lead", "outside", ["Ops Lead"]], ["Example Partner Rep", "external", []]] as const)
    expect((await call("POST", "/owners", { ...S, name, team, aliases })).status).toBe(200);
});
afterAll(() => { delete process.env.CORPORATE_REPORTING_SECRET; });

describe("link keys", () => {
  it("recognise the same document however the link was copied", () => {
    expect(linkKey("https://drive.google.com/drive/folders/ABCDEFGHIJ123?usp=sharing")).toBe(linkKey("https://drive.google.com/drive/u/4/folders/ABCDEFGHIJ123"));
    expect(linkKey("https://docs.google.com/spreadsheets/d/SHEETID12345/edit?gid=1#gid=1")).toBe("google:SHEETID12345");
    expect(linkKey("https://example-workspace.slack.com/files/U123ABC/F0ABCDEF12/one-sheet.pdf")).toBe("slack-file:F0ABCDEF12");
    expect(linkKey("https://Example.test/Page/?utm_source=x")).toBe(linkKey("https://example.test/page"));
  });
});

describe("resource links from Slack", () => {
  it("keeps the resource URL apart from the Slack message; a Slack attachment becomes a clickable resource", async () => {
    const t = ts();
    const r = await imp(pass("seo", [{ ...sel, key: "alpha-onboarding-form", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "onboarding_form",
      title: "Alpha vendor onboarding form (filled)", link_url: "https://example-workspace.slack.com/files/U0EXAMPLE/F0EXAMPLE01/vendor-form.docx", sources: [src("seo", t)] }]));
    expect(r.status).toBe(200);
    expect(r.body.changes[0]).toMatchObject({ type: "resource", action: "add", link: "slack_file", resource_type: "onboarding_form" });
    const row = (await q("select * from supplier_resources where finding_key = 'alpha-onboarding-form'"))[0];
    expect(row).toMatchObject({ link_kind: "slack_file", link_key: "slack-file:F0EXAMPLE01", section: "assets_documents", link_needed: false });
    expect(row.link_url).toContain("/files/");
    expect(row.source_url).toContain("/archives/");
  });

  it("classifies several links in one thread separately and skips a supplier-only link", async () => {
    const t = ts();
    const r = await imp(pass("seo", [
      { ...sel, key: "alpha-catalog-file", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "catalog", title: "Corporate catalog for Alpha", link_url: "https://docs.example.test/catalog.pdf", sources: [src("seo", t)] },
      { ...sel, key: "alpha-upload-folder", type: "resource", partner: { names: ["Demo Market Alpha"] }, resource_type: "shared_folder", title: "Alpha upload folder", link_url: "https://drive.google.com/drive/folders/FOLDERALPHA01?usp=sharing", partner_specific: true, sources: [src("seo", t)] },
      { ...sel, role: "supplier", key: "vendor-price-list", type: "resource", partner: { names: ["Example Pottery Co"] }, resource_type: "price_sheet", title: "Vendor price list", link_url: "https://docs.example.test/vendor.xlsx", sources: [src("seo", t)] },
    ]));
    expect(r.body).toMatchObject({ added: 2, skipped: 1, skipped_reasons: { supplier_role: 1 } });
    expect(r.body.changes.map((c: any) => c.resource_type).sort()).toEqual(["catalog", "shared_folder"]);
    expect(await q("select count(*)::int n from supplier_resources where link_url like '%vendor.xlsx'")).toEqual([{ n: 0 }]);
  });

  it("shows Link needed, then fills it in from a later message; the same URL from the other channel already exists", async () => {
    const charlie = (await mp("Demo Market Charlie")).id;
    const needs = await imp(pass("seo", [{ ...sel, key: "charlie-listing-steps", type: "resource", partner: { id: charlie }, resource_type: "listing_instructions", title: "Charlie listing instructions", link_needed: true, summary: "Sent by email", sources: [src("seo", ts())] }]));
    expect(needs.body.changes[0]).toMatchObject({ action: "needs_link" });
    expect((await q("select link_needed from supplier_resources where finding_key = 'charlie-listing-steps'"))[0].link_needed).toBe(true);
    const preview = await imp(pass("seo", [{ ...sel, key: "charlie-listing-steps-link", type: "resource", partner: { id: charlie }, resource_type: "listing_instructions", title: "Charlie listing instructions", link_url: "https://docs.example.test/charlie-steps", sources: [src("seo", ts())] }]), true);
    expect(preview.body.changes[0]).toMatchObject({ action: "fill_link" });
    expect((await q("select link_needed from supplier_resources where finding_key = 'charlie-listing-steps'"))[0].link_needed).toBe(true);   // preview wrote nothing
    const filled = await imp(pass("seo", [{ ...sel, key: "charlie-listing-steps-link", type: "resource", partner: { id: charlie }, resource_type: "listing_instructions", title: "Charlie listing instructions", link_url: "https://docs.example.test/charlie-steps", sources: [src("seo", ts())] }]));
    expect(filled.body.changes[0]).toMatchObject({ action: "fill_link" });
    const other = await imp(pass("teammarketing", [{ ...sel, key: "charlie-steps-tm", type: "resource", partner: { id: charlie }, resource_type: "listing_instructions", title: "Listing steps (Charlie)", link_url: "https://docs.example.test/charlie-steps/", sources: [src("teammarketing", ts())] }]));
    expect(other.body.changes[0]).toMatchObject({ action: "exists" });
    expect(await q("select count(*)::int n from supplier_resources where marketplace_id = $1 and resource_type = 'listing_instructions'", [charlie])).toEqual([{ n: 1 }]);
    // Retrying the whole backfill changes nothing.
    const again = await imp(pass("seo", [{ ...sel, key: "charlie-listing-steps-link", type: "resource", partner: { id: charlie }, resource_type: "listing_instructions", title: "Charlie listing instructions", link_url: "https://docs.example.test/charlie-steps", sources: [src("seo", ts())] }]));
    expect(again.body).toMatchObject({ added: 0, updated: 0 });
    expect(again.body.changes[0]).toMatchObject({ action: "exists" });
  });

  it("keeps general materials in the library and uses them for two marketplaces without duplicates on retry", async () => {
    const r = await imp(pass("seo", [{ ...sel, key: "corporate-videos", type: "resource", library: true, resource_type: "sales_assets", title: "Best-seller gift videos", link_url: "https://drive.google.com/drive/folders/VIDEOFOLDER01", sources: [src("seo", ts())] }]));
    expect(r.body.changes[0]).toMatchObject({ partner: null, action: "add" });
    const lib = (await call("GET", "/library-resources")).body.resources.find((x: any) => x.finding_key === "corporate-videos");
    expect(lib.scope).toBe("library");
    const ids = [(await mp("Demo Market Bravo")).id, (await mp("Demo Market Delta")).id];
    const dry = await call("POST", `/supplier-resources/${lib.id}/share`, { ...S, marketplace_ids: ids, dry_run: true });
    expect(dry.body.added).toHaveLength(2);
    expect(await q("select count(*)::int n from supplier_resources where shared_from_id = $1", [lib.id])).toEqual([{ n: 0 }]);
    const first = await call("POST", `/supplier-resources/${lib.id}/share`, { ...S, marketplace_ids: ids });
    expect(first.body.added.map((x: any) => x.name).sort()).toEqual(["Demo Market Bravo", "Demo Market Delta"]);
    const retry = await call("POST", `/supplier-resources/${lib.id}/share`, { ...S, marketplace_ids: ids });
    expect(retry.body.added).toHaveLength(0);
    expect(retry.body.skipped.map((x: any) => x.reason)).toEqual(["Already has this link", "Already has this link"]);
    const copies = await q("select marketplace_id, link_url, title, resource_type, source_url from supplier_resources where shared_from_id = $1 order by marketplace_id", [lib.id]);
    expect(copies).toHaveLength(2);
    expect(copies.every((c: any) => c.link_url === lib.link_url && c.title === lib.title && c.resource_type === "sales_assets" && c.source_url === lib.source_url)).toBe(true);
  });

  it("asks for confirmation before reusing a partner-specific resource", async () => {
    const folder = (await q("select id from supplier_resources where finding_key = 'alpha-upload-folder'"))[0];
    const echo = (await mp("Demo Market Echo")).id;
    const r = await call("POST", `/supplier-resources/${folder.id}/share`, { ...S, marketplace_ids: [echo] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("needs_confirmation");
    const ok = await call("POST", `/supplier-resources/${folder.id}/share`, { ...S, marketplace_ids: [echo], confirm_partner_specific: true });
    expect(ok.body.added).toHaveLength(1);
  });

  it("adds a link to a Link needed resource by hand, refusing a link already recorded there", async () => {
    const row = (await call("POST", "/supplier-resources", { ...S, supplier: "library", resource_type: "catalog", title: "Corporate catalog", link_needed: true })).body.resource;
    expect(row.link_needed).toBe(true);
    const dup = await call("PATCH", `/supplier-resources/${row.id}`, { ...S, link_url: "https://drive.google.com/drive/folders/VIDEOFOLDER01?usp=sharing", version: row.version });
    expect(dup.status).toBe(400);
    const ok = await call("PATCH", `/supplier-resources/${row.id}`, { ...S, link_url: "https://docs.example.test/corporate-catalog.pdf", version: row.version });
    expect(ok.body.resource).toMatchObject({ link_needed: false, link_kind: "url" });
  });
});

describe("routing and resolution", () => {
  const taskF = (id: string, owner: string | undefined, partner = "Demo Market Delta") => ({ ...sel, key: id, type: "task", task_id: id, partners: [{ names: [partner] }], title: `Fictional action ${id}`, ...(owner ? { owner } : {}), sources: [src("seo", ts())] });

  it("routes by owner: Marketing task, or a check-off item with the names from Slack", async () => {
    const r = await imp(pass("seo", [taskF("t-marketing", "Example Marketer"), taskF("t-ops", "Ops Lead (ops team)"), taskF("t-partner", "Example Partner Rep"), taskF("t-two", "Example Marketer / Example Ops Lead"), taskF("t-none", undefined), taskF("t-unknown", "Someone Else")]));
    expect(r.status).toBe(200);
    const routes = Object.fromEntries(r.body.changes.filter((c: any) => c.type === "task").map((c: any) => [c.title.replace("Fictional action ", ""), c.route]));
    expect(routes).toEqual({ "t-marketing": "marketing", "t-ops": "checkoff", "t-partner": "checkoff", "t-two": "checkoff", "t-none": "checkoff", "t-unknown": "checkoff" });
    const offered = (await rep("corporate-tasks?v=2")).body.tasks.map((t: any) => t.title);
    expect(offered).toContain("Fictional action t-marketing");
    expect(offered).not.toContain("Fictional action t-ops");
    const checks = (await rep("corporate-checkoffs")).body;
    expect(checks.items.find((x: any) => x.title === "Fictional action t-ops")).toMatchObject({ route: "checkoff", owner: "Example Ops Lead", state: "open" });
    expect(checks.items.find((x: any) => x.title === "Fictional action t-none")).toMatchObject({ route: "checkoff", route_reason: "No owner named", listed: true });
    expect(checks.items.find((x: any) => x.title === "Fictional action t-unknown")).toMatchObject({ route: "checkoff", owner: "Someone Else", route_reason: "Not on the Marketing team" });
    expect(JSON.stringify(checks)).not.toContain("slack.com");
    expect((await rep("corporate-checkoffs", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("an outside-Marketing action is one check-off item with no Task Tracker delivery; resolving from either app shows the same outcome", async () => {
    const ops = await task("t-ops");
    const viaDashboard = await post("corporate-task-actions", { actions: [{ id: ops.id, action: "resolve", by: "Example Reviewer" }] });
    expect(viaDashboard.body.results[0]).toMatchObject({ outcome: "resolved", state: "resolved" });
    const again = await call("POST", `/task-requests/${ops.id}/resolve`, { ...S });
    expect(again.body.outcome).toBe("already_resolved");
    const row = await task("t-ops");
    expect(row).toMatchObject({ resolution_state: "resolved", resolved_by: "Example Reviewer", completion_source: "manual", delivery_status: "resolved", resolved_in: "dashboard", tracker_task_id: null });
    const item = (await rep("corporate-checkoffs")).body.items.find((x: any) => x.id === ops.id);
    expect(item).toMatchObject({ state: "done", completed_on: String(row.completed_on).slice(0, 10) });
    expect((await call("GET", "/task-requests?status=all")).body.tasks.find((t: any) => t.id === ops.id).resolution_state).toBe("resolved");
  });

  it("a resolved draft can no longer be sent; a sent task is completed through Task Tracker and shows Resolved after its receipt", async () => {
    const m = await task("t-marketing");
    const resolved = await call("POST", `/task-requests/${m.id}/resolve`, { ...S, completed_on: "2026-11-02" });
    expect(resolved.body.outcome).toBe("resolved");
    // The dashboard sees the resolution and must not deliver it: a late "delivered" receipt is the only way in.
    const offered = (await rep("corporate-tasks?v=2&since=2000-01-01T00:00:00Z")).body.tasks.find((t: any) => t.id === m.id);
    expect(offered.resolution).toMatchObject({ state: "resolved", completed_on: "2026-11-02" });
    expect((await rep("corporate-tasks?v=2")).body.tasks.some((t: any) => t.id === m.id)).toBe(false);

    const r2 = await imp(pass("seo", [taskF("t-sent", "Example Marketer")]));
    const sent = (await task("t-sent"));
    expect(r2.body.added).toBe(1);
    await post("corporate-task-receipts", { receipts: [{ id: sent.id, content_version: 1, state: "delivered", tracker: { task_id: "trk-77", status: "open" } }] });
    const req = await call("POST", `/task-requests/${sent.id}/resolve`, { ...S, completed_on: "2026-11-03" });
    expect(req.body.outcome).toBe("requested");
    expect((await call("POST", `/task-requests/${sent.id}/resolve`, { ...S })).body.outcome).toBe("already_requested");
    expect((await rep("corporate-tasks?v=2")).body.tasks.find((t: any) => t.id === sent.id).resolution.state).toBe("requested");
    // Task Tracker refused: the error is shown, the item stays open for a retry.
    await post("corporate-task-receipts", { receipts: [{ id: sent.id, content_version: 1, state: "delivered", resolve_error: "Task Tracker refused", tracker: { task_id: "trk-77", status: "open" } }] });
    expect((await task("t-sent"))).toMatchObject({ resolution_state: "requested", resolve_error: "Task Tracker refused" });
    for (let i = 0; i < 2; i++) await post("corporate-task-receipts", { receipts: [{ id: sent.id, content_version: 1, state: "delivered", tracker: { task_id: "trk-77", status: "done", completed_on: "2026-11-05" } }] });
    const done = await task("t-sent");
    expect(done).toMatchObject({ resolution_state: "resolved", tracker_status: "done", resolve_error: null });
    expect(String(done.completed_on).slice(0, 10)).toBe("2026-11-03");   // the requested date, set once
  });

  it("bulk Mark done reports each item; failed ones can be retried without a second completion", async () => {
    await imp(pass("seo", [taskF("t-b1", "Example Ops Lead"), taskF("t-b2", "Example Partner Rep")]));
    const [b1, b2, marketing] = [await task("t-b1"), await task("t-b2"), await task("t-marketing")];
    const r = await call("POST", "/task-requests/mark-done", { ...S, ids: [b1.id, marketing.id] });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(["resolved", "failed"]);
    const retry = await call("POST", "/task-requests/mark-done", { ...S, ids: [b1.id, b2.id] });
    expect(retry.body.results.map((x: any) => x.outcome)).toEqual(["already_resolved", "resolved"]);
    expect(await q("select count(*)::int n from audit_events where entity_id = $1 and action = 'resolve'", [b1.id])).toEqual([{ n: 1 }]);
  });

  it("a routing decision moves an item out of review; routing existing tasks is previewed and keeps decided and sent ones", async () => {
    const two = await task("t-two");
    const decided = await call("POST", `/task-requests/${two.id}/route`, { ...S, route: "checkoff", version: two.version });
    expect(decided.body.task).toMatchObject({ route: "checkoff", route_decided_by: "Test Person" });
    // A new owner entry makes "Someone Else" known: the preview lists the change, Apply makes it.
    await call("POST", "/owners", { ...S, name: "Someone Else", team: "marketing" });
    const preview = await call("POST", "/task-requests/reroute", { ...S, dry_run: true });
    expect(preview.body.changes.map((c: any) => c.title)).toEqual(["Fictional action t-unknown"]);
    expect((await task("t-unknown")).route).toBe("checkoff");
    await call("POST", "/task-requests/reroute", { ...S, dry_run: false });
    expect((await task("t-unknown")).route).toBe("marketing");
    expect((await task("t-two")).route).toBe("checkoff");
    expect((await task("t-sent")).route).toBe("marketing");
  });
});

describe("Slack completion confirmations", () => {
  const done = (key: string, extra: any) => ({ ...sel, key, type: "completion", partners: [{ names: ["Demo Market Foxtrot"] }], title: "Fictional confirmation", sources: [src("seo", ts())], ...extra });

  it("an explicit reply completes the right action, a progress update leaves it open, an unmatched one changes nothing", async () => {
    await imp(pass("seo", [
      { ...sel, key: "fx-send", type: "task", task_id: "fx-send", partners: [{ names: ["Demo Market Foxtrot"] }], title: "Send the catalog to Foxtrot", owner: "Example Partner Rep", sources: [src("seo", ts())] },
      { ...sel, key: "fx-receive", type: "task", task_id: "fx-receive", partners: [{ names: ["Demo Market Foxtrot"] }], title: "Receive Foxtrot listing instructions", owner: "Example Ops Lead", sources: [src("seo", ts())] },
      { ...sel, key: "fx-upload", type: "task", task_id: "fx-upload", partners: [{ names: ["Demo Market Foxtrot"] }], title: "Upload the listings to Foxtrot", owner: "Example Ops Lead", sources: [src("seo", ts())] },
    ]));
    const progress = await imp(pass("seo", [done("fx-ready", { task_id: "fx-send", state: "progress" })]));
    expect(progress.body.skipped_reasons.progress).toBe(1);
    expect((await task("fx-send")).resolution_state).toBeNull();
    const preview = await imp(pass("seo", [done("fx-sent", { task_id: "fx-send" })]), true);
    expect(preview.body.changes[0]).toMatchObject({ type: "completion", action: "complete", task_title: "Send the catalog to Foxtrot" });
    expect((await task("fx-send")).resolution_state).toBeNull();
    const saved = await imp(pass("seo", [done("fx-sent", { task_id: "fx-send" }), done("fx-instr", { task_id: "fx-receive" }), done("fx-nomatch", { task_id: "fx-unknown-action" })]));
    expect(saved.body.skipped_reasons.no_match).toBe(1);
    expect((await task("fx-send"))).toMatchObject({ resolution_state: "resolved", completion_source: "slack" });
    expect((await task("fx-receive")).resolution_state).toBe("resolved");
    expect((await task("fx-upload")).resolution_state).toBeNull();     // stays open until separately confirmed
  });

  it("a later confirmation adds evidence without changing the date; an ambiguous one asks for Confirm completion", async () => {
    const before = await task("fx-send");
    const later = await imp(pass("teammarketing", [{ ...done("fx-sent-again", { task_id: "fx-send" }), sources: [src("teammarketing", ts())] }]));
    expect(later.body.changes[0]).toMatchObject({ action: "already_done" });
    const after = await task("fx-send");
    expect(String(after.completed_on)).toBe(String(before.completed_on));
    expect(after.evidence.length).toBe(before.evidence.length + 1);
    // Two open items could match: a person chooses.
    await imp(pass("seo", [{ ...sel, key: "fx-upload-2", type: "task", task_id: "fx-upload-2", partners: [{ names: ["Demo Market Foxtrot"] }], title: "Upload the holiday listings to Foxtrot", owner: "Example Ops Lead", sources: [src("seo", ts())] }]));
    const amb = await imp(pass("seo", [done("fx-uploaded", { certainty: "ambiguous", candidates: ["fx-upload", "fx-upload-2"] })]));
    expect(amb.body).toMatchObject({ flagged: 1 });
    const item = (await call("GET", "/review-items?status=open")).body.items.find((i: any) => i.finding_key === "fx-uploaded");
    expect(item.options).toHaveLength(2);
    const pick = item.options.findIndex((o: any) => o.label.includes("holiday"));
    const applied = await call("POST", `/review-items/${item.id}/apply`, { ...S, option: pick, version: item.version });
    expect(applied.status).toBe(200);
    expect((await task("fx-upload-2")).resolution_state).toBe("resolved");
    expect((await task("fx-upload")).resolution_state).toBeNull();
  });
});

describe("delivery claim and the check-off feed", () => {
  const taskF = (id: string, owner: string) => ({ ...sel, key: id, type: "task", task_id: id, partners: [{ names: ["Demo Market Charlie"] }], title: `Fictional claim ${id}`, owner, sources: [src("seo", ts())] });
  const claim = async (id: string, content_version: number) => (await post("corporate-task-actions", { actions: [{ id, action: "claim", by: "Example Reviewer", content_version }] })).body.results[0];

  it("only a current, open Marketing request can be claimed; stale, resolved and rerouted ones are refused", async () => {
    await imp(pass("seo", [taskF("c-ok", "Example Marketer"), taskF("c-res", "Example Marketer"), taskF("c-route", "Example Marketer"), taskF("c-stale", "Example Marketer")]));
    const [ok, res, route, stale] = [await task("c-ok"), await task("c-res"), await task("c-route"), await task("c-stale")];
    await call("POST", `/task-requests/${res.id}/resolve`, { ...S });
    await call("POST", `/task-requests/${route.id}/route`, { ...S, route: "checkoff", version: route.version });
    await imp(pass("seo", [{ ...taskF("c-stale", "Example Marketer"), due: "2026-12-20" }]));      // changed after the dashboard read it
    expect(await claim(res.id, res.content_version)).toMatchObject({ outcome: "resolved" });
    expect(await claim(route.id, route.content_version)).toMatchObject({ outcome: "rerouted" });
    expect(await claim(stale.id, stale.content_version)).toMatchObject({ outcome: "stale" });
    expect((await task("c-stale")).delivery_status).toBe("pending");
    expect(await claim(ok.id, ok.content_version)).toMatchObject({ outcome: "claimed" });
    expect((await task("c-ok")).delivery_status).toBe("sending");
    expect(await claim(ok.id, ok.content_version)).toMatchObject({ outcome: "claimed" });          // retry of an unanswered send
  });

  it("while sending it can't be rerouted or dismissed; a resolve waits, and a failed send then resolves it", async () => {
    const ok = await task("c-ok");
    expect((await call("POST", `/task-requests/${ok.id}/route`, { ...S, route: "checkoff", version: ok.version })).status).toBe(409);
    expect((await call("POST", `/task-requests/${ok.id}/dismiss`, { ...S, version: ok.version })).status).toBe(400);
    expect((await call("POST", `/task-requests/${ok.id}/resolve`, { ...S, completed_on: "2026-11-10" })).body.outcome).toBe("requested");
    await post("corporate-task-receipts", { receipts: [{ id: ok.id, content_version: ok.content_version, state: "in_review" }] });
    expect((await task("c-ok")).delivery_status).toBe("sending");
    await post("corporate-task-receipts", { receipts: [{ id: ok.id, content_version: ok.content_version, state: "failed", error: "Task Tracker unavailable" }] });
    expect(await task("c-ok")).toMatchObject({ delivery_status: "resolved", resolution_state: "resolved", delivery_error: expect.any(String) });
  });

  it("pages every change by (updated_at, id), including items that leave the check-off list", async () => {
    const all: any[] = [];
    let cursor: any = null, pages = 0;
    do {
      const r = await rep(`corporate-checkoffs?limit=3${cursor ? `&after=${encodeURIComponent(cursor.after)}&after_id=${cursor.after_id}` : ""}`);
      expect(r.status).toBe(200);
      all.push(...r.body.items);
      cursor = r.body.next;
      pages++;
      if (!r.body.has_more) break;
    } while (pages < 50);
    expect(pages).toBeGreaterThan(1);
    const total = (await q("select count(*)::int n from corporate_task_requests"))[0].n;
    expect(new Set(all.map((x) => x.id)).size).toBe(total);
    // Routed to Marketing: the feed still reports it, marked as not on the check-off list.
    const ck = await task("c-route");
    await post("corporate-task-actions", { actions: [{ id: ck.id, action: "route", route: "marketing", by: "Example Reviewer", version: ck.version }] });
    const after = await rep(`corporate-checkoffs?after=${encodeURIComponent(cursor.after)}&after_id=${cursor.after_id}`);
    expect(after.body.items.find((x: any) => x.id === ck.id)).toMatchObject({ route: "marketing", listed: false });
    expect((await rep("corporate-checkoffs?after=2026-01-01T00:00:00Z")).status).toBe(400);
  });
});

describe("releasing a claim whose answer was lost", () => {
  it("goes back to review, or resolves an item whose Resolve waited for the send; repeats are harmless", async () => {
    await imp(pass("seo", [{ ...sel, key: "rel-a", type: "task", task_id: "rel-a", partners: [{ names: ["Demo Market Delta"] }], title: "Fictional release A", owner: "Example Marketer", sources: [src("seo", ts())] },
      { ...sel, key: "rel-b", type: "task", task_id: "rel-b", partners: [{ names: ["Demo Market Delta"] }], title: "Fictional release B", owner: "Example Marketer", sources: [src("seo", ts())] }]));
    const [a, b] = [await task("rel-a"), await task("rel-b")];
    const act = async (id: string, action: string, extra: any = {}) => (await post("corporate-task-actions", { actions: [{ id, action, by: "Example Reviewer", ...extra }] })).body.results[0];
    expect(await act(a.id, "claim", { content_version: a.content_version })).toMatchObject({ outcome: "claimed" });
    expect(await act(b.id, "claim", { content_version: b.content_version })).toMatchObject({ outcome: "claimed" });
    // The dashboard never got the answers. Meanwhile someone resolves B in Corporate Gifts: it waits for the send.
    expect((await call("POST", `/task-requests/${b.id}/resolve`, { ...S, completed_on: "2026-11-12" })).body.outcome).toBe("requested");
    expect(await act(a.id, "release")).toMatchObject({ outcome: "released" });
    expect(await act(b.id, "release")).toMatchObject({ outcome: "resolved" });
    expect(await act(a.id, "release")).toMatchObject({ outcome: "not_claimed" });
    expect(await task("rel-a")).toMatchObject({ delivery_status: "in_review", resolution_state: null });
    expect(await task("rel-b")).toMatchObject({ delivery_status: "resolved", resolution_state: "resolved", resolved_in: "corporate_gifts", tracker_task_id: null });
    // Released A can be claimed again at its version.
    expect(await act(a.id, "claim", { content_version: a.content_version })).toMatchObject({ outcome: "claimed" });
  });
});

describe("follow up: assign check-off items to Marketing", () => {
  it("assigns one or many; each becomes one Marketing request for the dashboard; repeats and closed items are reported", async () => {
    await imp(pass("seo", ["fu-a", "fu-b", "fu-c"].map((k) => ({ ...sel, key: k, type: "task", task_id: k, partners: [{ names: ["Demo Market Delta"] }], title: `Fictional follow-up ${k}`, owner: "Example Outside Person", sources: [src("seo", ts())] }))));
    const [a, b, c] = [await task("fu-a"), await task("fu-b"), await task("fu-c")];
    expect([a.route, b.route, c.route]).toEqual(["checkoff", "checkoff", "checkoff"]);
    await call("POST", `/task-requests/${c.id}/resolve`, { ...S });
    const r = await call("POST", "/task-requests/assign-marketing", { ...S, ids: [a.id, b.id, c.id] });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(["assigned", "assigned", "failed"]);
    expect((await call("POST", "/task-requests/assign-marketing", { ...S, ids: [a.id] })).body.results[0].outcome).toBe("already");
    expect(await task("fu-a")).toMatchObject({ route: "marketing", route_decided_by: "Test Person", owner_hint: "Example Outside Person" });
    const offered = (await rep("corporate-tasks?v=2")).body.tasks.filter((t: any) => [a.id, b.id].includes(t.id));
    expect(offered).toHaveLength(2);
    const checks = (await rep("corporate-checkoffs")).body.items.filter((x: any) => [a.id, b.id].includes(x.id));
    expect(checks.every((x: any) => x.listed === false)).toBe(true);
  });
});
