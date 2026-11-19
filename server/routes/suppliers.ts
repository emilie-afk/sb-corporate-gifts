// Marketplace Resources (partners, product vendors kept for history), Corporate Gifts tasks, follow-ups, samples, the review queue and scan status.
// Signed-in team members (the approved Google login) can read and edit everything here; every change is audited
// with the typed signature and the verified Google account.
import { z } from "zod";
import type pg from "pg";
import { Router, updateVersioned } from "../router";
import { query, one, tx, getPool } from "../db";
import { audit, diff, type Actor } from "../audit";
import { badRequest, notFound, conflict, HttpError } from "../http";
import { INACTIVE_REASONS } from "./marketplaces";
import { setRelationshipStatus, setApplication } from "../lib/slackWorkflow";
import { routeFor, routeIsFree, resolveRequest, decideRoute, reportDate, resolutionOf, RESOLUTION_SQL } from "../lib/taskRouting";
import { parse, text, reqText, displayName, url, date, version, assertUuid, defined } from "../validate";
import {
  RESOURCE_TYPES, RESOURCE_TYPE_KEYS, SAMPLE_STATUSES, parseSupplierRef, requireSupplier, refColumns, refString,
  assertSupplier, type SupplierRef, businessToday, linkKey,
} from "../lib/suppliers";

const resourceFields = {
  resource_type: z.enum(RESOURCE_TYPE_KEYS),
  link_needed: z.boolean().optional(),
  partner_specific: z.boolean().optional(),
  internal: z.boolean().optional(),
  title: displayName(200),
  link_url: url,
  note: text(2000),
  source_url: url,
  effective_date: date,
  last_confirmed_on: date,
  series_key: text(120),
  requirement_id: z.string().uuid().nullable().optional(),
  action_id: z.string().uuid().nullable().optional(),
};

export const TASK_COLS = `t.id, t.task_key, t.title, t.brief, t.owner_hint, t.due_date, t.slack_status, t.marketplace_ids,
  (select array_agg(m.name order by m.name) from marketplaces m where m.id = any(t.marketplace_ids)) as marketplace_names,
  t.source_refs, t.content_version, t.delivery_status, t.delivery_error, t.delivered_version, t.tracker_task_id, t.tracker_status,
  t.tracker_assignee, t.tracker_due_date, t.tracker_open_url, t.delivered_at, t.origin, t.created_by, t.created_at, t.updated_at, t.version,
  t.route, t.route_reason, t.route_decided_by, t.owner_name, t.owner_team, ${RESOLUTION_SQL()} as resolution_state, t.resolved_at, t.resolved_by, t.resolved_in,
  to_char(t.completed_on, 'YYYY-MM-DD') as completed_on, t.completion_source, t.resolve_requested_at, t.resolve_requested_by, t.resolve_error, t.evidence`;

const SUPPLIER_JOIN = `
  left join marketplaces m on m.id = r.marketplace_id
  left join vendors v on v.id = r.vendor_id`;
const supplierCols = (alias = "r") =>
  `case when ${alias}.marketplace_id is not null then 'partner:' || ${alias}.marketplace_id else 'vendor:' || ${alias}.vendor_id end as supplier,
   coalesce(m.name, v.name) as supplier_name`;

async function checkLinks(c: pg.PoolClient, s: SupplierRef, d: { requirement_id?: string | null; action_id?: string | null }) {
  if (d.requirement_id) {
    const r = await one("select marketplace_id from requirements where id = $1 and removed_at is null", [d.requirement_id], c);
    if (!r) throw badRequest("That requirement does not exist.", { fields: { requirement_id: "Not found" } });
    if (s.kind !== "partner" || r.marketplace_id !== s.id) throw badRequest("The requirement belongs to a different partner.", { fields: { requirement_id: "Different partner" } });
  }
  if (d.action_id) {
    const a = await one("select marketplace_id, vendor_id from corporate_actions where id = $1", [d.action_id], c);
    if (!a) throw badRequest("That action does not exist.", { fields: { action_id: "Not found" } });
    const own = s.kind === "partner" ? a.marketplace_id : a.vendor_id;
    if ((a.marketplace_id || a.vendor_id) && own !== s.id) throw badRequest("The action belongs to a different supplier.", { fields: { action_id: "Different supplier" } });
  }
}

/**
 * Creates a resource for a partner or vendor, or (s = null) in the general corporate library. The link is stored
 * with its comparison key, so one document is held at most once per marketplace. With supersedes_id, the earlier
 * current resource of the same supplier becomes Superseded.
 */
