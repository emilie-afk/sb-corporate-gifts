// One import path for both the collector endpoint and the manual upload.
// Canonical order per store + order Name; newer snapshots update, older/equal-time different snapshots
// never overwrite; exact duplicate reports are no-ops; failures leave stored data untouched.
import { getPool, tx } from "../db";
import { assertPayload, computeOrder, payloadHash, type ComputedOrder } from "./revenueOrders";
import { classify, type Rule } from "./matching";
import type { OrdersPayload } from "../../shared/corporateOrders.js";

export type IngestMeta = { source: "collector" | "manual"; signer: string; sub: string | null; fileName?: string | null };

const DATA_COLS = [
  "order_id", "order_name", "created_at_raw", "created_at", "order_date", "order_month", "financial_status", "cancelled_at_raw", "currency",
  "subtotal_cents", "shipping_cents", "taxes_cents", "duties_cents", "total_cents", "discount_cents", "refunded_cents",
  "excluded_lines_cents", "gift_sales_cents", "refund_applied_cents", "net_revenue_cents", "units", "revenue_status", "awaiting_payment",
  "warnings", "match_fields", "lines", "content_hash",
] as const;
const COL_TYPES: Record<string, string> = {
  store: "text", order_key: "text", order_id: "text", order_name: "text", created_at_raw: "text", created_at: "timestamptz", order_date: "date", order_month: "date",
  financial_status: "text", cancelled_at_raw: "text", currency: "text", subtotal_cents: "bigint", shipping_cents: "bigint", taxes_cents: "bigint", duties_cents: "bigint",
  total_cents: "bigint", discount_cents: "bigint", refunded_cents: "bigint", excluded_lines_cents: "bigint", gift_sales_cents: "bigint", refund_applied_cents: "bigint",
  net_revenue_cents: "bigint", units: "int", revenue_status: "text", awaiting_payment: "boolean", warnings: "text[]", match_fields: "jsonb", lines: "jsonb",
  content_hash: "text", snapshot_at: "timestamptz", chronology: "text", rule_channel_id: "uuid", rule_status: "text", rule_conflict_channel_ids: "uuid[]",
};
const recordset = (cols: string[]) => cols.map((c) => `${c} ${COL_TYPES[c]}`).join(", ");

export async function activeRules(db = getPool()): Promise<Rule[]> {
  return (await db.query("select id, channel_id, source_field, operator, match_value, enabled from match_rules where removed_at is null and enabled")).rows;
}

