// Slack-to-Corporate Gifts workflow (format sbcg-slack-v2): applies one scan pass of one channel (#seo or #teammarketing).
//
// Scope: only Marketplaces records that sell, or are being pursued to sell, our corporate gifts (sales role
// confirmed). Product-supplier discussion, companies outside Marketplaces and general discussion are skipped before
// anything is written; a Slack mention never creates a partner. The same eligibility check runs here for every
// route (app import and the optional script route), not only in the scanner.
//
// Each finding becomes exactly one of:
//   - status   → the partner's relationship status and/or application status/date (latest confirmed evidence wins);
//   - resource → a fact, document, term or decision under the partner's Resources (with source link and date);
//   - task     → a Corporate Gifts task request for one partner or a named group of partners; the Marketing
//                Dashboard delivers it to Task Tracker (Marketing Tasks) and reports back;
//   - conflict → a review item, only when competing values block one specific field change.
// Everything is applied in ONE transaction. Stable keys make a rescan, an edit or the other channel update the same
// record; older evidence read later never overwrites newer evidence. The channel's scan position advances only when
// the pass is saved. A preview (dry run) computes the same changes and rolls back.
import { createHash } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { tx, getPool } from "../db";
import { audit, type Actor } from "../audit";
import { HttpError } from "../http";
import { STATUSES, INACTIVE_STATUSES, INACTIVE_REASONS } from "../routes/marketplaces";
import { createResource, supersede } from "../routes/suppliers";
import { RESOURCE_TYPES, RESOURCE_TYPE_KEYS, matchEligiblePartner, nameKey } from "./suppliers";

export const SLACK_SCHEMA = "sbcg-slack-v2";
export const CHANNELS = ["seo", "teammarketing"] as const;
export const APPLICATION_STATUSES = ["not_applied", "preparing", "submitted", "under_review", "approved", "rejected", "withdrawn"] as const;
export const CONFLICT_FIELDS = ["relationship_status", "application_status", "application_date"] as const;
const WORKFLOW: Actor = { signer: "Slack workflow", sub: null };

const TS = z.string().regex(/^\d{9,11}\.\d{1,6}$/, "Slack ts");
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Invalid date");
const httpUrl = z.string().max(2000).refine((v) => { try { return ["https:", "http:"].includes(new URL(v).protocol); } catch { return false; } }, "http(s) URL");
const slackLink = z.string().max(500).refine((v) => { try { const u = new URL(v); return u.protocol === "https:" && /(^|\.)slack\.com$/.test(u.hostname); } catch { return false; } }, "Slack https link");
const shortText = (max: number) => z.string().trim().min(1).max(max);
const KEY = z.string().regex(/^[a-z0-9][a-z0-9:._-]{2,119}$/, "lowercase key");

const source = z.object({
  channel: z.enum(CHANNELS),
  ts: TS,
  thread_ts: TS.nullable().optional(),
  permalink: slackLink,
  date: YMD.optional(),
}).strict();
const partnerRef = z.object({ id: z.string().uuid().optional(), names: z.array(shortText(120)).max(5).optional() }).strict()
  .refine((p) => !!p.id || (p.names?.length ?? 0) > 0, "A partner needs its record id or at least one name");

const base = {
  key: KEY,
  certainty: z.enum(["confirmed", "tentative", "conflicting", "ambiguous"]),
  // Which of the company's roles the finding is about. Supplier-role findings are always skipped.
  role: z.enum(["selling", "supplier"]),
  title: shortText(200),
  summary: z.string().trim().max(2000).optional(),
  occurred_on: YMD.optional(),
  sources: z.array(source).min(1).max(20),
};
const statusFinding = z.object({
  ...base, type: z.literal("status"), partner: partnerRef,
  relationship_status: z.enum(STATUSES).optional(),
  reason: z.enum(INACTIVE_REASONS).optional(),
  application_status: z.enum(APPLICATION_STATUSES).optional(),
  application_date: YMD.optional(),
}).strict()
  .refine((f) => f.relationship_status || f.application_status || f.application_date, "A status finding needs relationship_status, application_status or application_date")
  .refine((f) => !f.relationship_status || !(INACTIVE_STATUSES as readonly string[]).includes(f.relationship_status) || !!f.reason, "An inactive relationship status needs a reason");
