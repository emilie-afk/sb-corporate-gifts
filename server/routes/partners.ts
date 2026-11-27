// Partners: contacts, published contact routes/applications, bulk updates (with preview) and research imports.
// Partner records keep their /api/marketplaces paths; these endpoints add to them.
import { z } from "zod";
import type pg from "pg";
import { Router, updateVersioned } from "../router";
import { query, one, tx, getPool } from "../db";
import { audit } from "../audit";
import { badRequest, notFound } from "../http";
import { parse, text, displayName, url, email, date, version, assertUuid, defined } from "../validate";
import {
  CATEGORIES, CHANNEL_MODELS, OCCASIONS, PRIORITIES, CONTACT_ROLES, ROLE_VERIFICATION, APPLICATION_PURPOSES, isClosed,
} from "../lib/partners";
import { STATUSES, INACTIVE_STATUSES, INACTIVE_REASONS } from "./marketplaces";
import { previewImport, applyImport, reverseImport, type Decision } from "../lib/partnerImport";

const contactSchema = z.object({
  name: displayName(120),
  title: text(500),
  company: text(200),
  role: z.enum(CONTACT_ROLES),
  rank: z.enum(["primary", "backup", "other"]).default("other"),
  email,
  phone: text(80),
  profile_url: url,
  source_urls: z.array(z.string().trim().url().max(1000)).max(12).optional(),
  checked_on: date,
  role_verification: z.enum(ROLE_VERIFICATION).default("needs_verification"),
  confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
  note: text(2000),
});

const routeSchema = z.object({
  purpose: z.enum(APPLICATION_PURPOSES),
  label: text(200),
  url,
  detail: text(2000),
  verification: text(2000),
  checked_on: date,
});

const decisionSchema = z.record(z.string().max(200), z.object({
  action: z.enum(["import", "exclude"]).optional(),
  merge_into: z.string().uuid().optional(),
  create_new: z.boolean().optional(),
  stage: z.literal("skipped").optional(),
  stage_reason: z.string().trim().max(2000).optional(),
  category: z.enum(CATEGORIES).optional(),
  fields: z.record(z.string(), z.enum(["import", "keep"])).optional(),
  contact_roles: z.record(z.string(), z.enum(CONTACT_ROLES)).optional(),
}).strict());

async function assertPartner(id: string) {
  assertUuid(id);
  const m = await one("select id, name from marketplaces where id = $1", [id]);
  if (!m) throw notFound("Partner");
  return m;
}

/** Runs fn in a transaction that is always rolled back (previews). */
async function rolledBack<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try { await c.query("begin"); return await fn(c); }
  finally { await c.query("rollback").catch(() => {}); c.release(); }
}

