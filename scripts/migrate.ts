// Applies db/migrations/*.sql in order (once each) and the baseline (Direct website channel if missing).
// Usage: DATABASE_URL=... npm run db:migrate
// On Netlify it runs only in the production build (see netlify.toml) against the Neon DATABASE_URL.
// It never loads demo data on a deployed runtime and never reads operational data from Git.
// Locally/tests: SEED_DEMO_DATA=1 additionally loads the fictional demo data (db/seed/demo.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool, tx } from "../server/db";
import { ensureBaseline, seedDemo, demoSeedAllowed } from "./seed";
import { isDeployedRuntime } from "../server/runtime";

export async function migrate(log = true) {
  if (process.env.SEED_DEMO_DATA === "1" && isDeployedRuntime()) throw new Error("SEED_DEMO_DATA must not be set on a deployed runtime.");
  const pool = getPool();
  await pool.query("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const dir = join(import.meta.dirname, "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await pool.query("select 1 from schema_migrations where version = $1", [f]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(readFileSync(join(dir, f), "utf8"));
      await client.query("insert into schema_migrations (version) values ($1)", [f]);
      await client.query("commit");
      if (log) console.log(`applied ${f}`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  if (demoSeedAllowed()) await seedDemo(log);
  await tx((c) => ensureBaseline(c));
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — add the Neon connection string in Netlify (production, builds + functions).");
    process.exit(1);
  }
  // Errors are printed without connection strings or row values.
  migrate().then(() => closePool()).catch((e) => { console.error(`migration failed: ${e?.code ?? ""} ${String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "<db-url>")}`); process.exit(1); });
}
