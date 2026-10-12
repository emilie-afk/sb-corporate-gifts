import { z } from "zod";
import { Router, updateVersioned } from "../router";
import { query, one, tx } from "../db";
import { audit } from "../audit";
import { badRequest, notFound } from "../http";
import { parse, text, reqText, url, pct, version, assertUuid, defined } from "../validate";

export const FAMILIES = ["live_to_give_box", "succulent_arrangement", "airplant_gift_set", "plant_only", "custom_pots", "pots_plus_succulents", "watering_can", "other"] as const;
const tri = z.enum(["yes", "no", "unknown"]);

const teamFields = {
  selected: z.boolean().optional(),
  vendor: text(120),
  family: z.enum(FAMILIES).nullable().optional(),
  contents_summary: text(2000),
  availability: z.enum(["available", "planned", "paused"]).nullable().optional(),
  card_eligible: tri.optional(),
  customization_note: text(2000),
  plants_included: tri.optional(),
  individual_recipient_fulfillment: tri.optional(),
  fulfillment_note: text(2000),
  cost_source_note: text(2000),
};
const manualFields = {
  name: reqText(300),
  variant: text(200),
  sku: text(120),
  product_url: url,
  image_url: url,
};

function checkFamilyRules(p: { family?: string | null; plants_included?: string; individual_recipient_fulfillment?: string }) {
  const fields: Record<string, string> = {};
  if (p.family === "custom_pots" && p.plants_included === "yes") fields.plants_included = "Custom pots are pots only — plants are not included.";
  if (p.family === "pots_plus_succulents" && p.individual_recipient_fulfillment === "yes")
    fields.individual_recipient_fulfillment = "Pots plus succulents are bulk-only; SB cannot fulfill them to individual recipients.";
  if (Object.keys(fields).length) throw badRequest("This gift's fulfillment rules don't allow that combination.", { fields });
}

const PRODUCT_SELECT = `
  select p.*,
    cs.gift_cost_cents as current_cost_cents, cs.created_at as current_cost_at, cs.id as current_cost_snapshot_id,
    (select count(*) from gift_source_links l where l.product_id = p.id and l.removed_at is null)::int as source_link_count,
    (select coalesce(json_agg(json_build_object('id', c.id, 'name', c.name) order by c.name), '[]')
       from product_collections pc join collection_references c on c.id = pc.collection_id
      where pc.product_id = p.id and c.removed_at is null) as collections
  from products p
  left join lateral (select * from cost_snapshots s where s.product_id = p.id order by s.created_at desc limit 1) cs on true`;