const resourceFinding = z.object({
  ...base, type: z.literal("resource"), partner: partnerRef,
  resource_type: z.enum(RESOURCE_TYPE_KEYS),
  link_url: httpUrl.optional(),
  series: z.string().regex(/^[a-z0-9][a-z0-9:._-]{1,119}$/).optional(),
  effective_date: YMD.optional(),
}).strict();
const taskFinding = z.object({
  ...base, type: z.literal("task"), partners: z.array(partnerRef).min(1).max(20),
  task_id: KEY,                                   // stable action id: the same action always has the same id
  owner: z.string().trim().max(80).optional(),
  due: YMD.optional(),
  task_status: z.enum(["open", "done", "cancelled"]).default("open"),
}).strict();
const conflictFinding = z.object({
  ...base, type: z.literal("conflict"), partner: partnerRef,
  field: z.enum(CONFLICT_FIELDS),
  values: z.array(z.object({ value: shortText(40), sources: z.array(source).max(10).optional() }).strict()).min(2).max(5),
}).strict();

export const findingSchema = z.union([statusFinding, resourceFinding, taskFinding, conflictFinding]);
export type Finding = z.infer<typeof findingSchema>;

export const passSchema = z.object({
  schema: z.literal(SLACK_SCHEMA, { message: `Use format ${SLACK_SCHEMA} (Marketplace Resources). Older scan files must be rebuilt.` }),
  channel: z.enum(CHANNELS),
  through_ts: TS,
  messages: z.array(z.object({ ts: TS, thread_ts: TS.nullable().optional(), edited_ts: TS.nullable().optional() }).strict()).max(5000),
  findings: z.array(z.unknown()).max(500),
}).strict();

export type Outcome = "added" | "updated" | "flagged" | "unchanged" | "skipped";
export type SkipReason = "supplier_role" | "not_listed" | "role_unclear" | "not_confirmed" | "not_open";
type PartnerName = { id: string; name: string };
export type Change =
  | { type: "status"; partner: PartnerName; field: "relationship_status" | "application_status" | "application_date"; from: string | null; to: string | null }
  | { type: "resource"; partner: PartnerName; title: string; action: "add" | "update"; supersedes: number }
  | { type: "task"; partners: PartnerName[]; title: string; action: "create" | "update"; due_date: string | null; owner: string | null; note?: string }
  | { type: "conflict"; partner: PartnerName; field: string; current: string | null; values: string[] };
export type PassResult = {
  channel: string; dry_run: boolean;
  added: number; updated: number; flagged: number; unchanged: number; skipped: number;
  skipped_reasons: Record<SkipReason, number>;
  changes: Change[];
  findings: { key: string; outcome: Exclude<Outcome, "skipped">; target: string }[];
};

const tsNum = (t: string) => Number(t);
const latestSource = (s: { date?: string; permalink: string; ts: string }[]) => [...s].sort((a, b) => tsNum(b.ts) - tsNum(a.ts))[0];
const sourceDate = (s: { date?: string; ts: string }) => s.date ?? new Date(tsNum(s.ts) * 1000).toISOString().slice(0, 10);
const mergeSources = (a: any[], b: any[]) => {
  const m = new Map<string, any>();
  for (const s of [...a, ...b]) m.set(`${s.channel}:${s.ts}`, s);
  return [...m.values()].sort((x, y) => tsNum(x.ts) - tsNum(y.ts));
};
/** Content of a finding without its sources: the same event reported from two messages has the same content. */
const contentHash = (f: Finding) => createHash("sha256").update(JSON.stringify({ ...f, sources: undefined })).digest("hex").slice(0, 32);
const maxTs = (s: { ts: string }[]) => s.reduce((m, x) => (tsNum(x.ts) > tsNum(m) ? x.ts : m), "0.0");