export async function createResource(c: pg.PoolClient, s: SupplierRef | null, d: any, a: Actor, extra: { origin?: "manual" | "slack"; finding_key?: string | null; supersedes_id?: string | null; shared_from_id?: string | null } = {}) {
  const section = RESOURCE_TYPES[d.resource_type];
  const lk = linkKey(d.link_url);
  if (lk) {
    const dup = (await c.query(
      `select id, title from supplier_resources where link_key = $1 and status = 'current' and removed_at is null and excluded_at is null
         and ${s ? "marketplace_id is not distinct from $2 and vendor_id is not distinct from $3" : "scope = 'library'"} limit 1`,
      s ? [lk, refColumns(s).marketplace_id, refColumns(s).vendor_id] : [lk])).rows[0];
    if (dup && dup.id !== extra.supersedes_id) throw badRequest(`This link is already recorded here ("${dup.title}").`, { fields: { link_url: "Already recorded" } });
  }
  const ins = await c.query(
    `insert into supplier_resources (marketplace_id, vendor_id, section, resource_type, title, link_url, note, source_url, effective_date,
       last_confirmed_on, series_key, requirement_id, action_id, origin, finding_key, created_by, scope, link_key, link_kind, link_needed,
       partner_specific, internal, shared_from_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning *`,
    [refColumns(s).marketplace_id, refColumns(s).vendor_id, section, d.resource_type, d.title, d.link_url ?? null, d.note ?? null,
      d.source_url ?? null, d.effective_date ?? null, d.last_confirmed_on ?? null, d.series_key ?? null, d.requirement_id ?? null,
      d.action_id ?? null, extra.origin ?? "manual", extra.finding_key ?? null, a.signer, s ? "supplier" : "library", lk,
      d.link_url ? (d.link_kind ?? (lk?.startsWith("slack-file:") ? "slack_file" : "url")) : null, !d.link_url && !!d.link_needed,
      !!d.partner_specific, !!d.internal, extra.shared_from_id ?? null],
  );
  const created = ins.rows[0];
  if (extra.supersedes_id) await supersede(c, extra.supersedes_id, created, a);
  await audit(c, a, { entityType: "supplier_resource", entityId: created.id, marketplaceId: refColumns(s).marketplace_id, action: extra.shared_from_id ? "reuse" : "create", after: created });
  return created;
}

export async function supersede(c: pg.PoolClient, oldId: string, replacement: any, a: Actor) {
  const old = (await c.query("select * from supplier_resources where id = $1 for update", [oldId])).rows[0];
  if (!old) throw badRequest("The resource to replace does not exist.", { fields: { supersedes_id: "Not found" } });
  if (old.marketplace_id !== replacement.marketplace_id || old.vendor_id !== replacement.vendor_id) throw badRequest("A replacement must belong to the same supplier.");
  if (old.status !== "current") throw badRequest("That resource is already superseded.");
  if (old.id === replacement.id) return;
  const after = (await c.query(
    `update supplier_resources set status = 'superseded', superseded_by = $2, superseded_at = now(), updated_at = now(), version = version + 1
     where id = $1 returning *`, [oldId, replacement.id])).rows[0];
  await audit(c, a, { entityType: "supplier_resource", entityId: oldId, marketplaceId: old.marketplace_id, action: "supersede",
    before: { status: "current" }, after: { status: "superseded", superseded_by: replacement.id } });
  return after;
}

