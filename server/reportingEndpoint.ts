// Reporting API for the Marketing Dashboard's server (read-only except delivery receipts for Corporate Gifts tasks). Protected by its own private secret
// (CORPORATE_REPORTING_SECRET), never by the Google login, and separate from the collector's ingest secret.
//
//   GET /api/reporting/v1/months?from=YYYY-MM&to=YYYY-MM&cursor=YYYY-MM&limit=1..24
//       Monthly corporate revenue, one record per month (all corporate channels) with a per-channel breakdown.
//       Figures are exactly the Revenue page's summary (revenueSummary), so both always agree.
//   GET /api/reporting/v1/pipeline
//       Marketplace counts by status and provider type, as of now.
//   GET /api/reporting/v1/sample-signups
//       All-time count of corporate sample box signups (count only; the signup rows stay in Google Sheets).
//   GET /api/reporting/v1/corporate-workflow
//       Sample box progress (tracked requests by latest status), open and overdue follow-ups, and up to 8 recent
//       decisions and blockers as one-line summaries. No supplier files, quotes, terms, contacts or Slack messages.
//   GET /api/reporting/v1/corporate-tasks[?since=<ISO time>]
//       Corporate Gifts task requests the dashboard must deliver to Task Tracker (or update there): title, brief,
//       owner hint, due date, partner names with their Corporate Gifts links. Never Slack links or terms.
//   POST /api/reporting/v1/corporate-task-receipts
//       The only write on this connection: the dashboard reports what happened to each request (in review,
//       delivered with the Task Tracker task id, failed, dismissed, resolved). Nothing else can be changed through it.
//       "resolved" (handled without a task) is shared with the dashboard: the feed lists requests resolved here and
//       advertises capabilities: ["resolved"], so the dashboard sends "resolved" only once this build accepts it.
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
import { sampleSignupsReport } from "./lib/sampleSignups";
import { tx } from "./db";
import { audit } from "./audit";
import { readBounded } from "./body";
import { z } from "zod";