class DryRun extends Error {}

/**
 * Applies (or, with dryRun, previews) one pass. `actor` is the signed-in person for app imports (recorded on every
 * change); the script route uses the workflow's own signature.
 */
export async function applyPass(input: unknown, opts: { dryRun?: boolean; importedBy?: Actor } = {}): Promise<PassResult> {
  const parsed = passSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, "payload_rejected", "The scan payload is not valid.", {
      problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const pass = parsed.data;
  const findings: Finding[] = [];
  const problems: string[] = [];
  pass.findings.forEach((raw, i) => {
    const r = findingSchema.safeParse(raw);
    if (r.success) findings.push(r.data);
    else problems.push(...r.error.issues.slice(0, 3).map((x) => `findings.${i}${x.path.length ? "." + x.path.join(".") : ""}: ${x.message}`));
  });
  if (problems.length) throw new HttpError(400, "payload_rejected", "The scan payload is not valid.", { problems: problems.slice(0, 20) });
  const keys = findings.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, "payload_rejected", "A finding key appears twice in one pass.", { problems: [] });

  const actor = opts.importedBy ?? WORKFLOW;
  const result: PassResult = {
    channel: pass.channel, dry_run: !!opts.dryRun, added: 0, updated: 0, flagged: 0, unchanged: 0, skipped: 0,
    skipped_reasons: { supplier_role: 0, not_listed: 0, role_unclear: 0, not_confirmed: 0, not_open: 0 }, changes: [], findings: [],
  };
  try {
    await tx(async (c) => {
      await c.query("select 1 from slack_scan_state where channel_key = $1 for update", [pass.channel]);
      const appliedKeys = new Set<string>();
      for (const f of findings) {
        const r = await applyFinding(c, f, actor);
        if (r.outcome === "skipped") { result.skipped++; result.skipped_reasons[r.reason]++; continue; }
        appliedKeys.add(f.key);
        result[r.outcome]++;
        result.findings.push({ key: f.key, outcome: r.outcome, target: r.target });
        result.changes.push(...r.changes);
      }
      for (const m of pass.messages) {
        // Only in-scope findings are linked to messages (out-of-scope messages are counted, never described).
        const cited = findings.filter((f) => appliedKeys.has(f.key) && f.sources.some((s) => s.channel === pass.channel && s.ts === m.ts)).map((f) => f.key);
        await c.query(
          `insert into slack_messages (channel_key, ts, thread_ts, edited_ts, finding_keys) values ($1,$2,$3,$4,$5)
           on conflict (channel_key, ts) do update set thread_ts = excluded.thread_ts, edited_ts = excluded.edited_ts,
             finding_keys = (select array(select distinct unnest(slack_messages.finding_keys || excluded.finding_keys))), last_seen_at = now()`,
          [pass.channel, m.ts, m.thread_ts ?? null, m.edited_ts ?? null, cited],
        );
      }
      const cur = (await c.query("select position_ts from slack_scan_state where channel_key = $1", [pass.channel])).rows[0];
      const position = cur?.position_ts && tsNum(cur.position_ts) > tsNum(pass.through_ts) ? cur.position_ts : pass.through_ts;
      const counts = { added: result.added, updated: result.updated, flagged: result.flagged, unchanged: result.unchanged, skipped: result.skipped };
      await c.query(
        `update slack_scan_state set position_ts = $2, last_success_at = now(), last_attempt_at = now(), last_error = null, last_counts = $3 where channel_key = $1`,
        [pass.channel, position, JSON.stringify(counts)],
      );
      if (opts.importedBy) {
        await audit(c, opts.importedBy, { entityType: "slack_scan", entityId: null, action: "import",
          after: { channel: pass.channel, through_ts: pass.through_ts, format: SLACK_SCHEMA, ...counts, skipped_reasons: result.skipped_reasons } });
      }
      if (opts.dryRun) throw new DryRun();
    });
  } catch (e) {
    if (e instanceof DryRun) return result;
    // Nothing from this pass was saved. Record the failed attempt only (last success time is kept).
    if (!opts.dryRun) {
      await getPool().query("update slack_scan_state set last_attempt_at = now(), last_error = $2 where channel_key = $1",
        [pass.channel, e instanceof HttpError ? e.message.slice(0, 300) : "The pass could not be saved."]).catch(() => {});
    }
    throw e;
  }
  return result;
}

