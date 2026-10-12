// Applies db/migrations/*.sql in order (once each), then the initial data (once).
// Usage: DATABASE_URL=... npm run db:migrate
// On Netlify it runs only in the production build (see netlify.toml) against the Neon DATABASE_URL.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool } from "../server/db";
import { seed } from "./seed";

export async function migrate(log = true) {
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
  await seed(log);
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — add the Neon connection string in Netlify (production, builds + functions).");
    process.exit(1);
  }
  migrate().then(() => closePool()).catch((e) => { console.error(e); process.exit(1); });
}
