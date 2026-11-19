// Upgrade from the schema before migration 009 (008: the shared "resolved" status) with data in every state that
// schema allows: requests already resolved here and in the dashboard, a delivered task that was resolved while it
// already existed, open and delivered tasks. Synthetic data only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app, call, S, cookieFor, APPROVED } from "./helpers";
import { getPool } from "../server/db";
import { migrate } from "../scripts/migrate";

const REPORTING = "r".repeat(40);
const q = (sql: string, p: unknown[] = []) => getPool().query(sql, p).then((r) => r.rows);
const rep = async (path: string, init: RequestInit = {}) => {
  const r = await app(new Request(`http://localhost/api/reporting/v1/${path}`, { ...init, headers: { authorization: `Bearer ${REPORTING}`, "content-type": "application/json", ...(init.headers ?? {}) } }));
  return { status: r.status, body: await r.json() };
};
const post = (path: string, body: unknown) => rep(path, { method: "POST", body: JSON.stringify(body) });
const M = "eeeeeeee-0000-4000-8000-000000000009";
const ids = { here: "aaaaaaaa-0009-4000-8000-000000000001", dash: "aaaaaaaa-0009-4000-8000-000000000002", race: "aaaaaaaa-0009-4000-8000-000000000003",
  open: "aaaaaaaa-0009-4000-8000-000000000004", sent: "aaaaaaaa-0009-4000-8000-000000000005" };

beforeAll(async () => {
  process.env.CORPORATE_REPORTING_SECRET = REPORTING;
  const pool = getPool();
  await pool.query("drop schema public cascade; create schema public;");
  await pool.query("create table schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const dir = join(import.meta.dirname, "..", "db", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && x < "009").sort()) {
    await pool.query(readFileSync(join(dir, f), "utf8"));
    await pool.query("insert into schema_migrations (version) values ($1)", [f]);
  }
  const row = (id: string, key: string, title: string) => pool.query(
    "insert into corporate_task_requests (id, task_key, title, marketplace_ids, created_by, origin) values ($1, $2, $3, $4, 'Example Person', 'manual')", [id, key, title, [M]]);
  await row(ids.here, "up-here", "Fictional resolved here");
  await row(ids.dash, "up-dash", "Fictional resolved in the dashboard");
  await row(ids.race, "up-race", "Fictional resolved while its task existed");
  await row(ids.open, "up-open", "Fictional open request");
  await row(ids.sent, "up-sent", "Fictional delivered task");
  await pool.query(`update corporate_task_requests set delivery_status = 'resolved', resolved_at = '2026-11-12T20:00:00Z', resolved_by = 'Example Reviewer', resolved_in = 'corporate_gifts' where id = $1`, [ids.here]);
  await pool.query(`update corporate_task_requests set delivery_status = 'resolved', resolved_at = '2026-11-13T03:00:00Z', resolved_by = 'Marketing Dashboard', resolved_in = 'dashboard' where id = $1`, [ids.dash]);
  await pool.query(`update corporate_task_requests set delivery_status = 'delivered', tracker_task_id = 'trk-race', tracker_status = 'open', resolved_at = '2026-11-14T03:00:00Z', resolved_by = 'Example Reviewer', resolved_in = 'corporate_gifts' where id = $1`, [ids.race]);
  await pool.query(`update corporate_task_requests set delivery_status = 'delivered', tracker_task_id = 'trk-sent', tracker_status = 'open', delivered_version = 1 where id = $1`, [ids.sent]);
  const seed = process.env.SEED_DEMO_DATA;
  process.env.SEED_DEMO_DATA = "0";        // an existing database: no demo data
  try { await migrate(false); } finally { if (seed === undefined) delete process.env.SEED_DEMO_DATA; else process.env.SEED_DEMO_DATA = seed; }   // applies 009 to the data above
});
afterAll(() => { delete process.env.CORPORATE_REPORTING_SECRET; });