type Applied =
  | { outcome: Exclude<Outcome, "skipped">; target: string; changes: Change[] }
  | { outcome: "skipped"; reason: SkipReason };
type Ctx = { prev: any; hash: string; sources: any[]; latestUrl: string; latestDate: string; evidenceTs: string; actor: Actor };

async function applyFinding(c: pg.PoolClient, f: Finding, actor: Actor): Promise<Applied> {
  // Scope first: nothing is written for out-of-scope findings.
  if (f.role !== "selling") return { outcome: "skipped", reason: "supplier_role" };
  if (f.type !== "conflict" && f.certainty !== "confirmed") return { outcome: "skipped", reason: "not_confirmed" };
  const refs = f.type === "task" ? f.partners : [f.partner];
  const partners: PartnerName[] = [];
  for (const ref of refs) {
    const m = await matchEligiblePartner(c, ref);
    if (!m.ok) return { outcome: "skipped", reason: m.reason === "role_unclear" ? "role_unclear" : "not_listed" };
    if (!partners.some((p) => p.id === m.id)) partners.push({ id: m.id, name: m.name });
  }

  const prev = (await c.query("select * from slack_findings where key = $1 for update", [f.key])).rows[0];
  const hash = contentHash(f);
  const sources = mergeSources(prev?.sources ?? [], f.sources);
  const evidenceTs = maxTs(f.sources);
  const latest = latestSource(f.sources);
  const ctx: Ctx = { prev, hash, sources, latestUrl: latest.permalink, latestDate: f.occurred_on ?? sourceDate(latest), evidenceTs, actor };

  // The same event again (retry, edit with no change, or the other channel): keep the record, add the messages.
  // Older evidence read after newer evidence never overwrites it either.
  const older = prev?.evidence_ts && tsNum(prev.evidence_ts) > tsNum(evidenceTs);
  if (prev && prev.format === 2 && (prev.content_hash === hash || older)) {
    const keep = older ? prev.evidence_ts : evidenceTs;
    await c.query("update slack_findings set sources = $2, evidence_ts = $3, updated_at = now() where key = $1", [f.key, JSON.stringify(sources), keep]);
    if (prev.target_type === "review_item") await c.query("update review_items set sources = $2, updated_at = now() where id = $1", [prev.target_id, JSON.stringify(sources)]);
    return { outcome: "unchanged", target: `${prev.target_type}:${prev.target_id}`, changes: [] };
  }

  switch (f.type) {
    case "status": return applyStatus(c, f, partners[0], ctx);
    case "resource": return applyResource(c, f, partners[0], ctx);
    case "task": return applyTask(c, f, partners, ctx);
    case "conflict": return applyConflict(c, f, partners[0], ctx);
  }
}

async function recordFinding(c: pg.PoolClient, f: Finding, ctx: Ctx, targetType: string, targetId: string | null) {
  const evidence = ctx.prev?.evidence_ts && tsNum(ctx.prev.evidence_ts) > tsNum(ctx.evidenceTs) ? ctx.prev.evidence_ts : ctx.evidenceTs;
  await c.query(
    `insert into slack_findings (key, kind, content_hash, target_type, target_id, sources, format, scope, evidence_ts) values ($1,$2,$3,$4,$5,$6,2,'in_scope',$7)
     on conflict (key) do update set kind = excluded.kind, content_hash = excluded.content_hash, target_type = excluded.target_type,
       target_id = excluded.target_id, sources = excluded.sources, format = 2, scope = 'in_scope', evidence_ts = excluded.evidence_ts, updated_at = now()`,
    [f.key, f.type, ctx.hash, targetType, targetId, JSON.stringify(ctx.sources), evidence],
  );
}

