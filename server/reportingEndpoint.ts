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
//   GET /api/reporting/v1/corporate-checkoffs[?after=<cursor time>&after_id=<id>&limit=1..200]
//       Every task request changed after the cursor (paged by updated_at and id), with its route and whether it
//       belongs on the check-off list, for the dashboard's Corporate Gifts view and weekly report: action,
//       marketplaces, owner, due date, state and completion date. Never Slack links or message text.
//   POST /api/reporting/v1/corporate-task-receipts
//       The dashboard reports what happened to each Marketing request (in review, delivered with the Task Tracker
//       task id and its status, failed, dismissed, resolved). "resolved" (handled without a task) is the status shared
//       with the dashboard since migration 008; the feed advertises capabilities: ["resolved", "routing"] ("routing":
//       feed v=2, task actions and claims, the check-off feed, and the completion fields on receipts).
//   POST /api/reporting/v1/corporate-task-actions
//       Resolve / Mark done and routing decisions made in the dashboard, on the same records (with the person's name),
//       the claim the dashboard makes right before it creates a Task Tracker task (refused when stale), and the
//       release of a claim whose answer was lost before any Task Tracker task was started.
//   These two POST routes are the only writes on this connection; nothing else can be changed through it.
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
import { resolveRequest, decideRoute, reportDate, claimForDelivery, releaseClaim, resolutionOf, RESOLUTION_SQL } from "./lib/taskRouting";

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
  if (keys.some((k) => !["since", "v"].includes(k))) throw new HttpError(400, "bad_query", "Only since and v are accepted.");
  // v=2: the dashboard that routes, claims and resolves (route, resolution, "sending", every route). Without it the
  // feed stays as before (Marketing requests only; "sending" reads as "in review"), so an earlier dashboard build keeps
  // working while the two apps are deployed one after the other (closed requests of any route are still listed to a
  // read with since, so a draft it holds is closed).
  const v2 = params.get("v") === "2";
  const sinceRaw = params.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (sinceRaw && (Number.isNaN(since!.getTime()) || sinceRaw.length > 40)) throw new HttpError(400, "bad_query", "since must be an ISO time.");
  const rows = await query(
    `select t.id, t.title, t.brief, t.owner_hint, t.due_date, t.slack_status, t.content_version, t.delivery_status, t.delivered_version,
            t.tracker_task_id, t.updated_at, t.route, ${RESOLUTION_SQL()} as resolution_state, to_char(t.completed_on, 'YYYY-MM-DD') as completed_on, t.completion_source,
            t.resolved_by, t.resolved_in, t.resolve_requested_by,
            (select json_agg(json_build_object('id', m.id, 'name', m.name) order by m.name) from marketplaces m where m.id = any(t.marketplace_ids)) as partners
     from corporate_task_requests t
     where ($2 or t.route = 'marketing' or t.delivery_status in ('resolved', 'dismissed')) and (
           (t.delivery_status in ('pending', 'in_review', 'failed') and t.route = 'marketing')
        or (t.delivery_status = 'delivered' and t.content_version > coalesce(t.delivered_version, 0))
        or ($2 and ${RESOLUTION_SQL()} = 'requested')
        or ($1::timestamptz is not null and t.updated_at > $1::timestamptz))
     order by t.updated_at limit 200`, [since, v2]);
  const as_of = (await one("select now() as at"))!.at;
  return {
    ok: true, schema_version: 1, source: "sb-corporate-gifts", id: "cg:corporate-tasks", as_of, capabilities: ["resolved", "routing"],
    tasks: rows.map((r: any) => ({
      id: r.id, title: r.title, brief: r.brief, owner_hint: r.owner_hint,
      due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
      slack_status: r.slack_status, content_version: r.content_version, delivery_status: !v2 && r.delivery_status === "sending" ? "in_review" : r.delivery_status,
      delivered_version: r.delivered_version, tracker_task_id: r.tracker_task_id, updated_at: r.updated_at,
      route: r.route, resolution: r.resolution_state ? { state: r.resolution_state, completed_on: r.completed_on, source: r.completion_source, by: r.resolved_by ?? r.resolve_requested_by, in: r.resolved_in } : null,
      partners: (r.partners ?? []).map((p: any) => ({ name: p.name, url: `${appUrl()}/?tab=marketplaces&m=${p.id}` })),
    })),
  };
}

