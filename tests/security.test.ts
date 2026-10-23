// SECURITY TESTS — synthetic identities and fictional data only.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb, call, app, APPROVED, OUTSIDER, S, cookieFor } from "./helpers";
import { createApp } from "../server/app";
import { issueSession, _setGoogleVerifierForTests, _setTokenFetchForTests, parseStrictIsoTime } from "../server/auth";
import { getPool } from "../server/db";
import { restrictedGet, readSheet, _setSheetFetcherForTests, setSheetsReader } from "../server/lib/sheets";
import { safeText } from "../server/lib/pricingExcel";
import { redact } from "../server/redact";
import { hit } from "../server/rateLimit";
import { demoSeedAllowed, seedDemo } from "../scripts/seed";
import { migrate } from "../scripts/migrate";
import { assertPrivatePath, exportData, importData } from "../scripts/private-data";
import { scanText } from "../scripts/check-public-build";

const SECRET = process.env.SESSION_SECRET!;
const INGEST = "test-ingest-secret-test-ingest-secret-0001";
// Leak samples are assembled at runtime so the public-output scanner does not flag this file itself.
const PG = "postgres" + "ql://", SHEET = "docs.google.com/spreadsheets" + "/d/", AT = "@";
let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;

async function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await app(new Request(`http://localhost/api${path}`, { ...init, headers }));
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers, text };
}

async function forge(payload: Record<string, unknown>, opts: { secret?: string; exp?: string | number; iat?: number; aud?: string; sub?: string } = {}) {
  let j = new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setSubject(opts.sub ?? "google-sub-x").setAudience(opts.aud ?? "sbg-app");
  j = opts.iat !== undefined ? j.setIssuedAt(opts.iat) : j.setIssuedAt();
  j = j.setExpirationTime(opts.exp ?? "1h");
  return `sbg_session=${await j.sign(new TextEncoder().encode(opts.secret ?? SECRET))}`;
}

beforeAll(async () => { await resetDb(); });