// ------------------------------------------------------------------ status
/** Sets a partner's relationship status with history (used by the workflow and by review decisions). */
export async function setRelationshipStatus(c: pg.PoolClient, a: Actor, marketplaceId: string, to: string, detail: string, reason: string | null, evidenceAt: Date) {
  const m = (await c.query("select id, status from marketplaces where id = $1 for update", [marketplaceId])).rows[0];
  if (!m || m.status === to) return null;
  if ((INACTIVE_STATUSES as readonly string[]).includes(to) && !reason) throw new HttpError(400, "invalid_request", "A reason is required for this status.");
  await c.query("update marketplaces set status = $2, status_evidence_at = $3, updated_at = now(), version = version + 1 where id = $1", [marketplaceId, to, evidenceAt]);
  await c.query(
    `insert into status_history (marketplace_id, from_status, to_status, reason, detail, signer_name, auth_subject) values ($1,$2,$3,$4,$5,$6,$7)`,
    [marketplaceId, m.status, to, reason, detail.slice(0, 2000), a.signer, a.sub]);
  await audit(c, a, { entityType: "marketplace", entityId: marketplaceId, marketplaceId, action: "status_change", before: { status: m.status }, after: { status: to, reason } });
  return { from: m.status as string, to };
}

/** Sets a partner's application status and/or date (separate from the relationship status). */
export async function setApplication(c: pg.PoolClient, a: Actor, marketplaceId: string, d: { application_status?: string | null; application_date?: string | null }, note: string, evidenceAt: Date) {
  const m = (await c.query("select id, application_status, application_date from marketplaces where id = $1 for update", [marketplaceId])).rows[0];
  const curDate = m.application_date ? new Date(m.application_date).toISOString().slice(0, 10) : null;
  const set: Record<string, unknown> = {};
  if (d.application_status !== undefined && d.application_status !== m.application_status) set.application_status = d.application_status;
  if (d.application_date !== undefined && d.application_date !== curDate) set.application_date = d.application_date;
  if (!Object.keys(set).length) return [];
  const cols = Object.keys(set);
  await c.query(`update marketplaces set ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, application_updated_at = $${cols.length + 2}, updated_at = now(), version = version + 1 where id = $1`,
    [marketplaceId, ...cols.map((k) => set[k]), evidenceAt]);
  await audit(c, a, { entityType: "marketplace", entityId: marketplaceId, marketplaceId, action: "application_update",
    before: { application_status: m.application_status, application_date: curDate }, after: { ...set, note: note.slice(0, 500) } });
  return cols.map((k) => ({ field: k as "application_status" | "application_date", from: (k === "application_date" ? curDate : m.application_status) as string | null, to: set[k] as string | null }));
}

async function applyStatus(c: pg.PoolClient, f: z.infer<typeof statusFinding>, p: PartnerName, ctx: Ctx): Promise<Applied> {
  const changes: Change[] = [];
  const evidenceAt = new Date(tsNum(ctx.evidenceTs) * 1000);
  const detail = `${f.title}${f.summary ? `\n${f.summary}` : ""}\nSource: ${ctx.latestUrl}`;
  // Latest confirmed evidence wins: a status set from newer evidence (or by hand after this message) is kept.
  const m = (await c.query("select status_evidence_at, application_updated_at from marketplaces where id = $1", [p.id])).rows[0];
  const newerThan = (t: any) => t && new Date(t) > evidenceAt;
  if (f.relationship_status && !newerThan(m.status_evidence_at)) {
    const r = await setRelationshipStatus(c, ctx.actor, p.id, f.relationship_status, detail, f.reason ?? null, evidenceAt);
    if (r) changes.push({ type: "status", partner: p, field: "relationship_status", from: r.from, to: r.to });
  }
  if ((f.application_status || f.application_date) && !newerThan(m.application_updated_at)) {
    const r = await setApplication(c, ctx.actor, p.id, { application_status: f.application_status, application_date: f.application_date }, `${f.title} (${ctx.latestUrl})`, evidenceAt);
    for (const x of r) changes.push({ type: "status", partner: p, field: x.field, from: x.from, to: x.to });
  }
  await recordFinding(c, f, ctx, "marketplace", p.id);
  await closeReviewByFinding(c, f.key, ctx.actor);
  return { outcome: changes.length ? "updated" : "unchanged", target: `marketplace:${p.id}`, changes };
}

