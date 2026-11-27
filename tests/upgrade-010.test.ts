// Upgrade from the schema before migration 010 (Partners) with records in several stages and linked data, then the
// rollback script and a re-apply. Synthetic data only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { call } from "./helpers";
import { getPool } from "../server/db";
import { migrate } from "../scripts/migrate";
import { issueSession } from "../server/auth";

const q = (sql: string, p: unknown[] = []) => getPool().query(sql, p).then((r) => r.rows);
const ROOT = join(import.meta.dirname, "..");
const ids = { live: "bbbbbbbb-0010-4000-8000-000000000001", held: "bbbbbbbb-0010-4000-8000-000000000002", plain: "bbbbbbbb-0010-4000-8000-000000000003" };
let cookie = "";

async function upTo009() {
  const pool = getPool();
  await pool.query("drop schema public cascade; create schema public;");
  await pool.query("create table schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const dir = join(ROOT, "db", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && x < "010").sort()) {
    await pool.query(readFileSync(join(dir, f), "utf8"));
    await pool.query("insert into schema_migrations (version) values ($1)", [f]);
  }
  const mk = async (id: string, name: string, status: string, note: string | null) => {
    const ch = (await pool.query("insert into channels (name, type) values ($1, 'marketplace') returning id", [name])).rows[0].id;
    await pool.query("insert into marketplaces (id, channel_id, name, provider_type, status, priority_note, aliases) values ($1,$2,$3,'marketplace',$4,$5,'{Example Alias}')", [id, ch, name, status, note]);
    await pool.query("insert into status_history (marketplace_id, to_status, signer_name) values ($1,$2,'Example Person')", [id, status]);
    await pool.query("insert into requirements (marketplace_id, category, requirement, confirmation_state, confirmed_by, confirmed_at, created_by) values ($1,'pricing','Example agreed commission','confirmed','Example Person', now(), 'Example Person')", [id]);
    await pool.query("insert into communications (marketplace_id, occurred_on, signer_name, method, summary) values ($1, '2026-10-01', 'Example Person', 'email', 'Example note')", [id]);
  };
  await mk(ids.live, "Example Live Partner", "live", "Priority: A (strongest)");
  await mk(ids.held, "Example Held Partner", "on_hold", "Example priority B");
  await mk(ids.plain, "Example Plain Partner", "prospect", "C - starts with a letter only");
  await pool.query("insert into corporate_task_requests (task_key, title, marketplace_ids, created_by, origin) values ('up10-task', 'Example task', $1, 'Example Person', 'manual')", [[ids.live]]);
  const seed = process.env.SEED_DEMO_DATA;
  process.env.SEED_DEMO_DATA = "0";
  try { await migrate(false); } finally { if (seed === undefined) delete process.env.SEED_DEMO_DATA; else process.env.SEED_DEMO_DATA = seed; }
}

beforeAll(async () => {
  await upTo009();
  cookie = `sbg_session=${await issueSession({ sub: "google-sub-123", email: "approved-login@example.test" })}`;
});

describe("upgrade to 010 (Partners)", () => {
  it("keeps every record, ID, stage, alias, history, requirement, note and task link", async () => {
    const rows = await q("select id, status, priority, category, channel_models, aliases, sales_role from marketplaces order by name");
    expect(rows).toEqual([
      { id: ids.held, status: "on_hold", priority: "b", category: "uncategorized", channel_models: [], aliases: ["Example Alias"], sales_role: "confirmed" },
      { id: ids.live, status: "live", priority: "a", category: "uncategorized", channel_models: [], aliases: ["Example Alias"], sales_role: "confirmed" },
      { id: ids.plain, status: "prospect", priority: "not_assessed", category: "uncategorized", channel_models: [], aliases: ["Example Alias"], sales_role: "confirmed" },
    ]);
    expect((await q("select count(*)::int n from status_history"))[0].n).toBe(3);
    expect(await q("select distinct kind, confirmation_state from requirements")).toEqual([{ kind: "published", confirmation_state: "confirmed" }]);
    expect((await q("select count(*)::int n from communications"))[0].n).toBe(3);
    expect((await q("select marketplace_ids from corporate_task_requests"))[0].marketplace_ids).toEqual([ids.live]);
  });

  it("lists the upgraded records in the Partners views", async () => {
    const r = await call("GET", "/marketplaces?view=active", undefined, { cookie });
    expect(r.body.marketplaces.map((m: any) => m.id)).toEqual([ids.live]);
    expect((await call("GET", "/marketplaces?view=closed", undefined, { cookie })).body.marketplaces.map((m: any) => m.id)).toEqual([ids.held]);
    // A note that only starts with "C" is not a priority label: the record stays Not assessed (All partners only).
    expect((await call("GET", "/marketplaces?view=later", undefined, { cookie })).body.marketplaces).toEqual([]);
    expect((await call("GET", "/marketplaces?view=all&category=uncategorized", undefined, { cookie })).body.uncategorized).toBe(3);
    // The previous list call (bookmarks, other apps) still works.
    expect((await call("GET", "/marketplaces?include_inactive=1", undefined, { cookie })).body.marketplaces.length).toBe(3);
  });

  it("rollback refuses while a partner uses a new stage, then restores the 009 schema; re-applying works", async () => {
    const down = readFileSync(join(ROOT, "db", "rollback", "010_partners.down.sql"), "utf8");
    const pool = getPool();
    await pool.query("update marketplaces set status = 'skipped' where id = $1", [ids.plain]);
    const c = await pool.connect();
    try {
      await expect(c.query(down)).rejects.toThrow(/Rollback stopped: 1 partner/);
      await c.query("rollback");
      expect((await q("select count(*)::int n from information_schema.tables where table_name = 'partner_contacts'"))[0].n).toBe(1);
      await pool.query("update marketplaces set status = 'prospect' where id = $1", [ids.plain]);
      await c.query(down);
    } finally { c.release(); }
    expect((await q("select count(*)::int n from information_schema.columns where table_name = 'marketplaces' and column_name = 'priority'"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from schema_migrations where version = '010_partners.sql'"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from marketplaces"))[0].n).toBe(3);
    process.env.SEED_DEMO_DATA = "0";
    try { await migrate(false); } finally { process.env.SEED_DEMO_DATA = "1"; }
    expect((await q("select priority from marketplaces where id = $1", [ids.live]))[0].priority).toBe("a");
  });
});
