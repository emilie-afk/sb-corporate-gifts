// Google sign-in (OAuth 2.0 authorization-code flow) with a server-side allowlist.
// Approved logins come ONLY from the private APPROVED_GOOGLE_EMAILS env var (comma separated).
// The Google `sub` is kept privately for audit; the typed "Your name" is a self-reported signature.
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { HttpError } from "./http";

export type Session = { sub: string; email: string };

const SESSION_COOKIE = "sbg_session";
const STATE_COOKIE = "sbg_oauth";
const SESSION_HOURS = 12;
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function secretKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "misconfigured", "SESSION_SECRET is not configured (min 32 chars).");
  return new TextEncoder().encode(s);
}

export function approvedEmails(): Set<string> {
  return new Set(
    (process.env.APPROVED_GOOGLE_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isApproved(email: string) {
  return approvedEmails().has(email.trim().toLowerCase());
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAge: number, req: Request) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function issueSession(s: Session) {
  return new SignJWT({ email: s.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .setAudience("sbg-app")
    .sign(secretKey());
}

/** Returns the session if the cookie is valid AND the login is still on the allowlist. */
export async function readSession(req: Request): Promise<Session | null> {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { audience: "sbg-app", algorithms: ["HS256"] });
    const email = String(payload.email ?? "");
    if (!payload.sub || !isApproved(email)) return null;
    return { sub: payload.sub, email };
  } catch {
    return null;
  }
}

function baseUrl(req: Request) {
  return (process.env.APP_BASE_URL || new URL(req.url).origin).replace(/\/$/, "");
}

export function redirectUri(req: Request) {
  return `${baseUrl(req)}/api/auth/callback`;
}

export async function loginRedirect(req: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(500, "misconfigured", "GOOGLE_CLIENT_ID is not configured.");
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const signed = await new SignJWT({ state, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .setAudience("sbg-oauth")
    .sign(secretKey());
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri(req));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("prompt", "select_account");
  return new Response(null, { status: 302, headers: { location: u.toString(), "set-cookie": cookie(STATE_COOKIE, signed, 600, req) } });
}

export async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const home = baseUrl(req);
  const fail = (reason: string) =>
    new Response(null, {
      status: 302,
      headers: { location: `${home}/?auth_error=${reason}`, "set-cookie": cookie(STATE_COOKIE, "", 0, req) },
    });
  try {
    const raw = cookies(req)[STATE_COOKIE];
    if (!raw) return fail("expired");
    const { payload: st } = await jwtVerify(raw, secretKey(), { audience: "sbg-oauth", algorithms: ["HS256"] });
    if (!url.searchParams.get("state") || url.searchParams.get("state") !== st.state) return fail("state");
    const code = url.searchParams.get("code");
    if (!code) return fail("cancelled");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return fail("token");
    const tok = (await tokenRes.json()) as { id_token?: string };
    if (!tok.id_token) return fail("token");
    const { payload } = await jwtVerify(tok.id_token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    if (payload.nonce !== st.nonce) return fail("state");
    const email = String(payload.email ?? "");
    if (payload.email_verified !== true || !payload.sub || !isApproved(email)) return fail("not_authorized");

    const session = await issueSession({ sub: payload.sub, email });
    const headers = new Headers({ location: `${home}/` });
    headers.append("set-cookie", cookie(SESSION_COOKIE, session, SESSION_HOURS * 3600, req));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", 0, req));
    return new Response(null, { status: 302, headers });
  } catch {
    return fail("failed");
  }
}

export function logoutResponse(req: Request) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie(SESSION_COOKIE, "", 0, req) },
  });
}

export const sessionCookieName = SESSION_COOKIE;
