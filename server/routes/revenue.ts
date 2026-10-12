import { z } from "zod";
import { Router, updateVersioned } from "../router";
import { query, tx } from "../db";
import { audit } from "../audit";
import { notFound } from "../http";
import { parse, text, cents, count, month, version, assertUuid, defined } from "../validate";

// Core amounts must be entered (an explicit 0 is fine) before a record counts toward totals.
export const CORE_FIELDS = ["order_count", "units_sold", "gift_sales_cents", "shipping_revenue_cents", "refunds_cents", "marketplace_fees_cents"] as const;

const fields = {
  order_count: count,
  units_sold: count,
  gift_sales_cents: cents,
  shipping_revenue_cents: cents,
  refunds_cents: cents,
  marketplace_fees_cents: cents,
  payment_received_cents: cents,
  notes: text(4000),
};

export function withCalcs(r: any) {
  const complete = CORE_FIELDS.every((k) => r[k] !== null && r[k] !== undefined);
  // Net revenue = gift sales + shipping revenue − refunds (may be negative).
  const net = complete ? r.gift_sales_cents + r.shipping_revenue_cents - r.refunds_cents : null;
  return {
    ...r,
    reporting_month: typeof r.reporting_month === "string" ? r.reporting_month.slice(0, 7) : r.reporting_month,
    complete,
    missing_fields: CORE_FIELDS.filter((k) => r[k] === null || r[k] === undefined),
    net_revenue_cents: net,
    revenue_after_fees_cents: complete ? net! - r.marketplace_fees_cents : null,
  };
}

export function revenueRoutes(r: Router) {
  r.get("/revenue/monthly", async ({ query: q }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.get("from")) { params.push(parse(month, q.get("from")) + "-01"); where.push(`r.reporting_month >= $${params.length}::date`); }
    if (q.get("to")) { params.push(parse(month, q.get("to")) + "-01"); where.push(`r.reporting_month <= $${params.length}::date`); }
    if (q.get("month")) { params.push(parse(month, q.get("month")) + "-01"); where.push(`r.reporting_month = $${params.length}::date`); }
    if (q.get("channel_id")) { params.push(q.get("channel_id")); where.push(`r.channel_id = $${params.length}`); }
    // Inactive channels/marketplaces are always included in financial totals.
    const rows = (
      await query(
        `select r.*, c.name as channel_name, c.type as channel_type, m.status as marketplace_status
         from monthly_revenue r join channels c on c.id = r.channel_id left join marketplaces m on m.channel_id = c.id
         ${where.length ? "where " + where.join(" and ") : ""} order by r.reporting_month desc, c.name`,
        params,
      )
    ).map(withCalcs);
    const complete = rows.filter((x) => x.complete);
    const sum = (k: string) => complete.reduce((s, x) => s + x[k], 0);
    const byChannel = new Map<string, { channel_id: string; channel_name: string; net_revenue_cents: number; marketplace_fees_cents: number }>();
    for (const x of complete) {
      const e = byChannel.get(x.channel_id) ?? { channel_id: x.channel_id, channel_name: x.channel_name, net_revenue_cents: 0, marketplace_fees_cents: 0 };
      e.net_revenue_cents += x.net_revenue_cents;
      e.marketplace_fees_cents += x.marketplace_fees_cents;
      byChannel.set(x.channel_id, e);
    }
    return {
      revenue: rows,
      totals: {
        records_included: complete.length,
        records_incomplete: rows.length - complete.length,
        gift_sales_cents: sum("gift_sales_cents"),
        shipping_revenue_cents: sum("shipping_revenue_cents"),
        refunds_cents: sum("refunds_cents"),
        net_revenue_cents: sum("net_revenue_cents"),
        marketplace_fees_cents: sum("marketplace_fees_cents"),
        revenue_after_fees_cents: sum("revenue_after_fees_cents"),
        order_count: sum("order_count"),
        units_sold: sum("units_sold"),
      },
      byChannel: [...byChannel.values()].sort((a, b) => b.net_revenue_cents - a.net_revenue_cents),
    };
  });

  r.post("/revenue/monthly", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ channel_id: z.string().uuid(), reporting_month: month, ...fields }), b);
    return tx(async (c) => {
      const cols = ["channel_id", "reporting_month", ...Object.keys(fields), "recorded_by", "auth_subject"];
      const v: any = { ...d, reporting_month: d.reporting_month + "-01", recorded_by: a.signer, auth_subject: a.sub };
      const ins = await c.query(
        `insert into monthly_revenue (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
        cols.map((k) => v[k] ?? null),
      );
      await audit(c, a, { entityType: "monthly_revenue", entityId: ins.rows[0].id, action: "create", after: ins.rows[0] });
      return { record: withCalcs(ins.rows[0]) };
    });
  });

  r.patch("/revenue/monthly/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = defined(parse(z.object({ ...fields, version }), b)) as any;
    const { version: v, ...f } = d;
    return tx(async (c) => {
      const exists = await c.query("select 1 from monthly_revenue where id = $1", [params.id]);
      if (!exists.rowCount) throw notFound("Revenue record");
      const { before, after } = await updateVersioned(c, "monthly_revenue", params.id, v, { ...f, recorded_by: a.signer, auth_subject: a.sub });
      await audit(c, a, { entityType: "monthly_revenue", entityId: params.id, action: "correct", before, after });
      return { record: withCalcs(after) };
    });
  });

  r.get("/revenue/monthly/:id/history", async ({ params }) => {
    assertUuid(params.id);
    return {
      events: await query(
        "select action, before, after, signer_name, created_at from audit_events where entity_type = 'monthly_revenue' and entity_id = $1 order by created_at desc",
        [params.id],
      ),
    };
  });
}
