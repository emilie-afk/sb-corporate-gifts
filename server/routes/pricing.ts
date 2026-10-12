import { z } from "zod";
import type pg from "pg";
import { Router, updateVersioned } from "../router";
import { query, one, tx } from "../db";
import { audit, type Actor } from "../audit";
import { HttpError, badRequest, conflict, notFound } from "../http";
import { parse, text, cents, pct, date, version, assertUuid, defined } from "../validate";

export const FORMATS = ["individual", "corporate_separate_addresses", "bulk_one_location", "bulk_multiple_shipments"] as const;
const EDITABLE = ["draft", "proposed"];

const priceFields = {
  retail_ref_cents: cents,
  internal_cost_cents: cents,
  cost_inclusions_note: text(1000),
  customer_discount_pct: pct,
  proposed_supplier_cents: cents,
  agreed_price_cents: cents,
  customer_shipping_cents: cents,
  expected_shipping_cents: cents,
  extra_cost_cents: cents,
  commission_pct: pct,
  fixed_fee_cents: cents,
  pricing_basis_note: text(2000),
  moq: z.union([z.number().int().min(1).max(1_000_000), z.null()]).optional(),
  fulfillment_format: z.enum(FORMATS),
  shipping_responsibility: text(1000),
  payment_terms: text(1000),
  dispatch_requirement: text(1000),
  agreement_notes: text(4000),
  effective_from: date,
  effective_to: date,
  evidence_ref: text(2000),
  approved_by: text(80),
};

const createSchema = z.object({
  channel_id: z.string().uuid(),
  product_id: z.string().uuid(),
  status: z.enum(["draft", "proposed", "agreed"]).default("draft"),
  ...priceFields,
});

const TERM_KEYS = ["payment_terms", "shipping_responsibility", "dispatch_requirement"] as const;

function checkDates(d: { effective_from?: string | null; effective_to?: string | null }) {
  if (d.effective_from && d.effective_to && d.effective_to < d.effective_from)
    throw badRequest("Effective to must be on or after effective from.", { fields: { effective_to: "Must be on or after effective from" } });
}

async function checkProductRules(c: pg.PoolClient, productId: string, format: string) {
  const p = await c.query("select family from products where id = $1", [productId]);
  if (!p.rowCount) throw badRequest("Unknown gift/variant", { fields: { product_id: "Unknown" } });
  if (p.rows[0].family === "pots_plus_succulents" && (format === "individual" || format === "corporate_separate_addresses"))
    throw badRequest("Pots plus succulents are bulk-only (multiple shipments). Individual or separate-address recipient fulfillment is not allowed.", {
      fields: { fulfillment_format: "Bulk only for this offer" },
    });
}

/** Snapshot of cost, retail and terms at the moment a price becomes agreed. */
async function snapshotFields(c: pg.PoolClient, rec: any) {
  const cost = await c.query("select id, gift_cost_cents from cost_snapshots where product_id = $1 order by created_at desc limit 1", [rec.product_id]);
  const prod = await c.query("select web_price_cents from products where id = $1", [rec.product_id]);
  const ch = await c.query("select * from channels where id = $1", [rec.channel_id]);
  const channel = ch.rows[0];
  const terms: Record<string, unknown> = {};
  for (const k of TERM_KEYS) {
    terms[k] = rec[k] != null ? { value: rec[k], source: "gift_override" } : channel[k] != null ? { value: channel[k], source: "channel_common" } : { value: null, source: "unspecified" };
  }
  terms.fee_note = channel.fee_note != null ? { value: channel.fee_note, source: "channel_common" } : { value: null, source: "unspecified" };
  terms.channel_terms_note = channel.terms_note ?? null;
  terms.channel_terms_updated_at = channel.terms_updated_at ?? null;
  return {
    cost_snapshot_id: cost.rows[0]?.id ?? null,
    snapshot_cost_cents: rec.internal_cost_cents ?? cost.rows[0]?.gift_cost_cents ?? null,
    snapshot_retail_cents: rec.retail_ref_cents ?? prod.rows[0]?.web_price_cents ?? null,
    terms_snapshot: JSON.stringify(terms),
  };
}

const LIST_SQL = `
  select r.*, c.name as channel_name, c.type as channel_type, p.name as product_name, p.variant as product_variant,
         p.sku as product_sku, p.family as product_family, p.web_price_cents as current_retail_cents,
         cs.gift_cost_cents as current_cost_cents, cs.created_at as current_cost_at,
         (select count(*) from pricing_records x where x.previous_record_id = r.id)::int as revision_count
  from pricing_records r
  join channels c on c.id = r.channel_id
  join products p on p.id = r.product_id
  left join lateral (select gift_cost_cents, created_at from cost_snapshots s where s.product_id = r.product_id order by created_at desc limit 1) cs on true`;

async function loadForUpdate(c: pg.PoolClient, id: string) {
  const r = await c.query("select * from pricing_records where id = $1 for update", [id]);
  if (!r.rowCount) throw notFound("Pricing record");
  return r.rows[0];
}