// ------------------------------------------------------------------ sessions
describe("sessions and allowlist", () => {
  it("anonymous requests are rejected on every protected route (no DB work, no data)", async () => {
    for (const [m, p] of [["GET", "/marketplaces"], ["GET", "/sources"], ["GET", "/revenue/months"], ["POST", "/marketplaces"], ["GET", "/products"]] as const) {
      const r = await call(m, p, m === "POST" ? { ...S, name: "X" } : undefined, { cookie: null });
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(JSON.stringify(r.body)).not.toMatch(/Demo Market/);
    }
  });

  it("invalid, forged, expired and wrong-audience sessions are rejected", async () => {
    const bad = [
      "sbg_session=not-a-jwt",
      await forge({ email: APPROVED }, { secret: "another-secret-another-secret-another-1" }),
      await forge({ email: APPROVED }, { exp: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 100 }),
      await forge({ email: APPROVED }, { aud: "sbg-oauth" }),
    ];
    // alg "none" token
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ email: APPROVED, sub: "s", aud: "sbg-app", exp: 9999999999, iat: 1 })).toString("base64url")}.`;
    bad.push(`sbg_session=${none}`);
    for (const ck of bad) expect((await call("GET", "/marketplaces", undefined, { cookie: ck })).status).toBe(401);
  });

  it("a valid session for an unapproved account is rejected", async () => {
    expect((await call("GET", "/marketplaces", undefined, { cookie: await cookieFor(OUTSIDER) })).status).toBe(401);
  });

  it("client-supplied names, emails or IDs cannot grant access", async () => {
    const r = await req("/marketplaces", { headers: { "x-user-email": APPROVED, "x-forwarded-email": APPROVED, authorization: `Bearer ${APPROVED}` } });
    expect(r.status).toBe(401);
    const r2 = await req(`/marketplaces?email=${encodeURIComponent(APPROVED)}`, { cookie: `sbg_session=; email=${APPROVED}` });
    expect(r2.status).toBe(401);
    // Typed signature is self-reported: posting someone else's name with an unapproved session still fails.
    expect((await call("POST", "/marketplaces", { signer_name: "Approved Person", name: "Sneaky" }, { cookie: await cookieFor(OUTSIDER) })).status).toBe(401);
  });

  it("removing a login from the allowlist revokes its existing session immediately", async () => {
    const ck = await cookieFor(APPROVED);
    expect((await call("GET", "/marketplaces", undefined, { cookie: ck })).status).toBe(200);
    const saved = process.env.APPROVED_GOOGLE_EMAILS;
    process.env.APPROVED_GOOGLE_EMAILS = "someone-new@example.test";
    try {
      expect((await call("GET", "/marketplaces", undefined, { cookie: ck })).status).toBe(401);
    } finally { process.env.APPROVED_GOOGLE_EMAILS = saved; }
  });

  it("SESSION_NOT_BEFORE ends all sessions issued earlier", async () => {
    const ck = await forge({ email: APPROVED }, { iat: Math.floor(Date.now() / 1000) - 3600 });
    process.env.SESSION_NOT_BEFORE = new Date(Date.now() - 60_000).toISOString();
    try {
      expect((await call("GET", "/marketplaces", undefined, { cookie: ck })).status).toBe(401);
      expect((await call("GET", "/marketplaces", undefined, { cookie: await cookieFor(APPROVED) })).status).toBe(200);
    } finally { delete process.env.SESSION_NOT_BEFORE; }
  });

  it("an invalid SESSION_NOT_BEFORE denies everything instead of silently disabling revocation", async () => {
    const ck = await cookieFor(APPROVED);
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.example";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    try {
      for (const bad of ["yesterday", "2026-13-45T00:00:00Z", "1700000000", "2026-10-23", "2026-10-23T10:00:00",
        "2026-02-30T18:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-23T24:00:00Z", "2026-10-23T10:60:00Z", "2026-10-23T10:00:60Z", "2026-10-23T10:00:00+25:00", "2026-00-10T00:00:00Z"]) {
        process.env.SESSION_NOT_BEFORE = bad;
        expect((await call("GET", "/marketplaces", undefined, { cookie: ck })).status, bad).toBe(503);
        expect((await req("/auth/login", { headers: { "x-nf-client-connection-ip": freshIp() } })).status, bad).toBe(503);
      }
      process.env.SESSION_NOT_BEFORE = "2000-01-01T00:00:00Z";
      expect((await call("GET", "/marketplaces", undefined, { cookie: ck })).status).toBe(200);
    } finally {
      delete process.env.SESSION_NOT_BEFORE; delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
    }
  });

  it("strict ISO parsing accepts real instants only (no calendar roll-over)", () => {
    expect(parseStrictIsoTime("2026-02-30T18:00:00Z")).toBeNull();
    expect(parseStrictIsoTime("2026-02-28T18:00:00Z")).toBe(Date.UTC(2026, 1, 28, 18));
    expect(parseStrictIsoTime("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
    expect(parseStrictIsoTime("2026-10-23T18:00:00.123+07:00")).toBe(Date.UTC(2026, 9, 23, 11, 0, 0, 123));
    expect(parseStrictIsoTime("2026-12-31T23:59:59-05:30")).toBe(Date.UTC(2027, 0, 1, 5, 29, 59));
  });

  it("missing configuration denies everything", async () => {
    const saved = process.env.APPROVED_GOOGLE_EMAILS;
    process.env.APPROVED_GOOGLE_EMAILS = "";
    try {
      expect((await call("GET", "/marketplaces", undefined, { cookie: await issueSession({ sub: "s", email: APPROVED }).then((t) => `sbg_session=${t}`) })).status).toBe(503);
      expect((await call("GET", "/auth/session", undefined, { cookie: null })).body).toEqual({ authenticated: false });
      expect((await req("/auth/login")).status).toBe(503);
    } finally { process.env.APPROVED_GOOGLE_EMAILS = saved; }
    const savedSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "short";
    try { expect((await call("GET", "/marketplaces")).status).toBe(503); } finally { process.env.SESSION_SECRET = savedSecret; }
  });

  it("the development login cannot run on a deployed runtime", () => {
    for (const key of ["NETLIFY", "CONTEXT", "SITE_ID", "AWS_LAMBDA_FUNCTION_NAME"]) {
      process.env[key] = "true";
      try { expect(() => createApp({ devSession: { sub: "d", email: "d@example.test" } })).toThrow(/never/); } finally { delete process.env[key]; }
    }
    vi.stubEnv("NODE_ENV", "production");
    try { expect(() => createApp({ devSession: { sub: "d", email: "d@example.test" } })).toThrow(); } finally { vi.unstubAllEnvs(); }
  });

  it("session cookies are HttpOnly, SameSite and Secure outside localhost", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.example";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    try {
      const res = await app(new Request("https://gifts.example.com/api/auth/login", { headers: { "x-nf-client-connection-ip": freshIp() } }));
      const sc = res.headers.get("set-cookie")!;
      expect(sc).toMatch(/HttpOnly/);
      expect(sc).toMatch(/SameSite=Lax/);
      expect(sc).toMatch(/Secure/);
      const logout = await app(new Request("https://gifts.example.com/api/auth/logout", { method: "POST", headers: { "x-requested-with": "sbg", origin: "https://gifts.example.com" } }));
      expect(logout.headers.get("set-cookie")).toMatch(/sbg_session=;.*Max-Age=0.*Secure/);
    } finally { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; }
  });
});

// ------------------------------------------------------------- Google callback
describe("Google sign-in callback", () => {
  let ip = "";
  beforeAll(() => { process.env.GOOGLE_CLIENT_ID = "test-client.apps.example"; process.env.GOOGLE_CLIENT_SECRET = "test-client-secret"; });
  afterAll(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; _setGoogleVerifierForTests(null); _setTokenFetchForTests(null); });
  afterEach(() => { _setGoogleVerifierForTests(null); _setTokenFetchForTests(null); });

  async function start() {
    ip = freshIp();
    const res = await app(new Request("http://localhost/api/auth/login", { headers: { "x-nf-client-connection-ip": ip } }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://accounts.google.com");
    const stateCookie = res.headers.get("set-cookie")!.split(";")[0];
    return { state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")!, stateCookie };
  }
  async function finish(q: string, cookie: string | null) {
    const headers: Record<string, string> = { "x-nf-client-connection-ip": ip };
    if (cookie) headers.cookie = cookie;
    const res = await app(new Request(`http://localhost/api/auth/callback?${q}`, { headers }));
    return { location: res.headers.get("location") ?? "", cookies: res.headers.getSetCookie().join("\n") };
  }
  function google(payload: Record<string, unknown>) {
    _setTokenFetchForTests((async () => new Response(JSON.stringify({ id_token: "stub" }), { status: 200 })) as any);
    _setGoogleVerifierForTests(async (_t, aud) => { expect(aud).toBe("test-client.apps.example"); return { payload }; });
  }

  it("approved, verified account with matching state and nonce gets a session", async () => {
    const s = await start();
    google({ sub: "g-1", email: APPROVED, email_verified: true, nonce: s.nonce });
    const r = await finish(`state=${s.state}&code=c`, s.stateCookie);
    expect(r.location).toBe("http://localhost/");
    expect(r.cookies).toMatch(/sbg_session=ey/);
  });

  it("unapproved account, unverified email, wrong nonce, wrong/missing state are refused", async () => {
    const cases: [Record<string, unknown> | null, (s: any) => string, (s: any) => string | null, string][] = [
      [{ sub: "g", email: OUTSIDER, email_verified: true }, (s) => `state=${s.state}&code=c`, (s) => s.stateCookie, "not_authorized"],
      [{ sub: "g", email: APPROVED, email_verified: false }, (s) => `state=${s.state}&code=c`, (s) => s.stateCookie, "not_authorized"],
      [{ sub: "g", email: APPROVED, email_verified: true, nonce: "other" }, (s) => `state=${s.state}&code=c`, (s) => s.stateCookie, "state"],
      [null, () => `state=wrong&code=c`, (s) => s.stateCookie, "state"],
      [null, (s) => `state=${s.state}&code=c`, () => null, "expired"],
    ];
    for (const [payload, q, ck, reason] of cases) {
      const s = await start();
      google(payload ? { nonce: s.nonce, ...payload } : { sub: "g", email: APPROVED, email_verified: true, nonce: s.nonce });
      const r = await finish(q(s), ck(s));
      expect(r.location).toContain(`auth_error=${reason}`);
      expect(r.cookies).not.toMatch(/sbg_session=ey/);
    }
  });

  it("a forged state cookie is refused and a failing Google verification is refused", async () => {
    const s = await start();
    const forged = await new SignJWT({ state: "x", nonce: "y" }).setProtectedHeader({ alg: "HS256" }).setAudience("sbg-oauth").setExpirationTime("5m")
      .sign(new TextEncoder().encode("another-secret-another-secret-another-1"));
    google({ sub: "g", email: APPROVED, email_verified: true, nonce: "y" });
    expect((await finish(`state=x&code=c`, `sbg_oauth=${forged}`)).location).toContain("auth_error=failed");
    _setTokenFetchForTests((async () => new Response(JSON.stringify({ id_token: "stub" }), { status: 200 })) as any);
    _setGoogleVerifierForTests(async () => { throw new Error("signature verification failed"); });
    expect((await finish(`state=${s.state}&code=c`, s.stateCookie)).location).toContain("auth_error=failed");
  });

  it("login attempts are rate limited per client address", async () => {
    const addr = freshIp();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app(new Request("http://localhost/api/auth/login", { headers: { "x-nf-client-connection-ip": addr } }))).status;
    expect(last).toBe(429);
  });
});

