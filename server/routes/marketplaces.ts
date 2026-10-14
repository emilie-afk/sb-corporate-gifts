import { z } from "zod";
import { Router, updateVersioned } from "../router";
import { query, one, tx } from "../db";
import type pg from "pg";
import { audit, type Actor } from "../audit";
import { HttpError, badRequest, conflict, notFound } from "../http";
import { fetchCollectionProductIds } from "../lib/shopify";
import { parse, text, reqText, url, email, date, version, assertUuid, defined } from "../validate";
import { DEFAULT_MILESTONES } from "../../db/seed/providers";

export const STATUSES = [
  "prospect", "reconnecting", "preparing_application", "in_discussion", "application_submitted",
  "approved", "setting_up_listings", "live", "on_hold", "rejected", "not_qualified", "inactive",
] as const;
export const INACTIVE_STATUSES = ["on_hold", "rejected", "not_qualified", "inactive"] as const;
export const INACTIVE_REASONS = [
  "fulfillment_requirement", "pricing_or_margin", "product_fit", "application_rejected",
  "no_current_demand", "partnership_paused", "other",
] as const;
const isInactive = (s: string) => (INACTIVE_STATUSES as readonly string[]).includes(s);

const PROGRESS_SQL = `
  select m.*, c.active as channel_active,
    (select count(*) from setup_milestones s where s.marketplace_id = m.id and s.removed_at is null and s.state = 'done')::int as milestones_done,
    (select count(*) from setup_milestones s where s.marketplace_id = m.id and s.removed_at is null and s.state <> 'not_applicable')::int as milestones_applicable,
    (select count(*) from setup_milestones s where s.marketplace_id = m.id and s.removed_at is null)::int as milestones_total,
    (select max(occurred_on) from communications k where k.marketplace_id = m.id and k.removed_at is null) as last_communication
  from marketplaces m join channels c on c.id = m.channel_id`;

const detailsSchema = z.object({
  name: reqText(120).optional(),
  provider_type: z.enum(["marketplace", "supplier_opportunity"]).optional(),
  contact_name: text(120),
  contact_email: email,
  website_url: url,
  portal_url: url,
  description: text(4000),
  priority_note: text(200),
  initial_action: text(2000),
});

async function loadMarketplace(id: string) {
  assertUuid(id);
  const m = await one(`${PROGRESS_SQL} where m.id = $1`, [id]);
  if (!m) throw notFound("Marketplace");
  return m;
}

