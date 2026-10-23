// Scans the public build output (dist/) — and optionally any other folder — for things that must never ship
// to browsers: source maps, connection strings, Google Sheet links/IDs, server secrets, real email addresses
// and (optionally) a PRIVATE list of confidential terms kept outside Git.
//
//   npm run build && npm run check:public
//   PRIVATE_TERMS_FILE=private/terms.txt npm run check:public     # one confidential term per line (git-ignored)
//   npx tsx scripts/check-public-build.ts db docs tests           # scan other folders too
//
// Exit code 1 when anything is found. Findings print the file and the kind of match, never the matched secret.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|test|org|net)|.*\.example|localhost)$/i;

type Finding = { file: string; kind: string };

export function scanText(text: string, privateTerms: string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
  const kinds: string[] = [];
  // Local placeholders (postgresql://localhost/db) are fine; anything with a password or a remote host is not.
  const dbUrls = text.match(/postgres(ql)?:\/\/[^\s"'`<>]+/gi) ?? [];
  if (dbUrls.some((u) => /:\/\/[^/@\s]*:[^/@\s]+@/.test(u) || !/:\/\/([^/@\s]*@)?(localhost|127\.0\.0\.1)([:/?]|$)/i.test(u))) kinds.push("database connection string");
  const sheetIds = [...text.matchAll(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g)].map((m) => m[1]);
  if (sheetIds.some((id) => !/example/i.test(id))) kinds.push("Google Sheet link");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) kinds.push("private key");
  if (/"private_key_id"\s*:/.test(text)) kinds.push("service-account JSON");
  if (new RegExp("source" + "MappingURL=\\S").test(text)) kinds.push("source map reference");
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  // Library code contains a few addresses-shaped strings (e.g. "user@host" examples); only flag real-looking ones.
  if (emails.some((e) => !ALLOWED_EMAIL_DOMAINS.test(e) && !/\.(js|css|png|svg)$/i.test(e))) kinds.push("email address");
  // Values of server-only settings must never appear in browser assets.
  for (const name of ["SESSION_SECRET", "GOOGLE_CLIENT_SECRET", "CORPORATE_INGEST_SECRET", "DATABASE_URL", "NETLIFY_DATABASE_URL", "GOOGLE_SERVICE_ACCOUNT_JSON"]) {
    const v = env[name];
    if (v && v.length >= 8 && text.includes(v)) kinds.push(`value of ${name}`);
  }
  for (const e of (env.APPROVED_GOOGLE_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (text.toLowerCase().includes(e.toLowerCase())) { kinds.push("approved login email"); break; }
  }
  for (const t of privateTerms) if (t && text.toLowerCase().includes(t.toLowerCase())) { kinds.push("private term (from PRIVATE_TERMS_FILE)"); break; }
  return kinds;
}

function walk(dir: string, out: string[] = []) {
  if (!statSync(dir).isDirectory()) return [dir];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

export function scan(dirs: string[], privateTerms: string[] = []): Finding[] {
  const findings: Finding[] = [];
  for (const d of dirs) {
    const abs = resolve(ROOT, d);
    if (!existsSync(abs)) { findings.push({ file: d, kind: "folder missing (run npm run build first)" }); continue; }
    for (const f of walk(abs)) {
      if (extname(f) === ".map") { findings.push({ file: f, kind: "source map file" }); continue; }
      if ([".png", ".jpg", ".ico", ".woff", ".woff2", ".xlsx"].includes(extname(f))) continue;
      for (const kind of scanText(readFileSync(f, "utf8"), privateTerms)) findings.push({ file: f.replace(ROOT + "/", ""), kind });
    }
  }
  return findings;
}

if (process.argv[1]?.endsWith("check-public-build.ts")) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["dist"];
  const termsFile = process.env.PRIVATE_TERMS_FILE;
  const terms = termsFile ? readFileSync(termsFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) : [];
  const findings = scan(dirs, terms);
  if (findings.length) {
    for (const f of findings) console.error(`FOUND ${f.kind}: ${f.file}`);
    process.exit(1);
  }
  console.log(`public check passed: ${dirs.join(", ")}${terms.length ? ` (+${terms.length} private terms)` : ""}`);
}