export const REPORTING_TIMEZONE = "America/Los_Angeles";
export const MONTHS_PAGE_MAX = 24;
const LIMIT = { limit: 120, windowSec: 3600 };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function credential(header: string | null) {
  const secret = process.env.CORPORATE_REPORTING_SECRET ?? "";
  if (secret.length < 32) return "disabled" as const;
  // Separate from every other credential: equal to one of them counts as not configured.
  if ([process.env.CORPORATE_INGEST_SECRET, process.env.CORPORATE_SLACK_INGEST_SECRET, process.env.SESSION_SECRET, process.env.GOOGLE_CLIENT_SECRET].includes(secret)) return "disabled" as const;
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

/**
 * Counting rules (also shown on the dashboard):
 *  - sample progress: each tracked sample request once, under its latest confirmed status;
 *  - follow-ups: open actions (kind "action"); overdue = open with an explicit due date before today (Los Angeles);
 *  - recent: decisions and blockers created or changed in the last 30 days, newest first, title only (max 120 chars).
 * Google Form signups are a separate count (sample-signups) and are never changed by this data.
 */
export async function workflowReport(now = new Date()) {
  const today = businessToday(now);
  const samples = await query(`select status, count(*)::int as n from sample_requests group by status`);
  const by: Record<string, number> = { requested: 0, approved: 0, shipped: 0, delivered: 0, cancelled: 0 };
  for (const r of samples) by[r.status] = r.n;
  // Open work = open Corporate Gifts tasks (requests not dismissed and not completed in Task Tracker) + open manual
  // actions. Overdue = open with an explicit due date (Task Tracker's, once delivered) before today (Los Angeles).
  const fu = await one(
    `select (select count(*) from corporate_actions where kind = 'action' and status = 'open' and excluded_at is null)
            + (select count(*) from corporate_task_requests where slack_status = 'open' and delivery_status not in ('dismissed', 'resolved') and coalesce(tracker_status, 'open') = 'open') as open,
            (select count(*) from corporate_actions where kind = 'action' and status = 'open' and excluded_at is null and due_date < $1::date)
            + (select count(*) from corporate_task_requests where slack_status = 'open' and delivery_status not in ('dismissed', 'resolved') and coalesce(tracker_status, 'open') = 'open'
                 and coalesce(tracker_due_date, due_date) < $1::date) as overdue`, [today]);
  const recent = await query(
    `select * from (
       select 'action:' || a.id as rid, a.kind, left(a.title, 120) as title, greatest(a.created_at, a.updated_at) as at, a.status, m.name as supplier_name
       from corporate_actions a left join marketplaces m on m.id = a.marketplace_id
       where a.kind in ('decision', 'blocker') and a.excluded_at is null
       union all
       select 'resource:' || r.id, 'decision', left(r.title, 120), greatest(r.created_at, r.updated_at), 'done', m.name
       from supplier_resources r join marketplaces m on m.id = r.marketplace_id
       where r.resource_type = 'decision' and r.removed_at is null and r.excluded_at is null and r.status = 'current'
     ) x where at >= $1::timestamptz - interval '30 days' order by at desc limit 8`, [now.toISOString()]);
  const last = await one(`select max(t) as at from (select max(updated_at) as t from sample_requests union all select max(updated_at) from corporate_actions
    union all select max(updated_at) from corporate_task_requests union all select max(updated_at) from supplier_resources) x`);
  return {
    ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:corporate-workflow", as_of: last?.at ?? null, today,
    sample_progress: { tracked: Object.values(by).reduce((a, b) => a + b, 0), by_status: by },
    follow_ups: { open: Number(fu?.open ?? 0), overdue: Number(fu?.overdue ?? 0) },
    recent: recent.map((r: any) => ({ id: `cg:${r.rid}`, kind: r.kind, title: r.title, supplier: r.supplier_name ?? null, at: r.at, status: r.status })),
  };
}

// ------------------------------------------------------------- Corporate Gifts tasks
const appUrl = () => (process.env.APP_BASE_URL ?? "https://sb-corporate-gifts.netlify.app").replace(/\/$/, "");

/** Requests the dashboard still has to deliver or update, plus anything changed since `since` (to drop drafts). */
export async function corporateTasksReport(params: URLSearchParams) {
  const keys = [...params.keys()];
  if (keys.some((k) => k !== "since")) throw new HttpError(400, "bad_query", "Only since is accepted.");
  const sinceRaw = params.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (sinceRaw && (Number.isNaN(since!.getTime()) || sinceRaw.length > 40)) throw new HttpError(400, "bad_query", "since must be an ISO time.");
  const rows = await query(
    `select t.id, t.title, t.brief, t.owner_hint, t.due_date, t.slack_status, t.content_version, t.delivery_status, t.delivered_version,
            t.tracker_task_id, t.updated_at,
            (select json_agg(json_build_object('id', m.id, 'name', m.name) order by m.name) from marketplaces m where m.id = any(t.marketplace_ids)) as partners
     from corporate_task_requests t
     where t.delivery_status in ('pending', 'in_review', 'failed')
        or (t.delivery_status = 'delivered' and t.content_version > coalesce(t.delivered_version, 0))
        or ($1::timestamptz is not null and t.updated_at > $1::timestamptz)
     order by t.updated_at limit 200`, [since]);
  const as_of = (await one("select now() as at"))!.at;
  return {
    ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:corporate-tasks", as_of, capabilities: ["resolved"],
    tasks: rows.map((r: any) => ({
      id: r.id, title: r.title, brief: r.brief, owner_hint: r.owner_hint,
      due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
      slack_status: r.slack_status, content_version: r.content_version, delivery_status: r.delivery_status,
      delivered_version: r.delivered_version, tracker_task_id: r.tracker_task_id, updated_at: r.updated_at,
      partners: (r.partners ?? []).map((p: any) => ({ name: p.name, url: `${appUrl()}/?tab=marketplaces&m=${p.id}` })),
    })),
  };
}

const receiptSchema = z.object({
  receipts: z.array(z.object({
    id: z.string().uuid(),
    content_version: z.number().int().min(1),
    state: z.enum(["in_review", "delivered", "failed", "dismissed", "resolved"]),
    tracker: z.object({
      task_id: z.string().min(1).max(80),
      status: z.enum(["open", "done", "deleted"]),
      assignee: z.string().max(120).nullable().optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      // https only (http is accepted for a local Task Tracker during development).
      open_url: z.string().url().max(500).refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), "https only").nullable().optional(),
    }).strict().optional(),
    error: z.string().max(500).optional(),
  }).strict()).min(1).max(100),
}).strict();

const DASHBOARD = { signer: "Marketing Dashboard", sub: null };