describe("upgrade to 009", () => {
  it("keeps every resolved request resolved, with who and where, and gives it the completion date it was resolved on", async () => {
    const rows = Object.fromEntries((await q("select id, delivery_status, resolved_by, resolved_in, to_char(completed_on, 'YYYY-MM-DD') d, completion_source, route from corporate_task_requests")).map((r) => [r.id, r]));
    // 2026-11-12 20:00 UTC is 2026-11-13 in Vietnam (the report calendar).
    expect(rows[ids.here]).toMatchObject({ delivery_status: "resolved", resolved_by: "Example Reviewer", resolved_in: "corporate_gifts", d: "2026-11-13", completion_source: "manual", route: "marketing" });
    expect(rows[ids.dash]).toMatchObject({ delivery_status: "resolved", resolved_in: "dashboard", d: "2026-11-13" });
    // A delivered task keeps its task; its earlier resolution stays as history and is not a completion.
    expect(rows[ids.race]).toMatchObject({ delivery_status: "delivered", resolved_in: "corporate_gifts", d: null });
    expect(rows[ids.open]).toMatchObject({ delivery_status: "pending", resolved_in: null, d: null });
  });

  it("lists them as done once in the check-off feed (for the weekly report), and the open ones as before", async () => {
    const items = (await rep("corporate-checkoffs")).body.items;
    const by = Object.fromEntries(items.map((x: any) => [x.id, x]));
    expect(by[ids.here]).toMatchObject({ listed: true, state: "done", completed_on: "2026-11-13" });
    expect(by[ids.dash]).toMatchObject({ listed: true, state: "done", completed_on: "2026-11-13" });
    expect(by[ids.race]).toMatchObject({ listed: false, state: "open" });
    expect(by[ids.sent]).toMatchObject({ listed: false, state: "open" });
    expect(items.filter((x: any) => x.id === ids.here)).toHaveLength(1);
  });

  it("nothing reopens them: stale receipts, a repeated resolve, a rescan-like change", async () => {
    for (const state of ["in_review", "failed", "dismissed", "resolved"])
      expect((await post("corporate-task-receipts", { receipts: [{ id: ids.here, content_version: 1, state, ...(state === "failed" ? { error: "x" } : {}) }] })).body).toMatchObject({ ignored: 1 });
    expect((await post("corporate-task-actions", { actions: [{ id: ids.dash, action: "resolve", by: "Example Reviewer" }] })).body.results[0].outcome).toBe("already_resolved");
    expect((await post("corporate-task-actions", { actions: [{ id: ids.here, action: "claim", by: "Marketing Dashboard", content_version: 1 }] })).body.results[0].outcome).toBe("resolved");
    expect((await q("select delivery_status from corporate_task_requests where id = any($1)", [[ids.here, ids.dash]])).map((r) => r.delivery_status)).toEqual(["resolved", "resolved"]);
  });

  it("the earlier dashboard build reads the feed as before; the new one gets routes and resolve requests", async () => {
    const v1 = (await rep("corporate-tasks?since=2000-01-01T00:00:00Z")).body;
    expect(v1.capabilities).toEqual(["resolved", "routing"]);
    expect(v1.tasks.find((t: any) => t.id === ids.here)).toMatchObject({ delivery_status: "resolved" });
    // Resolve on the delivered task (in either app) asks the dashboard to complete it in Task Tracker.
    const cookie = await cookieFor(APPROVED);
    const r = await call("POST", `/task-requests/${ids.sent}/resolve`, { ...S, completed_on: "2026-11-18" }, { cookie });
    expect(r.body.outcome).toBe("requested");
    const v2 = (await rep("corporate-tasks?v=2")).body.tasks.find((t: any) => t.id === ids.sent);
    expect(v2).toMatchObject({ delivery_status: "delivered", resolution: { state: "requested", completed_on: "2026-11-18" } });
    // Task Tracker reports it done: resolved, once, with the requested date; the report feed lists it nowhere
    // (Marketing tasks are counted through Task Tracker).
    for (let i = 0; i < 2; i++) await post("corporate-task-receipts", { receipts: [{ id: ids.sent, content_version: 1, state: "delivered", tracker: { task_id: "trk-sent", status: "done", completed_on: "2026-11-19" } }] });
    const done = (await q("select delivery_status, tracker_status, resolved_in, to_char(completed_on, 'YYYY-MM-DD') d from corporate_task_requests where id = $1", [ids.sent]))[0];
    expect(done).toMatchObject({ delivery_status: "delivered", tracker_status: "done", resolved_in: "corporate_gifts", d: "2026-11-18" });
    expect((await call("GET", "/task-requests?status=all", undefined, { cookie })).body.tasks.find((t: any) => t.id === ids.sent).resolution_state).toBe("resolved");
  });
});