export function partnerRoutes(r: Router) {
  // ------------------------------------------------------------- contacts
  r.post("/marketplaces/:id/contacts", async ({ params, body, actor }) => {
    const b = await body(); const a = actor(b);
    await assertPartner(params.id);
    const d = parse(contactSchema, b);
    return tx(async (c) => {
      const ins = (await c.query(
        `insert into partner_contacts (marketplace_id, name, title, company, role, rank, email, phone, profile_url, source_urls, checked_on, role_verification, confidence, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [params.id, d.name, d.title ?? null, d.company ?? null, d.role, d.rank, d.email ?? null, d.phone ?? null, d.profile_url ?? null, d.source_urls ?? [],
          d.checked_on ?? null, d.role_verification, d.confidence ?? null, d.note ?? null, a.signer])).rows[0];
      await audit(c, a, { entityType: "partner_contact", entityId: ins.id, marketplaceId: params.id, action: "create", after: ins });
      return { contact: ins };
    });
  });

  r.patch("/marketplaces/:id/contacts/:cid", async ({ params, body, actor }) => {
    const b = await body(); const a = actor(b);
    assertUuid(params.id); assertUuid(params.cid);
    const d = defined(parse(contactSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    return tx(async (c) => {
      const own = await c.query("select 1 from partner_contacts where id = $1 and marketplace_id = $2", [params.cid, params.id]);
      if (!own.rowCount) throw notFound("Contact");
      const { version: v, remove, ...fields } = d;
      if (remove) fields.removed_at = new Date();
      const { before, after } = await updateVersioned(c, "partner_contacts", params.cid, v, fields);
      await audit(c, a, { entityType: "partner_contact", entityId: params.cid, marketplaceId: params.id, action: remove ? "remove" : "update", before, after });
      return { contact: after };
    });
  });

  // --------------------------------------------- contact routes / applications
  r.post("/marketplaces/:id/applications", async ({ params, body, actor }) => {
    const b = await body(); const a = actor(b);
    await assertPartner(params.id);
    const d = parse(routeSchema, b);
    if (!d.url && !d.detail) throw badRequest("Add a link or describe the route.", { fields: { url: "Required without a description" } });
    return tx(async (c) => {
      const ins = (await c.query(
        `insert into partner_applications (marketplace_id, purpose, label, url, detail, verification, checked_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [params.id, d.purpose, d.label ?? null, d.url ?? null, d.detail ?? null, d.verification ?? null, d.checked_on ?? null, a.signer])).rows[0];
      await audit(c, a, { entityType: "partner_application", entityId: ins.id, marketplaceId: params.id, action: "create", after: ins });
      return { application: ins };
    });
  });

  r.patch("/marketplaces/:id/applications/:aid", async ({ params, body, actor }) => {
    const b = await body(); const a = actor(b);
    assertUuid(params.id); assertUuid(params.aid);
    const d = defined(parse(routeSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    return tx(async (c) => {
      const own = await c.query("select 1 from partner_applications where id = $1 and marketplace_id = $2", [params.aid, params.id]);
      if (!own.rowCount) throw notFound("Contact route");
      const { version: v, remove, ...fields } = d;
      if (remove) fields.removed_at = new Date();
      const { before, after } = await updateVersioned(c, "partner_applications", params.aid, v, fields);
      await audit(c, a, { entityType: "partner_application", entityId: params.aid, marketplaceId: params.id, action: remove ? "remove" : "update", before, after });
      return { application: after };
    });
  });

  // ------------------------------------------------- bulk field update (preview)
  // Category, priority, owner, channel models or occasion tags for several partners. dry_run lists every affected
  // record with its current and new value; saving applies exactly the previewed IDs, all-or-nothing.
  r.post("/marketplaces/bulk-update", async ({ body, actor }) => {
    const b = await body(); const a = actor(b);
    const d = parse(z.object({
      dry_run: z.boolean().default(false),
      ids: z.array(z.string().uuid()).min(1, "Choose at least one partner").max(300),
      set: z.object({
        category: z.enum(CATEGORIES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        owner: text(80),
        add_channel_models: z.array(z.enum(CHANNEL_MODELS)).optional(),
        add_occasion_tags: z.array(z.enum(OCCASIONS)).optional(),
      }).strict(),
    }), b);
    const set = defined(d.set) as Record<string, any>;
    if (!Object.keys(set).length) throw badRequest("Choose what to change.");
    if ("status" in (b.set ?? {})) throw badRequest("Stages are changed with Change stage, which shows the affected records.");
    const run = async (c: pg.PoolClient) => {
      const ids = [...new Set(d.ids)];
      const rows = (await c.query("select * from marketplaces where id = any($1) order by name for update", [ids])).rows;
      if (rows.length !== ids.length) throw badRequest("Some partners were not found.");
      const changes = rows.map((m) => {
        const next: Record<string, unknown> = {};
        if (set.category !== undefined) next.category = set.category;
        if (set.priority !== undefined) next.priority = set.priority;
        if ("owner" in set) next.owner = set.owner;
        if (set.add_channel_models) next.channel_models = [...new Set([...m.channel_models, ...set.add_channel_models])];
        if (set.add_occasion_tags) next.occasion_tags = [...new Set([...m.occasion_tags, ...set.add_occasion_tags])];
        const diff = Object.entries(next).filter(([k, v]) => JSON.stringify(m[k]) !== JSON.stringify(v)).map(([field, after]) => ({ field, before: m[field], after }));
        return { id: m.id, name: m.name, status: m.status, version: m.version, diff };
      });
      if (!d.dry_run) for (const ch of changes) {
        if (!ch.diff.length) continue;
        const fields = Object.fromEntries(ch.diff.map((x) => [x.field, x.after]));
        const { before, after } = await updateVersioned(c, "marketplaces", ch.id, ch.version, fields);
        await audit(c, a, { entityType: "marketplace", entityId: ch.id, marketplaceId: ch.id, action: "bulk_update", before: pick(before, Object.keys(fields)), after: pick(after, Object.keys(fields)) });
      }
      return { rows: changes.map(({ version: _v, ...x }) => x), changed: changes.filter((x) => x.diff.length).length, unchanged: changes.filter((x) => !x.diff.length).length };
    };
    return d.dry_run ? rolledBack(run) : tx(run);
  });

  // ------------------------------------------------- bulk stage change (preview)
  // Never applied blind: the preview lists every affected record (current → new stage), and saving requires the
  // exact list of IDs that was previewed. Each record gets its own status history entry.
  r.post("/marketplaces/bulk-stage", async ({ body, actor }) => {
    const b = await body(); const a = actor(b);
    const d = parse(z.object({
      dry_run: z.boolean().default(false),
      ids: z.array(z.string().uuid()).min(1, "Choose at least one partner").max(100),
      confirm_ids: z.array(z.string().uuid()).optional(),
      to_status: z.enum(STATUSES),
      reason: z.enum(INACTIVE_REASONS).nullable().optional(),
      detail: text(2000),
    }), b);
    const needsReason = (INACTIVE_STATUSES as readonly string[]).includes(d.to_status);
    if (needsReason && !d.reason) throw badRequest("A reason is required for this stage.", { fields: { reason: "Required" } });
    const ids = [...new Set(d.ids)].sort();
    if (!d.dry_run && JSON.stringify([...new Set(d.confirm_ids ?? [])].sort()) !== JSON.stringify(ids))
      throw badRequest("Preview the change and confirm the listed partners before saving.");
    const run = async (c: pg.PoolClient) => {
      const rows = (await c.query("select id, name, status, version from marketplaces where id = any($1) order by name for update", [ids])).rows;
      if (rows.length !== ids.length) throw badRequest("Some partners were not found.");
      const out = rows.map((m) => ({ id: m.id, name: m.name, from: m.status, to: d.to_status, unchanged: m.status === d.to_status }));
      if (!d.dry_run) for (const m of rows) {
        if (m.status === d.to_status) continue;
        await c.query("update marketplaces set status = $2, status_evidence_at = now(), updated_at = now(), version = version + 1 where id = $1", [m.id, d.to_status]);
        await c.query(`insert into status_history (marketplace_id, from_status, to_status, reason, detail, signer_name, auth_subject) values ($1,$2,$3,$4,$5,$6,$7)`,
          [m.id, m.status, d.to_status, needsReason ? d.reason : null, d.detail ?? null, a.signer, a.sub]);
        await audit(c, a, { entityType: "marketplace", entityId: m.id, marketplaceId: m.id, action: "bulk_status_change", before: { status: m.status }, after: { status: d.to_status, reason: d.reason ?? null } });
      }
      // Open tasks on partners moving to a closed stage are listed for reconciliation, never closed automatically.
      const open = isClosed(d.to_status) ? (await c.query(
        `select t.id, t.title, t.delivery_status, m.name as partner from corporate_task_requests t join marketplaces m on m.id = any(t.marketplace_ids)
         where m.id = any($1) and t.slack_status = 'open' and t.delivery_status <> 'dismissed'
         union all select k.id, k.title, k.status, m.name from corporate_actions k join marketplaces m on m.id = k.marketplace_id where m.id = any($1) and k.status = 'open'`, [ids])).rows : [];
      return { rows: out, changing: out.filter((x) => !x.unchanged).length, open_tasks: open };
    };
    return d.dry_run ? rolledBack(run) : tx(run);
  });

  // ---------------------------------------------------------- research import
  const importSchema = z.object({
    csv: z.string().min(1, "Add the CSV").max(3_000_000, "The file is too large"),
    source_name: z.string().trim().min(1).max(200).default("Partner research import"),
    decisions: decisionSchema.default({}),
  });

  r.post("/partners/import/preview", async ({ body }) => {
    const d = parse(importSchema, await body());
    const p = await rolledBack((c) => previewImport(c, d.csv, d.decisions as Record<string, Decision>));
    const { mapped: _m, ...rest } = p;
    return rest;
  });

  r.post("/partners/import/apply", async ({ body, actor }) => {
    const b = await body(); const a = actor(b);
    const d = parse(importSchema, b);
    return tx((c) => applyImport(c, a, d.csv, d.source_name, d.decisions as Record<string, Decision>));
  });

  r.get("/partners/import/batches", async () => ({
    batches: await query(`select id, source_name, row_count, status, summary, created_by, created_at, reversed_at, reversed_by from partner_import_batches order by created_at desc limit 50`),
  }));

  r.get("/partners/import/batches/:id", async ({ params }) => {
    assertUuid(params.id);
    const b = await one("select * from partner_import_batches where id = $1", [params.id]);
    if (!b) throw notFound("Import batch");
    const items = await query(`select i.line, i.company, i.outcome, i.marketplace_id, i.created_partner, i.field_changes, i.created_rows, i.conflicts, i.decision, m.name as partner_name
      from partner_import_items i left join marketplaces m on m.id = i.marketplace_id where i.batch_id = $1 order by i.line`, [params.id]);
    return { batch: b, items };
  });

  r.post("/partners/import/batches/:id/reverse", async ({ params, body, actor }) => {
    const b = await body(); const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ dry_run: z.boolean().default(false) }), b);
    return d.dry_run ? rolledBack((c) => reverseImport(c, a, params.id)) : tx((c) => reverseImport(c, a, params.id));
  });
}

function pick(o: any, keys: string[]) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }
