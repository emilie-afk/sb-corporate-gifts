// Slack-to-Corporate Gifts workflow: applies one scan pass of one channel (#seo or #teammarketing).
//
// The scanner (a scheduled task that reads Slack) classifies messages into findings and posts them here with the
// messages it examined and the newest ts it covered. This module matches each finding to existing records before
// creating anything, applies it, and records everything in ONE transaction:
//   - every finding has a stable event key; the same key from a retry, an edited message or the other channel
//     updates the same record (its supporting messages are merged), never a new one;
//   - tentative, conflicting or ambiguous findings, and findings whose supplier or target cannot be matched to
//     exactly one record, go to the review queue with their sources and the question to resolve;
//   - the channel's scan position advances only when the pass is saved; a failed pass changes nothing except the
//     channel's last attempt and error (its last successful scan time is kept).
// Facts, source links and supplier terms are stored only in this private database.
import { createHash } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { tx, getPool } from "../db";
import { audit, type Actor } from "../audit";
import { HttpError } from "../http";
import { STATUSES, INACTIVE_STATUSES } from "../routes/marketplaces";
import { createResource, supersede } from "../routes/suppliers";
import { RESOURCE_TYPES, RESOURCE_TYPE_KEYS, SAMPLE_STATUSES, SAMPLE_RANK, matchSupplier, nameKey, refColumns, type SupplierRef } from "./suppliers";

export const SLACK_SCHEMA = "sbcg-slack-v1";
export const CHANNELS = ["seo", "teammarketing"] as const;
const WORKFLOW: Actor = { signer: "Slack workflow", sub: null };

const TS = z.string().regex(/^\d{9,11}\.\d{1,6}$/, "Slack ts");
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Invalid date");
const httpUrl = z.string().max(2000).refine((v) => { try { return ["https:", "http:"].includes(new URL(v).protocol); } catch { return false; } }, "http(s) URL");
const slackLink = z.string().max(500).refine((v) => { try { const u = new URL(v); return u.protocol === "https:" && /(^|\.)slack\.com$/.test(u.hostname); } catch { return false; } }, "Slack https link");
const shortText = (max: number) => z.string().trim().min(1).max(max);

const source = z.object({
  channel: z.enum(CHANNELS),
  ts: TS,
  thread_ts: TS.nullable().optional(),
  permalink: slackLink,
  date: YMD.optional(),
});

export const findingSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9:._-]{2,119}$/, "lowercase key"),
  kind: z.enum(["resource", "terms", "decision", "sample", "outreach", "proposal", "requirement", "action", "blocker"]),
  certainty: z.enum(["confirmed", "tentative", "conflicting", "ambiguous"]),
  supplier: z.object({ names: z.array(shortText(120)).min(1).max(5), kind: z.enum(["partner", "vendor"]).optional() }).nullable().optional(),
  title: shortText(200),
  summary: z.string().trim().max(2000).optional(),
  question: z.string().trim().max(1000).optional(),
  resource_type: z.enum(RESOURCE_TYPE_KEYS).optional(),
  link_url: httpUrl.optional(),
  series: z.string().regex(/^[a-z0-9][a-z0-9:._-]{1,119}$/).optional(),
  effective_date: YMD.optional(),
  sample_status: z.enum(SAMPLE_STATUSES).optional(),
  action_status: z.enum(["open", "done", "cancelled"]).optional(),
  marketplace_status: z.enum(STATUSES).optional(),
  requirement_category: z.enum(["fulfillment", "product", "customization", "pricing", "payment", "technical", "other"]).optional(),
  owner: z.string().trim().max(80).optional(),
  due: YMD.optional(),
  occurred_on: YMD.optional(),
  sources: z.array(source).min(1).max(20),
}).strict();
export type Finding = z.infer<typeof findingSchema>;

export const passSchema = z.object({
  schema: z.literal(SLACK_SCHEMA),
  channel: z.enum(CHANNELS),
  through_ts: TS,
  messages: z.array(z.object({ ts: TS, thread_ts: TS.nullable().optional(), edited_ts: TS.nullable().optional() }).strict()).max(5000),
  findings: z.array(findingSchema).max(500),
}).strict();
export type Pass = z.infer<typeof passSchema>;

