// Local preview server: serves the built SPA (dist/) and the same API handler the Netlify function uses.
// Usage: npm run build && DATABASE_URL=... npm run dev
// LOCAL_DEV_LOGIN=1 skips Google sign-in with a placeholder identity — refuses to run on Netlify.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { createApp } from "../server/app";

if (process.env.NETLIFY || process.env.CONTEXT) throw new Error("dev-server is for local use only");
const devLogin = process.env.LOCAL_DEV_LOGIN === "1";
if (devLogin && !process.env.SESSION_SECRET) process.env.SESSION_SECRET = "local-dev-only-secret-local-dev-only-secret";
const app = createApp(devLogin ? { devSession: { sub: "local-dev", email: "local-preview@example.test" } } : {});
const dist = join(import.meta.dirname, "..", "dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const port = Number(process.env.PORT ?? 8888);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await app(new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks),
    }));
    const headers: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => { headers[k] = k === "set-cookie" ? r.headers.getSetCookie() : v; });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = normalize(join(dist, url.pathname === "/" ? "index.html" : url.pathname));
  const safe = file.startsWith(dist) ? file : join(dist, "index.html");
  try {
    const body = await readFile(safe);
    res.writeHead(200, { "content-type": TYPES[extname(safe)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(await readFile(join(dist, "index.html")));
  }
}).listen(port, "127.0.0.1", () => console.log(`Preview on http://localhost:${port}${devLogin ? " (local dev login)" : ""}`));
