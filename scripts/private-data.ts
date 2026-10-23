// Private operational data: copy it between environments WITHOUT Git.
//
//   Export (e.g. from production, read-only):
//     DATABASE_URL=<source db> npx tsx scripts/private-data.ts export --out private/operational-YYYYMMDD.json
//   Preview an import (nothing is written — runs in a transaction that is rolled back):
//     DATABASE_URL=<target db> npx tsx scripts/private-data.ts import --in private/operational-YYYYMMDD.json
//   Apply it:
//     DATABASE_URL=<target db> npx tsx scripts/private-data.ts import --in private/operational-YYYYMMDD.json --apply
//
// Rules:
// - Record IDs are kept, so relationships (marketplace → proposals, pricing versions, revenue …) survive.
// - Import only ADDS rows. Existing rows (same ID or same unique name) are left exactly as they are;
//   nothing is updated. Rows whose unique name is already used by a different ID are reported, not merged.
//   One exception keeps IDs intact on a fresh target: the automatically created, still unused and unedited
//   "Direct website" row is replaced by the exported one. All tables are written in one transaction.
// - The file contains confidential business data: it may only be written outside the repository or in
//   the git-ignored private/ folder, with owner-only permissions. Never commit, email or upload it.
import { writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { getPool, closePool } from "../server/db";
import { BASELINE_SIGNER } from "./seed";
import { OPERATIONAL_TABLES } from "../server/lib/operationalTables";

export const FORMAT = "sbcg-private-v1";

/** Foreign-key-safe order. Rate limits, migrations bookkeeping and transient import pages are excluded. */
export const TABLES = OPERATIONAL_TABLES;

const REPO = resolve(import.meta.dirname, "..");

/** Only outside the repository, or inside the git-ignored private/ folder. */
export function assertPrivatePath(p: string) {
  const abs = resolve(p);
  const rel = relative(REPO, abs);
  const inside = rel && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside && !rel.startsWith("private/")) throw new Error("Write private exports outside the repository or under private/ (git-ignored).");
  return abs;
}

export async function exportData(out: string, tables: readonly string[] = TABLES) {
  const file = assertPrivatePath(out);
  // One connection, one read-only REPEATABLE READ transaction: every table is read from the same snapshot,
  // so records changed while the export runs can never produce mismatched rows between tables.
  const c = await getPool().connect();
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  let migrations: string[];
  try {
    await c.query("begin transaction isolation level repeatable read read only");
    migrations = (await c.query("select version from schema_migrations order by version")).rows.map((r) => r.version);
    for (const t of tables) {
      const hasCreated = (await c.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = 'created_at'", [t])).rowCount;
      // Postgres renders the JSON itself, so timestamps keep microseconds and numbers keep their exact text.
      const j: string = (await c.query(`select coalesce(json_agg(x${hasCreated ? " order by x.created_at" : ""}), '[]'::json)::text as j from ${t} x`)).rows[0].j;
      counts[t] = (JSON.parse(j) as unknown[]).length;
      parts.push(`${JSON.stringify(t)}:${j}`);
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  mkdirSync(dirname(file), { recursive: true });
  const head = { format: FORMAT, exported_at: new Date().toISOString(), migrations };
  writeFileSync(file, `${JSON.stringify(head).slice(0, -1)},"tables":{${parts.join(",")}}}`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return counts;
}

/** Keeps integers beyond JavaScript's safe range as their exact text (Postgres casts them back). */
function parseExact(text: string) {
  return JSON.parse(text, function (_k: string, v: unknown, ctx?: { source?: string }) {
    return typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v) && ctx?.source ? ctx.source : v;
  } as any);
}

export async function importData(input: string, apply: boolean) {
  const raw = parseExact(readFileSync(resolve(input), "utf8"));
  if (raw?.format !== FORMAT || typeof raw.tables !== "object") throw new Error(`Not a ${FORMAT} file.`);
  const db = getPool();
  const have = new Set((await db.query("select version from schema_migrations")).rows.map((r) => r.version));
  const missing = (raw.migrations as string[]).filter((m) => m.endsWith(".sql") && !have.has(m));
  if (missing.length) throw new Error(`Run the app's migrations on the target first (missing: ${missing.join(", ")}).`);
  const c = await db.connect();
  const report: Record<string, { in_file: number; added: number; already_present: number; same_name_other_id?: number }> = {};
  try {
    await c.query("begin");
    await replaceUnusedBaseline(c, raw.tables.channels);
    for (const t of TABLES) {
      const rows = raw.tables[t];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      // json_populate_recordset keeps every column (including IDs) and its type. Rows that collide with an
      // existing primary key or unique value are skipped, never overwritten. Self-references within the table
      // (pricing versions, duplicate imports) are checked at the end of the statement, so order is irrelevant.
      const r = await c.query(`insert into ${t} select * from json_populate_recordset(null::${t}, $1::json) on conflict do nothing`, [JSON.stringify(rows)]);
      const ids = rows.map((x: any) => x.id).filter(Boolean);
      const present = ids.length ? (await c.query(`select count(*)::int as n from ${t} where id = any($1::uuid[])`, [ids])).rows[0].n : rows.length;
      // Rows skipped because a DIFFERENT record already uses the same unique value (e.g. a name): reported, never merged.
      const otherId = ids.length ? ids.length - present : 0;
      report[t] = { in_file: rows.length, added: r.rowCount ?? 0, already_present: rows.length - (r.rowCount ?? 0) - otherId, ...(otherId ? { same_name_other_id: otherId } : {}) };
    }
    await c.query(apply ? "commit" : "rollback");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  return { applied: apply, report };
}

/**
 * A freshly migrated database already has an automatically created, empty "Direct website" row (BASELINE_SIGNER).
 * If it is still unused, it is replaced by the exported row so that the original ID (and every price, revenue
 * and audit record pointing at it) is kept. A row the team has edited or used is never touched.
 */
async function replaceUnusedBaseline(c: import("pg").PoolClient, channels: any[] | undefined) {
  const exported = (channels ?? []).find((x) => x.name === "Direct website");
  if (!exported) return;
  const cur = (await c.query("select id, terms_updated_by, terms_note from channels where name = 'Direct website'")).rows[0];
  if (!cur || cur.id === exported.id || cur.terms_updated_by !== BASELINE_SIGNER || cur.terms_note) return;
  await c.query("savepoint baseline");
  try {
    await c.query("delete from channels where id = $1", [cur.id]); // fails (FK) if anything references it
    await c.query("release savepoint baseline");
  } catch {
    await c.query("rollback to savepoint baseline");
  }
}

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.argv[1]?.endsWith("private-data.ts")) {
  const cmd = process.argv[2];
  const run = async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
    if (cmd === "export") {
      const out = arg("--out");
      if (!out) throw new Error("--out <file> is required");
      console.log("exported row counts:", await exportData(out));
    } else if (cmd === "import") {
      const inp = arg("--in");
      if (!inp) throw new Error("--in <file> is required");
      const r = await importData(inp, process.argv.includes("--apply"));
      console.log(r.applied ? "IMPORTED (committed)" : "PREVIEW ONLY (rolled back) — add --apply to write");
      console.table(r.report);
    } else throw new Error("usage: private-data.ts export --out <file> | import --in <file> [--apply]");
  };
  // Errors are printed without row values or connection strings.
  run().then(() => closePool()).catch((e) => { console.error(`failed: ${e?.code ?? ""} ${String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "<db-url>")}`); process.exit(1); });
}
