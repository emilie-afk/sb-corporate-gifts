// Shared rules for Marketplace Resources and the Slack workflow (partner refs, resource types, eligibility).
// A supplier is either an existing partner record (marketplaces table, any provider type) or a product vendor
// (vendors table). Both are referenced by their existing ID: "partner:<uuid>" or "vendor:<uuid>".
import type { Db } from "../db";
import { badRequest, notFound } from "../http";

export const SECTIONS = ["catalogs_pricing", "gift_terms", "assets_documents", "decisions_followups"] as const;
export type Section = (typeof SECTIONS)[number];

export const RESOURCE_TYPES: Record<string, Section> = {
  catalog: "catalogs_pricing", availability_list: "catalogs_pricing", quote: "catalogs_pricing", price_sheet: "catalogs_pricing",
  sample_option: "gift_terms", minimum_quantity: "gift_terms", customization: "gift_terms", lead_time: "gift_terms",
  shipping_method: "gift_terms", order_cutoff: "gift_terms", other_term: "gift_terms",
  product_photos: "assets_documents", logo: "assets_documents", packaging_guide: "assets_documents", proof: "assets_documents",
  order_form: "assets_documents", other_document: "assets_documents",
  one_sheet: "assets_documents", onboarding_form: "assets_documents", listings_spreadsheet: "assets_documents",
  listing_instructions: "assets_documents", sales_assets: "assets_documents", shared_folder: "assets_documents",
  decision: "decisions_followups", follow_up: "decisions_followups",
};
/** Resource types that are documents or sites with a link (the ones a Slack link can fill). */
export const LINK_TYPES = ["catalog", "price_sheet", "availability_list", "quote", "one_sheet", "onboarding_form", "order_form", "listings_spreadsheet",
  "listing_instructions", "sales_assets", "shared_folder", "product_photos", "logo", "packaging_guide", "proof", "other_document"] as const;

/**
 * Comparison key of a resource URL, so the same document is recognised however the link was copied: Google Docs,
 * Sheets, Slides and Drive files/folders by their id; Slack files by their file id; anything else by host and path
 * (lower-case host, no fragment, no tracking or sharing parameters, no trailing slash).
 */