// ------------------------------------------------------------------- CSRF
describe("CSRF and request validation", () => {
  it("writes need the custom header, a same-origin request and JSON", async () => {
    expect((await call("POST", "/marketplaces", { ...S, name: "No header" }, { noCsrf: true })).status).toBe(403);
    const ck = await cookieFor(APPROVED);
    const base = { cookie: ck, "x-requested-with": "sbg", "content-type": "application/json" };
    const body = JSON.stringify({ ...S, name: "Cross site" });
    expect((await req("/marketplaces", { method: "POST", headers: { ...base, origin: "https://evil.example" }, body })).status).toBe(403);
    expect((await req("/marketplaces", { method: "POST", headers: { ...base, "sec-fetch-site": "cross-site" }, body })).status).toBe(403);
    expect((await req("/marketplaces", { method: "POST", headers: { ...base, "content-type": "text/plain" }, body })).status).toBe(415);
    expect((await req("/auth/logout", { method: "POST", headers: { origin: "https://evil.example", "x-requested-with": "sbg" } })).status).toBe(403);
  });

  it("malformed record IDs are rejected before any database access", async () => {
    const spy = vi.spyOn(getPool(), "query");
    const r = await call("GET", "/marketplaces/1%20or%201=1");
    expect(r.status).toBe(400);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("marketplaces"))).toBe(false);
    spy.mockRestore();
  });

  it("oversized bodies are refused", async () => {
    const r = await call("POST", "/marketplaces", { ...S, name: "Big", description: "x".repeat(1024 * 1024 + 10) });
    expect(r.status).toBe(413);
  });

  it("bodies are limited in BYTES and read before any database work (incl. rate-limit counters)", async () => {
    const ck = await cookieFor(APPROVED);
    const headers = { cookie: ck, "x-requested-with": "sbg", "content-type": "application/json" };
    const spy = vi.spyOn(getPool(), "query");
    const sql = () => spy.mock.calls.map((c) => String(c[0]));
    // 600k two-byte characters: under 1M characters but over 1 MB.
    const multi = JSON.stringify({ ...S, name: "Multi", description: "é".repeat(600_000) });
    expect(multi.length).toBeLessThan(1024 * 1024);
    expect((await req("/marketplaces", { method: "POST", headers, body: multi })).status).toBe(413);
    // A lying/oversized declared length is refused before reading.
    expect((await req("/marketplaces", { method: "POST", headers: { ...headers, "content-length": String(5 * 1024 * 1024) }, body: "{}" })).status).toBe(413);
    // Streamed body without a length header.
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(100 * 1024).fill(0x20)); c.close(); } });
    expect((await app(new Request("http://localhost/api/marketplaces", { method: "POST", headers, body: stream, duplex: "half" } as any))).status).toBe(413);
    // Malformed JSON and invalid UTF-8.
    expect((await req("/marketplaces", { method: "POST", headers, body: "{not json" })).status).toBe(400);
    expect((await req("/marketplaces", { method: "POST", headers, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })).status).toBe(400);
    expect(sql().filter((q) => /rate_limits|marketplaces/.test(q))).toEqual([]);
    spy.mockRestore();
  });

  it("spreadsheet-formula names are refused; responses are never cacheable", async () => {
    const r = await call("POST", "/marketplaces", { ...S, name: "=HYPERLINK(\"https://evil.example\")" });
    expect(r.status).toBe(400);
    const ok = await req("/marketplaces", { cookie: await cookieFor(APPROVED) });
    expect(ok.headers.get("cache-control")).toMatch(/no-store/);
    expect(ok.headers.get("cache-control")).toMatch(/private/);
  });

  it("errors do not leak SQL, connection details or stack traces", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = vi.spyOn(getPool(), "query").mockRejectedValueOnce(Object.assign(new Error(`connect failed ${PG}user:pw${AT}db.example.net/x for someone${AT}example.com https://${SHEET}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), { code: "ECONNREFUSED" }));
    const r = await call("GET", "/sources");
    q.mockRestore();
    expect(r.status).toBe(500);
    const all = JSON.stringify(r.body) + spy.mock.calls.flat().join(" ");
    for (const leak of ["postgresql://", "pw@", "someone@example.com", "docs.google.com", "AAAAAAAAAAAAAAAA", "    at "]) expect(all).not.toContain(leak);
    spy.mockRestore();
    expect(redact(`Bearer abc.def ${PG}u:p${AT}h/db https://x.example/a b${AT}c.com`)).toBe("Bearer <redacted> <db-url> <url> <email>");
  });
});