type Outcome = "added" | "updated" | "flagged" | "unchanged";
export type PassResult = { channel: string; dry_run: boolean; added: number; updated: number; flagged: number; unchanged: number; findings: { key: string; outcome: Outcome; target: string }[] };

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

class DryRun extends Error {}

export async function applyPass(input: unknown, opts: { dryRun?: boolean } = {}): Promise<PassResult> {
  const parsed = passSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, "payload_rejected", "The scan payload is not valid.", {
      problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const pass = parsed.data;
  const keys = pass.findings.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, "payload_rejected", "A finding key appears twice in one pass.", { problems: [] });

  const result: PassResult = { channel: pass.channel, dry_run: !!opts.dryRun, added: 0, updated: 0, flagged: 0, unchanged: 0, findings: [] };
  try {
    await tx(async (c) => {
      await c.query("select 1 from slack_scan_state where channel_key = $1 for update", [pass.channel]);
      for (const f of pass.findings) {
        const { outcome, target } = await applyFinding(c, f);
        result[outcome]++;
        result.findings.push({ key: f.key, outcome, target });
      }
      for (const m of pass.messages) {
        const cited = pass.findings.filter((f) => f.sources.some((s) => s.channel === pass.channel && s.ts === m.ts)).map((f) => f.key);
        await c.query(
          `insert into slack_messages (channel_key, ts, thread_ts, edited_ts, finding_keys) values ($1,$2,$3,$4,$5)
           on conflict (channel_key, ts) do update set thread_ts = excluded.thread_ts, edited_ts = excluded.edited_ts,
             finding_keys = (select array(select distinct unnest(slack_messages.finding_keys || excluded.finding_keys))), last_seen_at = now()`,
          [pass.channel, m.ts, m.thread_ts ?? null, m.edited_ts ?? null, cited],
        );
      }
      const cur = (await c.query("select position_ts from slack_scan_state where channel_key = $1", [pass.channel])).rows[0];
      const position = cur?.position_ts && tsNum(cur.position_ts) > tsNum(pass.through_ts) ? cur.position_ts : pass.through_ts;
      await c.query(
        `update slack_scan_state set position_ts = $2, last_success_at = now(), last_attempt_at = now(), last_error = null, last_counts = $3 where channel_key = $1`,
        [pass.channel, position, JSON.stringify({ added: result.added, updated: result.updated, flagged: result.flagged, unchanged: result.unchanged })],
      );
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

async function recordFinding(c: pg.PoolClient, f: Finding, hash: string, targetType: string, targetId: string | null, sources: any[]) {
  await c.query(
    `insert into slack_findings (key, kind, content_hash, target_type, target_id, sources) values ($1,$2,$3,$4,$5,$6)
     on conflict (key) do update set kind = excluded.kind, content_hash = excluded.content_hash, target_type = excluded.target_type,
       target_id = excluded.target_id, sources = excluded.sources, updated_at = now()`,
    [f.key, f.kind, hash, targetType, targetId, JSON.stringify(sources)],
  );
}

async function flag(c: pg.PoolClient, f: Finding, question: string, sources: any[], hash: string, supplierHint: string | null): Promise<{ outcome: Outcome; target: string }> {
  const prev = (await c.query("select * from review_items where finding_key = $1", [f.key])).rows[0];
  const fields = [f.kind, f.title, f.summary ?? null, question, supplierHint, JSON.stringify(sources)];
  let id: string;
  if (!prev) {
    id = (await c.query(
      `insert into review_items (finding_key, kind, title, summary, question, supplier_hint, sources) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [f.key, ...fields])).rows[0].id;
  } else {
    id = prev.id;
    const sameContent = (await c.query("select content_hash from slack_findings where key = $1", [f.key])).rows[0]?.content_hash === hash;
    // New information reopens an item someone already resolved; the same content again only adds sources.
    await c.query(
      `update review_items set kind = $2, title = $3, summary = $4, question = $5, supplier_hint = $6, sources = $7,
         status = case when $8 then status else 'open' end, updated_at = now(), version = version + 1 where id = $1`,
      [id, ...fields, sameContent]);
  }
  await recordFinding(c, f, hash, "review_item", id, sources);
  return { outcome: "flagged", target: `review_item:${id}` };
}

async function applyFinding(c: pg.PoolClient, f: Finding): Promise<{ outcome: Outcome; target: string }> {
  const prev = (await c.query("select * from slack_findings where key = $1 for update", [f.key])).rows[0];
  const hash = contentHash(f);
  const sources = mergeSources(prev?.sources ?? [], f.sources);
  const newSources = sources.length !== (prev?.sources ?? []).length;

  // The same event again (retry, or the other channel): keep the record, add any new supporting messages.
  if (prev && prev.content_hash === hash) {
    if (!newSources) return { outcome: "unchanged", target: `${prev.target_type}:${prev.target_id}` };
    await c.query("update slack_findings set sources = $2, updated_at = now() where key = $1", [f.key, JSON.stringify(sources)]);
    if (prev.target_type === "review_item") await c.query("update review_items set sources = $2, updated_at = now() where id = $1", [prev.target_id, JSON.stringify(sources)]);
    return { outcome: "updated", target: `${prev.target_type}:${prev.target_id}` };
  }

  const supplierNames = f.supplier?.names ?? [];
  const hint = supplierNames.length ? supplierNames.join(" / ") : null;
  if (f.certainty !== "confirmed") {
    return flag(c, f, f.question ?? `This is ${f.certainty}. Confirm it before it updates any record.`, sources, hash, hint);
  }

  let supplier: SupplierRef | null = null;
  if (f.supplier) {
    const kindFilter = ["outreach", "proposal", "requirement"].includes(f.kind) ? "partner" : f.supplier.kind;
    const m = await matchSupplier(c, supplierNames, kindFilter);
    if (!m.ref) {
      const q = m.reason === "several_matches"
        ? `Which record is "${hint}"? Several match: ${m.candidates.join("; ")}.`
        : `No ${kindFilter === "partner" ? "partner" : "partner or vendor"} record named "${hint}". Create one, or say which existing record this is.`;
      return flag(c, f, q, sources, hash, hint);
    }
    supplier = m.ref;
  }
  const latest = latestSource(sources);
  const ctx = { prev, hash, sources, latestUrl: latest.permalink, latestDate: sourceDate(latest) };

  switch (f.kind) {
    case "resource": case "terms": case "decision":
      if (!supplier) {
        if (f.kind === "decision") return applyAction(c, f, null, ctx, "decision");
        return flag(c, f, f.question ?? "Which supplier does this belong to?", sources, hash, hint);
      }
      return applyResource(c, f, supplier, ctx);
    case "sample": return applySample(c, f, supplier, ctx);
    case "outreach": case "proposal":
      if (supplier?.kind !== "partner") return flag(c, f, "Which partner record is this about?", sources, hash, hint);
      return applyOutreach(c, f, supplier.id, ctx);
    case "requirement":
      if (supplier?.kind !== "partner") return flag(c, f, "Which partner record is this requirement for?", sources, hash, hint);
      return applyRequirement(c, f, supplier.id, ctx);
    case "action": case "blocker":
      return applyAction(c, f, supplier, ctx, f.kind);
  }
}

type Ctx = { prev: any; hash: string; sources: any[]; latestUrl: string; latestDate: string };
const done = async (c: pg.PoolClient, f: Finding, ctx: Ctx, type: string, id: string, outcome: Outcome) => {
  await recordFinding(c, f, ctx.hash, type, id, ctx.sources);
  // A finding that had been waiting for review and is now confirmed and applied closes its review item.
  await c.query(`update review_items set status = 'resolved', resolution_note = coalesce(resolution_note, 'Confirmed by a later Slack message.'),
    resolved_by = coalesce(resolved_by, 'Slack workflow'), resolved_at = coalesce(resolved_at, now()), updated_at = now(), version = version + 1
    where finding_key = $1 and status = 'open'`, [f.key]);
  return { outcome, target: `${type}:${id}` };
};

async function applyResource(c: pg.PoolClient, f: Finding, s: SupplierRef, ctx: Ctx) {
  const type = f.resource_type ?? (f.kind === "terms" ? "other_term" : f.kind === "decision" ? "decision" : "other_document");
  const col = s.kind === "partner" ? "marketplace_id" : "vendor_id";
  const fields = {
    resource_type: type, title: f.title, link_url: f.link_url ?? null, note: f.summary ?? null, source_url: ctx.latestUrl,
    effective_date: f.effective_date ?? null, last_confirmed_on: ctx.latestDate, series_key: f.series ?? null,
  };
  let row = (await c.query(`select * from supplier_resources where finding_key = $1 for update`, [f.key])).rows[0];
  // Match an existing record (e.g. added manually) before creating: same supplier, same title, still current.
  if (!row) row = (await c.query(
    `select * from supplier_resources where ${col} = $1 and finding_key is null and status = 'current' and removed_at is null for update`, [s.id]))
    .rows.find((r: any) => nameKey(r.title) === nameKey(f.title));
  let outcome: Outcome;
  if (row) {
    const sameSupplier = row[col] === s.id;
    if (!sameSupplier) return flag(c, f, `This finding was applied to a different supplier before; the corrected message names "${f.supplier?.names.join(" / ")}". Which is right?`, ctx.sources, ctx.hash, null);
    const after = (await c.query(
      `update supplier_resources set resource_type = $2, section = $3, title = $4, link_url = coalesce($5, link_url), note = coalesce($6, note),
         source_url = $7, effective_date = coalesce($8, effective_date), last_confirmed_on = $9, series_key = coalesce($10, series_key),
         finding_key = $11, updated_at = now(), version = version + 1 where id = $1 returning *`,
      [row.id, type, RESOURCE_TYPES[type], fields.title, fields.link_url, fields.note, fields.source_url, fields.effective_date,
        fields.last_confirmed_on, fields.series_key, f.key])).rows[0];
    await audit(c, WORKFLOW, { entityType: "supplier_resource", entityId: row.id, marketplaceId: refColumns(s).marketplace_id, action: "slack_update", after: { title: after.title, source_url: after.source_url } });
    row = after;
    outcome = "updated";
  } else {
    row = await createResource(c, s, fields, WORKFLOW, { origin: "slack", finding_key: f.key });
    outcome = "added";
  }
  // A confirmed replacement in the same series supersedes the earlier current version(s); they stay in history.
  if (f.series && row.status === "current") {
    const older = (await c.query(
      `select id from supplier_resources where ${col} = $1 and series_key = $2 and status = 'current' and removed_at is null and id <> $3
         and coalesce(effective_date, last_confirmed_on, created_at::date) <= coalesce($4::date, $5::date)`,
      [s.id, f.series, row.id, f.effective_date ?? null, ctx.latestDate])).rows;
    for (const o of older) await supersede(c, o.id, row, WORKFLOW);
  }
  return done(c, f, ctx, "supplier_resource", row.id, outcome);
}

async function applySample(c: pg.PoolClient, f: Finding, s: SupplierRef | null, ctx: Ctx) {
  if (!f.sample_status) return flag(c, f, "What is the sample's status (requested, approved, shipped, delivered)?", ctx.sources, ctx.hash, f.supplier?.names.join(" / ") ?? null);
  let row = (await c.query("select * from sample_requests where finding_key = $1 for update", [f.key])).rows[0];
  if (!row && s) {
    const col = s.kind === "partner" ? "marketplace_id" : "vendor_id";
    const open = (await c.query(`select * from sample_requests where ${col} = $1 and status not in ('delivered', 'cancelled') for update`, [s.id])).rows;
    if (open.length > 1) return flag(c, f, `Several open sample requests exist for this supplier: which one is it?`, ctx.sources, ctx.hash, f.supplier?.names.join(" / ") ?? null);
    row = open[0];
  }
  if (!row && !s && f.sample_status !== "requested") {
    return flag(c, f, "This sample update does not match a tracked request. Which request is it?", ctx.sources, ctx.hash, null);
  }
  if (row) {
    // Latest confirmed status wins; an older message read later never moves a sample backwards.
    const forward = SAMPLE_RANK[f.sample_status] >= SAMPLE_RANK[row.status];
    const after = (await c.query(
      `update sample_requests set status = $2, status_on = $3, note = coalesce($4, note), source_url = $5, finding_key = coalesce(finding_key, $6),
         updated_at = now(), version = version + 1 where id = $1 returning *`,
      [row.id, forward ? f.sample_status : row.status, forward ? (f.occurred_on ?? ctx.latestDate) : row.status_on, f.summary ?? null,
        forward ? ctx.latestUrl : row.source_url, row.finding_key ? null : f.key])).rows[0];
    await audit(c, WORKFLOW, { entityType: "sample_request", entityId: row.id, marketplaceId: row.marketplace_id, action: "slack_update", before: { status: row.status }, after: { status: after.status } });
    return done(c, f, ctx, "sample_request", row.id, "updated");
  }
  const ins = (await c.query(
    `insert into sample_requests (label, marketplace_id, vendor_id, status, status_on, note, source_url, origin, finding_key, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'slack',$8,$9) returning *`,
    [f.title, refColumns(s).marketplace_id, refColumns(s).vendor_id, f.sample_status, f.occurred_on ?? ctx.latestDate, f.summary ?? null, ctx.latestUrl, f.key, WORKFLOW.signer])).rows[0];
  await audit(c, WORKFLOW, { entityType: "sample_request", entityId: ins.id, marketplaceId: ins.marketplace_id, action: "slack_create", after: { status: ins.status } });
  return done(c, f, ctx, "sample_request", ins.id, "added");
}

async function applyOutreach(c: pg.PoolClient, f: Finding, marketplaceId: string, ctx: Ctx) {
  // A meaningful status change moves the partner record (with history). Inactive statuses need a reason → review.
  if (f.marketplace_status) {
    const m = (await c.query("select * from marketplaces where id = $1 for update", [marketplaceId])).rows[0];
    if (m.status !== f.marketplace_status) {
      if ((INACTIVE_STATUSES as readonly string[]).includes(f.marketplace_status)) {
        return flag(c, f, `Change ${m.name} to "${f.marketplace_status.replace(/_/g, " ")}"? This status needs a reason, so it is not changed automatically.`, ctx.sources, ctx.hash, m.name);
      }
      await c.query("update marketplaces set status = $2, updated_at = now(), version = version + 1 where id = $1", [marketplaceId, f.marketplace_status]);
      await c.query(
        `insert into status_history (marketplace_id, from_status, to_status, detail, signer_name) values ($1,$2,$3,$4,$5)`,
        [marketplaceId, m.status, f.marketplace_status, `${f.title}${f.summary ? `\n${f.summary}` : ""}\nSource: ${ctx.latestUrl}`, WORKFLOW.signer]);
      await audit(c, WORKFLOW, { entityType: "marketplace", entityId: marketplaceId, marketplaceId, action: "status_change", before: { status: m.status }, after: { status: f.marketplace_status } });
    }
  }
  const summary = `${f.title}${f.summary ? ` — ${f.summary}` : ""}`.slice(0, 4000);
  const row = (await c.query("select * from communications where finding_key = $1 for update", [f.key])).rows[0];
  if (row) {
    await c.query(`update communications set summary = $2, reference_url = $3, occurred_on = $4, updated_at = now(), version = version + 1 where id = $1`,
      [row.id, summary, ctx.latestUrl, f.occurred_on ?? row.occurred_on]);
    await audit(c, WORKFLOW, { entityType: "communication", entityId: row.id, marketplaceId, action: "slack_update", after: { summary } });
    return done(c, f, ctx, "communication", row.id, "updated");
  }
  const ins = (await c.query(
    `insert into communications (marketplace_id, occurred_on, signer_name, method, summary, reference_url, finding_key)
     values ($1,$2,$3,'other',$4,$5,$6) returning id`,
    [marketplaceId, f.occurred_on ?? ctx.latestDate, WORKFLOW.signer, summary, ctx.latestUrl, f.key])).rows[0];
  await audit(c, WORKFLOW, { entityType: "communication", entityId: ins.id, marketplaceId, action: "slack_create", after: { summary } });
  return done(c, f, ctx, "communication", ins.id, ctx.prev ? "updated" : "added");
}

async function applyRequirement(c: pg.PoolClient, f: Finding, marketplaceId: string, ctx: Ctx) {
  let row = (await c.query("select * from requirements where finding_key = $1 for update", [f.key])).rows[0];
  if (!row) row = (await c.query("select * from requirements where marketplace_id = $1 and finding_key is null and removed_at is null for update", [marketplaceId]))
    .rows.find((r: any) => nameKey(r.requirement) === nameKey(f.title));
  if (row) {
    await c.query(`update requirements set requirement = $2, response = coalesce($3, response), source_ref = $4, finding_key = $5,
        updated_at = now(), version = version + 1 where id = $1`, [row.id, f.title, f.summary ?? null, ctx.latestUrl, f.key]);
    await audit(c, WORKFLOW, { entityType: "requirement", entityId: row.id, marketplaceId, action: "slack_update", after: { requirement: f.title } });
    return done(c, f, ctx, "requirement", row.id, "updated");
  }
  const ins = (await c.query(
    `insert into requirements (marketplace_id, category, requirement, response, source_ref, created_by, finding_key)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [marketplaceId, f.requirement_category ?? "other", f.title, f.summary ?? null, ctx.latestUrl, WORKFLOW.signer, f.key])).rows[0];
  await audit(c, WORKFLOW, { entityType: "requirement", entityId: ins.id, marketplaceId, action: "slack_create", after: { requirement: f.title } });
  return done(c, f, ctx, "requirement", ins.id, "added");
}

async function applyAction(c: pg.PoolClient, f: Finding, s: SupplierRef | null, ctx: Ctx, kind: "action" | "blocker" | "decision") {
  let row = (await c.query("select * from corporate_actions where finding_key = $1 for update", [f.key])).rows[0];
  if (!row) row = (await c.query("select * from corporate_actions where kind = $1 and finding_key is null and status = 'open' for update", [kind]))
    .rows.find((r: any) => nameKey(r.title) === nameKey(f.title) && (r.marketplace_id ?? null) === refColumns(s).marketplace_id && (r.vendor_id ?? null) === refColumns(s).vendor_id);
  const status = f.action_status ?? (kind === "decision" ? "done" : "open");
  if (row) {
    await c.query(`update corporate_actions set title = $2, note = coalesce($3, note), owner = coalesce($4, owner), due_date = coalesce($5, due_date),
        status = $6, closed_at = case when $6 = 'open' then null else coalesce(closed_at, now()) end, source_url = $7, finding_key = $8,
        updated_at = now(), version = version + 1 where id = $1`,
      [row.id, f.title, f.summary ?? null, f.owner ?? null, f.due ?? null, status, ctx.latestUrl, f.key]);
    await audit(c, WORKFLOW, { entityType: "corporate_action", entityId: row.id, marketplaceId: row.marketplace_id, action: "slack_update", before: { status: row.status }, after: { status } });
    return done(c, f, ctx, "corporate_action", row.id, "updated");
  }
  const ins = (await c.query(
    `insert into corporate_actions (kind, title, note, owner, due_date, status, closed_at, marketplace_id, vendor_id, source_url, origin, finding_key, created_by)
     values ($1,$2,$3,$4,$5,$6,case when $6 = 'open' then null else now() end,$7,$8,$9,'slack',$10,$11) returning id, marketplace_id`,
    [kind, f.title, f.summary ?? null, f.owner ?? null, f.due ?? null, status, refColumns(s).marketplace_id, refColumns(s).vendor_id, ctx.latestUrl, f.key, WORKFLOW.signer])).rows[0];
  await audit(c, WORKFLOW, { entityType: "corporate_action", entityId: ins.id, marketplaceId: ins.marketplace_id, action: "slack_create", after: { kind, status } });
  return done(c, f, ctx, "corporate_action", ins.id, "added");
}

/** For the scanner: per-channel position, and the threads that already have findings (to revisit for new replies). */
export async function scanState() {
  const pool = getPool();
  const channels = (await pool.query("select channel_key, position_ts, last_success_at, last_attempt_at, last_error from slack_scan_state order by channel_key")).rows;
  const threads = (await pool.query(
    `select channel_key, coalesce(thread_ts, ts) as thread_ts from slack_messages where cardinality(finding_keys) > 0 group by 1, 2 order by 1, 2`)).rows;
  return { ok: true, schema: SLACK_SCHEMA, channels, tracked_threads: threads };
}
