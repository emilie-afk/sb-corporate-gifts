// Routing and resolution of Corporate Gifts tasks (shared by the app, the Slack workflow and the dashboard connection).
//
// Routing by owner (owner directory = verified names and their team):
//   - one owner, an active Marketing team member      → "marketing": Marketing Dashboard draft → Task Tracker task;
//   - one owner, outside Marketing or an external partner → "checkoff": a check-off item shown in both apps;
//   - no owner, several owners, an unknown name, or a name matching several entries → "review" (a person decides).
// A route chosen by a reviewer is kept; a task already sent to Task Tracker always stays a Marketing task.
//
// Resolution (one record, both apps):
//   - No Task Tracker task (Marketing draft not sent yet, check-off item, item waiting for routing) → the shared
//     status "resolved" (delivery_status, migration 008) at once, recorded as completed; the dashboard then closes the
//     draft (it can't be sent).
//   - Marketing task in Task Tracker → "requested": the dashboard completes the linked task through Task Tracker's
//     completion rules and reports back; it shows Resolved once Task Tracker confirms.
//   - Check-off item → resolved at once.
// Repeating a resolve (double click, retry, the other app, a second Slack message) never completes anything twice:
// a resolved item keeps its first completion date and only gains evidence.
import type pg from "pg";
import { audit, type Actor } from "../audit";
import { HttpError } from "../http";
import { nameKey } from "./suppliers";

/** Dates of completions follow the weekly report calendar (Vietnam time). */
export const REPORT_TZ = "Asia/Ho_Chi_Minh";
export const reportDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const slackDate = (ts: string) => reportDate(new Date(Number(ts) * 1000));

export type Route = "marketing" | "checkoff" | "review";
export type RouteResult = { route: Route; reason: string; owner_name: string | null; owner_team: string | null };

