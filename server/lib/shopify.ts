// Public Shopify storefront catalog reader. The origin is fixed server-side (never taken from a request).
// Verified 2026-10-09: https://succulentsbox.com/products.json?limit=250&page=N paginates (~11 pages) and
// returns per-variant `available`, `price`, `sku`; it does NOT return collections, vendor costs or
// corporate/card eligibility.

export const SHOPIFY_ORIGIN = (process.env.SHOPIFY_CATALOG_ORIGIN || "https://succulentsbox.com").replace(/\/$/, "");
export const PAGE_LIMIT = 250;
export const MAX_PAGES = 100;

export type CatalogItem = {
  product_id: number;
  variant_id: number;
  name: string;
  variant: string | null;
  sku: string | null;
  handle: string;
  product_url: string;
  image_url: string | null;
  website_vendor: string | null;
  price_cents: number | null;
  web_availability: "available" | "unavailable" | "unknown";
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (u, i) => fetch(u, i);
export function setShopifyFetcher(f: Fetcher | null) {
  fetcher = f ?? ((u, i) => fetch(u, i));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with timeout and polite bounded retries (429 / 5xx / network). */
export async function politeGet(url: string, attempts = 3): Promise<any> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetcher(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "SB-corporate-gifting-tracker/1.0" } });
      if (res.ok) return await res.json();
      lastErr = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 4000) : 800 * (i + 1));
    } catch (e: any) {
      lastErr = e?.name === "AbortError" ? "timeout" : String(e?.message ?? e);
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`Shopify request failed (${lastErr})`);
}

function toCents(price: unknown): number | null {
  if (price === null || price === undefined || price === "") return null;
  const n = Number(price);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function mapProducts(products: any[]): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const p of products ?? []) {
    if (!p?.id || !Array.isArray(p.variants)) continue;
    const firstImage = p.images?.[0]?.src ?? null;
    for (const v of p.variants) {
      if (!v?.id) continue;
      const vt = v.title && v.title !== "Default Title" ? String(v.title) : null;
      out.push({
        product_id: Number(p.id),
        variant_id: Number(v.id),
        name: String(p.title ?? "").slice(0, 300) || `Product ${p.id}`,
        variant: vt,
        sku: v.sku ? String(v.sku) : null,
        handle: String(p.handle ?? ""),
        product_url: `${SHOPIFY_ORIGIN}/products/${encodeURIComponent(p.handle ?? "")}?variant=${v.id}`,
        image_url: v.featured_image?.src ?? firstImage,
        website_vendor: p.vendor ? String(p.vendor) : null,
        price_cents: toCents(v.price),
        web_availability: v.available === true ? "available" : v.available === false ? "unavailable" : "unknown",
      });
    }
  }
  return out;
}

export async function fetchCatalogPage(page: number): Promise<{ items: CatalogItem[]; productCount: number }> {
  const data = await politeGet(`${SHOPIFY_ORIGIN}/products.json?limit=${PAGE_LIMIT}&page=${page}`);
  if (!data || !Array.isArray(data.products)) throw new Error("Unexpected Shopify response shape");
  return { items: mapProducts(data.products), productCount: data.products.length };
}

export async function fetchCollectionProductIds(handle: string): Promise<number[]> {
  if (!/^[a-z0-9][a-z0-9-]{0,200}$/.test(handle)) throw new Error("Invalid collection handle");
  const ids: number[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await politeGet(`${SHOPIFY_ORIGIN}/collections/${handle}/products.json?limit=${PAGE_LIMIT}&page=${page}`);
    const ps = Array.isArray(data?.products) ? data.products : [];
    if (!ps.length) return ids;
    ids.push(...ps.map((p: any) => Number(p.id)));
  }
  throw new Error("Collection exceeded page limit");
}