// ------------------------------------------------------------------ resources
async function applyResource(c: pg.PoolClient, f: z.infer<typeof resourceFinding>, p: PartnerName, ctx: Ctx): Promise<Applied> {
  const fields = {
    resource_type: f.resource_type, title: f.title, link_url: f.link_url ?? null, note: f.summary ?? null, source_url: ctx.latestUrl,
    effective_date: f.effective_date ?? null, last_confirmed_on: ctx.latestDate, series_key: f.series ?? null,
  };
  let row = (await c.query(`select * from supplier_resources where finding_key = $1 for update`, [f.key])).rows[0];
  // Match an existing record (e.g. added manually) before creating: same partner, same title, still current.
  if (!row) row = (await c.query(
    `select * from supplier_resources where marketplace_id = $1 and finding_key is null and status = 'current' and removed_at is null and excluded_at is null for update`, [p.id]))
    .rows.find((r: any) => nameKey(r.title) === nameKey(f.title));
  let outcome: "added" | "updated";
  if (row) {
    const after = (await c.query(
      `update supplier_resources set marketplace_id = $12, vendor_id = null, resource_type = $2, section = $3, title = $4, link_url = coalesce($5, link_url), note = coalesce($6, note),
         source_url = $7, effective_date = coalesce($8, effective_date), last_confirmed_on = $9, series_key = coalesce($10, series_key),
         finding_key = $11, excluded_at = null, excluded_reason = null, updated_at = now(), version = version + 1 where id = $1 returning *`,
      [row.id, f.resource_type, RESOURCE_TYPES[f.resource_type], fields.title, fields.link_url, fields.note, fields.source_url, fields.effective_date,
        fields.last_confirmed_on, fields.series_key, f.key, p.id])).rows[0];
    await audit(c, ctx.actor, { entityType: "supplier_resource", entityId: row.id, marketplaceId: p.id, action: "slack_update", after: { title: after.title, source_url: after.source_url } });
    row = after;
    outcome = "updated";
  } else {
    row = await createResource(c, { kind: "partner", id: p.id }, fields, ctx.actor, { origin: "slack", finding_key: f.key });
    outcome = "added";
  }
  // A confirmed replacement in the same series supersedes the earlier current version(s); they stay in history.
  let superseded = 0;
  if (f.series && row.status === "current") {
    const olderRows = (await c.query(
      `select id from supplier_resources where marketplace_id = $1 and series_key = $2 and status = 'current' and removed_at is null and id <> $3
         and coalesce(effective_date, last_confirmed_on, created_at::date) <= coalesce($4::date, $5::date)`,
      [p.id, f.series, row.id, f.effective_date ?? null, ctx.latestDate])).rows;
    for (const o of olderRows) { await supersede(c, o.id, row, ctx.actor); superseded++; }
  }
  await recordFinding(c, f, ctx, "supplier_resource", row.id);
  await closeReviewByFinding(c, f.key, ctx.actor);
  return { outcome, target: `supplier_resource:${row.id}`, changes: [{ type: "resource", partner: p, title: f.title, action: outcome === "added" ? "add" : "update", supersedes: superseded }] };
}