/** Splits an owner hint ("A / B", "A and B", "A (SEO team)") into the names it contains. */
export function ownerNames(hint: string | null | undefined): string[] {
  if (!hint) return [];
  return hint.replace(/\([^)]*\)/g, " ").split(/\s*(?:\/|,|&|;|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
}

export async function routeFor(c: pg.PoolClient, hint: string | null | undefined): Promise<RouteResult> {
  const names = ownerNames(hint);
  if (names.length === 0) return { route: "review", reason: "No owner named", owner_name: null, owner_team: null };
  if (names.length > 1) return { route: "review", reason: `Several owners named (${names.join(", ")})`, owner_name: null, owner_team: null };
  const key = nameKey(names[0]);
  const owners = (await c.query("select id, name, aliases, team from corporate_owners where active")).rows;
  const hits = owners.filter((o: any) => [o.name, ...(o.aliases ?? [])].some((n: string) => nameKey(n) === key));
  if (hits.length === 0) return { route: "review", reason: `Owner not in the owner directory (${names[0]})`, owner_name: null, owner_team: null };
  if (hits.length > 1) return { route: "review", reason: `Owner name matches several people (${names[0]})`, owner_name: null, owner_team: null };
  const o = hits[0];
  return o.team === "marketing"
    ? { route: "marketing", reason: "Marketing team member", owner_name: o.name, owner_team: o.team }
    : { route: "checkoff", reason: o.team === "external" ? "External partner" : "Outside Marketing", owner_name: o.name, owner_team: o.team };
}

/** Whether a request's route may still change automatically (not decided by a person, not sent, not resolved). */
export const routeIsFree = (row: any) =>
  !row.route_decided_by && !["delivered", "sending"].includes(row.delivery_status) && !row.resolution_state;

export type Evidence = { source: "manual" | "slack" | "task_tracker"; at: string; date: string; permalink?: string; by?: string; note?: string };
const addEvidence = (row: any, e: Evidence) => {
  const list: Evidence[] = Array.isArray(row.evidence) ? row.evidence : [];
  const dup = list.some((x) => x.source === e.source && (e.permalink ? x.permalink === e.permalink : x.at === e.at));
  return dup ? list : [...list, e].slice(-50);
};

export type ResolveOutcome = "resolved" | "requested" | "already_resolved" | "already_requested" | "not_open";
/**
 * Resolves one task request. `by` is the person (signer or dashboard user). For a Slack confirmation, `completed_on`
 * is the message date unless the message gives another date; for a manual check-off it is today (report calendar).
 */
export async function resolveRequest(c: pg.PoolClient, id: string, opts: { actor: Actor; by: string; source: "manual" | "slack"; completed_on?: string | null; permalink?: string; note?: string; in?: "corporate_gifts" | "dashboard" }) {
  const row = (await c.query("select * from corporate_task_requests where id = $1 for update", [id])).rows[0];
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const now = new Date();
  const ev: Evidence = { source: opts.source, at: now.toISOString(), date: opts.completed_on ?? reportDate(now), ...(opts.permalink ? { permalink: opts.permalink } : {}), by: opts.by, ...(opts.note ? { note: opts.note.slice(0, 300) } : {}) };
  if (row.resolution_state === "resolved") {
    // Later evidence is kept; the completion date and the count stay as they are.
    const evidence = addEvidence(row, ev);
    if (evidence.length !== (row.evidence ?? []).length) await c.query("update corporate_task_requests set evidence = $2, updated_at = now() where id = $1", [id, JSON.stringify(evidence)]);
    return { outcome: "already_resolved" as ResolveOutcome, row };
  }
  if (row.delivery_status === "dismissed" || row.slack_status === "cancelled") return { outcome: "not_open" as ResolveOutcome, row };
  if (row.delivery_status === "resolved") return { outcome: "already_resolved" as ResolveOutcome, row };
  const completedOn = opts.completed_on ?? reportDate(now);
  // (A task in Task Tracker or being sent there, whatever its route: a task that exists always wins.)
  if (["delivered", "sending"].includes(row.delivery_status) && row.tracker_status !== "done") {
    // In Task Tracker (or being sent there right now): completion goes through Task Tracker (the dashboard does it
    // and confirms with a receipt). If the send then fails, no task exists and the failure receipt resolves it here.
    if (row.resolution_state === "requested") {
      await c.query("update corporate_task_requests set evidence = $2, updated_at = now() where id = $1", [id, JSON.stringify(addEvidence(row, ev))]);
      return { outcome: "already_requested" as ResolveOutcome, row };
    }
    const after = (await c.query(
      `update corporate_task_requests set resolution_state = 'requested', resolve_requested_at = now(), resolve_requested_by = $2, resolve_error = null,
         completion_source = $3, completed_on = $4, evidence = $5, updated_at = now(), version = version + 1 where id = $1 returning *`,
      [id, opts.by, opts.source, completedOn, JSON.stringify(addEvidence(row, ev))])).rows[0];
    await audit(c, opts.actor, { entityType: "corporate_task_request", entityId: id, action: "resolve_requested", after: { by: opts.by, source: opts.source, completed_on: completedOn } });
    return { outcome: "requested" as ResolveOutcome, row: after };
  }
  // Draft not sent yet, a check-off item, an item waiting for routing (no task: the shared "resolved" status), or a
  // task Task Tracker already shows done (it stays delivered).
  const done = row.tracker_status === "done";
  const noTask = !["delivered", "sending"].includes(row.delivery_status) && !row.tracker_task_id;
  const after = (await c.query(
    `update corporate_task_requests set resolution_state = 'resolved', resolved_at = now(), resolved_by = $2, completion_source = $3,
       completed_on = $4, evidence = $5, resolve_error = null,
       delivery_status = case when $6 then 'resolved' else delivery_status end, delivery_error = case when $6 then null else delivery_error end,
       resolved_in = case when $6 then $7 else resolved_in end,
       updated_at = now(), version = version + 1, content_version = content_version + 1 where id = $1 returning *`,
    [id, opts.by, opts.source, done && row.completed_on ? row.completed_on : completedOn, JSON.stringify(addEvidence(row, ev)), noTask, opts.in ?? "corporate_gifts"])).rows[0];
  await audit(c, opts.actor, { entityType: "corporate_task_request", entityId: id, action: "resolve", after: { by: opts.by, source: opts.source, completed_on: completedOn, route: row.route } });
  return { outcome: "resolved" as ResolveOutcome, row: after };
}

export type ClaimOutcome = "claimed" | "stale" | "rerouted" | "resolved" | "closed" | "not_found";
/**
 * The dashboard claims a Marketing request right before it creates the Task Tracker task, with the content version
 * its draft was built from. Only a current, open, Marketing-routed request can be claimed; a request resolved,
 * rerouted, dismissed or changed in Corporate Gifts since the dashboard last read it is refused, so a stale draft
 * never creates a task. A repeat claim (retry of an unanswered send) is accepted.
 */
export async function claimForDelivery(c: pg.PoolClient, id: string, contentVersion: number, actor: Actor): Promise<{ outcome: ClaimOutcome; message?: string }> {
  const row = (await c.query("select * from corporate_task_requests where id = $1 for update", [id])).rows[0];
  if (!row) return { outcome: "not_found", message: "Not found in Corporate Gifts." };
  if (row.delivery_status === "delivered" || row.delivery_status === "sending") return { outcome: "claimed" };
  if (row.resolution_state) return { outcome: "resolved", message: "Resolved in Corporate Gifts; it is not sent." };
  if (row.route !== "marketing") return { outcome: "rerouted", message: row.route === "checkoff" ? "Now a check-off item in Corporate Gifts; it is not sent." : "Waiting for a routing decision in Corporate Gifts; it is not sent." };
  if (row.delivery_status === "dismissed" || row.slack_status !== "open") return { outcome: "closed", message: "Dismissed or closed in Corporate Gifts; it is not sent." };
  if (row.content_version !== contentVersion) return { outcome: "stale", message: "Changed in Corporate Gifts since the last refresh. Refresh, check it, then send again." };
  await c.query("update corporate_task_requests set delivery_status = 'sending', delivery_error = null, receipt_at = now(), updated_at = now() where id = $1", [id]);
  await audit(c, actor, { entityType: "corporate_task_request", entityId: id, action: "claimed_for_delivery", before: { delivery_status: row.delivery_status }, after: { delivery_status: "sending", content_version: contentVersion } });
  return { outcome: "claimed" };
}

export type ReleaseOutcome = "released" | "resolved" | "not_claimed" | "delivered" | "not_found";
/**
 * The dashboard releases a claim whose answer it never received, when it knows the Task Tracker task was never
 * started (it does not call Task Tracker without a confirmed claim). The request goes back to "in review"; if a
 * Resolve was asked for meanwhile, it is resolved now (no task exists). Repeats are harmless.
 */
export async function releaseClaim(c: pg.PoolClient, id: string, actor: Actor): Promise<{ outcome: ReleaseOutcome }> {
  const row = (await c.query("select * from corporate_task_requests where id = $1 for update", [id])).rows[0];
  if (!row) return { outcome: "not_found" };
  if (row.delivery_status === "delivered" || row.tracker_task_id) return { outcome: "delivered" };
  if (row.delivery_status !== "sending") return { outcome: "not_claimed" };
  if (row.resolution_state === "requested") {
    // No task was started: the shared "resolved" status.
    await c.query(`update corporate_task_requests set delivery_status = 'resolved', resolution_state = 'resolved', resolved_at = now(),
                     resolved_by = coalesce(resolve_requested_by, 'Marketing Dashboard'), resolved_in = 'dashboard', receipt_at = now(), updated_at = now(), version = version + 1 where id = $1`, [id]);
    await audit(c, actor, { entityType: "corporate_task_request", entityId: id, action: "claim_released_resolved", after: { completed_on: row.completed_on } });
    return { outcome: "resolved" };
  }
  await c.query("update corporate_task_requests set delivery_status = 'in_review', receipt_at = now(), updated_at = now() where id = $1", [id]);
  await audit(c, actor, { entityType: "corporate_task_request", entityId: id, action: "claim_released", before: { delivery_status: "sending" }, after: { delivery_status: "in_review" } });
  return { outcome: "released" };
}

/** A reviewer's routing decision ("Assign as Marketing task" / "Track as check-off"). */
export async function decideRoute(c: pg.PoolClient, id: string, route: "marketing" | "checkoff", opts: { actor: Actor; by: string; version?: number }) {
  const row = (await c.query("select * from corporate_task_requests where id = $1 for update", [id])).rows[0];
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  if (opts.version !== undefined && row.version !== opts.version) throw new HttpError(409, "conflict", "This task changed since you opened it. Reload and try again.");
  if (row.delivery_status === "delivered") throw new HttpError(409, "delivered", "This task is already in Task Tracker; it stays a Marketing task.");
  if (row.delivery_status === "sending") throw new HttpError(409, "sending", "This task is being sent to Task Tracker; it stays a Marketing task.");
  if (row.resolution_state) throw new HttpError(409, "resolved", "This task is already resolved.");
  if (row.route === route && row.route_decided_by) return row;
  const after = (await c.query(
    `update corporate_task_requests set route = $2, route_reason = $3, route_decided_by = $4, content_version = content_version + 1,
       updated_at = now(), version = version + 1 where id = $1 returning *`,
    [id, route, route === "marketing" ? "Assigned as a Marketing task" : "Tracked as a check-off item", opts.by])).rows[0];
  await audit(c, opts.actor, { entityType: "corporate_task_request", entityId: id, action: "route", before: { route: row.route }, after: { route, by: opts.by } });
  return after;
}