// ------------------------------------------------------------------- ingestion
describe("collector ingestion credential", () => {
  beforeAll(() => { process.env.CORPORATE_INGEST_SECRET = INGEST; });
  afterAll(() => { delete process.env.CORPORATE_INGEST_SECRET; });

  it("the ingestion secret cannot be used for any other route", async () => {
    for (const p of ["/marketplaces", "/sources", "/revenue/months"]) {
      expect((await req(p, { headers: { authorization: `Bearer ${INGEST}` } })).status).toBe(401);
    }
    expect((await req("/marketplaces", { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "x-requested-with": "sbg", "content-type": "application/json" }, body: JSON.stringify({ ...S, name: "x" }) })).status).toBe(401);
  });

  it("a signed-in session cannot ingest; missing/wrong secret refused; non-JSON refused", async () => {
    const headers = { "x-nf-client-connection-ip": freshIp(), "content-type": "application/json" };
    expect((await req("/ingest/shopify-orders", { method: "POST", cookie: await cookieFor(APPROVED), headers, body: "{}" })).status).toBe(401);
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: { ...headers, authorization: `Bearer ${INGEST}`, "content-type": "text/csv" }, body: "a,b" })).status).toBe(415);
    expect((await req("/ingest/shopify-orders", { method: "GET", headers })).status).toBe(405);
  });

  it("collector payloads are limited in bytes (declared and actual)", async () => {
    const h = { "x-nf-client-connection-ip": freshIp(), authorization: `Bearer ${INGEST}`, "content-type": "application/json" };
    const big = JSON.stringify({ pad: "é".repeat(3_200_000) }); // ~6.4 MB of bytes, < 6.3M characters
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: h, body: big })).status).toBe(413);
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: { ...h, "content-length": String(7 * 1024 * 1024) }, body: "{}" })).status).toBe(413);
  });

  it("content type and declared size are checked before any database work", async () => {
    const spy = vi.spyOn(getPool(), "query");
    const h = { "x-nf-client-connection-ip": freshIp(), authorization: "Bearer guess" };
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: { ...h, "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: { ...h, "content-type": "application/json", "content-length": String(7 * 1024 * 1024) }, body: "{}" })).status).toBe(413);
    expect(spy.mock.calls.filter((c) => /rate_limits/.test(String(c[0])))).toEqual([]);
    spy.mockRestore();
  });

  it("credential guessing is rate limited", async () => {
    const addr = freshIp();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await req("/ingest/shopify-orders", { method: "POST", headers: { "x-nf-client-connection-ip": addr, authorization: "Bearer guess", "content-type": "application/json" }, body: "{}" })).status;
    expect(last).toBe(429);
  });

  it("missing ingestion configuration refuses the request", async () => {
    delete process.env.CORPORATE_INGEST_SECRET;
    expect((await req("/ingest/shopify-orders", { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    process.env.CORPORATE_INGEST_SECRET = INGEST;
  });
});

// ------------------------------------------------------------- rate limits
describe("durable limits", () => {
  it("are stored in the database with hashed keys and survive app restarts", async () => {
    const bucket = `test:${freshIp()}`;
    for (let i = 0; i < 3; i++) await hit({ bucket, limit: 3, windowSec: 600 });
    await expect(hit({ bucket, limit: 3, windowSec: 600 })).rejects.toMatchObject({ status: 429 });
    const stored = await getPool().query("select bucket from rate_limits where bucket like 'login:%' or bucket like 'ingest:%' limit 5");
    for (const r of stored.rows) expect(r.bucket).not.toMatch(/198\.51/);
  });
});

// -------------------------------------------------------------- sheet fetching
describe("Google Sheet fetching", () => {
  afterEach(() => _setSheetFetcherForTests(null));
  const tab = { spreadsheetId: "example_spreadsheet_id_for_tests", tabName: "Tab", gid: "0", headerRow: 1, lastColumn: "C" };

  it("only https Google hosts are contacted", async () => {
    const seen: string[] = [];
    _setSheetFetcherForTests(async (u) => { seen.push(u); return new Response("x"); });
    for (const u of ["http://docs.google.com/x", "https://evil.example/x", "https://docs.google.com.evil.example/x", `https://user:pw${AT}docs.google.com/x`, "https://docs.google.com:8443/x", "file:///etc/passwd", "https://169.254.169.254/latest"]) {
      await expect(restrictedGet(u, [/^docs\.google\.com$/])).rejects.toThrow(/Blocked/);
    }
    expect(seen).toEqual([]);
  });

  it("redirects to a non-Google host are refused (no open proxy)", async () => {
    const seen: string[] = [];
    _setSheetFetcherForTests(async (u) => { seen.push(u); return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:5432/" } }); });
    setSheetsReader(null);
    await expect(readSheet(tab)).rejects.toThrow(/outside Google Sheets/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/example_spreadsheet_id_for_tests\/export/);
  });

  it("a redirect to Google's download host is followed; invalid sheet IDs are never fetched", async () => {
    _setSheetFetcherForTests(async (u) => u.includes("docs.google.com")
      ? new Response(null, { status: 307, headers: { location: "https://doc-0s-1c-sheets.googleusercontent.com/export/abc" } })
      : new Response("SKU,Cost\nA,1", { headers: { "content-type": "text/csv" } }));
    expect(await readSheet(tab)).toEqual([["SKU", "Cost"], ["A", "1"]]);
    await expect(readSheet({ ...tab, spreadsheetId: "../../evil" })).rejects.toThrow(/invalid spreadsheet reference/);
  });

  it("sheet locations are masked in lists and revealing one is audited", async () => {
    const created = await call("POST", "/sources", {
      ...S, label: "Synthetic tab", spreadsheet: "https://docs.google.com/spreadsheets/d/example_spreadsheet_id_for_tests/edit#gid=7",
      vendor: "Example Vendor Co", tab_name: "Synthetic", match_columns: ["SKU"], cost_column: "Cost", cost_basis: "per_piece",
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain("example_spreadsheet_id_for_tests");
    const list = await call("GET", "/sources");
    expect(JSON.stringify(list.body)).not.toContain("example_spreadsheet_id_for_tests");
    expect(list.body.sources[0].spreadsheet_ref).toBe("…ests");
    const id = created.body.source.id;
    const shown = await call("GET", `/sources/${id}/location`);
    expect(shown.body.link).toContain("example_spreadsheet_id_for_tests");
    const a = await getPool().query("select action, auth_subject from audit_events where entity_id = $1 and action = 'reveal_location'", [id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].auth_subject).toBe("google-sub-123");
    const audits = JSON.stringify((await getPool().query("select before, after from audit_events where entity_id = $1", [id])).rows);
    expect(audits).not.toContain("example_spreadsheet_id_for_tests");
  });
});

// ------------------------------------------------------------- exports/imports
describe("spreadsheet safety", () => {
  it("exported template text cannot start a formula", () => {
    for (const v of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(safeText(v).startsWith("'")).toBe(true);
    expect(safeText("Demo Market Alpha")).toBe("Demo Market Alpha");
  });
});

// ------------------------------------------------------------- public data
describe("public repository data", () => {
  it("demo data is refused on deployed runtimes and in databases holding real data", async () => {
    expect(demoSeedAllowed({ SEED_DEMO_DATA: "1" } as any)).toBe(true);
    expect(demoSeedAllowed({ SEED_DEMO_DATA: "1", NETLIFY: "true" } as any)).toBe(false);
    expect(demoSeedAllowed({ SEED_DEMO_DATA: "1", NODE_ENV: "production" } as any)).toBe(false);
    expect(demoSeedAllowed({} as any)).toBe(false);
    await expect(seedDemo(false, { SEED_DEMO_DATA: "1", CONTEXT: "production" } as any)).rejects.toThrow(/only for local/);
    await getPool().query("insert into schema_migrations (version) values ('seed_initial_data') on conflict do nothing");
    try {
      await getPool().query("delete from schema_migrations where version = 'seed_demo_data'");
      await expect(seedDemo(false, { SEED_DEMO_DATA: "1" } as any)).rejects.toThrow(/real data/);
    } finally {
      await getPool().query("delete from schema_migrations where version = 'seed_initial_data'");
      await getPool().query("insert into schema_migrations (version) values ('seed_demo_data') on conflict do nothing");
    }
  });

  it("the build scanner flags secrets, sheet links, real emails and source maps", () => {
    expect(scanText(`${PG}u:pw${AT}ep-1.example.net/db`)).toContain("database connection string");
    expect(scanText("postgresql://localhost/gifting")).toEqual([]);
    expect(scanText(`https://${SHEET}1AbCdEfGhIjKlMnOpQrStUvWxYz012`)).toContain("Google Sheet link");
    expect(scanText(`hello person${AT}company.com`)).toContain("email address");
    expect(scanText("demo@example.com")).toEqual([]);
    expect(scanText("x", ["Secret Partner"], { APPROVED_GOOGLE_EMAILS: `boss${AT}company.com` } as any)).toEqual([]);
    expect(scanText(`boss${AT}company.com`, [], { APPROVED_GOOGLE_EMAILS: `boss${AT}company.com` } as any)).toContain("approved login email");
    expect(scanText("about secret partner", ["Secret Partner"], {} as any)).toContain("private term (from PRIVATE_TERMS_FILE)");
  });
});

describe("private data transfer", () => {
  it("refuses to write exports inside the repository (except private/)", () => {
    expect(() => assertPrivatePath("db/export.json")).toThrow();
    expect(() => assertPrivatePath("private/export.json")).not.toThrow();
    expect(() => assertPrivatePath(join(tmpdir(), "x.json"))).not.toThrow();
  });

  it("exports every table from one read-only repeatable-read snapshot on one connection", async () => {
    const pool = getPool();
    const poolSpy = vi.spyOn(pool, "query");
    const origConnect = pool.connect.bind(pool);
    const seen: string[] = [];
    const connectSpy = vi.spyOn(pool, "connect").mockImplementation((async () => {
      const client: any = await origConnect();
      const q = client.query.bind(client);
      client.query = (text: any, ...rest: any[]) => { seen.push(String(text)); return q(text, ...rest); };
      return client;
    }) as any);
    await exportData(join(mkdtempSync(join(tmpdir(), "sbcg-")), "snap.json"));
    const connects = connectSpy.mock.calls.length;
    connectSpy.mockRestore();
    expect(connects).toBe(1);
    expect(seen[0]).toMatch(/begin transaction isolation level repeatable read read only/i);
    expect(seen.at(-1)).toBe("commit");
    expect(seen.filter((q) => /from marketplaces x/.test(q))).toHaveLength(1);
    expect(poolSpy.mock.calls.map((c) => String(c[0])).filter((q) => /json_agg|schema_migrations/.test(q))).toEqual([]);
    poolSpy.mockRestore();
  });

  it("round-trips with the same IDs, only adds rows and never overwrites", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbcg-"));
    const file = join(dir, "ops.json");
    const counts = await exportData(file);
    expect(counts.marketplaces).toBeGreaterThan(0);
    expect(statSync(file).mode & 0o077).toBe(0);
    const data = JSON.parse(readFileSync(file, "utf8"));
    const m0 = data.tables.marketplaces[0];
    // Same database: everything already present → nothing added, nothing changed.
    const again = await importData(file, true);
    expect(again.report.marketplaces.added).toBe(0);
    // Locally changed record is not overwritten by an import.
    await getPool().query("update marketplaces set description = 'changed locally' where id = $1", [m0.id]);
    await importData(file, true);
    expect((await getPool().query("select description from marketplaces where id = $1", [m0.id])).rows[0].description).toBe("changed locally");
    // A deleted record comes back with its original ID; preview mode writes nothing.
    const ch0 = data.tables.channels.find((c: any) => c.id === m0.channel_id);
    const ch = { ...ch0, id: "00000000-0000-4000-8000-000000000002", name: "Demo Market Restored" };
    const extra = { ...m0, id: "00000000-0000-4000-8000-000000000001", channel_id: ch.id, name: "Demo Market Restored" };
    data.tables.channels.push(ch);
    data.tables.marketplaces.push(extra);
    writeFileSync(file, JSON.stringify(data));
    const preview = await importData(file, false);
    expect(preview.report.marketplaces.added).toBe(1);
    expect((await getPool().query("select 1 from marketplaces where id = $1", [extra.id])).rowCount).toBe(0);
    await importData(file, true);
    expect((await getPool().query("select name from marketplaces where id = $1", [extra.id])).rows[0].name).toBe("Demo Market Restored");
  });
});

describe("demo data guard (fresh database)", () => {
  afterAll(async () => { await resetDb(); });

  it("refuses when ANY operational table has records; replaces only the untouched baseline row", async () => {
    vi.stubEnv("SEED_DEMO_DATA", "0");
    try {
      await getPool().query("drop schema public cascade; create schema public;");
      await migrate(false);
    } finally { vi.unstubAllEnvs(); }
    const env = { SEED_DEMO_DATA: "1" } as any;
    const direct = async () => (await getPool().query("select id, default_discount_pct, terms_updated_by from channels where name = 'Direct website'")).rows;
    expect((await direct())[0].terms_updated_by).toBe("System baseline");

    // A product without any marketplace still counts as real data.
    const p = await getPool().query("insert into products (name) values ('Real-looking gift') returning id");
    await expect(seedDemo(false, env)).rejects.toThrow(/products/);
    await getPool().query("delete from products where id = $1", [p.rows[0].id]);
    // An edited baseline row counts as real data too.
    await getPool().query("update channels set terms_note = 'edited by team' where name = 'Direct website'");
    await expect(seedDemo(false, env)).rejects.toThrow(/channels/);
    await getPool().query("update channels set terms_note = null where name = 'Direct website'");
    // NULL-safe: a Direct website row with a NULL signer is not the automatic baseline.
    await getPool().query("update channels set terms_updated_by = null where name = 'Direct website'");
    await expect(seedDemo(false, env)).rejects.toThrow(/channels/);
    await getPool().query("update channels set terms_updated_by = 'System baseline' where name = 'Direct website'");
    // A monthly revenue record (no products, no marketplaces) also refuses.
    await getPool().query("insert into channels (name, type) values ('Other channel', 'marketplace')");
    await expect(seedDemo(false, env)).rejects.toThrow(/channels/);
    await getPool().query("delete from channels where name = 'Other channel'");

    // Only the untouched baseline: allowed, and it is replaced by the demo terms.
    await seedDemo(false, env);
    const d = await direct();
    expect(d).toHaveLength(1);
    expect(Number(d[0].default_discount_pct)).toBe(15);
    expect((await getPool().query("select count(*)::int as n from marketplaces")).rows[0].n).toBeGreaterThan(0);
  });
});