// ------------------------------------------------------------------ tasks
async function applyTask(c: pg.PoolClient, f: z.infer<typeof taskFinding>, partners: PartnerName[], ctx: Ctx): Promise<Applied> {
  const ids = partners.map((p) => p.id).sort();
  let row = (await c.query("select * from corporate_task_requests where task_key = $1 for update", [f.task_id])).rows[0];
  // Match an existing task request (e.g. entered manually) before creating: same title, same partners, not dismissed.
  if (!row) row = (await c.query("select * from corporate_task_requests where delivery_status <> 'dismissed' for update")).rows
    .find((r: any) => nameKey(r.title) === nameKey(f.title) && [...r.marketplace_ids].sort().join() === ids.join());
  const next = { title: f.title, brief: f.summary ?? null, owner_hint: f.owner ?? null, due_date: f.due ?? null, slack_status: f.task_status, ids };
  if (!row) {
    // A historical or completed action does not establish an open task.
    if (f.task_status !== "open") return { outcome: "skipped", reason: "not_open" };
    const ins = (await c.query(
      `insert into corporate_task_requests (task_key, title, brief, owner_hint, due_date, slack_status, marketplace_ids, source_refs, origin, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'slack',$9) returning *`,
      [f.task_id, next.title, next.brief, next.owner_hint, next.due_date, next.slack_status, ids, JSON.stringify(ctx.sources), ctx.actor.signer])).rows[0];
    await audit(c, ctx.actor, { entityType: "corporate_task_request", entityId: ins.id, action: "slack_create",
      after: { title: ins.title, marketplace_ids: ids, due_date: ins.due_date, sources: ctx.sources.map((s: any) => s.permalink) } });
    await recordFinding(c, f, ctx, "corporate_task_request", ins.id);
    return { outcome: "added", target: `corporate_task_request:${ins.id}`, changes: [{ type: "task", partners, title: f.title, action: "create", due_date: next.due_date, owner: next.owner_hint }] };
  }
  const cur = { title: row.title, brief: row.brief, owner_hint: row.owner_hint, due_date: row.due_date ? new Date(row.due_date).toISOString().slice(0, 10) : null, slack_status: row.slack_status, ids: [...row.marketplace_ids].sort() };
  // Ownership and completion belong to Task Tracker once delivered; Slack only updates the request's own fields.
  const merged = { ...next, brief: next.brief ?? cur.brief, owner_hint: next.owner_hint ?? cur.owner_hint, due_date: next.due_date ?? cur.due_date };
  const changed = JSON.stringify(merged) !== JSON.stringify(cur);
  if (changed) {
    await c.query(
      `update corporate_task_requests set task_key = coalesce(task_key, $2), title = $3, brief = $4, owner_hint = $5, due_date = $6, slack_status = $7,
         marketplace_ids = $8, source_refs = $9, content_version = content_version + 1, updated_at = now(), version = version + 1 where id = $1`,
      [row.id, f.task_id, merged.title, merged.brief, merged.owner_hint, merged.due_date, merged.slack_status, merged.ids, JSON.stringify(mergeSources(row.source_refs ?? [], ctx.sources))]);
    await audit(c, ctx.actor, { entityType: "corporate_task_request", entityId: row.id, action: "slack_update", before: cur, after: merged });
  } else {
    await c.query("update corporate_task_requests set source_refs = $2 where id = $1", [row.id, JSON.stringify(mergeSources(row.source_refs ?? [], ctx.sources))]);
  }
  await recordFinding(c, f, ctx, "corporate_task_request", row.id);
  const note = row.delivery_status === "delivered" && changed
    ? (merged.due_date !== cur.due_date ? "Already in Task Tracker: the due date will be updated there; title and owner stay as set in Task Tracker." : "Already in Task Tracker: it keeps its own title, owner and completion.")
    : undefined;
  return {
    outcome: changed ? "updated" : "unchanged", target: `corporate_task_request:${row.id}`,
    changes: changed ? [{ type: "task", partners, title: merged.title, action: "update", due_date: merged.due_date, owner: merged.owner_hint, ...(note ? { note } : {}) }] : [],
  };
}

