import { Router, makeActor, type Ctx } from "./router";
import { HttpError, json, errorResponse, badRequest } from "./http";
import { readSession, loginRedirect, handleCallback, logoutResponse, type Session } from "./auth";
import { marketplaceRoutes } from "./routes/marketplaces";
import { productRoutes } from "./routes/products";
import { pricingRoutes } from "./routes/pricing";
import { revenueRoutes } from "./routes/revenue";
import { importRoutes } from "./routes/imports";

const router = new Router();
marketplaceRoutes(router);
productRoutes(router);
pricingRoutes(router);
revenueRoutes(router);
importRoutes(router);

export type AppOptions = {
  /** LOCAL DEVELOPMENT ONLY — injected by scripts/dev-server.ts, never by the Netlify function. */
  devSession?: Session;
};

const MAX_BODY = 256 * 1024;

export function createApp(opts: AppOptions = {}) {
  return async function handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api/, "") || "/";

      // ---- auth endpoints (public)
      if (path === "/auth/login" && req.method === "GET") return await loginRedirect(req);
      if (path === "/auth/callback" && req.method === "GET") return await handleCallback(req);
      if (path === "/auth/logout" && req.method === "POST") return logoutResponse(req);

      const session = opts.devSession ?? (await readSession(req));
      if (path === "/auth/session") {
        return json(session ? { authenticated: true, email: session.email } : { authenticated: false });
      }
      if (!session) throw new HttpError(401, "unauthorized", "Sign in with the approved Google account.");

      const mutating = req.method !== "GET" && req.method !== "HEAD";
      // CSRF defence: custom header can't be sent cross-site without a CORS preflight (which we never allow).
      if (mutating && req.headers.get("x-requested-with") !== "sbg") throw new HttpError(403, "forbidden", "Missing request header.");

      const m = router.match(req.method, path);
      if (!m) throw new HttpError(404, "not_found", "Unknown endpoint");

      let cached: any;
      const ctx: Ctx = {
        req,
        params: m.params,
        query: url.searchParams,
        session,
        body: async () => {
          if (cached !== undefined) return cached;
          const t = await req.text();
          if (t.length > MAX_BODY) throw badRequest("Request too large");
          try { cached = t ? JSON.parse(t) : {}; } catch { throw badRequest("Invalid JSON"); }
          return cached;
        },
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