export function productRoutes(r: Router) {
  r.get("/products", async ({ query: q }) => {
    const where = ["p.archived_at is null"];
    const params: unknown[] = [];
    if (q.get("q")) {
      params.push(`%${q.get("q")}%`);
      where.push(`(p.name ilike $${params.length} or p.variant ilike $${params.length} or p.sku ilike $${params.length})`);
    }
    if (q.get("selected") === "1") where.push("p.selected");
    if (q.get("family")) { params.push(q.get("family")); where.push(`p.family = $${params.length}`); }
    if (q.get("collection_id")) {
      params.push(q.get("collection_id"));
      where.push(`exists (select 1 from product_collections pc where pc.product_id = p.id and pc.collection_id = $${params.length})`);
    }
    const limit = Math.min(Number(q.get("limit") ?? 50) || 50, 200);
    const offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0);
    const w = `where ${where.join(" and ")}`;
    const total = await one(`select count(*)::int as n from products p ${w}`, params);
    const rows = await query(`${PRODUCT_SELECT} ${w} order by p.selected desc, lower(p.name), p.variant nulls first limit ${limit} offset ${offset}`, params);
    return { products: rows, total: total?.n ?? 0, limit, offset };
  });

  r.get("/products/:id", async ({ params }) => {
    assertUuid(params.id);
    const p = await one(`${PRODUCT_SELECT} where p.id = $1`, [params.id]);
    if (!p) throw notFound("Product");
    const [snapshots, links] = await Promise.all([
      query("select id, gift_cost_cents, detail, confirmed_by, created_at from cost_snapshots where product_id = $1 order by created_at desc limit 20", [params.id]),
      query(
        `select l.*, m.label as mapping_label, m.vendor, m.tab_name, m.cost_basis
         from gift_source_links l join source_mappings m on m.id = l.source_mapping_id where l.product_id = $1 and l.removed_at is null`,
        [params.id],
      ),
    ]);
    return { product: p, costSnapshots: snapshots, sourceLinks: links };
  });

  r.post("/products", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ ...manualFields, ...teamFields }), b);
    checkFamilyRules(d as any);
    return tx(async (c) => {
      const cols = Object.keys(defined(d));
      const vals = cols.map((k) => (d as any)[k]);
      const ins = await c.query(
        `insert into products (source, ${cols.join(",")}) values ('manual', ${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
        vals,
      );
      await audit(c, a, { entityType: "product", entityId: ins.rows[0].id, action: "create", after: ins.rows[0] });
      return { product: ins.rows[0] };
    });
  });

  r.patch("/products/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    return tx(async (c) => {
      const cur = await c.query("select * from products where id = $1", [params.id]);
      if (!cur.rowCount) throw notFound("Product");
      const isManual = cur.rows[0].source === "manual";
      const schema = z.object({ ...teamFields, ...(isManual ? { ...manualFields, name: manualFields.name.optional() } : {}), version, archive: z.boolean().optional() });
      const d = defined(parse(schema, b)) as any;
      const { version: v, archive, ...fields } = d;
      if (archive) fields.archived_at = new Date();
      checkFamilyRules({ ...cur.rows[0], ...fields });
      const { before, after } = await updateVersioned(c, "products", params.id, v, fields);
      await audit(c, a, { entityType: "product", entityId: params.id, action: archive ? "archive" : "update", before, after });
      return { product: after };
    });
  });

  r.post("/products/:id/collections", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ collection_id: z.string().uuid(), remove: z.boolean().optional() }), b);
    return tx(async (c) => {
      if (d.remove) await c.query("delete from product_collections where product_id = $1 and collection_id = $2", [params.id, d.collection_id]);
      else await c.query("insert into product_collections (product_id, collection_id) values ($1,$2) on conflict do nothing", [params.id, d.collection_id]);
      await audit(c, a, { entityType: "product", entityId: params.id, action: d.remove ? "collection_unlink" : "collection_link", after: { collection_id: d.collection_id } });
      return { ok: true };
    });
  });

  // ------------------------------------------------- collection references
  const collSchema = z.object({ name: reqText(200), url: url, note: text(2000) });
  r.get("/collections", async () => ({
    collections: await query(
      `select c.*, (select count(*) from product_collections pc where pc.collection_id = c.id)::int as product_count
       from collection_references c where c.removed_at is null order by c.name`,
    ),
  }));
  r.post("/collections", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(collSchema, b);
    return tx(async (c) => {
      const ins = await c.query("insert into collection_references (name, url, note, created_by) values ($1,$2,$3,$4) returning *", [d.name, d.url ?? null, d.note ?? null, a.signer]);
      await audit(c, a, { entityType: "collection", entityId: ins.rows[0].id, action: "create", after: ins.rows[0] });
      return { collection: ins.rows[0] };
    });
  });
  r.patch("/collections/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = defined(parse(collSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    const { version: v, remove, ...fields } = d;
    if (remove) fields.removed_at = new Date();
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "collection_references", params.id, v, fields);
      await audit(c, a, { entityType: "collection", entityId: params.id, action: remove ? "remove" : "update", before, after });
      return { collection: after };
    });
  });

  // ------------------------------------------------------------- channels
  r.get("/channels", async () => ({
    channels: await query(
      `select c.*, m.id as marketplace_id, m.status as marketplace_status, m.provider_type
       from channels c left join marketplaces m on m.channel_id = c.id
       order by (c.type = 'direct') desc, c.name`,
    ),
  }));

  r.patch("/channels/:id/terms", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = defined(
      parse(
        z.object({
          default_discount_pct: pct,
          corporate_moq: z.union([z.number().int().min(1), z.null()]).optional(),
          payment_terms: text(1000),
          shipping_responsibility: text(1000),
          fee_note: text(1000),
          dispatch_requirement: text(1000),
          terms_note: text(2000),
          version,
        }),
        b,
      ),
    ) as any;
    const { version: v, ...fields } = d;
    fields.terms_updated_by = a.signer;
    fields.terms_updated_at = new Date();
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "channels", params.id, v, fields);
      const m = await c.query("select id from marketplaces where channel_id = $1", [params.id]);
      await audit(c, a, { entityType: "channel_terms", entityId: params.id, marketplaceId: m.rows[0]?.id ?? null, action: "update", before, after });
      return { channel: after };
    });
  });
}