export function pricingRoutes(r: Router) {
  r.get("/pricing", async ({ query: q }) => {
    const where = ["r.archived_at is null"];
    const params: unknown[] = [];
    if (q.get("channel_id")) { params.push(q.get("channel_id")); where.push(`r.channel_id = $${params.length}`); }
    if (q.get("product_id")) { params.push(q.get("product_id")); where.push(`r.product_id = $${params.length}`); }
    if (q.get("status")) { params.push(q.get("status")!.split(",")); where.push(`r.status = any($${params.length})`); }
    else if (q.get("include_expired") !== "1") where.push("r.status <> 'expired'");
    if (q.get("q")) { params.push(`%${q.get("q")}%`); where.push(`(p.name ilike $${params.length} or p.variant ilike $${params.length})`); }
    const rows = await query(`${LIST_SQL} where ${where.join(" and ")} order by c.name, p.name, p.variant, r.created_at desc limit 500`, params);
    return { pricing: rows };
  });

  r.get("/pricing/:id", async ({ params }) => {
    assertUuid(params.id);
    const rec = await one(`${LIST_SQL} where r.id = $1`, [params.id]);
    if (!rec) throw notFound("Pricing record");
    return { record: rec };
  });

  r.get("/pricing/:id/history", async ({ params }) => {
    assertUuid(params.id);
    const rows = await query(
      `with recursive up as (
         select id, previous_record_id from pricing_records where id = $1
         union all select p.id, p.previous_record_id from pricing_records p join up on p.id = up.previous_record_id
       ), root as (select id from up where previous_record_id is null),
       down as (
         select id from root
         union all select p.id from pricing_records p join down on p.previous_record_id = down.id
       )
       ${LIST_SQL} where r.id in (select id from down) order by r.created_at`,
      [params.id],
    );
    const audits = await query(
      "select action, before, after, signer_name, created_at from audit_events where entity_type = 'pricing_record' and entity_id = any($1) order by created_at",
      [rows.map((x) => x.id)],
    );
    return { versions: rows, events: audits };
  });

  r.post("/pricing", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(createSchema, b);
    checkDates(d);
    if (d.status === "agreed") {
      if (d.agreed_price_cents == null) throw badRequest("An agreed price is required.", { fields: { agreed_price_cents: "Required" } });
      if (!d.approved_by) throw badRequest("Approved by is required for an agreed price.", { fields: { approved_by: "Required" } });
    }
    return tx(async (c) => {
      await checkProductRules(c, d.product_id, d.fulfillment_format);
      const rec = await insertRecord(c, d, a, null);
      return { record: rec };
    });
  });

  r.patch("/pricing/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = defined(
      parse(z.object({ ...priceFields, fulfillment_format: priceFields.fulfillment_format.optional(), status: z.enum(["draft", "proposed", "agreed"]).optional(), version }), b),
    ) as any;
    return tx(async (c) => {
      const cur = await loadForUpdate(c, params.id);
      if (!EDITABLE.includes(cur.status)) throw new HttpError(409, "immutable", "Agreed and active prices are immutable. Use Revise price to create a new version.");
      if (cur.version !== d.version) throw conflict();
      const { version: v, ...fields } = d;
      const merged = { ...cur, ...fields };
      checkDates(merged);
      await checkProductRules(c, merged.product_id, merged.fulfillment_format);
      if (fields.status === "agreed") {
        if (merged.agreed_price_cents == null) throw badRequest("An agreed price is required.", { fields: { agreed_price_cents: "Required" } });
        if (!merged.approved_by) throw badRequest("Approved by is required for an agreed price.", { fields: { approved_by: "Required" } });
        Object.assign(fields, { approved_at: new Date() }, await snapshotFields(c, merged));
      }
      const { before, after } = await updateVersioned(c, "pricing_records", params.id, v, fields);
      await audit(c, a, { entityType: "pricing_record", entityId: params.id, action: fields.status === "agreed" ? "agree" : "update", before, after });
      return { record: after };
    });
  });

  r.post("/pricing/:id/revisions", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const overrides = defined(parse(z.object({ ...priceFields, fulfillment_format: priceFields.fulfillment_format.optional() }).partial(), b)) as any;
    return tx(async (c) => {
      const prev = await loadForUpdate(c, params.id);
      if (EDITABLE.includes(prev.status)) throw badRequest("Draft and proposed prices can be edited directly.");
      const copy: any = {
        channel_id: prev.channel_id, product_id: prev.product_id, status: "draft",
        ...Object.fromEntries(Object.keys(priceFields).map((k) => [k, prev[k]])),
        effective_from: null, effective_to: null, approved_by: null,
        ...overrides,
      };
      checkDates(copy);
      await checkProductRules(c, copy.product_id, copy.fulfillment_format);
      const rec = await insertRecord(c, copy, a, prev.id);
      return { record: rec };
    });
  });

  r.post("/pricing/:id/activate", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ effective_from: date, effective_to: date, approved_by: text(80), version }), b);
    return tx(async (c) => {
      const rec = await loadForUpdate(c, params.id);
      if (rec.version !== d.version) throw conflict();
      if (!["proposed", "agreed"].includes(rec.status)) throw badRequest(`A ${rec.status} price cannot be activated.`);
      if (rec.agreed_price_cents == null) throw badRequest("Activation needs an agreed price.", { fields: { agreed_price_cents: "Required" } });
      const from = rec.effective_from ?? d.effective_from ?? null;
      const to = rec.effective_to ?? d.effective_to ?? null;
      const approvedBy = rec.approved_by ?? d.approved_by ?? null;
      if (!from) throw badRequest("Activation needs an effective start date.", { fields: { effective_from: "Required" } });
      if (!approvedBy) throw badRequest("Activation needs an approver name.", { fields: { approved_by: "Required" } });
      checkDates({ effective_from: from, effective_to: to });
      await checkProductRules(c, rec.product_id, rec.fulfillment_format);

      // Supersede the current active price for the same channel + variant + format (closing its period),
      // reject anything else that would overlap.
      const overlapping = await c.query(
        `select * from pricing_records where status = 'active' and id <> $1 and channel_id = $2 and product_id = $3 and fulfillment_format = $4
           and daterange(effective_from, effective_to, '[]') && daterange($5::date, $6::date, '[]') for update`,
        [rec.id, rec.channel_id, rec.product_id, rec.fulfillment_format, from, to],
      );
      for (const o of overlapping.rows) {
        if (o.effective_from >= from)
          throw new HttpError(409, "overlap", `An active price starting ${o.effective_from} already covers this period. Choose a later effective start.`);
        const closeTo = (await c.query("select ($1::date - 1)::text as d", [from])).rows[0].d;
        const closed = await c.query(
          "update pricing_records set status = 'expired', effective_to = $2, superseded_by_id = $3, updated_at = now(), version = version + 1 where id = $1 returning *",
          [o.id, o.effective_to && o.effective_to < closeTo ? o.effective_to : closeTo, rec.id],
        );
        await audit(c, a, { entityType: "pricing_record", entityId: o.id, action: "superseded", before: { status: o.status, effective_to: o.effective_to }, after: { status: "expired", effective_to: closed.rows[0].effective_to, superseded_by_id: rec.id } });
      }
      const snaps = rec.terms_snapshot ? {} : await snapshotFields(c, rec);
      const fields: Record<string, unknown> = { status: "active", effective_from: from, effective_to: to, approved_by: approvedBy, ...snaps };
      if (!rec.approved_at) fields.approved_at = new Date();
      const { before, after } = await updateVersioned(c, "pricing_records", rec.id, rec.version, fields);
      await audit(c, a, { entityType: "pricing_record", entityId: rec.id, action: "activate", before: { status: before.status }, after: { status: "active", effective_from: from, effective_to: to, approved_by: approvedBy } });
      return { record: after, superseded: overlapping.rows.map((o) => o.id) };
    });
  });

  r.post("/pricing/:id/expire", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), version }), b);
    return tx(async (c) => {
      const rec = await loadForUpdate(c, params.id);
      if (rec.status !== "active") throw badRequest("Only active prices can be expired.");
      if (rec.version !== d.version) throw conflict();
      checkDates({ effective_from: rec.effective_from, effective_to: d.effective_to });
      if (rec.effective_to && d.effective_to > rec.effective_to) throw badRequest("Cannot extend an existing end date; create a revision instead.");
      const { before, after } = await updateVersioned(c, "pricing_records", rec.id, rec.version, { status: "expired", effective_to: d.effective_to });
      await audit(c, a, { entityType: "pricing_record", entityId: rec.id, action: "expire", before: { status: before.status, effective_to: before.effective_to }, after: { status: "expired", effective_to: d.effective_to } });
      return { record: after };
    });
  });
}

async function insertRecord(c: pg.PoolClient, d: any, a: Actor, previousId: string | null) {
  const cols = ["channel_id", "product_id", "status", ...Object.keys(priceFields), "entered_by", "entered_auth_subject", "previous_record_id"];
  const values: any = { ...d, entered_by: a.signer, entered_auth_subject: a.sub, previous_record_id: previousId };
  if (d.status === "agreed") {
    Object.assign(values, await snapshotFields(c, d), { approved_at: new Date() });
    cols.push("cost_snapshot_id", "snapshot_cost_cents", "snapshot_retail_cents", "terms_snapshot", "approved_at");
  }
  const ins = await c.query(
    `insert into pricing_records (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    cols.map((k) => values[k] ?? null),
  );
  await audit(c, a, { entityType: "pricing_record", entityId: ins.rows[0].id, action: previousId ? "revise" : "create", after: ins.rows[0] });
  return ins.rows[0];
}