export function linkKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  let m: RegExpExecArray | null;
  if (host === "docs.google.com" && (m = /^\/(document|spreadsheets|presentation|forms)\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(path))) return `google:${m[2]}`;
  if (host === "drive.google.com") {
    if ((m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(path))) return `google:${m[1]}`;
    if ((m = /\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/.exec(path))) return `google:${m[1]}`;
    const id = u.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return `google:${id}`;
  }
  if (/(^|\.)slack\.com$/.test(host) && (m = /^\/files\/[A-Z0-9]+\/(F[A-Z0-9]{6,})/.exec(path))) return `slack-file:${m[1]}`;
  const params = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|usp$|fbclid$|gclid$|ref$|ouid$|rtpof$|sd$)/i.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const q = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${host}${path.replace(/\/+$/, "") || ""}${q}`.toLowerCase().slice(0, 500);
}
export const RESOURCE_TYPE_KEYS = Object.keys(RESOURCE_TYPES) as [string, ...string[]];

export const SAMPLE_STATUSES = ["requested", "approved", "shipped", "delivered", "cancelled"] as const;
/** Progress order; a finding never moves a sample backwards (an older message read later does not undo progress). */
export const SAMPLE_RANK: Record<string, number> = { requested: 1, approved: 2, shipped: 3, delivered: 4, cancelled: 5 };

export type SupplierRef = { kind: "partner"; id: string } | { kind: "vendor"; id: string };

const REF = /^(partner|vendor):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function parseSupplierRef(v: string | null | undefined): SupplierRef | null {
  const m = REF.exec(v ?? "");
  return m ? { kind: m[1].toLowerCase() as "partner" | "vendor", id: m[2].toLowerCase() } : null;
}
export const refString = (r: SupplierRef) => `${r.kind}:${r.id}`;
export const refColumns = (r: SupplierRef | null) => ({
  marketplace_id: r?.kind === "partner" ? r.id : null,
  vendor_id: r?.kind === "vendor" ? r.id : null,
});

export async function assertSupplier(db: Db, r: SupplierRef) {
  const table = r.kind === "partner" ? "marketplaces" : "vendors";
  const row = (await db.query(`select id, name from ${table} where id = $1`, [r.id])).rows[0];
  if (!row) throw notFound(r.kind === "partner" ? "Partner" : "Vendor");
  return row as { id: string; name: string };
}

export function requireSupplier(v: unknown): SupplierRef {
  const r = parseSupplierRef(typeof v === "string" ? v : null);
  if (!r) throw badRequest("Choose a supplier.", { fields: { supplier: "Required" } });
  return r;
}

/** Name comparison key: case, spacing, punctuation, "&"/"and", a trailing ".com"/".io" and company suffixes ignored. */
export function nameKey(name: string) {
  return name.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\.(com|io|co|net)\b/g, " ")
    .replace(/\b(inc|llc|ltd|co|company|corp)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Matches a supplier name to exactly one existing partner or vendor. Several names may be given (e.g. "Example" and
 * "Example.io"); every one must point to the same record. Zero or several candidates → null with the reason.
 */
export async function matchSupplier(db: Db, names: string[], kind?: "partner" | "vendor"):
  Promise<{ ref: SupplierRef; name: string } | { ref: null; reason: "no_match" | "several_matches"; candidates: string[] }> {
  const keys = [...new Set(names.map(nameKey).filter(Boolean))];
  if (!keys.length) return { ref: null, reason: "no_match", candidates: [] };
  const rows: { kind: "partner" | "vendor"; id: string; name: string }[] = [];
  if (kind !== "vendor") rows.push(...(await db.query("select 'partner' as kind, id, name from marketplaces")).rows);
  if (kind !== "partner") rows.push(...(await db.query("select 'vendor' as kind, id, name from vendors")).rows);
  // A record named "A / B" answers to A, B and the full name.
  const recordKeys = (n: string) => [nameKey(n), ...n.split("/").map(nameKey)].filter(Boolean);
  const hits = rows.filter((r) => recordKeys(r.name).some((k) => keys.includes(k)));
  const distinct = [...new Map(hits.map((h) => [`${h.kind}:${h.id}`, h])).values()];
  if (distinct.length === 1) return { ref: { kind: distinct[0].kind, id: distinct[0].id } as SupplierRef, name: distinct[0].name };
  return { ref: null, reason: distinct.length ? "several_matches" : "no_match", candidates: distinct.map((d) => `${d.kind === "partner" ? "Partner" : "Vendor"}: ${d.name}`) };
}

/** Today's date in Los Angeles (the business calendar), for "overdue". */
export const businessToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

// ------------------------------------------------------------ Marketplace Resources eligibility
// A Slack finding may only touch a Marketplaces record that sells (or is being pursued to sell) our corporate gifts:
// sales_role = 'confirmed'. Product vendors are never matched. A name matches when, after normalising (nameKey), it
// equals the record's name, one part of an "A / B" name, or one of its verified aliases. Zero or several matches, or
// an unclear sales role, means the finding is skipped: a Slack mention never creates or guesses a partner.
export type EligibleMatch =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: "not_listed" | "role_unclear" | "several_matches" };

const recordKeys = (name: string, aliases: string[] = []) =>
  [...new Set([nameKey(name), ...name.split("/").map(nameKey), ...aliases.map(nameKey)].filter(Boolean))];

export async function matchEligiblePartner(db: Db, ref: { id?: string; names?: string[] }): Promise<EligibleMatch> {
  if (ref.id) {
    const m = (await db.query("select id, name, sales_role from marketplaces where id = $1", [ref.id])).rows[0];
    if (!m) return { ok: false, reason: "not_listed" };
    if (m.sales_role !== "confirmed") return { ok: false, reason: "role_unclear" };
    return { ok: true, id: m.id, name: m.name };
  }
  const keys = [...new Set((ref.names ?? []).map(nameKey).filter(Boolean))];
  if (!keys.length) return { ok: false, reason: "not_listed" };
  const rows = (await db.query("select id, name, sales_role, aliases from marketplaces")).rows;
  const hits = rows.filter((r: any) => recordKeys(r.name, r.aliases).some((k) => keys.includes(k)));
  if (hits.length === 0) return { ok: false, reason: "not_listed" };
  if (hits.length > 1) return { ok: false, reason: "several_matches" };
  if (hits[0].sales_role !== "confirmed") return { ok: false, reason: "role_unclear" };
  return { ok: true, id: hits[0].id, name: hits[0].name };
}
