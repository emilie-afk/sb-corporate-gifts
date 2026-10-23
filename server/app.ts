import { Router, makeActor, type Ctx } from "./router";
import { HttpError, json, errorResponse, badRequest } from "./http";
import { readSession, loginRedirect, handleCallback, logoutResponse, authConfigured, type Session } from "./auth";
import { isDeployedRuntime } from "./runtime";
import { hit, subjectKey, EXPENSIVE, LIMITS } from "./rateLimit";
import { marketplaceRoutes } from "./routes/marketplaces";
import { productRoutes } from "./routes/products";
import { pricingRoutes } from "./routes/pricing";
import { revenueRoutes } from "./routes/revenue";
import { importRoutes } from "./routes/imports";
import { pricingImportRoutes } from "./routes/pricingImport";
import { revenueShopifyRoutes } from "./routes/revenueShopify";
import { handleIngest } from "./ingestEndpoint";
import { readBounded } from "./body";

const router = new Router();
marketplaceRoutes(router);
productRoutes(router);
pricingRoutes(router);
revenueRoutes(router);
importRoutes(router);
pricingImportRoutes(router);
revenueShopifyRoutes(router);

export type AppOptions = {
  /** LOCAL DEVELOPMENT ONLY — injected by scripts/dev-server.ts, never by the Netlify function. */
  devSession?: Session;
};

/** Default request-body limit; only the file uploads below may be larger (Netlify's 6 MB function limit). */
const MAX_BODY = 1024 * 1024;
const LARGE_BODY = 6 * 1024 * 1024;
const LARGE_BODY_PATHS = [/^\/pricing-import\/preview$/, /^\/revenue\/imports\/manual$/];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects cross-site browser writes: a foreign Origin, or a browser-declared cross-site request. */
function sameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients; the custom header below still applies
  const allowed = new Set([new URL(req.url).origin]);
  if (process.env.APP_BASE_URL) allowed.add(new URL(process.env.APP_BASE_URL).origin);
  return allowed.has(origin);
}

export function createApp(opts: AppOptions = {}) {
  if (opts.devSession && isDeployedRuntime()) throw new Error("The development login can never be used on a deployed runtime.");
  return async function handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api/, "") || "/";

      // ---- collector ingestion (own secret, no Google session)
      if (path === "/ingest/shopify-orders") return await handleIngest(req);

      // ---- auth endpoints (public)
      if (path === "/auth/login" && req.method === "GET") return await loginRedirect(req);
      if (path === "/auth/callback" && req.method === "GET") return await handleCallback(req);
      if (path === "/auth/logout" && req.method === "POST") {
        if (!sameOrigin(req) || req.headers.get("x-requested-with") !== "sbg") throw new HttpError(403, "forbidden", "Request blocked.");
        return logoutResponse(req);
      }

      // Missing security configuration denies everything (no partial or anonymous mode).
      if (!opts.devSession && !authConfigured()) {
        if (path === "/auth/session") return json({ authenticated: false });
        throw new HttpError(503, "misconfigured", "Sign-in is not configured.");
      }
      const session = opts.devSession ?? (await readSession(req));
      if (path === "/auth/session") {
        return json(session ? { authenticated: true, email: session.email } : { authenticated: false });
      }
      if (!session) throw new HttpError(401, "unauthorized", "Sign in with the approved Google account.");

      const mutating = req.method !== "GET" && req.method !== "HEAD";
      // CSRF defence (cookie-authenticated writes): a custom header that browsers can't send cross-site without a
      // CORS preflight (never allowed), a JSON content type, and a same-origin check on Origin / Sec-Fetch-Site.
      if (mutating) {
        if (req.headers.get("x-requested-with") !== "sbg" || !sameOrigin(req)) throw new HttpError(403, "forbidden", "Missing request header.");
        if (req.headers.get("content-length") !== "0" && !/^application\/json\b/i.test(req.headers.get("content-type") ?? ""))
          throw new HttpError(415, "unsupported_media_type", "Send JSON.");
      }

      const m = router.match(req.method, path);
      if (!m) throw new HttpError(404, "not_found", "Unknown endpoint");
      // Every route parameter is a record ID: reject malformed IDs before any database access.
      for (const v of Object.values(m.params)) if (!UUID.test(v)) throw new HttpError(400, "invalid_request", "Invalid record identifier.");

      // The body is read (byte-limited) and parsed BEFORE any database work, including the rate-limit counters.
      const maxBody = LARGE_BODY_PATHS.some((re) => re.test(path)) ? LARGE_BODY : MAX_BODY;
      let parsed: any = {};
      if (mutating) {
        const t = await readBounded(req, maxBody);
        if (t) { try { parsed = JSON.parse(t); } catch { throw badRequest("Invalid JSON"); } }
      }

      // Durable limits: expensive operations and overall write volume per signed-in Google account.
      if (mutating) {
        const ex = EXPENSIVE.find(([re]) => re.test(path));
        if (ex) await hit({ bucket: `op:${ex[0].source}:${subjectKey(session.sub)}`, limit: ex[1], windowSec: ex[2] });
        await hit({ bucket: `writes:${subjectKey(session.sub)}`, ...LIMITS.writes });
      }

      const ctx: Ctx = {
        req,
        params: m.params,
        query: url.searchParams,
        session,
        body: async () => parsed,
        actor: makeActor(session),
      };
      const out = await m.route.handler(ctx);
      return out instanceof Response ? out : json(stripPrivate(out));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** The authenticated Google subject is kept privately for audit and never returned to the browser. */
export function stripPrivate(v: any): any {
  if (Array.isArray(v)) return v.map(stripPrivate);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) if (!k.endsWith("auth_subject")) o[k] = stripPrivate(x);
    return o;
  }
  return v;
}