export async function ingestPayload(raw: unknown, meta: IngestMeta) {
  const pool = getPool();
  // Shape/privacy check first. A rejected payload is still recorded (codes and paths only).
  try {
    assertPayload(raw);
  } catch (e: any) {
    const p: any = raw ?? {};
    await pool.query(
      `insert into shopify_import_runs (source, file_name, payload_sha256, exported_at, chronology, coverage_from, coverage_to, status, errors, signer_name, auth_subject, completed_at)
       values ($1,$2,'rejected',now(),$3,current_date,current_date,'failed',$4,$5,$6,now())`,
      [meta.source, typeof p.fileName === "string" ? p.fileName.slice(0, 200) : meta.fileName ?? null, meta.source === "collector" ? "reported" : "declared",
        JSON.stringify([{ code: "payload_rejected", message: e.message, problems: e.details?.problems ?? [] }]), meta.signer, meta.sub],
    );
    throw e;
  }
  const payload = raw as OrdersPayload;
  const chronology = meta.source === "collector" ? "reported" : "declared";
  const hash = payloadHash(payload);
  const fileName = payload.fileName ?? meta.fileName ?? null;

  const prior = (await pool.query(
    "select id, completed_at from shopify_import_runs where payload_sha256 = $1 and status in ('completed', 'no_change') order by started_at limit 1", [hash],
  )).rows[0];
  if (prior) {
    const dup = (await pool.query(
      `insert into shopify_import_runs (source, file_name, payload_sha256, exported_at, chronology, coverage_from, coverage_to, available_fields, status, duplicate_of,
         orders_received, orders_unchanged, signer_name, auth_subject, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'duplicate',$9,$10,$10,$11,$12,now()) returning *`,
      [meta.source, fileName, hash, payload.exportedAt, chronology, payload.coverageFrom, payload.coverageTo, payload.fields, prior.id, payload.orders.length, meta.signer, meta.sub],
    )).rows[0];
    return { run: dup, duplicate: true };
  }

  const run = (await pool.query(
    `insert into shopify_import_runs (source, file_name, payload_sha256, exported_at, chronology, coverage_from, coverage_to, available_fields, status, orders_received, signer_name, auth_subject)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,$10,$11) returning *`,
    [meta.source, fileName, hash, payload.exportedAt, chronology, payload.coverageFrom, payload.coverageTo, payload.fields, payload.orders.length, meta.signer, meta.sub],
  )).rows[0];

  try {
    const result = await tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(7230001)"); // one import at a time
      const warnings: string[] = [];
      const rejected: string[] = [];
      const computed = new Map<string, ComputedOrder>();
      for (const o of payload.orders) {
        const r = computeOrder(o);
        if ("rejected" in r) { rejected.push(r.rejected); continue; }
        if (computed.has(r.order.order_key)) { warnings.push(`${r.order.order_name}: listed twice in the report — the first entry was used`); continue; }
        computed.set(r.order.order_key, r.order);
        if (r.order.order_date < payload.coverageFrom || r.order.order_date > payload.coverageTo) warnings.push(`${r.order.order_name}: created ${r.order.order_date}, outside the declared coverage`);
      }
      const keys = [...computed.keys()];
      const existing = new Map<string, any>((await c.query(
        `select id, order_key, snapshot_at, content_hash, net_revenue_cents, gift_sales_cents, shipping_cents, refunded_cents, revenue_status, financial_status, order_month
         from shopify_orders where store = $1 and order_key = any($2)`,
        [payload.store, keys],
      )).rows.map((r) => [r.order_key, r]));
      const snapshotAt = new Date(payload.exportedAt);
      const rules = await activeRules(c as any);
      const inserts: any[] = [], updates: any[] = [], touches: string[] = [];
      let stale = 0;
      const auditRows: any[] = [];
      for (const [key, o] of computed) {
        const ex = existing.get(key);
        const cls = classify(o.match_fields, rules);
        const row = { store: payload.store, ...o, snapshot_at: snapshotAt.toISOString(), chronology,
          rule_channel_id: cls.channel_id, rule_status: cls.status, rule_conflict_channel_ids: cls.conflict_channel_ids };
        if (!ex) { inserts.push(row); continue; }
        const exAt = new Date(ex.snapshot_at).getTime();
        if (snapshotAt.getTime() < exAt) {
          stale++;
          if (ex.content_hash !== o.content_hash) warnings.push(`${o.order_name}: this report is older than the stored snapshot — not applied`);
          continue;
        }
        if (snapshotAt.getTime() === exAt) {
          if (ex.content_hash !== o.content_hash) { stale++; warnings.push(`${o.order_name}: differs from a snapshot with the same export time — chronology uncertain, not applied`); }
          else touches.push(key);
          continue;
        }
        if (ex.content_hash === o.content_hash) { touches.push(key); continue; }
        updates.push(row);
        auditRows.push({
          entity_type: "shopify_order", entity_id: ex.id, action: "import_update",
          before: { net_revenue_cents: ex.net_revenue_cents, gift_sales_cents: ex.gift_sales_cents, shipping_cents: ex.shipping_cents, refunded_cents: ex.refunded_cents, revenue_status: ex.revenue_status, financial_status: ex.financial_status, order_month: ex.order_month },
          after: { net_revenue_cents: o.net_revenue_cents, gift_sales_cents: o.gift_sales_cents, shipping_cents: o.shipping_cents, refunded_cents: o.refunded_cents, revenue_status: o.revenue_status, financial_status: o.financial_status, order_month: o.order_month, import_id: run.id },
        });
      }
      if (meta.source === "manual") warnings.unshift("Export time was declared by the uploader (manual upload); chronology against collector snapshots relies on it");

      const cols = ["store", "order_key", ...DATA_COLS, "snapshot_at", "chronology", "rule_channel_id", "rule_status", "rule_conflict_channel_ids"];
      const jsonRows = (rs: any[]) => JSON.stringify(rs.map((r) => Object.fromEntries(cols.map((k) => [k, r[k]]))));
      if (inserts.length) {
        await c.query(
          `insert into shopify_orders (${cols.join(",")}, first_import_id, last_import_id)
           select ${cols.join(",")}, $2::uuid, $2::uuid from jsonb_to_recordset($1::jsonb) as x(${recordset(cols)})`,
          [jsonRows(inserts), run.id],
        );
      }
      if (updates.length) {
        const set = [...DATA_COLS, "snapshot_at", "chronology", "rule_channel_id", "rule_status", "rule_conflict_channel_ids"].map((k) => `${k} = x.${k}`).join(", ");
        await c.query(
          `update shopify_orders o set ${set}, last_import_id = $2::uuid, updated_at = now(), version = o.version + 1
           from jsonb_to_recordset($1::jsonb) as x(${recordset(cols)})
           where o.store = x.store and o.order_key = x.order_key and o.snapshot_at < x.snapshot_at`,
          [jsonRows(updates), run.id],
        );
      }
      if (touches.length) {
        await c.query(
          "update shopify_orders set snapshot_at = greatest(snapshot_at, $3::timestamptz), last_import_id = $4 where store = $1 and order_key = any($2)",
          [payload.store, touches, snapshotAt.toISOString(), run.id],
        );
      }
      if (auditRows.length) {
        await c.query(
          `insert into audit_events (entity_type, entity_id, action, before, after, signer_name, auth_subject)
           select entity_type, entity_id, action, before, after, $2, $3 from jsonb_to_recordset($1::jsonb) as x(entity_type text, entity_id uuid, action text, before jsonb, after jsonb)`,
          [JSON.stringify(auditRows), meta.signer, meta.sub],
        );
      }
      if (rejected.length) warnings.push(...rejected.slice(0, 50).map((r) => `Rejected: ${r}`));
      return { inserted: inserts.length, updated: updates.length, unchanged: touches.length, stale, rejected: rejected.length, warnings };
    });
    const status = result.inserted + result.updated === 0 ? "no_change" : "completed";
    const done = (await pool.query(
      `update shopify_import_runs set status = $2, orders_new = $3, orders_updated = $4, orders_unchanged = $5, orders_stale = $6, orders_rejected = $7,
         warnings = $8, completed_at = now() where id = $1 returning *`,
      [run.id, status, result.inserted, result.updated, result.unchanged, result.stale, result.rejected, JSON.stringify(result.warnings.slice(0, 200))],
    )).rows[0];
    return { run: done, duplicate: false };
  } catch (e: any) {
    await pool.query("update shopify_import_runs set status = 'failed', errors = $2, completed_at = now() where id = $1",
      [run.id, JSON.stringify([{ code: "import_failed", message: String(e?.message ?? e).slice(0, 500) }])]);
    throw e;
  }
}