export function marketplaceRoutes(r: Router) {
  r.get("/marketplaces", async ({ query: q }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.get("q")) { params.push(`%${q.get("q")}%`); where.push(`m.name ilike $${params.length}`); }
    if (q.get("status")) { params.push(q.get("status")!.split(",")); where.push(`m.status = any($${params.length})`); }
    if (q.get("provider_type")) { params.push(q.get("provider_type")); where.push(`m.provider_type = $${params.length}`); }
    if (q.get("include_inactive") !== "1" && !q.get("status")) {
      params.push(INACTIVE_STATUSES); where.push(`m.status <> all($${params.length})`);
    }
    const rows = await query(`${PROGRESS_SQL} ${where.length ? "where " + where.join(" and ") : ""} order by m.name`, params);
    const counts = await one(
      `select count(*) filter (where status <> all($1))::int as working, count(*) filter (where status = 'live')::int as live from marketplaces`,
      [INACTIVE_STATUSES],
    );
    return { marketplaces: rows, counts };
  });

  r.post("/marketplaces", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(
      detailsSchema.extend({
        name: reqText(120),
        provider_type: z.enum(["marketplace", "supplier_opportunity"]),
        status: z.enum(STATUSES).default("prospect"),
      }),
      b,
    );
    if (isInactive(d.status)) throw badRequest("Create the record with a working status, then change status with a reason.");
    const created = await tx((c) => createMarketplace(c, d, a));
    return { marketplace: created };
  });

  /**
   * Add several marketplaces at once: names + provider type + a working status per name.
   * dry_run: true only checks (duplicates in the list, names already in use). Saving is all-or-nothing.
   */
  r.post("/marketplaces/bulk", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({
      dry_run: z.boolean().default(false),
      items: z.array(z.object({
        name: reqText(120),
        provider_type: z.enum(["marketplace", "supplier_opportunity"]).default("marketplace"),
        status: z.enum(STATUSES).default("prospect"),
      })).min(1, "Add at least one name").max(200, "Up to 200 names at a time"),
    }), b);
    const key = (n: string) => n.replace(/\s+/g, " ").trim().toLowerCase();
    const existing = new Map((await query("select name from channels")).map((x) => [key(x.name), x.name]));
    const seen = new Map<string, number>();
    const rows = d.items.map((it, i) => {
      const errors: string[] = [];
      const k = key(it.name);
      if (existing.has(k)) errors.push(`Already exists as “${existing.get(k)}”`);
      if (seen.has(k)) errors.push(`Repeated (same as line ${seen.get(k)! + 1})`);
      else seen.set(k, i);
      if (isInactive(it.status)) errors.push("Choose a working status; inactive statuses need a reason and are set later");
      return { line: i + 1, name: it.name.replace(/\s+/g, " ").trim(), provider_type: it.provider_type, status: it.status, errors };
    });
    const invalid = rows.filter((r) => r.errors.length).length;
    if (d.dry_run) return { rows, invalid };
    if (invalid) throw badRequest(`${invalid} name(s) can't be added. Fix or remove them and try again.`, { rows });
    const created = await tx(async (c) => {
      const out = [];
      for (const r of rows) out.push(await createMarketplace(c, { name: r.name, provider_type: r.provider_type, status: r.status }, a));
      return out;
    });
    return { created: created.map((m) => ({ id: m.id, name: m.name, status: m.status, provider_type: m.provider_type })) };
  });

  r.get("/marketplaces/:id", async ({ params }) => {
    const m = await loadMarketplace(params.id);
    const [milestones, requirements, communications, products, statusHistory, history, channel] = await Promise.all([
      query("select * from setup_milestones where marketplace_id = $1 and removed_at is null order by sort_order, created_at", [m.id]),
      query("select * from requirements where marketplace_id = $1 and removed_at is null order by category, created_at", [m.id]),
      query("select * from communications where marketplace_id = $1 and removed_at is null order by occurred_on desc, created_at desc", [m.id]),
      query(
        `select mp.*, p.name as product_name, p.variant as product_variant, p.sku as product_sku, p.family as product_family,
                p.plants_included, p.individual_recipient_fulfillment, p.card_eligible
         from marketplace_products mp join products p on p.id = mp.product_id
         where mp.marketplace_id = $1 and mp.removed_at is null order by mp.created_at`,
        [m.id],
      ),
      query("select id, from_status, to_status, reason, detail, unmet_requirement, what_would_change, revisit_date, signer_name, created_at from status_history where marketplace_id = $1 order by created_at desc", [m.id]),
      query(
        `select id, entity_type, entity_id, action, before, after, signer_name, created_at from audit_events
         where marketplace_id = $1 and entity_type in ('milestone') order by created_at desc limit 200`,
        [m.id],
      ),
      one("select * from channels where id = $1", [m.channel_id]),
    ]);
    return { marketplace: m, channel, milestones, requirements, communications, products, statusHistory, milestoneHistory: history };
  });

  r.patch("/marketplaces/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = defined(parse(detailsSchema.extend({ version }), b));
    const { version: v, ...fields } = d as any;
    if ("status" in b) throw badRequest("Use Change status to change the status.");
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "marketplaces", params.id, v, fields);
      if (fields.name && fields.name !== before.name) await c.query("update channels set name = $1, updated_at = now() where id = $2", [fields.name, before.channel_id]);
      if (fields.provider_type && fields.provider_type !== before.provider_type)
        await c.query("update channels set type = $1 where id = $2", [fields.provider_type === "marketplace" ? "marketplace" : "sourcing", before.channel_id]);
      await audit(c, a, { entityType: "marketplace", entityId: params.id, marketplaceId: params.id, action: "update", before, after });
      return { marketplace: after };
    });
  });

  r.post("/marketplaces/:id/status-transitions", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(
      z.object({
        to_status: z.enum(STATUSES),
        reason: z.enum(INACTIVE_REASONS).nullable().optional(),
        detail: text(2000),
        unmet_requirement: text(1000),
        what_would_change: text(1000),
        revisit_date: date,
        version,
      }),
      b,
    );
    return tx(async (c) => {
      const cur = await c.query("select * from marketplaces where id = $1 for update", [params.id]);
      if (!cur.rowCount) throw notFound("Marketplace");
      const m = cur.rows[0];
      if (m.version !== d.version) throw conflict();
      if (m.status === d.to_status) throw badRequest("The marketplace already has that status.");
      if (isInactive(d.to_status) && !d.reason) throw badRequest("A reason is required for this status.", { fields: { reason: "Required" } });
      const after = await c.query(
        "update marketplaces set status = $2, updated_at = now(), version = version + 1 where id = $1 returning *",
        [params.id, d.to_status],
      );
      const hist = await c.query(
        `insert into status_history (marketplace_id, from_status, to_status, reason, detail, unmet_requirement, what_would_change, revisit_date, signer_name, auth_subject)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [params.id, m.status, d.to_status, d.reason ?? null, d.detail ?? null,
          d.to_status === "not_qualified" ? d.unmet_requirement ?? null : null,
          d.to_status === "not_qualified" ? d.what_would_change ?? null : null,
          isInactive(d.to_status) ? d.revisit_date ?? null : null, a.signer, a.sub],
      );
      await audit(c, a, {
        entityType: "marketplace", entityId: params.id, marketplaceId: params.id,
        action: isInactive(m.status) && !isInactive(d.to_status) ? "reactivate" : "status_change",
        before: { status: m.status }, after: { status: d.to_status, reason: d.reason ?? null },
      });
      // Reactivation deliberately keeps milestones, prices, communications and revenue untouched.
      return { marketplace: after.rows[0], transition: hist.rows[0] };
    });
  });

  // ------------------------------------------------------------ milestones
  r.get("/marketplaces/:id/milestones", async ({ params }) => {
    assertUuid(params.id);
    return { milestones: await query("select * from setup_milestones where marketplace_id = $1 and removed_at is null order by sort_order", [params.id]) };
  });

  r.post("/marketplaces/:id/milestones", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    await loadMarketplace(params.id);
    const d = parse(z.object({ title: reqText(200), note: text(500) }), b);
    return tx(async (c) => {
      const so = await c.query("select coalesce(max(sort_order), 0) + 10 as n from setup_milestones where marketplace_id = $1", [params.id]);
      const ins = await c.query(
        "insert into setup_milestones (marketplace_id, title, note, sort_order) values ($1,$2,$3,$4) returning *",
        [params.id, d.title, d.note ?? null, so.rows[0].n],
      );
      await audit(c, a, { entityType: "milestone", entityId: ins.rows[0].id, marketplaceId: params.id, action: "add", after: { title: d.title } });
      return { milestone: ins.rows[0] };
    });
  });

  r.patch("/marketplaces/:id/milestones/:mid", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id); assertUuid(params.mid);
    const d = parse(
      z.object({
        action: z.enum(["done", "not_applicable", "reopen", "edit", "remove"]),
        title: reqText(200).optional(),
        note: text(500),
        reason: text(500),
        version,
      }),
      b,
    );
    return tx(async (c) => {
      const cur = await c.query("select * from setup_milestones where id = $1 and marketplace_id = $2 and removed_at is null for update", [params.mid, params.id]);
      if (!cur.rowCount) throw notFound("Milestone");
      const m = cur.rows[0];
      if (m.version !== d.version) throw conflict();
      let fields: Record<string, unknown>;
      switch (d.action) {
        case "done":
          if (m.state === "done") throw badRequest("Already marked done.");
          fields = { state: "done", completed_by: a.signer, completed_at: new Date(), completed_auth_subject: a.sub, not_applicable_reason: null, ...(d.note !== undefined ? { note: d.note } : {}) };
          break;
        case "not_applicable":
          if (!d.reason) throw badRequest("A brief reason is required for Not applicable.", { fields: { reason: "Required" } });
          fields = { state: "not_applicable", completed_by: a.signer, completed_at: new Date(), completed_auth_subject: a.sub, not_applicable_reason: d.reason };
          break;
        case "reopen":
          if (m.state === "pending") throw badRequest("Milestone is already pending.");
          fields = { state: "pending", completed_by: null, completed_at: null, completed_auth_subject: null, not_applicable_reason: null };
          break;
        case "edit":
          fields = defined({ title: d.title, note: d.note });
          break;
        case "remove":
          fields = { removed_at: new Date() };
          break;
      }
      const { before, after } = await updateVersioned(c, "setup_milestones", params.mid, d.version, fields);
      const pick = (x: any) => ({ title: x.title, note: x.note, state: x.state, completed_by: x.completed_by, completed_at: x.completed_at, not_applicable_reason: x.not_applicable_reason, removed_at: x.removed_at });
      await audit(c, a, { entityType: "milestone", entityId: params.mid, marketplaceId: params.id, action: d.action, before: pick(before), after: pick(after) });
      return { milestone: after };
    });
  });

  // ---------------------------------------------------------- requirements
  const reqSchema = z.object({
    category: z.enum(["fulfillment", "product", "customization", "pricing", "payment", "technical", "other"]),
    requirement: reqText(4000),
    response: text(4000),
    confirmation_state: z.enum(["unverified", "awaiting_clarification", "confirmed"]).default("unverified"),
    source_ref: text(2000),
    verified_on: date,
  });

  r.get("/marketplaces/:id/requirements", async ({ params }) => {
    assertUuid(params.id);
    return { requirements: await query("select * from requirements where marketplace_id = $1 and removed_at is null order by created_at", [params.id]) };
  });

  r.post("/marketplaces/:id/requirements", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    await loadMarketplace(params.id);
    const d = parse(reqSchema, b);
    return tx(async (c) => {
      const confirmed = d.confirmation_state === "confirmed";
      const ins = await c.query(
        `insert into requirements (marketplace_id, category, requirement, response, confirmation_state, source_ref, verified_on, confirmed_by, confirmed_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [params.id, d.category, d.requirement, d.response ?? null, d.confirmation_state, d.source_ref ?? null, d.verified_on ?? null,
          confirmed ? a.signer : null, confirmed ? new Date() : null, a.signer],
      );
      await audit(c, a, { entityType: "requirement", entityId: ins.rows[0].id, marketplaceId: params.id, action: "create", after: ins.rows[0] });
      return { requirement: ins.rows[0] };
    });
  });

  /** Several requirements at once (one per line), with a category each; shared state, source and date. */
  r.post("/marketplaces/:id/requirements/bulk", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    const m = await loadMarketplace(params.id);
    const d = parse(z.object({
      dry_run: z.boolean().default(false),
      items: z.array(z.object({ category: reqSchema.shape.category, requirement: reqText(4000) })).min(1, "Add at least one requirement").max(200, "Up to 200 at a time"),
      confirmation_state: z.enum(["unverified", "awaiting_clarification", "confirmed"]).default("unverified"),
      source_ref: text(2000),
      verified_on: date,
    }), b);
    const key = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    const have = new Set((await query("select requirement from requirements where marketplace_id = $1 and removed_at is null", [m.id])).map((x) => key(x.requirement)));
    const seen = new Map<string, number>();
    const rows = d.items.map((it, i) => {
      const errors: string[] = [];
      const k = key(it.requirement);
      if (have.has(k)) errors.push("Already recorded for this marketplace");
      if (seen.has(k)) errors.push(`Repeated (same as line ${seen.get(k)! + 1})`); else seen.set(k, i);
      return { line: i + 1, category: it.category, requirement: it.requirement.trim(), errors };
    });
    const invalid = rows.filter((r) => r.errors.length).length;
    if (d.dry_run) return { rows, invalid };
    if (invalid) throw badRequest(`${invalid} requirement(s) can't be added. Fix or remove them and try again.`);
    const confirmed = d.confirmation_state === "confirmed";
    return tx(async (c) => {
      for (const r of rows) {
        const ins = await c.query(
          `insert into requirements (marketplace_id, category, requirement, confirmation_state, source_ref, verified_on, confirmed_by, confirmed_at, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [m.id, r.category, r.requirement, d.confirmation_state, d.source_ref ?? null, d.verified_on ?? null, confirmed ? a.signer : null, confirmed ? new Date() : null, a.signer]);
        await audit(c, a, { entityType: "requirement", entityId: ins.rows[0].id, marketplaceId: m.id, action: "create", after: { ...ins.rows[0], bulk: true } });
      }
      return { created: rows.length };
    });
  });

  r.patch("/marketplaces/:id/requirements/:rid", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id); assertUuid(params.rid);
    const d = defined(parse(reqSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    return tx(async (c) => {
      const { version: v, remove, ...fields } = d;
      if ("confirmation_state" in b && b.confirmation_state !== undefined) {
        if (fields.confirmation_state === "confirmed") { fields.confirmed_by = a.signer; fields.confirmed_at = new Date(); }
        else { fields.confirmed_by = null; fields.confirmed_at = null; }
      }
      if (remove) fields.removed_at = new Date();
      const own = await c.query("select 1 from requirements where id = $1 and marketplace_id = $2", [params.rid, params.id]);
      if (!own.rowCount) throw notFound("Requirement");
      const { before, after } = await updateVersioned(c, "requirements", params.rid, v, fields);
      await audit(c, a, { entityType: "requirement", entityId: params.rid, marketplaceId: params.id, action: remove ? "remove" : "update", before, after });
      return { requirement: after };
    });
  });

  // -------------------------------------------------------- communications
  const commSchema = z.object({
    occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    contact_name: text(120),
    method: z.enum(["email", "call", "meeting", "portal", "other"]),
    summary: reqText(4000),
    reference_url: url,
  });

  r.get("/marketplaces/:id/communications", async ({ params }) => {
    assertUuid(params.id);
    return { communications: await query("select * from communications where marketplace_id = $1 and removed_at is null order by occurred_on desc, created_at desc", [params.id]) };
  });

  r.post("/marketplaces/:id/communications", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    await loadMarketplace(params.id);
    const d = parse(commSchema, b);
    return tx(async (c) => {
      const ins = await c.query(
        `insert into communications (marketplace_id, occurred_on, signer_name, contact_name, method, summary, reference_url)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [params.id, d.occurred_on, a.signer, d.contact_name ?? null, d.method, d.summary, d.reference_url ?? null],
      );
      await audit(c, a, { entityType: "communication", entityId: ins.rows[0].id, marketplaceId: params.id, action: "create", after: ins.rows[0] });
      return { communication: ins.rows[0] };
    });
  });

  r.patch("/marketplaces/:id/communications/:cid", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id); assertUuid(params.cid);
    const d = defined(parse(commSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    return tx(async (c) => {
      const { version: v, remove, ...fields } = d;
      if (remove) fields.removed_at = new Date();
      const own = await c.query("select 1 from communications where id = $1 and marketplace_id = $2", [params.cid, params.id]);
      if (!own.rowCount) throw notFound("Communication");
      const { before, after } = await updateVersioned(c, "communications", params.cid, v, fields);
      await audit(c, a, { entityType: "communication", entityId: params.cid, marketplaceId: params.id, action: remove ? "remove" : "update", before, after });
      return { communication: after };
    });
  });

  // ----------------------------------------------------- proposed products
  const propSchema = z.object({
    product_id: z.string().uuid(),
    proposal_status: z.enum(["proposed", "submitted", "approved", "declined", "withdrawn"]).default("proposed"),
    offer_type: z.enum(["individual", "bulk_customized", "bulk"]).default("individual"),
    offer_note: text(2000),
    submitted_on: date,
    listing_url: url,
    approval_note: text(2000),
  });

  async function assertOfferAllowed(c: any, productId: string, offerType: string) {
    const p = await c.query("select family, archived_at from products where id = $1", [productId]);
    if (!p.rowCount) throw badRequest("Unknown product", { fields: { product_id: "Unknown product" } });
    if (p.rows[0].family === "pots_plus_succulents" && offerType === "individual")
      throw badRequest("Pots with succulents are a complete gift for bulk orders only (individual recipient shipping is unavailable). Choose a bulk offer type.", { fields: { offer_type: "Bulk only" } });
  }

  r.get("/marketplaces/:id/products", async ({ params }) => {
    assertUuid(params.id);
    const rows = await query(
      `select mp.*, p.name as product_name, p.variant as product_variant, p.family as product_family
       from marketplace_products mp join products p on p.id = mp.product_id where mp.marketplace_id = $1 and mp.removed_at is null order by mp.created_at`,
      [params.id],
    );
    return { products: rows };
  });

  r.post("/marketplaces/:id/products", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    await loadMarketplace(params.id);
    const d = parse(propSchema, b);
    return tx(async (c) => {
      await assertOfferAllowed(c, d.product_id, d.offer_type);
      const ins = await c.query(
        `insert into marketplace_products (marketplace_id, product_id, proposal_status, offer_type, offer_note, submitted_on, listing_url, approval_note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [params.id, d.product_id, d.proposal_status, d.offer_type, d.offer_note ?? null, d.submitted_on ?? null, d.listing_url ?? null, d.approval_note ?? null, a.signer],
      );
      await audit(c, a, { entityType: "marketplace_product", entityId: ins.rows[0].id, marketplaceId: params.id, action: "create", after: ins.rows[0] });
      return { proposal: ins.rows[0] };
    });
  });

  // ------------------------------------------------ bulk: propose several gifts
  const FAMILIES = ["live_to_give_box", "succulent_arrangement", "airplant_gift_set", "plant_only", "custom_pots", "pots_plus_succulents", "watering_can", "other"] as const;
  /** Gifts to choose from: a gift category, a succulentsbox.com collection link, or gifts picked one by one. */
  r.post("/marketplaces/:id/products/candidates", async ({ params, body }) => {
    const b = await body();
    const m = await loadMarketplace(params.id);
    const d = parse(z.object({
      source: z.enum(["family", "collection", "picked"]),
      family: z.enum(FAMILIES).optional(),
      collection_url: z.string().trim().max(500).optional(),
      product_ids: z.array(z.string().uuid()).max(300).optional(),
      selected_only: z.boolean().default(true),
    }), b);
    const where = ["p.archived_at is null"];
    const args: unknown[] = [];
    let note: string | null = null;
    if (d.source === "family") {
      if (!d.family) throw badRequest("Choose a gift category.", { fields: { family: "Required" } });
      args.push(d.family); where.push(`p.family = $${args.length}`);
    } else if (d.source === "collection") {
      const mm = /^(?:https?:\/\/)?(?:www\.)?succulentsbox\.com\/collections\/([a-z0-9][a-z0-9-]*)\/?(?:[?#].*)?$/i.exec(d.collection_url ?? "");
      if (!mm) throw badRequest("Paste a succulentsbox.com/collections/… link.", { fields: { collection_url: "Not a succulentsbox.com collection link" } });
      let ids: number[];
      try { ids = await fetchCollectionProductIds(mm[1].toLowerCase()); }
      catch (e: any) { throw new HttpError(502, "upstream", `Could not read that collection from the website (${e.message}). Check the link and try again.`); }
      if (!ids.length) throw badRequest("That collection has no products on the website (or the link is wrong).", { fields: { collection_url: "Empty collection" } });
      args.push(ids); where.push(`p.shopify_product_id = any($${args.length}::bigint[])`);
      note = `${ids.length} product(s) on the website collection “${mm[1].toLowerCase()}”`;
    } else {
      if (!d.product_ids?.length) throw badRequest("Pick at least one gift.");
      args.push(d.product_ids); where.push(`p.id = any($${args.length}::uuid[])`);
    }
    if (d.selected_only && d.source !== "picked") where.push("p.selected");
    args.push(m.id);
    const rows = await query(
      `select p.id, p.name, p.variant, p.sku, p.family, p.selected, p.web_price_cents,
              (select mp.proposal_status from marketplace_products mp where mp.marketplace_id = $${args.length} and mp.product_id = p.id and mp.removed_at is null
                order by mp.created_at desc limit 1) as existing_status
       from products p where ${where.join(" and ")} order by lower(p.name), p.variant nulls first limit 500`, args);
    return { gifts: rows, note };
  });

  r.post("/marketplaces/:id/products/bulk", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    const m = await loadMarketplace(params.id);
    const d = parse(z.object({
      dry_run: z.boolean().default(false),
      items: z.array(z.object({ product_id: z.string().uuid(), offer_type: z.enum(["individual", "bulk_customized", "bulk"]) }))
        .min(1, "Select at least one gift").max(300, "Up to 300 gifts at a time"),
      proposal_status: z.enum(["proposed", "submitted", "approved", "declined", "withdrawn"]).default("proposed"),
      offer_note: text(2000),
      submitted_on: date,
    }), b);
    const ids = d.items.map((i) => i.product_id);
    const prods = new Map((await query("select id, name, variant, family, archived_at from products where id = any($1::uuid[])", [ids])).map((p) => [p.id, p]));
    const existing = new Set((await query("select product_id from marketplace_products where marketplace_id = $1 and removed_at is null", [m.id])).map((x) => x.product_id));
    const seen = new Set<string>();
    const rows = d.items.map((it) => {
      const p = prods.get(it.product_id);
      const errors: string[] = [];
      if (!p || p.archived_at) errors.push("Unknown or archived gift");
      if (existing.has(it.product_id)) errors.push("Already proposed to this marketplace");
      if (seen.has(it.product_id)) errors.push("Listed twice");
      seen.add(it.product_id);
      if (p?.family === "pots_plus_succulents" && it.offer_type === "individual") errors.push("Pots with succulents are bulk orders only — choose a bulk offer type");
      return { product_id: it.product_id, offer_type: it.offer_type, name: p ? [p.name, p.variant].filter(Boolean).join(" — ") : null, errors };
    });
    const invalid = rows.filter((r) => r.errors.length).length;
    if (d.dry_run) return { rows, invalid };
    if (invalid) throw badRequest(`${invalid} gift(s) can't be proposed. Fix or untick them and try again.`);
    return tx(async (c) => {
      const out = [];
      for (const r of rows) {
        const ins = await c.query(
          `insert into marketplace_products (marketplace_id, product_id, proposal_status, offer_type, offer_note, submitted_on, created_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [m.id, r.product_id, d.proposal_status, r.offer_type, d.offer_note ?? null, d.submitted_on ?? null, a.signer]);
        await audit(c, a, { entityType: "marketplace_product", entityId: ins.rows[0].id, marketplaceId: m.id, action: "create", after: { ...ins.rows[0], bulk: true } });
        out.push(ins.rows[0]);
      }
      return { created: out.length };
    });
  });

  r.patch("/marketplaces/:id/products/:pid", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id); assertUuid(params.pid);
    const d = defined(parse(propSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    return tx(async (c) => {
      const cur = await c.query("select * from marketplace_products where id = $1 and marketplace_id = $2", [params.pid, params.id]);
      if (!cur.rowCount) throw notFound("Proposal");
      const { version: v, remove, ...fields } = d;
      await assertOfferAllowed(c, fields.product_id ?? cur.rows[0].product_id, fields.offer_type ?? cur.rows[0].offer_type);
      if (remove) fields.removed_at = new Date();
      // A product decline never changes the marketplace status.
      const { before, after } = await updateVersioned(c, "marketplace_products", params.pid, v, fields);
      await audit(c, a, { entityType: "marketplace_product", entityId: params.pid, marketplaceId: params.id, action: remove ? "remove" : "update", before, after });
      return { proposal: after };
    });
  });
}

/** One new marketplace / supplier opportunity: channel, record, default milestones, first status entry, audit. */
async function createMarketplace(c: pg.PoolClient, d: any, a: Actor) {
  const ch = await c.query("insert into channels (name, type) values ($1,$2) returning id", [
    d.name, d.provider_type === "marketplace" ? "marketplace" : "sourcing",
  ]);
  const m = await c.query(
    `insert into marketplaces (channel_id, name, provider_type, status, contact_name, contact_email, website_url, portal_url, description, priority_note, initial_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [ch.rows[0].id, d.name, d.provider_type, d.status, d.contact_name ?? null, d.contact_email ?? null, d.website_url ?? null,
      d.portal_url ?? null, d.description ?? null, d.priority_note ?? null, d.initial_action ?? null],
  );
  const mid = m.rows[0].id;
  for (const [i, t] of DEFAULT_MILESTONES.entries()) {
    await c.query("insert into setup_milestones (marketplace_id, title, sort_order, is_default) values ($1,$2,$3,true)", [mid, t, (i + 1) * 10]);
  }
  await c.query("insert into status_history (marketplace_id, from_status, to_status, reason, signer_name, auth_subject) values ($1,null,$2,'Created',$3,$4)",
    [mid, d.status, a.signer, a.sub]);
  await audit(c, a, { entityType: "marketplace", entityId: mid, marketplaceId: mid, action: "create", after: m.rows[0] });
  return m.rows[0];
}
