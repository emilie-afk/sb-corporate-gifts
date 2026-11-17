// Sends one Slack scan pass (a JSON file in the sbcg-slack-v1 format) to the app, or previews it.
//   CORPORATE_GIFTS_URL=https://<site> CORPORATE_SLACK_INGEST_SECRET=... npx tsx scripts/slack-pass.ts --file private/pass.json [--dry-run]
//   ... npx tsx scripts/slack-pass.ts --state      (per-channel scan position and threads to revisit)
// Pass files hold private findings and source links: keep them outside the repository or in the git-ignored
// private/ folder. Only counts and record references are printed.
import { readFileSync } from "node:fs";
import { assertPrivatePath } from "./private-data";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const base = (process.env.CORPORATE_GIFTS_URL ?? "").replace(/\/$/, "");
const secret = process.env.CORPORATE_SLACK_INGEST_SECRET ?? "";
if (!/^https:\/\/|^http:\/\/localhost/.test(base) || secret.length < 32) {
  console.error("Set CORPORATE_GIFTS_URL (https) and CORPORATE_SLACK_INGEST_SECRET.");
  process.exit(1);
}
const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
const run = async () => {
  if (process.argv.includes("--state")) {
    const r = await fetch(`${base}/api/ingest/slack-state`, { headers });
    console.log(r.status, JSON.stringify(await r.json(), null, 2));
    return;
  }
  const file = arg("--file");
  if (!file) throw new Error("--file <pass.json> is required");
  const body = readFileSync(assertPrivatePath(file), "utf8");
  const r = await fetch(`${base}/api/ingest/slack-findings${process.argv.includes("--dry-run") ? "?dry_run=1" : ""}`, { method: "POST", headers, body });
  const j: any = await r.json();
  if (!r.ok) { console.error(r.status, j?.error?.code, j?.error?.message, (j?.error?.problems ?? []).join("; ")); process.exit(1); }
  console.log(`${j.dry_run ? "PREVIEW (nothing saved)" : "SAVED"} #${j.channel}: ${j.added} added, ${j.updated} updated, ${j.flagged} flagged for review, ${j.unchanged} unchanged`);
  for (const f of j.findings) console.log(`  ${f.outcome.padEnd(9)} ${f.key} → ${f.target}`);
};
run().catch((e) => { console.error(`failed: ${String(e?.message ?? e)}`); process.exit(1); });
