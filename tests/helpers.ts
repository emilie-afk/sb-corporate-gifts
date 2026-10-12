import { createApp } from "../server/app";
import { issueSession } from "../server/auth";
import { getPool } from "../server/db";
import { migrate } from "../scripts/migrate";
import { seed } from "../scripts/seed";

// Test-only placeholder identities (not real logins).
export const APPROVED = "approved-login@example.test";
export const OUTSIDER = "someone-else@example.test";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-123";
process.env.APPROVED_GOOGLE_EMAILS = APPROVED;

export const app = createApp();

let cookie = "";
export async function resetDb() {
  const pool = getPool();
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(false);
  await seed(false);
  cookie = `sbg_session=${await issueSession({ sub: "google-sub-123", email: APPROVED })}`;
}

export async function cookieFor(email: string) {
  return `sbg_session=${await issueSession({ sub: "x", email })}`;
}

export async function call(method: string, path: string, body?: unknown, opts: { cookie?: string | null; noCsrf?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const ck = opts.cookie === undefined ? cookie : opts.cookie;
  if (ck) headers.cookie = ck;
  if (!opts.noCsrf) headers["x-requested-with"] = "sbg";
  const res = await app(new Request(`http://localhost/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const S = { signer_name: "Test Person" };