// ------------------------------------------------------------------ conflicts
const FIELD_LABEL: Record<string, string> = { relationship_status: "Relationship status", application_status: "Application status", application_date: "Application date" };
async function currentValue(c: pg.PoolClient, id: string, field: string) {
  const m = (await c.query("select status, application_status, application_date from marketplaces where id = $1", [id])).rows[0];
  if (field === "relationship_status") return m.status as string;
  if (field === "application_status") return m.application_status as string | null;
  return m.application_date ? new Date(m.application_date).toISOString().slice(0, 10) : null;
}
function checkValue(field: string, v: string) {
  if (field === "relationship_status") return (STATUSES as readonly string[]).includes(v);
  if (field === "application_status") return (APPLICATION_STATUSES as readonly string[]).includes(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

async function applyConflict(c: pg.PoolClient, f: z.infer<typeof conflictFinding>, p: PartnerName, ctx: Ctx): Promise<Applied> {
  const bad = f.values.find((v) => !checkValue(f.field, v.value));
  if (bad) throw new HttpError(400, "payload_rejected", "The scan payload is not valid.", { problems: [`${f.key}: "${bad.value}" is not a valid ${FIELD_LABEL[f.field].toLowerCase()}`] });
  const current = await currentValue(c, p.id, f.field);
  const options = f.values.map((v) => ({
    label: f.field === "application_date" ? `Apply date: ${v.value}` : `Apply status: ${v.value.replace(/_/g, " ")}`,
    change: { type: "status", field: f.field, to: v.value },
    sources: v.sources ?? [],
  }));
  const values = f.values.map((v) => v.value);
  const question = `${FIELD_LABEL[f.field]} for ${p.name}: messages disagree (${values.join(" vs ")}). Current value: ${current ?? "not set"}.`;
  const prev = (await c.query("select * from review_items where finding_key = $1 for update", [f.key])).rows[0];
  let id: string;
  if (!prev) {
    id = (await c.query(
      `insert into review_items (finding_key, kind, title, summary, question, supplier_hint, sources, format, marketplace_id, field, current_value, options)
       values ($1,'conflict',$2,$3,$4,$5,$6,2,$7,$8,$9,$10) returning id`,
      [f.key, f.title, f.summary ?? null, question, p.name, JSON.stringify(ctx.sources), p.id, f.field, current, JSON.stringify(options)])).rows[0].id;
  } else {
    id = prev.id;
    // New, different evidence reopens a decided item; the same content again only adds sources.
    await c.query(
      `update review_items set kind = 'conflict', title = $2, summary = $3, question = $4, supplier_hint = $5, sources = $6, format = 2, marketplace_id = $7,
         field = $8, current_value = $9, options = $10, status = 'open', resolution = null, resolved_by = null, resolved_at = null,
         updated_at = now(), version = version + 1 where id = $1`,
      [id, f.title, f.summary ?? null, question, p.name, JSON.stringify(ctx.sources), p.id, f.field, current, JSON.stringify(options)]);
  }
  await recordFinding(c, f, ctx, "review_item", id);
  return { outcome: "flagged", target: `review_item:${id}`, changes: [{ type: "conflict", partner: p, field: f.field, current, values }] };
}

/** A later confirmed finding with the same key settles an open conflict about it. */
async function closeReviewByFinding(c: pg.PoolClient, key: string, a: Actor) {
  await c.query(`update review_items set status = 'resolved', resolution = 'applied', resolution_note = coalesce(resolution_note, 'Settled by a later confirmed Slack message.'),
    resolved_by = coalesce(resolved_by, $2), resolved_at = coalesce(resolved_at, now()), updated_at = now(), version = version + 1
    where finding_key = $1 and status = 'open'`, [key, a.signer]);
}

/** For the scanner: per-channel position, and the threads that already have findings (to revisit for new replies). */
export async function scanState() {
  const pool = getPool();
  const channels = (await pool.query("select channel_key, position_ts, last_success_at, last_attempt_at, last_error from slack_scan_state order by channel_key")).rows;
  const threads = (await pool.query(
    `select channel_key, coalesce(thread_ts, ts) as thread_ts from slack_messages where cardinality(finding_keys) > 0 group by 1, 2 order by 1, 2`)).rows;
  return { ok: true, schema: SLACK_SCHEMA, channels, tracked_threads: threads };
}