/**
 * Feed of Corporate Gifts task requests for the dashboard's check-off list and weekly report: EVERY request whose
 * record changed after the cursor, whatever its route, so the dashboard also learns when an item leaves the
 * check-off list (routed to Marketing). Ordered and paged by (updated_at, id); `next` is the cursor of the last row.
 * The dashboard re-reads a short overlap before its stored cursor, so a row committed late is never skipped.
 */
export const FEED_PAGE = 200;
export async function checkoffsReport(params: URLSearchParams) {
  const keys = [...params.keys()];
  if (keys.some((k) => !["after", "after_id", "limit"].includes(k))) throw new HttpError(400, "bad_query", "Only after, after_id and limit are accepted.");
  const after = params.get("after"), afterId = params.get("after_id");
  if (after && (after.length > 40 || Number.isNaN(Date.parse(after)))) throw new HttpError(400, "bad_query", "after must be an ISO time.");
  if (afterId && !/^[0-9a-f-]{36}$/.test(afterId)) throw new HttpError(400, "bad_query", "after_id must be a record id.");
  if (!!after !== !!afterId) throw new HttpError(400, "bad_query", "Send after and after_id together.");
  const limit = Math.min(Math.max(Number(params.get("limit") ?? FEED_PAGE) || FEED_PAGE, 1), FEED_PAGE);
  const rows = await query(
    `select t.id, t.title, t.route, t.route_reason, t.owner_name, t.owner_hint, t.owner_team, t.due_date, t.slack_status, t.delivery_status, ${RESOLUTION_SQL()} as resolution_state,
            to_char(t.completed_on, 'YYYY-MM-DD') as completed_on, t.completion_source, t.resolved_by, t.resolved_at, t.version,
            to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
            jsonb_array_length(t.evidence) as evidence_count,
            (select json_agg(json_build_object('id', m.id, 'name', m.name) order by m.name) from marketplaces m where m.id = any(t.marketplace_ids)) as partners
     from corporate_task_requests t
     where ($1::timestamptz is null or (t.updated_at, t.id) > ($1::timestamptz, $2::uuid))
     order by t.updated_at, t.id limit $3`, [after, afterId, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    ok: true, schema_version: 2, source: "sb-corporate-gifts", id: "cg:corporate-checkoffs", today: reportDate(),
    has_more: rows.length > limit, next: last ? { after: last.cursor_at, after_id: last.id } : null,
    items: page.map((r: any) => ({
      id: r.id, title: r.title, route: r.route, route_reason: r.route_reason, owner: r.owner_name ?? r.owner_hint ?? null, owner_team: r.owner_team,
      due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
      state: r.resolution_state === "resolved" ? "done" : r.delivery_status === "dismissed" || r.slack_status === "cancelled" ? "closed" : "open",
      // Whether the item belongs on the check-off list: check-off or routing items, and Marketing items resolved
      // without a task (they never reached Task Tracker). Everything else must leave the list.
      listed: r.route !== "marketing" || r.delivery_status === "resolved",
      completed_on: r.completed_on, completion_source: r.completion_source, resolved_by: r.resolved_by, resolved_at: r.resolved_at,
      evidence_count: Number(r.evidence_count ?? 0), version: r.version, updated_at: r.cursor_at,
      partners: (r.partners ?? []).map((p: any) => ({ name: p.name, url: `${appUrl()}/?tab=marketplaces&m=${p.id}` })),
    })),
  };
}

const actionSchema = z.object({
  actions: z.array(z.object({
    id: z.string().uuid(),
    action: z.enum(["resolve", "route", "claim", "release"]),
    route: z.enum(["marketing", "checkoff"]).optional(),
    content_version: z.number().int().min(1).optional(),     // claim: the version the dashboard's draft was built from
    by: z.string().trim().min(1).max(120),
    completed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    version: z.number().int().min(1).optional(),
  }).strict()).min(1).max(100),
}).strict();

/** Resolve and routing decisions made in the dashboard. Each action on its own: one failure leaves the others applied. */
export async function applyTaskActions(input: unknown) {
  const r = actionSchema.safeParse(input);
  if (!r.success) throw new HttpError(400, "payload_rejected", r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const results: { id: string; outcome: string; message?: string; state?: string; completed_on?: string | null }[] = [];
  for (const x of r.data.actions) {
    const actor = { signer: `${x.by} (Marketing Dashboard)`.slice(0, 120), sub: null };
    try {
      if (x.action === "release") {
        const out = await tx((c) => releaseClaim(c, x.id, actor));
        results.push({ id: x.id, outcome: out.outcome });
      } else if (x.action === "claim") {
        if (!x.content_version) throw new HttpError(400, "payload_rejected", "content_version is required");
        const out = await tx((c) => claimForDelivery(c, x.id, x.content_version!, actor));
        results.push({ id: x.id, outcome: out.outcome, ...(out.message ? { message: out.message } : {}) });
      } else if (x.action === "route") {
        if (!x.route) throw new HttpError(400, "payload_rejected", "route is required");
        await tx((c) => decideRoute(c, x.id, x.route!, { actor, by: actor.signer, version: x.version }));
        results.push({ id: x.id, outcome: "routed" });
      } else {
        if (x.completed_on && x.completed_on > reportDate()) throw new HttpError(400, "payload_rejected", "completed_on is in the future");
        const out = await tx((c) => resolveRequest(c, x.id, { actor, by: x.by, source: "manual", in: "dashboard", completed_on: x.completed_on ?? null }));
        results.push({ id: x.id, outcome: out.outcome, state: resolutionOf(out.row) ?? undefined, completed_on: out.row.completed_on ? new Date(out.row.completed_on).toISOString().slice(0, 10) : null });
      }
    } catch (e: any) {
      results.push({ id: x.id, outcome: "failed", message: e instanceof HttpError ? e.message : "Could not be applied." });
    }
  }
  return { ok: true, results };
}

const receiptSchema = z.object({
  receipts: z.array(z.object({
    id: z.string().uuid(),
    content_version: z.number().int().min(1),
    state: z.enum(["in_review", "delivered", "failed", "dismissed", "resolved"]),
    // For "resolved" (a draft closed in the dashboard without a task): who and when. Optional: an earlier dashboard
    // build sends "resolved" without them (then it is "Marketing Dashboard", today).
    resolved_by: z.string().trim().min(1).max(120).optional(),
    completed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // A resolve that Task Tracker refused (the task stays open there); shown in both apps for a retry.
    resolve_error: z.string().max(500).optional(),
    tracker: z.object({
      task_id: z.string().min(1).max(80),
      status: z.enum(["open", "done", "deleted"]),
      completed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
             delivered_at = coalesce(delivered_at, now()), route = 'marketing', receipt_at = now(), updated_at = now() where id = $1`,
          [x.id, version, x.tracker.task_id, x.tracker.status, x.tracker.assignee ?? null, x.tracker.due_date ?? null, x.tracker.open_url ?? null]);
        // Resolved while the dashboard's send was in flight: the task exists and wins. The resolution becomes a
        // resolve request, so the dashboard completes that task in Task Tracker (resolved_at stays as history).
        if (row.delivery_status === "resolved" && x.tracker.status !== "done" && !row.resolve_requested_at) {
          await c.query(`update corporate_task_requests set resolve_requested_at = coalesce(resolved_at, now()), resolve_requested_by = resolved_by,
                           resolve_requested_in = case when resolved_in in ('corporate_gifts', 'dashboard') then resolved_in end, updated_at = now() where id = $1`, [x.id]);
          await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "resolve_requested", after: { reason: "task already existed" } });
        }
        if (row.delivery_status !== "delivered" || row.tracker_status !== x.tracker.status) {
          await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "delivery_receipt",
            before: { delivery_status: row.delivery_status, tracker_status: row.tracker_status }, after: { delivery_status: "delivered", tracker_task_id: x.tracker.task_id, tracker_status: x.tracker.status } });
        }
        // Done in Task Tracker (after Resolve in either app, or completed there): Resolved here, once. A requested
        // resolve keeps its own date and source; a task completed directly in Task Tracker uses Task Tracker's date.
        // (An earlier resolved_at on a delivered task is the history of a resolve made while the task existed.)
        if (x.tracker.status === "done" && row.tracker_status !== "done") {
          const requested = resolutionOf(row) === "requested";
          const on = requested && row.completed_on ? new Date(row.completed_on).toISOString().slice(0, 10) : x.tracker.completed_on ?? reportDate();
          await c.query(`update corporate_task_requests set resolved_at = now(), resolved_by = case when $4 then coalesce(resolve_requested_by, 'Marketing Dashboard') else 'Task Tracker' end,
                           resolved_in = case when $4 then coalesce(resolve_requested_in, 'dashboard') else 'task_tracker' end,
                           completed_on = $2, completion_source = case when $4 then coalesce(completion_source, 'manual') else 'manual' end, resolve_error = null, evidence = evidence || $3::jsonb where id = $1`,
            [x.id, on, JSON.stringify([{ source: "task_tracker", at: new Date().toISOString(), date: on }]), requested]);
          await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "resolved_in_tracker", after: { completed_on: on } });
        } else if (resolutionOf(row) === "requested" && x.resolve_error) {
          await c.query("update corporate_task_requests set resolve_error = $2 where id = $1", [x.id, x.resolve_error]);
        }
        out.applied++;
        continue;
      }
      // Not delivered (yet): never overrides a delivered request; a dismissal or a resolution is final (a repeated or
      // stale receipt never reopens it).
      if (["delivered", "dismissed", "resolved"].includes(row.delivery_status)) { out.ignored++; continue; }
      if (x.state === "resolved") {
        // Resolved in the dashboard, handled without a task (same request). A claimed request ("sending") is not
        // resolved by a receipt: its send settles first.
        if (row.delivery_status === "sending") { out.ignored++; continue; }
        const res = await resolveRequest(c, x.id, { actor: DASHBOARD, by: x.resolved_by ?? "Marketing Dashboard", source: "manual", in: "dashboard", completed_on: x.completed_on ?? null });
        if (res.outcome === "resolved") out.applied++; else out.ignored++;
        continue;
      }
      // Resolve was asked for while the task was being sent, and the send failed: no task exists, so it is resolved here.
      if (x.state === "failed" && resolutionOf(row) === "requested") {
        await c.query(`update corporate_task_requests set delivery_status = 'resolved', delivery_error = $2, resolved_at = now(),
                         resolved_by = coalesce(resolve_requested_by, 'Marketing Dashboard'), resolved_in = coalesce(resolve_requested_in, 'dashboard'),
                         receipt_at = now(), updated_at = now(), version = version + 1 where id = $1`, [x.id, x.error ?? "Delivery failed."]);
        await audit(c, DASHBOARD, { entityType: "corporate_task_request", entityId: x.id, action: "resolved_after_failed_send", after: { completed_on: row.completed_on } });
        out.applied++;
        continue;
      }
      if (x.state === "in_review" && row.delivery_status !== "pending") { out.ignored++; continue; }
      // A claimed request ("sending") settles only with delivered or failed.
      if (row.delivery_status === "sending" && x.state !== "failed") { out.ignored++; continue; }
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
    const actions = path === "/reporting/v1/corporate-task-actions";
    const receipts = path === "/reporting/v1/corporate-task-receipts" || actions;
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
      return json(actions ? await applyTaskActions(body) : await applyTaskReceipts(body));
    }
    if (path === "/reporting/v1/corporate-checkoffs") return json(await checkoffsReport(url.searchParams));
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