export function supplierRoutes(r: Router) {
  // ------------------------------------------------------------- suppliers
  r.get("/suppliers", async () => {
    const counts = `
      (select count(*) from supplier_resources x where x.%COL% = s.id and x.removed_at is null and x.excluded_at is null and x.status = 'current')::int as current_resources,
      (select count(*) from supplier_resources x where x.%COL% = s.id and x.removed_at is null and x.excluded_at is null and x.status = 'superseded')::int as superseded_resources`;
    const partners = await query(
      `select 'partner:' || s.id as ref, 'partner' as kind, s.id, s.name, s.provider_type, s.status, s.sales_role, s.application_status,
         ${counts.replace(/%COL%/g, "marketplace_id")},
         (select count(*) from corporate_task_requests t where s.id = any(t.marketplace_ids) and t.delivery_status not in ('dismissed', 'resolved') and t.slack_status = 'open')::int as open_tasks
       from marketplaces s order by s.name`);
    const vendors = await query(
      `select 'vendor:' || s.id as ref, 'vendor' as kind, s.id, s.name, s.website_url, s.note, s.version, ${counts.replace(/%COL%/g, "vendor_id")}
       from vendors s order by s.name`);
    // Vendor names already used on gifts and cost sources that have no vendor record yet (to create one in a click).
    const unlinked = await query(
      `select distinct name from (
         select btrim(website_vendor) as name from products where website_vendor is not null and btrim(website_vendor) <> ''
         union select btrim(vendor) from source_mappings where vendor is not null and btrim(vendor) <> '') n
       where not exists (select 1 from vendors v where lower(btrim(v.name)) = lower(n.name)) order by name`);
    return { partners, vendors, unlinked_vendor_names: unlinked.map((u: any) => u.name) };
  });

  r.post("/vendors", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ name: displayName(120), website_url: url, note: text(2000) }), b);
    return tx(async (c) => {
      const dup = await one("select id from vendors where lower(btrim(name)) = lower(btrim($1))", [d.name], c);
      if (dup) throw badRequest("A vendor with that name already exists.", { fields: { name: "Already exists" } });
      const v = (await c.query("insert into vendors (name, website_url, note, created_by) values ($1,$2,$3,$4) returning *",
        [d.name, d.website_url ?? null, d.note ?? null, a.signer])).rows[0];
      await audit(c, a, { entityType: "vendor", entityId: v.id, action: "create", after: v });
      return { vendor: v };
    });
  });

  r.patch("/vendors/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ name: displayName(120).optional(), website_url: url, note: text(2000), version }), b);
    const { version: v, ...fields } = d;
    return tx(async (c) => {
      if (fields.name) {
        const dup = await one("select id from vendors where lower(btrim(name)) = lower(btrim($1)) and id <> $2", [fields.name, params.id], c);
        if (dup) throw badRequest("A vendor with that name already exists.", { fields: { name: "Already exists" } });
      }
      const { before, after } = await updateVersioned(c, "vendors", params.id, v, defined(fields));
      await audit(c, a, { entityType: "vendor", entityId: params.id, action: "update", ...diff(before, after) });
      return { vendor: after };
    });
  });

  // ------------------------------------------------------------- resources
  r.get("/supplier-resources", async ({ query: q }) => {
    const s = requireSupplier(q.get("supplier"));
    const sup = await assertSupplier(getPool(), s);
    const col = s.kind === "partner" ? "marketplace_id" : "vendor_id";
    const resources = await query(
      `select r.*, ${supplierCols()}, rq.requirement as requirement_text, rq.confirmation_state as requirement_state,
         ac.title as action_title, ac.status as action_status, ac.due_date as action_due
       from supplier_resources r ${SUPPLIER_JOIN}
       left join requirements rq on rq.id = r.requirement_id
       left join corporate_actions ac on ac.id = r.action_id
       where r.${col} = $1 and r.removed_at is null and r.excluded_at is null
       order by r.section, r.status, coalesce(r.effective_date, r.last_confirmed_on, r.created_at::date) desc, r.created_at desc`, [s.id]);
    const requirements = s.kind === "partner"
      ? await query("select id, category, requirement, confirmation_state from requirements where marketplace_id = $1 and removed_at is null order by created_at", [s.id])
      : [];
    const actions = await query(`select id, kind, title, owner, due_date, status from corporate_actions where ${col} = $1 and excluded_at is null order by status, due_date nulls last, created_at`, [s.id]);
    const samples = await query(`select id, label, status, status_on from sample_requests where ${col} = $1 and excluded_at is null order by updated_at desc`, [s.id]);
    const tasks = s.kind === "partner"
      ? await query(`select ${TASK_COLS} from corporate_task_requests t where $1 = any(t.marketplace_ids) and t.delivery_status not in ('dismissed', 'resolved') order by (t.slack_status = 'open') desc, t.due_date nulls last, t.created_at desc`, [s.id])
      : [];
    const m = s.kind === "partner" ? await one("select status, sales_role, application_status, application_date, aliases from marketplaces where id = $1", [s.id]) : null;
    return { supplier: { ref: refString(s), kind: s.kind, id: sup.id, name: sup.name, ...(m ?? {}) }, resources, requirements, actions, samples, tasks };
  });

  r.post("/supplier-resources", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const s = b?.supplier === "library" ? null : requireSupplier(b?.supplier);
    const d = parse(z.object({ ...resourceFields, supersedes_id: z.string().uuid().nullable().optional() }), b);
    return tx(async (c) => {
      if (s) { await assertSupplier(c, s); await checkLinks(c, s, d); }
      else if (d.requirement_id || d.action_id) throw badRequest("Library materials are not linked to a requirement or action.");
      return { resource: await createResource(c, s, d, a, { supersedes_id: d.supersedes_id ?? null }) };
    });
  });

  // General corporate materials (not tied to one marketplace), available to attach to eligible marketplaces.
  r.get("/library-resources", async () => ({
    resources: await query(
      `select r.*, (select count(*) from supplier_resources x where x.shared_from_id = r.id and x.status = 'current' and x.removed_at is null and x.excluded_at is null)::int as used_on
       from supplier_resources r where r.scope = 'library' and r.removed_at is null and r.excluded_at is null
       order by r.status, r.link_needed desc, r.resource_type, r.title`),
  }));

  // "Use for other marketplaces": the same link, title, type and source reference on other eligible partners.
  // Partners that already hold the link are skipped; a partner-specific resource needs an explicit confirmation.
  // Only references inside Corporate Gifts are added; the document's own sharing settings are not touched.
  r.post("/supplier-resources/:id/share", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ marketplace_ids: z.array(z.string().uuid()).min(1, "Choose at least one marketplace").max(30), confirm_partner_specific: z.boolean().optional(), dry_run: z.boolean().optional() }), b);
    const run = async (c: pg.PoolClient) => {
      const src = await one("select * from supplier_resources where id = $1 and removed_at is null and excluded_at is null", [params.id], c);
      if (!src) throw notFound("Resource");
      if (!src.link_url || !src.link_key) throw badRequest("Add the link first; only linked resources can be used for other marketplaces.");
      if (src.status !== "current") throw badRequest("Only the current version can be reused.");
      if (src.internal) throw badRequest("This is an internal reference; it is not attached to marketplaces.");
      if (src.partner_specific && !d.confirm_partner_specific) throw new HttpError(409, "needs_confirmation", "This resource is marked partner-specific. Confirm to use it for other marketplaces.");
      const ids = [...new Set(d.marketplace_ids)].filter((x) => x !== src.marketplace_id);
      const rows = (await c.query("select id, name, sales_role from marketplaces where id = any($1) order by name", [ids])).rows;
      if (rows.length !== ids.length) throw badRequest("Choose existing marketplaces.", { fields: { marketplace_ids: "Not found" } });
      const added: { id: string; name: string }[] = [], skipped: { id: string; name: string; reason: string }[] = [];
      for (const m of rows) {
        if (m.sales_role !== "confirmed") { skipped.push({ id: m.id, name: m.name, reason: "Sales role unclear" }); continue; }
        const has = await one(`select id from supplier_resources where marketplace_id = $1 and link_key = $2 and status = 'current' and removed_at is null and excluded_at is null`, [m.id, src.link_key], c);
        if (has) { skipped.push({ id: m.id, name: m.name, reason: "Already has this link" }); continue; }
        await createResource(c, { kind: "partner", id: m.id }, {
          resource_type: src.resource_type, title: src.title, link_url: src.link_url, link_kind: src.link_kind, note: src.note, source_url: src.source_url,
          effective_date: src.effective_date, last_confirmed_on: src.last_confirmed_on, series_key: src.series_key, partner_specific: false,
        }, a, { shared_from_id: src.shared_from_id ?? src.id });
        added.push({ id: m.id, name: m.name });
      }
      return { added, skipped };
    };
    if (d.dry_run) {
      const pool = getPool();
      const c = await pool.connect();
      try { await c.query("begin"); return { dry_run: true, ...(await run(c)) }; } finally { await c.query("rollback").catch(() => {}); c.release(); }
    }
    return tx(run);
  });

  r.patch("/supplier-resources/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({
      resource_type: resourceFields.resource_type.optional(), title: displayName(200).optional(), link_url: url, note: text(2000),
      source_url: url, effective_date: date, last_confirmed_on: date, series_key: text(120),
      requirement_id: resourceFields.requirement_id, action_id: resourceFields.action_id, version,
      link_needed: z.boolean().optional(), partner_specific: z.boolean().optional(), internal: z.boolean().optional(),
    }), b);
    const { version: v, ...fields } = d;
    return tx(async (c) => {
      const cur = await one("select * from supplier_resources where id = $1", [params.id], c);
      if (!cur) throw notFound("Resource");
      const s = cur.scope === "library" ? null : parseSupplierRef(cur.marketplace_id ? `partner:${cur.marketplace_id}` : `vendor:${cur.vendor_id}`)!;
      if (s) await checkLinks(c, s, fields);
      const set: Record<string, unknown> = defined(fields);
      if (fields.resource_type) set.section = RESOURCE_TYPES[fields.resource_type];
      if (fields.link_url !== undefined) {
        // Adding or changing the link: same duplicate rule as on creation; "Link needed" ends once a link is saved.
        const lk = linkKey(fields.link_url);
        if (lk) {
          const dup = await one(`select title from supplier_resources where link_key = $1 and id <> $2 and status = 'current' and removed_at is null and excluded_at is null
            and ${s ? "marketplace_id is not distinct from $3 and vendor_id is not distinct from $4" : "scope = 'library'"} limit 1`,
            s ? [lk, params.id, cur.marketplace_id, cur.vendor_id] : [lk, params.id], c);
          if (dup) throw badRequest(`This link is already recorded here ("${dup.title}").`, { fields: { link_url: "Already recorded" } });
        }
        set.link_key = lk;
        set.link_kind = lk ? (lk.startsWith("slack-file:") ? "slack_file" : "url") : null;
        if (lk) set.link_needed = false;
      }
      if (set.link_needed === true && (fields.link_url ?? cur.link_url)) set.link_needed = false;
      const { before, after } = await updateVersioned(c, "supplier_resources", params.id, v, set);
      await audit(c, a, { entityType: "supplier_resource", entityId: params.id, marketplaceId: cur.marketplace_id, action: cur.link_needed && after.link_url ? "link_added" : "update", ...diff(before, after) });
      return { resource: after };
    });
  });

  // ------------------------------------------------------- actions/blockers
  const actionFields = {
    kind: z.enum(["action", "blocker", "decision"]),
    title: displayName(300),
    note: text(2000),
    owner: text(80),
    due_date: date,
    source_url: url,
    requirement_id: z.string().uuid().nullable().optional(),
  };
  r.get("/actions", async ({ query: q }) => {
    const status = q.get("status") ?? "open";
    if (!["open", "all"].includes(status)) throw badRequest("status must be open or all");
    const rows = await query(
      `select r.*, ${supplierCols()}, (r.status = 'open' and r.due_date is not null and r.due_date < $1::date) as overdue
       from corporate_actions r ${SUPPLIER_JOIN} where r.excluded_at is null ${status === "open" ? "and r.status = 'open'" : ""}
       order by (r.status = 'open') desc, r.due_date nulls last, r.created_at desc`, [businessToday()]);
    return { actions: rows.map((x: any) => ({ ...x, supplier: x.marketplace_id || x.vendor_id ? x.supplier : null })) };
  });

  r.post("/actions", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object(actionFields), b);
    const s = b?.supplier ? requireSupplier(b.supplier) : null;
    return tx(async (c) => {
      if (s) { await assertSupplier(c, s); await checkLinks(c, s, d); }
      else if (d.requirement_id) throw badRequest("Choose the partner the requirement belongs to.", { fields: { supplier: "Required with a requirement" } });
      const row = (await c.query(
        `insert into corporate_actions (kind, title, note, owner, due_date, source_url, requirement_id, marketplace_id, vendor_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [d.kind, d.title, d.note ?? null, d.owner ?? null, d.due_date ?? null, d.source_url ?? null, d.requirement_id ?? null,
          refColumns(s).marketplace_id, refColumns(s).vendor_id, a.signer])).rows[0];
      await audit(c, a, { entityType: "corporate_action", entityId: row.id, marketplaceId: row.marketplace_id, action: "create", after: row });
      return { action: row };
    });
  });

  r.patch("/actions/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({
      title: displayName(300).optional(), note: text(2000), owner: text(80), due_date: date, source_url: url,
      status: z.enum(["open", "done", "cancelled"]).optional(), version,
    }), b);
    const { version: v, ...fields } = d;
    return tx(async (c) => {
      const set: Record<string, unknown> = defined(fields);
      if (fields.status) set.closed_at = fields.status === "open" ? null : new Date();
      const { before, after } = await updateVersioned(c, "corporate_actions", params.id, v, set);
      await audit(c, a, { entityType: "corporate_action", entityId: params.id, marketplaceId: after.marketplace_id, action: "update", ...diff(before, after) });
      return { action: after };
    });
  });

  // ------------------------------------------------------------- samples
  r.get("/samples", async () => ({
    samples: (await query(`select r.*, ${supplierCols()} from sample_requests r ${SUPPLIER_JOIN} where r.excluded_at is null order by r.updated_at desc`))
      .map((x: any) => ({ ...x, supplier: x.marketplace_id || x.vendor_id ? x.supplier : null })),
  }));

  r.post("/samples", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ label: displayName(200), status: z.enum(SAMPLE_STATUSES), status_on: date, note: text(2000), source_url: url }), b);
    const s = b?.supplier ? requireSupplier(b.supplier) : null;
    return tx(async (c) => {
      if (s) await assertSupplier(c, s);
      const row = (await c.query(
        `insert into sample_requests (label, status, status_on, note, source_url, marketplace_id, vendor_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [d.label, d.status, d.status_on ?? null, d.note ?? null, d.source_url ?? null, refColumns(s).marketplace_id, refColumns(s).vendor_id, a.signer])).rows[0];
      await audit(c, a, { entityType: "sample_request", entityId: row.id, marketplaceId: row.marketplace_id, action: "create", after: row });
      return { sample: row };
    });
  });

  r.patch("/samples/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ label: displayName(200).optional(), status: z.enum(SAMPLE_STATUSES).optional(), status_on: date, note: text(2000), source_url: url, version }), b);
    const { version: v, ...fields } = d;
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "sample_requests", params.id, v, defined(fields));
      await audit(c, a, { entityType: "sample_request", entityId: params.id, marketplaceId: after.marketplace_id, action: "update", ...diff(before, after) });
      return { sample: after };
    });
  });

  // --------------------------------------------------------- review queue
  r.get("/review-items", async ({ query: q }) => {
    const status = q.get("status") ?? "open";
    if (!["open", "resolved", "dismissed", "all"].includes(status)) throw badRequest("Unknown status");
    return { items: await query(`select * from review_items ${status === "all" ? "" : "where status = $1"} order by created_at desc`, status === "all" ? [] : [status]) };
  });

  // Apply one of the item's proposed changes (e.g. "Apply status: Live"); the item closes only when the change is saved.
  r.post("/review-items/:id/apply", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ option: z.number().int().min(0).max(9), reason: z.enum(INACTIVE_REASONS).nullable().optional(), note: text(2000), version }), b);
    return tx(async (c) => {
      const item = await one("select * from review_items where id = $1 for update", [params.id], c);
      if (!item) throw notFound("Review item");
      if (item.version !== d.version) throw conflict("This item changed since you opened it. Reload and try again.");
      if (item.status !== "open") throw badRequest("This item is already closed.");
      const opt = (item.options ?? [])[d.option];
      if (item.format !== 2 || !opt || (!item.marketplace_id && opt.change?.type !== "complete")) throw badRequest("This item has no change to apply. Dismiss it instead.");
      const detail = `Review decision: ${item.title}${d.note ? `\n${d.note}` : ""}`;
      let applied: any;
      if (opt.change.type === "complete") {
        // "Confirm completion": the chosen item is completed with the Slack message as evidence.
        const src = (item.sources ?? []).slice(-1)[0];
        applied = (await resolveRequest(c, opt.change.task_request_id, { actor: a, by: a.signer, source: "slack", completed_on: opt.change.completed_on ?? null, permalink: src?.permalink, note: d.note ?? undefined })).outcome;
      } else if (opt.change.field === "relationship_status") applied = await setRelationshipStatus(c, a, item.marketplace_id, opt.change.to, detail, d.reason ?? null, new Date());
      else applied = await setApplication(c, a, item.marketplace_id, { [opt.change.field]: opt.change.to }, detail, new Date());
      const after = (await c.query(
        `update review_items set status = 'resolved', resolution = 'applied', resolution_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now(), version = version + 1
         where id = $1 returning *`, [params.id, `${opt.label}${d.note ? ` — ${d.note}` : ""}`, a.signer])).rows[0];
      await audit(c, a, { entityType: "review_item", entityId: params.id, marketplaceId: item.marketplace_id, action: "apply", after: { option: opt.label, applied: applied ?? "already set", sources: item.sources } });
      return { item: after };
    });
  });

  r.post("/review-items/:id/dismiss", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ note: text(2000), version }), b);
    return tx(async (c) => {
      const item = await one("select * from review_items where id = $1 for update", [params.id], c);
      if (!item) throw notFound("Review item");
      if (item.version !== d.version) throw conflict("This item changed since you opened it. Reload and try again.");
      if (item.status !== "open") throw badRequest("This item is already closed.");
      const after = (await c.query(
        `update review_items set status = 'dismissed', resolution = 'dismissed', resolution_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now(), version = version + 1
         where id = $1 returning *`, [params.id, d.note ?? "Dismissed", a.signer])).rows[0];
      await audit(c, a, { entityType: "review_item", entityId: params.id, marketplaceId: item.marketplace_id ?? null, action: "dismiss", after: { note: d.note ?? null } });
      return { item: after };
    });
  });

  // ------------------------------------------------------- Corporate Gifts tasks
  // Requests become Task Tracker tasks through the Marketing Dashboard (reviewed and assigned there). Here: list,
  // add one by hand, retry a failed delivery (same id, so never a second task), resolve one handled without a task,
  // or dismiss one that needs no action. "To review" = waiting for the dashboard, in review there, being sent, failed,
  // or waiting for Task Tracker to complete a resolve.
  r.get("/task-requests", async ({ query: q }) => {
    const status = q.get("status") ?? "active";
    if (!["review", "active", "all"].includes(status)) throw badRequest("status must be review, active or all");
    const toReviewSql = `(t.delivery_status in ('pending', 'in_review', 'sending', 'failed') or ${RESOLUTION_SQL()} = 'requested')`;
    const where = status === "review" ? `where ${toReviewSql}`
      : status === "active" ? "where t.delivery_status not in ('dismissed', 'resolved')" : "";
    const rows = await query(
      `select ${TASK_COLS}, (t.slack_status = 'open' and t.due_date is not null and t.due_date < $1::date and coalesce(t.tracker_status, 'open') = 'open') as overdue
       from corporate_task_requests t ${where}
       order by (t.delivery_status in ('failed', 'pending', 'in_review')) desc, t.due_date nulls last, t.created_at desc`, [businessToday()]);
    const toReview = (await one(`select count(*)::int as n from corporate_task_requests t where ${toReviewSql}`))!.n;
    return { tasks: rows, to_review: toReview };
  });

  r.post("/task-requests", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({
      title: displayName(300), brief: text(1500), owner_hint: text(80), due_date: date,
      marketplace_ids: z.array(z.string().uuid()).min(1, "Choose at least one marketplace").max(20),
      route: z.enum(["marketing", "checkoff"]).optional(),
    }), b);
    return tx(async (c) => {
      const ids = [...new Set(d.marketplace_ids)];
      const ok = (await c.query("select id from marketplaces where id = any($1) and sales_role = 'confirmed'", [ids])).rows.length;
      if (ok !== ids.length) throw badRequest("Choose marketplaces that sell our corporate gifts.", { fields: { marketplace_ids: "Not eligible" } });
      const key = `manual-${(await c.query("select gen_random_uuid() as k")).rows[0].k}`;
      const rt = d.route ? { route: d.route, reason: d.route === "marketing" ? "Added as a Marketing task" : "Added as a check-off item", owner_name: null, owner_team: null } : await routeFor(c, d.owner_hint);
      const row = (await c.query(
        `insert into corporate_task_requests (task_key, title, brief, owner_hint, due_date, marketplace_ids, origin, created_by, route, route_reason, owner_name, owner_team, route_decided_by)
         values ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12) returning *`,
        [key, d.title, d.brief ?? null, d.owner_hint ?? null, d.due_date ?? null, ids, a.signer, rt.route, rt.reason, rt.owner_name, rt.owner_team, d.route ? a.signer : null])).rows[0];
      await audit(c, a, { entityType: "corporate_task_request", entityId: row.id, action: "create", after: row });
      return { task: row };
    });
  });

  r.post("/task-requests/:id/retry", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ version }), b);
    return tx(async (c) => {
      const row = await one("select * from corporate_task_requests where id = $1 for update", [params.id], c);
      if (!row) throw notFound("Task");
      if (row.version !== d.version) throw conflict("This task changed since you opened it. Reload and try again.");
      if (row.delivery_status !== "failed") throw badRequest("Only a failed delivery can be retried.");
      const after = (await c.query(`update corporate_task_requests set delivery_status = 'pending', delivery_error = null, updated_at = now(), version = version + 1 where id = $1 returning *`, [params.id])).rows[0];
      await audit(c, a, { entityType: "corporate_task_request", entityId: params.id, action: "retry_delivery", before: { delivery_status: "failed" }, after: { delivery_status: "pending" } });
      return { task: after };
    });
  });

  r.post("/task-requests/:id/dismiss", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ version }), b);
    return tx(async (c) => {
      const row = await one("select * from corporate_task_requests where id = $1 for update", [params.id], c);
      if (!row) throw notFound("Task");
      if (row.version !== d.version) throw conflict("This task changed since you opened it. Reload and try again.");
      if (row.delivery_status === "delivered") throw badRequest("This task is already in Task Tracker; use Resolve to complete it.");
      if (row.delivery_status === "sending") throw badRequest("This task is being sent to Task Tracker; use Resolve to complete it.");
      if (resolutionOf(row)) throw badRequest("This task was already resolved.");
      if (row.delivery_status === "dismissed") throw badRequest("This task was already dismissed.");
      const after = (await c.query(`update corporate_task_requests set delivery_status = 'dismissed', updated_at = now(), version = version + 1 where id = $1 returning *`, [params.id])).rows[0];
      await audit(c, a, { entityType: "corporate_task_request", entityId: params.id, action: "dismiss", before: { delivery_status: row.delivery_status } });
      return { task: after };
    });
  });

  // Resolve: the same record in both apps. Handled without a task (a draft, a check-off item, an item waiting for
  // routing): resolved at once (the shared "resolved" status). A task already in Task Tracker is completed there by the
  // dashboard and shows Resolved once Task Tracker confirms. A repeat answers "already resolved"; a form opened before
  // another change is refused (version).
  r.post("/task-requests/:id/resolve", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ completed_on: date, note: text(300), version: version.optional() }), b);
    if (d.completed_on && d.completed_on > reportDate()) throw badRequest("The completion date can't be in the future.", { fields: { completed_on: "In the future" } });
    return tx(async (c) => {
      const row = await one("select * from corporate_task_requests where id = $1 for update", [params.id], c);
      if (!row) throw notFound("Task");
      // From a form (with its version): a form opened before another change can't act, and a repeat is refused.
      if (d.version !== undefined) {
        if (row.version !== d.version) throw conflict("This task changed since you opened it. Reload and try again.");
        if (resolutionOf(row) === "resolved") throw badRequest("This task was already resolved.");
        if (row.delivery_status === "dismissed") throw badRequest("This task was dismissed.");
      }
      const r = await resolveRequest(c, params.id, { actor: a, by: a.signer, source: "manual", completed_on: d.completed_on ?? null, note: d.note ?? undefined });
      return { outcome: r.outcome, task: await one(`select ${TASK_COLS} from corporate_task_requests t where t.id = $1`, [params.id], c) };
    });
  });

  // Bulk "Mark done" for check-off items: each item on its own, so one failure leaves the others done.
  r.post("/task-requests/mark-done", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), completed_on: date }), b);
    const results: { id: string; outcome: string; message?: string }[] = [];
    for (const id of [...new Set(d.ids)]) {
      try {
        const out = await tx(async (c) => {
          const row = await one("select route from corporate_task_requests where id = $1", [id], c);
          if (!row) return { outcome: "failed", message: "Not found." };
          if (row.route !== "checkoff") return { outcome: "failed", message: "Not a check-off item (use Resolve)." };
          return { outcome: (await resolveRequest(c, id, { actor: a, by: a.signer, source: "manual", completed_on: d.completed_on ?? null })).outcome };
        });
        results.push({ id, ...out });
      } catch (e: any) { results.push({ id, outcome: "failed", message: e?.message ?? "Could not be marked done." }); }
    }
    return { results };
  });

  // Follow-up: assign check-off items to Marketing (one or many). Each becomes a Marketing task in the dashboard, where
  // it gets the default assignee (the Marketing owner) and is sent to Task Tracker. Each item on its own.
  r.post("/task-requests/assign-marketing", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }), b);
    const results: { id: string; outcome: string; message?: string }[] = [];
    for (const id of [...new Set(d.ids)]) {
      try {
        const out = await tx(async (c) => {
          const row = await one("select route, delivery_status, tracker_status, resolve_requested_at, slack_status from corporate_task_requests where id = $1", [id], c);
          if (!row) return { outcome: "failed", message: "Not found." };
          if (row.route === "marketing") return { outcome: "already" };
          if (resolutionOf(row) || ["dismissed", "resolved"].includes(row.delivery_status) || row.slack_status === "cancelled") return { outcome: "failed", message: "Already closed." };
          await decideRoute(c, id, "marketing", { actor: a, by: a.signer });
          return { outcome: "assigned" };
        });
        results.push({ id, ...out });
      } catch (e: any) { results.push({ id, outcome: "failed", message: e?.message ?? "Could not be assigned." }); }
    }
    return { results };
  });

  // Routing decision for an item in review: "Assign as Marketing task" or "Track as check-off".
  r.post("/task-requests/:id/route", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ route: z.enum(["marketing", "checkoff"]), version }), b);
    return tx(async (c) => ({ task: await decideRoute(c, params.id, d.route, { actor: a, by: a.signer, version: d.version }) }));
  });

  // Routing of already imported tasks by the owner directory. Preview first; tasks already in Task Tracker, resolved
  // ones and routes chosen by a person are never changed.
  r.post("/task-requests/reroute", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ dry_run: z.boolean() }), b);
    const work = async (c: pg.PoolClient) => {
      const rows = (await c.query(`select t.*, (select array_agg(m.name order by m.name) from marketplaces m where m.id = any(t.marketplace_ids)) as names
                                   from corporate_task_requests t where t.delivery_status <> 'dismissed' order by t.created_at for update of t`)).rows;
      const changes: any[] = [];
      let kept = 0;
      for (const row of rows) {
        if (!routeIsFree(row)) { kept++; continue; }
        const rt = await routeFor(c, row.owner_hint);
        if (rt.route === row.route && rt.owner_name === row.owner_name) continue;
        // Only route changes are listed; a newly verified owner on an unchanged route is recorded quietly.
        if (rt.route !== row.route) changes.push({ id: row.id, title: row.title, marketplaces: row.names ?? [], owner_hint: row.owner_hint, from: row.route, to: rt.route, reason: rt.reason });
        if (!d.dry_run) {
          await c.query(`update corporate_task_requests set route = $2, route_reason = $3, owner_name = $4, owner_team = $5, content_version = content_version + 1,
                           updated_at = now(), version = version + 1 where id = $1`, [row.id, rt.route, rt.reason, rt.owner_name, rt.owner_team]);
          await audit(c, a, { entityType: "corporate_task_request", entityId: row.id, action: "reroute", before: { route: row.route }, after: { route: rt.route, reason: rt.reason } });
        }
      }
      return { dry_run: d.dry_run, changes, kept };
    };
    if (!d.dry_run) return tx(work);
    const c = await getPool().connect();
    try { await c.query("begin"); return await work(c); } finally { await c.query("rollback").catch(() => {}); c.release(); }
  });

  // ------------------------------------------------------------ owner directory
  // Verified owner names and their team, used for routing. Keep real names in the app's data only.
  const ownerFields = { name: displayName(80), aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional(), team: z.enum(["marketing", "outside", "external"]), active: z.boolean().optional(), note: text(300) };
  r.get("/owners", async () => ({ owners: await query("select * from corporate_owners order by active desc, team, lower(name)") }));
  r.post("/owners", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object(ownerFields), b);
    return tx(async (c) => {
      if (await one("select id from corporate_owners where lower(btrim(name)) = lower(btrim($1))", [d.name], c)) throw badRequest("This owner is already listed.", { fields: { name: "Already listed" } });
      const row = (await c.query("insert into corporate_owners (name, aliases, team, active, note, created_by) values ($1,$2,$3,$4,$5,$6) returning *",
        [d.name, d.aliases ?? [], d.team, d.active ?? true, d.note ?? null, a.signer])).rows[0];
      await audit(c, a, { entityType: "corporate_owner", entityId: row.id, action: "create", after: { team: row.team } });
      return { owner: row };
    });
  });
  r.patch("/owners/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ name: displayName(80).optional(), aliases: ownerFields.aliases, team: ownerFields.team.optional(), active: z.boolean().optional(), note: text(300), version }), b);
    const { version: v, ...fields } = d;
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "corporate_owners", params.id, v, defined(fields));
      await audit(c, a, { entityType: "corporate_owner", entityId: params.id, action: "update", ...diff(before, after) });
      return { owner: after };
    });
  });

  // ------------------------------------------------------------ Slack scans
  r.get("/slack/scans", async () => ({
    scans: await query("select channel_key, last_success_at, last_attempt_at, last_error, last_counts from slack_scan_state order by channel_key"),
  }));
}