/** Applies delivery receipts. "delivered" requires Task Tracker's task id; a delivered request is never downgraded. */
export async function applyTaskReceipts(input: unknown) {
  const r = receiptSchema.safeParse(input);
  if (!r.success) throw new HttpError(400, "payload_rejected", r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const out = { applied: 0, ignored: 0, unknown: 0 };
  await tx(async (c) => {
    for (const x of r.data.receipts) {
      const row = (await c.query("select * from corporate_task_requests where id = $1 for update", [x.id])).rows[0];
      if (!row) { out.unknown++; continue; }
      if (x.state === "delivered") {
        if (!x.tracker) throw new HttpError(400, "payload_rejected", `receipts: ${x.id} delivered without a Task Tracker task`);
        const version = Math.min(x.content_version, row.content_version);
        await c.query(
          `update corporate_task_requests set delivery_status = 'delivered', delivery_error = null, delivered_version = greatest(coalesce(delivered_version, 0), $2),
             tracker_task_id = $3, tracker_status = $4, tracker_assignee = $5, tracker_due_date = $6, tracker_open_url = $7,
             delivered_at = coalesce(delivered_at, now()), receipt_at = now(), updated_at = now() where id = $1`,
          [x.id, version, x.tracker.task_id, x.tracker.status, x.tracker.assignee ?? null, x.tracker.due_date ?? null, x.tracker.open_url ?? null]);
        if (row.delivery_status !== "delivered" || row.tracker_status !== x.tracker.status) {
          await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "delivery_receipt",
            before: { delivery_status: row.delivery_status, tracker_status: row.tracker_status }, after: { delivery_status: "delivered", tracker_task_id: x.tracker.task_id, tracker_status: x.tracker.status } });
        }
        out.applied++;
        continue;
      }
      // Not delivered (yet): never overrides a delivered request; a dismissal or a resolution is final (a repeated or
      // stale receipt never reopens it).
      if (["delivered", "dismissed", "resolved"].includes(row.delivery_status)) { out.ignored++; continue; }
      if (x.state === "resolved") {
        // Resolved in the dashboard: same request, no task. Bumps the version so a form opened before it can't act on it.
        await c.query(`update corporate_task_requests set delivery_status = 'resolved', delivery_error = null, resolved_at = now(), resolved_by = $2, resolved_in = 'dashboard',
                         receipt_at = now(), updated_at = now(), version = version + 1 where id = $1`, [x.id, DASHBOARD.signer]);
        await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "resolve", before: { delivery_status: row.delivery_status }, after: { delivery_status: "resolved", resolved_in: "dashboard" } });
        out.applied++;
        continue;
      }
      if (x.state === "in_review" && row.delivery_status !== "pending") { out.ignored++; continue; }
      await c.query(`update corporate_task_requests set delivery_status = $2, delivery_error = $3, receipt_at = now(), updated_at = now() where id = $1`,
        [x.id, x.state, x.state === "failed" ? (x.error ?? "Delivery failed.") : null]);
      await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "delivery_receipt", before: { delivery_status: row.delivery_status }, after: { delivery_status: x.state, error: x.error ?? null } });
      out.applied++;
    }
  });
  return { ok: true, ...out };
}

export async function handleReporting(req: Request, path: string): Promise<Response> {
  try {
    const receipts = path === "/reporting/v1/corporate-task-receipts";
    if (req.method !== (receipts ? "POST" : "GET")) return json({ error: { code: "method_not_allowed", message: receipts ? "POST only" : "GET only" } }, 405);
    const ok = credential(req.headers.get("authorization"));
    if (ok === "disabled") return json({ error: { code: "reporting_disabled", message: "Reporting is not configured." } }, 503);
    // Counted before the credential check, so guessing the secret is limited too.
    await hit({ bucket: `reporting:${clientKey(req)}`, ...LIMIT });
    if (!ok) return json({ error: { code: "unauthorized", message: "Invalid reporting credential." } }, 401);
    const url = new URL(req.url);
    if (receipts) {
      if ([...url.searchParams.keys()].length) throw new HttpError(400, "bad_query", "No parameters are accepted.");
      if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json({ error: { code: "unsupported_media_type", message: "Send application/json." } }, 415);
      let body: unknown;
      try { body = JSON.parse(await readBounded(req, 256 * 1024)); } catch (e: any) {
        if (e?.status === 413) return json({ error: { code: "too_large", message: "Payload too large." } }, 413);
        return json({ error: { code: "invalid_json", message: "Body is not JSON." } }, 400);
      }
      return json(await applyTaskReceipts(body));
    }
    if (path === "/reporting/v1/corporate-tasks") return json(await corporateTasksReport(url.searchParams));
    if (path === "/reporting/v1/months") return json(await monthsReport(url.searchParams));
    if (path === "/reporting/v1/sample-signups") {
      if ([...url.searchParams.keys()].length) throw new HttpError(400, "bad_query", "No parameters are accepted.");
      return json(await sampleSignupsReport());
    }
    if (path === "/reporting/v1/corporate-workflow") {
      if ([...url.searchParams.keys()].length) throw new HttpError(400, "bad_query", "No parameters are accepted.");
      return json(await workflowReport());
    }
    if (path === "/reporting/v1/pipeline") {
      if ([...url.searchParams.keys()].length) throw new HttpError(400, "bad_query", "No parameters are accepted.");
      return json(await pipelineReport());
    }
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
