// Read-only reporting API for the Marketing Dashboard's server. Protected by its own private secret
// (CORPORATE_REPORTING_SECRET), never by the Google login, and separate from the collector's ingest secret.
//
//   GET /api/reporting/v1/months?from=YYYY-MM&to=YYYY-MM&cursor=YYYY-MM&limit=1..24
//       Monthly corporate revenue, one record per month (all corporate channels) with a per-channel breakdown.
//       Figures are exactly the Revenue page's summary (revenueSummary), so both always agree.
//   GET /api/reporting/v1/pipeline
//       Marketplace counts by status and provider type, as of now.
//
// Returned: stable record ids, a content revision, the reporting month and timezone, the scope, completeness with
// reason codes, and amounts in cents. Never returned: orders, order lines, customer or billing names, contact
// names or emails, notes, match rules, signer names, portal links or any secret. Revoke by removing the
// CORPORATE_REPORTING_SECRET environment variable (and redeploying); the routes then answer 503.
import { createHash, timingSafeEqual } from "node:crypto";
import { json, errorResponse, HttpError } from "./http";
import { hit, clientKey } from "./rateLimit";
import { query, one } from "./db";
import { revenueSummary } from "./routes/revenueShopify";

export const REPORTING_TIMEZONE = "America/Los_Angeles";
export const MONTHS_PAGE_MAX = 24;
const LIMIT = { limit: 120, windowSec: 3600 };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function credential(header: string | null) {
  const secret = process.env.CORPORATE_REPORTING_SECRET ?? "";
  if (secret.length < 32) return "disabled" as const;
  // Separate from every other credential: equal to one of them counts as not configured.
  if ([process.env.CORPORATE_INGEST_SECRET, process.env.SESSION_SECRET, process.env.GOOGLE_CLIENT_SECRET].includes(secret)) return "disabled" as const;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

const monthEnd = (m: string) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
};
/** Today's date in the reporting timezone (business date). */
const businessToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: REPORTING_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const revisionOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export async function monthsReport(params: URLSearchParams, now = new Date()) {
  for (const k of params.keys()) if (!["from", "to", "cursor", "limit"].includes(k)) throw new HttpError(400, "bad_query", `Unknown parameter ${k}`);
  const from = params.get("from"), to = params.get("to"), cursor = params.get("cursor");
  for (const [k, v] of [["from", from], ["to", to], ["cursor", cursor]] as const) if (v !== null && !MONTH.test(v)) throw new HttpError(400, "bad_query", `${k} must be YYYY-MM`);
  if (from && to && from > to) throw new HttpError(400, "bad_query", "from must not be after to");
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? 12 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MONTHS_PAGE_MAX) throw new HttpError(400, "bad_query", `limit must be an integer between 1 and ${MONTHS_PAGE_MAX}`);

  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const s: any = await revenueSummary(q);
  const today = businessToday(now);

  const byMonth = new Map<string, any[]>();
  for (const row of s.rows) (byMonth.get(row.month) ?? byMonth.set(row.month, []).get(row.month)!).push(row);
  const info = new Map<string, any>(s.months.map((m: any) => [m.month, m]));
  const months = [...new Set([...byMonth.keys(), ...info.keys()])].filter((m) => !cursor || m > cursor).sort();
  const page = months.slice(0, limit);

  const records = page.map((m) => {
    const rows = byMonth.get(m) ?? [];
    const mi = info.get(m);
    const reasons: string[] = [];
    if (today <= monthEnd(m)) reasons.push("month_in_progress");
    if (!mi?.complete) reasons.push(mi?.covered_days ? "shopify_coverage_partial" : "no_shopify_coverage");
    if (mi?.conflicts) reasons.push("orders_with_channel_conflicts");
    if (mi?.unclassified) reasons.push("unclassified_orders");
    if (rows.some((r) => r.legacy_needs_review.length)) reasons.push("manual_records_need_review");
    if (rows.some((r) => r.legacy_incomplete)) reasons.push("manual_records_incomplete");
    const completeness = reasons.includes("month_in_progress") ? "provisional" : reasons.length ? "partial" : "complete";
    const sum = (f: (r: any) => number) => rows.reduce((t, r) => t + Number(f(r)), 0);
    const feeRows = rows.filter((r) => r.fees_cents != null);
    const totals = {
      net_revenue_cents: sum((r) => r.combined_cents),
      shopify_net_revenue_cents: sum((r) => r.shopify.net_cents),
      manual_net_revenue_cents: sum((r) => r.manual_cents),
      // Manual records and adjustments included in the revenue (they carry no order or unit counts). A count, not
      // the net amount, so entries that cancel out (a sale and its refund) are still visible.
      manual_entries: sum((r) => r.manual_entries),
      shopify_orders: sum((r) => r.shopify.orders),
      shopify_units: sum((r) => r.shopify.units),
      // Fees are known only where they were recorded; null when no row recorded any.
      marketplace_fees_cents: feeRows.length ? feeRows.reduce((t, r) => t + Number(r.fees_cents), 0) : null,
      fees_recorded_channels: feeRows.length,
    };
    const channels = rows.map((r) => ({
      id: `cg:channel-month:${r.channel_id}:${m}`,
      channel_id: r.channel_id, channel_name: r.channel_name ?? null, marketplace_status: r.marketplace_status ?? null,
      net_revenue_cents: Number(r.combined_cents), shopify_net_revenue_cents: Number(r.shopify.net_cents), manual_net_revenue_cents: Number(r.manual_cents),
      manual_entries: Number(r.manual_entries),
      shopify_orders: Number(r.shopify.orders), shopify_units: Number(r.shopify.units),
      marketplace_fees_cents: r.fees_cents == null ? null : Number(r.fees_cents),
    })).sort((a, b) => a.channel_id.localeCompare(b.channel_id));
    const body = { totals, channels, completeness, reasons };
    return {
      id: `cg:month:${m}`,
      revision: revisionOf(body),                  // changes whenever any figure, channel or completeness changes
      period: { start: `${m}-01`, end: monthEnd(m), granularity: "month", timezone: REPORTING_TIMEZONE },
      scope: { key: "channel:corporate", label: "Corporate gifting (all corporate channels)" },
      completeness, completeness_reasons: reasons,
      currency: "USD",
      totals, channels,
    };
  });
  return {
    ok: true, schema_version: 1, source: "sb-corporate-gifts",
    as_of: s.last_import_at ?? null,
    orders_note: "Orders and units count Shopify orders only; manual entries (see manual_entries) add revenue but not orders.",
    months: records,
    next_cursor: months.length > limit ? page[page.length - 1] : null,
  };
}

export async function pipelineReport() {
  const rows = await query(
    `select provider_type, status, count(*)::int as n from marketplaces group by 1, 2 order by 1, 2`,
  );
  const last = await one("select max(updated_at) as at from marketplaces");
  return { ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:pipeline", as_of: last?.at ?? null, counts: rows };
}

export async function handleReporting(req: Request, path: string): Promise<Response> {
  try {
    if (req.method !== "GET") return json({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
    const ok = credential(req.headers.get("authorization"));
    if (ok === "disabled") return json({ error: { code: "reporting_disabled", message: "Reporting is not configured." } }, 503);
    // Counted before the credential check, so guessing the secret is limited too.
    await hit({ bucket: `reporting:${clientKey(req)}`, ...LIMIT });
    if (!ok) return json({ error: { code: "unauthorized", message: "Invalid reporting credential." } }, 401);
    const url = new URL(req.url);
    if (path === "/reporting/v1/months") return json(await monthsReport(url.searchParams));
    if (path === "/reporting/v1/pipeline") {
      if ([...url.searchParams.keys()].length) throw new HttpError(400, "bad_query", "No parameters are accepted.");
      return json(await pipelineReport());
    }
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
