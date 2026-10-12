// Shopify-derived revenue: imports, canonical orders, matching rules, manual classification,
// manual adjustments, legacy reconciliation and the channel/month summary.
import { z } from "zod";
import { createHash } from "node:crypto";
import { Router, updateVersioned } from "../router";
import { query, one, tx, getPool } from "../db";
import { audit } from "../audit";
import { badRequest, conflict, notFound } from "../http";
import { parse, text, reqText, month, version, assertUuid } from "../validate";
import { ingestPayload } from "../lib/ingest";
import { classify, effective, ruleMatch, type Rule } from "../lib/matching";
import { withCalcs } from "./revenue";

const FIELD_LABEL: Record<string, string> = { source: "Order source", tags: "Order tags", billing_company: "Billing company" };

// ------------------------------------------------------------------ coverage
export async function coverage() {
  const runs = await query(
    `select coverage_from::text as f, coverage_to::text as t from shopify_import_runs where status in ('completed', 'no_change', 'duplicate') order by coverage_from`,
  );
  const merged: { from: string; to: string }[] = [];
  const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.f <= nextDay(last.to)) { if (r.t > last.to) last.to = r.t; }
    else merged.push({ from: r.f, to: r.t });
  }
  return merged;
}

export function monthCoverage(month: string, intervals: { from: string; to: string }[]) {
  const start = month.slice(0, 7) + "-01";
  const d = new Date(start + "T00:00:00Z");
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  let covered = 0;
  for (const i of intervals) {
    const a = i.from > start ? i.from : start, b = i.to < end ? i.to : end;
    if (a <= b) covered += (Date.parse(b) - Date.parse(a)) / 86400000 + 1;
  }
  const days = Number(end.slice(8));
  return { days, covered_days: Math.min(covered, days), complete: covered >= days, end };
}

// ------------------------------------------------------- rule-change preview
type Proposal = {
  op: "create" | "update" | "enable" | "disable" | "remove";
  rule_id?: string;
  rule?: { channel_id: string; source_field: "source" | "tags" | "billing_company"; operator: "equals" | "contains"; match_value: string; note?: string | null };
};
const proposalSchema = z.object({
  op: z.enum(["create", "update", "enable", "disable", "remove"]),
  rule_id: z.string().uuid().optional(),
  rule: z.object({
    channel_id: z.string().uuid(),
    source_field: z.enum(["source", "tags", "billing_company"]),
    operator: z.enum(["equals", "contains"]),
    match_value: z.string().trim().min(1, "Match value required").max(200),
    note: text(500),
  }).optional(),
});

async function loadRulesAll() {
  return (await query("select * from match_rules where removed_at is null order by created_at")) as any[];
}

function applyProposal(rules: any[], p: Proposal): { next: Rule[]; changed: Rule | null } {
  const next: Rule[] = rules.map((r) => ({ ...r }));
  if (p.op === "create") {
    if (!p.rule) throw badRequest("Rule details required");
    const nr: Rule = { id: "proposed", ...p.rule, enabled: true };
    next.push(nr);
    return { next, changed: nr };
  }
  const r = next.find((x) => x.id === p.rule_id);
  if (!r) throw notFound("Rule");
  if (p.op === "update") { if (!p.rule) throw badRequest("Rule details required"); Object.assign(r, p.rule); }
  if (p.op === "enable") r.enabled = true;
  if (p.op === "disable") r.enabled = false;
  if (p.op === "remove") return { next: next.filter((x) => x.id !== r.id), changed: { ...r, enabled: false } };
  return { next, changed: r };
}

async function impact(p: Proposal) {
  const rules = await loadRulesAll();
  const { next, changed } = applyProposal(rules, p);
  const orders = await query(
    `select id, order_name, order_date::text, order_month::text, match_fields, net_revenue_cents, revenue_status,
            rule_status, rule_channel_id, manual_state, manual_channel_id from shopify_orders`,
  );
  const channels = new Map((await query("select id, name from channels")).map((c) => [c.id, c.name]));
  const name = (id: string | null) => (id ? channels.get(id) ?? "Unknown channel" : null);
  const label = (e: { status: string; channel_id: string | null }) => (e.status === "assigned" ? name(e.channel_id)! : e.status === "conflict" ? "Conflict" : e.status === "excluded" ? "Excluded" : "Unclassified");
  const curRules = rules.filter((r) => r.enabled) as Rule[];
  const nextRules = next.filter((r) => r.enabled);
  const matched: any[] = [], moved: any[] = [], conflicts: any[] = [], heldByManual: any[] = [];
  const months = new Set<string>();
  let changedRuleResults = 0;
  for (const o of orders) {
    const before = classify(o.match_fields, curRules), after = classify(o.match_fields, nextRules);
    if (changed) { const v = ruleMatch({ ...changed, enabled: true }, o.match_fields); if (v !== null && p.op !== "remove" && p.op !== "disable") matched.push({ o, v }); }
    const ruleChanged = before.status !== after.status || before.channel_id !== after.channel_id || before.conflict_channel_ids.join() !== after.conflict_channel_ids.join();
    if (!ruleChanged) continue;
    changedRuleResults++;
    months.add(o.order_month);
    const eb = effective(o, before), ea = effective(o, after);
    const sample = { id: o.id, order: o.order_name, date: o.order_date, net_revenue_cents: o.net_revenue_cents, counted: o.revenue_status === "counted", values: after.values.length ? after.values : before.values };
    if (ea.manual) heldByManual.push({ ...sample, kept: label(ea) });
    else if (eb.status !== ea.status || eb.channel_id !== ea.channel_id) moved.push({ ...sample, from: label(eb), to: label(ea) });
    if (after.status === "conflict" && before.status !== "conflict")
      conflicts.push({ ...sample, channels: after.conflict_channel_ids.map((id) => name(id)) });
  }
  const token = createHash("sha256").update(JSON.stringify({ p, rules: rules.map((r) => [r.id, r.version, r.enabled]), n: orders.length,
    sig: (await one("select coalesce(max(updated_at), 'epoch')::text as m from shopify_orders"))!.m })).digest("hex");
  return {
    token,
    rule_matches: { count: matched.length, sample: matched.slice(0, 15).map(({ o, v }) => ({ order: o.order_name, date: o.order_date, value: v, net_revenue_cents: o.net_revenue_cents, counted: o.revenue_status === "counted" })) },
    moved: { count: moved.length, sample: moved.slice(0, 25) },
    new_conflicts: { count: conflicts.length, sample: conflicts.slice(0, 15) },
    manual_overrides_kept: { count: heldByManual.length, sample: heldByManual.slice(0, 10) },
    rule_results_changed: changedRuleResults,
    affected_months: [...months].sort(),
    next,
  };
}

export function revenueShopifyRoutes(r: Router) {
  // ------------------------------------------------------------ imports
  r.post("/revenue/imports/manual", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const out = await ingestPayload(b.payload, { source: "manual", signer: a.signer, sub: a.sub, fileName: b.payload?.fileName ?? null });
    return { run: out.run, duplicate: out.duplicate };
  });

  r.get("/revenue/imports", async () => {
    const runs = await query(
      `select id, source, file_name, exported_at, chronology, coverage_from::text, coverage_to::text, status, duplicate_of, orders_received, orders_new,
              orders_updated, orders_unchanged, orders_stale, orders_rejected, errors, warnings, signer_name, started_at, completed_at
       from shopify_import_runs order by started_at desc limit 30`,
    );
    const last = await query(
      `select distinct on (source) source, id, completed_at, exported_at, coverage_from::text, coverage_to::text from shopify_import_runs
       where status in ('completed', 'no_change', 'duplicate') order by source, completed_at desc`,
    );
    const counts = await one(
      `select count(*)::int as orders, count(*) filter (where class_status = 'assigned')::int as assigned,
              count(*) filter (where class_status = 'conflict')::int as conflicts, count(*) filter (where class_status = 'unclassified')::int as unclassified,
              count(*) filter (where class_status = 'excluded')::int as excluded, min(order_date)::text as first_order, max(order_date)::text as last_order
       from shopify_orders_effective`,
    );
    return { runs, last_success: last, coverage: await coverage(), counts };
  });

  // ------------------------------------------------------------- orders
  r.get("/revenue/orders", async ({ query: q }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.get("status")) { params.push(q.get("status")); where.push(`o.class_status = $${params.length}`); }
    if (q.get("channel_id")) { params.push(q.get("channel_id")); where.push(`o.channel_id = $${params.length}`); }
    if (q.get("month")) { params.push(parse(month, q.get("month")) + "-01"); where.push(`o.order_month = $${params.length}::date`); }
    if (q.get("q")) {
      params.push(`%${q.get("q")}%`);
      where.push(`(o.order_name ilike $${params.length} or o.match_fields->>'source' ilike $${params.length} or o.match_fields->>'billing_company' ilike $${params.length} or o.match_fields->>'tags' ilike $${params.length})`);
    }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const limit = Math.min(Number(q.get("limit") ?? 50) || 50, 200), offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0);
    const total = await one(`select count(*)::int as n from shopify_orders_effective o ${w}`, params);
    const orders = await query(
      `select o.id, o.order_name, o.order_date::text, o.order_month::text, o.financial_status, o.revenue_status, o.awaiting_payment, o.gift_sales_cents, o.shipping_cents,
              o.refund_applied_cents, o.net_revenue_cents, o.units, o.match_fields, o.warnings, o.class_status, o.channel_id, o.class_manual, o.manual_reason, o.manual_by,
              o.manual_at, o.rule_conflict_channel_ids, o.version, c.name as channel_name
       from shopify_orders_effective o left join channels c on c.id = o.channel_id ${w} order by o.order_date desc, o.order_name desc limit ${limit} offset ${offset}`,
      params,
    );
    return { orders, total: total?.n ?? 0, limit, offset };
  });

  r.get("/revenue/orders/:id", async ({ params }) => {
    assertUuid(params.id);
    const o = await one("select o.*, c.name as channel_name from shopify_orders_effective o left join channels c on c.id = o.channel_id where o.id = $1", [params.id]);
    if (!o) throw notFound("Order");
    const history = await query("select action, before, after, signer_name, created_at from audit_events where entity_type = 'shopify_order' and entity_id = $1 order by created_at desc", [params.id]);
    return { order: o, history };
  });

  r.post("/revenue/orders/:id/classify", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ action: z.enum(["assign", "exclude", "clear"]), channel_id: z.string().uuid().optional(), reason: text(500), version }), b);
    if (d.action !== "clear" && !d.reason) throw badRequest("A reason is required.", { fields: { reason: "Required" } });
    if (d.action === "assign" && !d.channel_id) throw badRequest("Choose a channel.", { fields: { channel_id: "Required" } });
    return tx(async (c) => {
      if (d.channel_id && !(await c.query("select 1 from channels where id = $1", [d.channel_id])).rowCount) throw badRequest("Unknown channel");
      const fields = d.action === "clear"
        ? { manual_state: null, manual_channel_id: null, manual_reason: null, manual_by: null, manual_at: null }
        : { manual_state: d.action === "assign" ? "assigned" : "excluded", manual_channel_id: d.action === "assign" ? d.channel_id : null, manual_reason: d.reason, manual_by: a.signer, manual_at: new Date() };
      const { before, after } = await updateVersioned(c, "shopify_orders", params.id, d.version, fields);
      const pick = (x: any) => ({ manual_state: x.manual_state, manual_channel_id: x.manual_channel_id, manual_reason: x.manual_reason, order_month: x.order_month });
      await audit(c, a, { entityType: "shopify_order", entityId: params.id, action: `manual_${d.action}`, before: pick(before), after: pick(after) });
      return { order: { id: after.id, version: after.version, manual_state: after.manual_state } };
    });
  });

  // -------------------------------------------------------------- rules
  r.get("/revenue/rules", async () => {
    const rules = await query(
      `select m.*, c.name as channel_name from match_rules m join channels c on c.id = m.channel_id where m.removed_at is null order by c.name, m.created_at`,
    );
    const orders = await query("select match_fields from shopify_orders");
    for (const rule of rules) rule.match_count = orders.filter((o) => ruleMatch({ ...rule, enabled: true }, o.match_fields) !== null).length;
    const history = await query("select action, before, after, signer_name, created_at from audit_events where entity_type = 'match_rule' order by created_at desc limit 50");
    return { rules, history };
  });

  /** Only fields actually present in imported reports are offered, with their most common values. */
  r.get("/revenue/rules/fields", async () => {
    const present = (await one(
      "select coalesce(array_agg(distinct f), '{}') as f from shopify_import_runs, unnest(available_fields) f where status in ('completed', 'no_change', 'duplicate')",
    ))!.f as string[];
    const fields = [];
    for (const f of ["source", "tags", "billing_company"].filter((x) => present.includes(x))) {
      const sql = f === "tags"
        ? "select lower(t) as v, count(*)::int as n from shopify_orders, jsonb_array_elements_text(coalesce(match_fields->'tags', '[]')) t group by 1 order by 2 desc limit 30"
        : `select lower(match_fields->>'${f}') as v, count(*)::int as n from shopify_orders where coalesce(match_fields->>'${f}', '') <> '' group by 1 order by 2 desc limit 30`;
      fields.push({ field: f, label: FIELD_LABEL[f], top_values: await query(sql) });
    }
    return { fields };
  });

  r.post("/revenue/rules/preview", async ({ body }) => {
    const p = parse(proposalSchema, await body()) as Proposal;
    const present = (await one("select coalesce(array_agg(distinct f), '{}') as f from shopify_import_runs, unnest(available_fields) f where status in ('completed', 'no_change', 'duplicate')"))!.f as string[];
    if (p.rule && !present.includes(p.rule.source_field)) throw badRequest(`“${FIELD_LABEL[p.rule.source_field]}” is not present in any imported report.`);
    const { next, ...out } = await impact(p);
    return out;
  });

  r.post("/revenue/rules/apply", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const p = parse(proposalSchema.extend({ token: z.string().length(64) }), b) as Proposal & { token: string };
    const { token, ...proposal } = p;
    return tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(7230001)");
      const imp = await impact(proposal);
      if (imp.token !== token) throw conflict("Orders or rules changed since the preview. Preview again before confirming.");
      let ruleId = proposal.rule_id ?? null;
      if (proposal.op === "create") {
        const ins = await c.query(
          "insert into match_rules (channel_id, source_field, operator, match_value, note, entered_by, auth_subject) values ($1,$2,$3,$4,$5,$6,$7) returning *",
          [proposal.rule!.channel_id, proposal.rule!.source_field, proposal.rule!.operator, proposal.rule!.match_value, proposal.rule!.note ?? null, a.signer, a.sub],
        );
        ruleId = ins.rows[0].id;
        await audit(c, a, { entityType: "match_rule", entityId: ruleId, action: "create", after: ins.rows[0] });
      } else {
        const cur = (await c.query("select * from match_rules where id = $1 and removed_at is null for update", [ruleId])).rows[0];
        if (!cur) throw notFound("Rule");
        const fields: Record<string, unknown> =
          proposal.op === "update" ? { ...proposal.rule, note: proposal.rule!.note ?? null } :
          proposal.op === "enable" ? { enabled: true } : proposal.op === "disable" ? { enabled: false } : { removed_at: new Date(), enabled: false };
        fields.updated_by = a.signer;
        const { before, after } = await updateVersioned(c, "match_rules", ruleId!, cur.version, fields);
        await audit(c, a, { entityType: "match_rule", entityId: ruleId, action: proposal.op, before, after });
      }
      // Re-classify every order with the confirmed rule set (manual decisions are untouched).
      const rules = (await c.query("select id, channel_id, source_field, operator, match_value, enabled from match_rules where removed_at is null and enabled")).rows as Rule[];
      const orders = (await c.query("select id, match_fields, rule_status, rule_channel_id, rule_conflict_channel_ids from shopify_orders")).rows;
      const changes = [];
      for (const o of orders) {
        const k = classify(o.match_fields, rules);
        if (k.status !== o.rule_status || k.channel_id !== o.rule_channel_id || k.conflict_channel_ids.join() !== (o.rule_conflict_channel_ids ?? []).join())
          changes.push({ id: o.id, rule_status: k.status, rule_channel_id: k.channel_id, rule_conflict_channel_ids: k.conflict_channel_ids });
      }
      if (changes.length) {
        await c.query(
          `update shopify_orders o set rule_status = x.rule_status, rule_channel_id = x.rule_channel_id, rule_conflict_channel_ids = x.rule_conflict_channel_ids,
             updated_at = now(), version = o.version + 1
           from jsonb_to_recordset($1::jsonb) as x(id uuid, rule_status text, rule_channel_id uuid, rule_conflict_channel_ids uuid[]) where o.id = x.id`,
          [JSON.stringify(changes)],
        );
      }
      await audit(c, a, { entityType: "match_rule", entityId: ruleId, action: "reclassify", after: { orders_changed: changes.length, affected_months: imp.affected_months, moved: imp.moved.count, new_conflicts: imp.new_conflicts.count } });
      return { rule_id: ruleId, orders_reclassified: changes.length, affected_months: imp.affected_months };
    });
  });

  // ---------------------------------------------------- manual adjustments
  const adjSchema = z.object({
    channel_id: z.string().uuid(),
    reporting_month: month,
    kind: z.enum(["off_shopify_sale", "correction", "fee"]),
    order_count: z.union([z.number().int().min(0), z.null()]).optional(),
    units_sold: z.union([z.number().int().min(0), z.null()]).optional(),
    gift_sales_cents: z.union([z.number().int().min(-1e12).max(1e12), z.null()]).optional(),
    shipping_revenue_cents: z.union([z.number().int().min(-1e12).max(1e12), z.null()]).optional(),
    refunds_cents: z.union([z.number().int().min(-1e12).max(1e12), z.null()]).optional(),
    marketplace_fees_cents: z.union([z.number().int().min(-1e12).max(1e12), z.null()]).optional(),
    reason: reqText(1000),
    reference: reqText(200),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  });

  r.get("/revenue/adjustments", async ({ query: q }) => ({
    adjustments: await query(
      `select a.*, a.reporting_month::text as reporting_month, c.name as channel_name from revenue_adjustments a join channels c on c.id = a.channel_id
       ${q.get("include_voided") === "1" ? "" : "where a.voided_at is null"} order by a.reporting_month desc, a.created_at desc limit 300`,
    ),
  }));

  r.post("/revenue/adjustments", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(adjSchema, b);
    if (d.kind !== "correction") for (const k of ["gift_sales_cents", "shipping_revenue_cents", "refunds_cents", "marketplace_fees_cents"] as const)
      if ((d[k] ?? 0) < 0) throw badRequest("Only corrections can be negative.", { fields: { [k]: "Must be ≥ 0" } });
    if (d.kind === "fee" && d.marketplace_fees_cents == null) throw badRequest("Enter the fee amount.", { fields: { marketplace_fees_cents: "Required" } });
    if (d.kind !== "fee" && d.gift_sales_cents == null && d.shipping_revenue_cents == null && d.refunds_cents == null)
      throw badRequest("Enter at least one revenue amount (use 0 explicitly where it applies).", { fields: { gift_sales_cents: "Required" } });
    return tx(async (c) => {
      const ins = await c.query(
        `insert into revenue_adjustments (channel_id, reporting_month, kind, order_count, units_sold, gift_sales_cents, shipping_revenue_cents, refunds_cents,
           marketplace_fees_cents, reason, reference, entry_date, signer_name, auth_subject)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [d.channel_id, d.reporting_month + "-01", d.kind, d.order_count ?? null, d.units_sold ?? null, d.gift_sales_cents ?? null, d.shipping_revenue_cents ?? null,
          d.refunds_cents ?? null, d.marketplace_fees_cents ?? null, d.reason, d.reference, d.entry_date, a.signer, a.sub],
      );
      await audit(c, a, { entityType: "revenue_adjustment", entityId: ins.rows[0].id, action: "create", after: ins.rows[0] });
      return { adjustment: ins.rows[0] };
    });
  });

  r.post("/revenue/adjustments/:id/void", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ reason: reqText(500), version }), b);
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "revenue_adjustments", params.id, d.version, { voided_at: new Date(), voided_by: a.signer, void_reason: d.reason });
      if (before.voided_at) throw badRequest("Already voided.");
      await audit(c, a, { entityType: "revenue_adjustment", entityId: params.id, action: "void", before, after });
      return { adjustment: after };
    });
  });

  // ------------------------------------------------ legacy reconciliation
  r.post("/revenue/monthly/:id/reconcile", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(z.object({ reconciliation: z.enum(["needs_review", "additional", "covered_by_shopify"]), note: text(1000), version }), b);
    if (d.reconciliation !== "needs_review" && !d.note) throw badRequest("Explain the reconciliation (e.g. invoice or order reference).", { fields: { note: "Required" } });
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "monthly_revenue", params.id, d.version,
        { reconciliation: d.reconciliation, reconciliation_note: d.note ?? null, reconciled_by: a.signer, reconciled_at: new Date() });
      await audit(c, a, { entityType: "monthly_revenue", entityId: params.id, action: "reconcile", before: { reconciliation: before.reconciliation }, after: { reconciliation: after.reconciliation, note: after.reconciliation_note } });
      return { record: withCalcs(after) };
    });
  });

  // ----------------------------------------------------------- summary
  r.get("/revenue/summary", async ({ query: q }) => {
    const params: unknown[] = [];
    const cond = (col: string) => {
      const w: string[] = [];
      if (q.get("from")) { params.push(parse(month, q.get("from")) + "-01"); w.push(`${col} >= $${params.length}::date`); }
      if (q.get("to")) { params.push(parse(month, q.get("to")) + "-01"); w.push(`${col} <= $${params.length}::date`); }
      return w;
    };
    const chFilter = q.get("channel_id");
    if (chFilter) assertUuid(chFilter);

    params.length = 0;
    const wOrders = ["class_status = 'assigned'", ...cond("order_month")];
    if (chFilter) { params.push(chFilter); wOrders.push(`channel_id = $${params.length}`); }
    const shop = await query(
      `select channel_id, order_month::text as month,
              count(*) filter (where revenue_status = 'counted')::int as orders,
              coalesce(sum(units) filter (where revenue_status = 'counted'), 0)::int as units,
              coalesce(sum(gift_sales_cents) filter (where revenue_status = 'counted'), 0) as gift_sales_cents,
              coalesce(sum(shipping_cents) filter (where revenue_status = 'counted'), 0) as shipping_cents,
              coalesce(sum(refund_applied_cents) filter (where revenue_status = 'counted'), 0) as refunds_cents,
              coalesce(sum(net_revenue_cents) filter (where revenue_status = 'counted'), 0) as net_cents,
              count(*) filter (where awaiting_payment)::int as awaiting_payment,
              count(*) filter (where revenue_status <> 'counted')::int as excluded_cancelled
       from shopify_orders_effective where ${wOrders.join(" and ")} group by 1, 2`,
      [...params],
    );
    params.length = 0;
    const wMonth = cond("order_month");
    const monthWarn = await query(
      `select order_month::text as month, count(*) filter (where class_status = 'conflict')::int as conflicts,
              count(*) filter (where class_status = 'unclassified')::int as unclassified
       from shopify_orders_effective ${wMonth.length ? "where " + wMonth.join(" and ") : ""} group by 1`,
      [...params],
    );
    params.length = 0;
    const wLegacy = cond("reporting_month");
    if (chFilter) { params.push(chFilter); wLegacy.push(`channel_id = $${params.length}`); }
    const legacy = (await query(
      `select * from monthly_revenue ${wLegacy.length ? "where " + wLegacy.join(" and ") : ""}`, [...params],
    )).map(withCalcs);
    params.length = 0;
    const wAdj = ["voided_at is null", ...cond("reporting_month")];
    if (chFilter) { params.push(chFilter); wAdj.push(`channel_id = $${params.length}`); }
    const adjs = await query(`select *, reporting_month::text as month from revenue_adjustments where ${wAdj.join(" and ")}`, [...params]);
    const channels = new Map((await query("select c.id, c.name, m.status from channels c left join marketplaces m on m.channel_id = c.id")).map((c) => [c.id, c]));

    type Cell = any;
    const cells = new Map<string, Cell>();
    const cell = (ch: string, m: string) => {
      const k = `${ch}|${m}`;
      if (!cells.has(k)) cells.set(k, {
        channel_id: ch, channel_name: channels.get(ch)?.name, marketplace_status: channels.get(ch)?.status ?? null, month: m,
        shopify: { orders: 0, units: 0, gift_sales_cents: 0, shipping_cents: 0, refunds_cents: 0, net_cents: 0, awaiting_payment: 0, excluded_cancelled: 0 },
        manual_cents: 0, manual_entries: 0, legacy_needs_review: [] as any[], legacy_covered: 0, legacy_incomplete: 0,
        fees_cents: null as number | null, warnings: [] as string[],
      });
      return cells.get(k);
    };
    for (const s of shop) Object.assign(cell(s.channel_id, s.month.slice(0, 7)).shopify, { ...s, channel_id: undefined, month: undefined });
    const addFee = (c: Cell, v: number | null) => { if (v != null) c.fees_cents = (c.fees_cents ?? 0) + Number(v); };
    for (const l of legacy) {
      const c = cell(l.channel_id, l.reporting_month);
      if (l.reconciliation === "needs_review") { c.legacy_needs_review.push({ id: l.id, net_revenue_cents: l.net_revenue_cents, complete: l.complete }); continue; }
      addFee(c, l.marketplace_fees_cents);
      if (l.reconciliation === "covered_by_shopify") { c.legacy_covered++; continue; }
      if (!l.complete) { c.legacy_incomplete++; continue; }
      c.manual_cents += l.net_revenue_cents; c.manual_entries++;
    }
    for (const a of adjs) {
      const c = cell(a.channel_id, a.month.slice(0, 7));
      addFee(c, a.marketplace_fees_cents);
      if (a.kind === "fee") continue;
      c.manual_cents += Number(a.gift_sales_cents ?? 0) + Number(a.shipping_revenue_cents ?? 0) - Number(a.refunds_cents ?? 0);
      c.manual_entries++;
    }
    const cov = await coverage();
    const lastImport = await one("select max(completed_at) as at from shopify_import_runs where status in ('completed', 'no_change', 'duplicate')");
    const monthInfo = new Map<string, any>();
    for (const c of cells.values()) {
      if (!monthInfo.has(c.month)) monthInfo.set(c.month, { month: c.month, ...monthCoverage(c.month, cov), conflicts: 0, unclassified: 0 });
    }
    for (const mw of monthWarn) {
      const m = mw.month.slice(0, 7);
      if (!monthInfo.has(m)) monthInfo.set(m, { month: m, ...monthCoverage(m, cov), conflicts: 0, unclassified: 0 });
      Object.assign(monthInfo.get(m), { conflicts: mw.conflicts, unclassified: mw.unclassified });
    }
    const rows = [...cells.values()].map((c) => {
      const combined = c.shopify.net_cents + c.manual_cents;
      if (c.legacy_needs_review.length) c.warnings.push(`${c.legacy_needs_review.length} manual monthly record(s) need review — excluded until reconciled (they may duplicate Shopify sales)`);
      if (c.legacy_incomplete) c.warnings.push(`${c.legacy_incomplete} manual record(s) incomplete — excluded`);
      if (c.shopify.awaiting_payment) c.warnings.push(`${c.shopify.awaiting_payment} order(s) awaiting payment (counted)`);
      if (c.shopify.excluded_cancelled) c.warnings.push(`${c.shopify.excluded_cancelled} cancelled/voided order(s) excluded`);
      const mi = monthInfo.get(c.month);
      if (mi && !mi.complete) c.warnings.push(mi.covered_days ? `Shopify coverage partial (${mi.covered_days}/${mi.days} days)` : "No Shopify report covers this month");
      return { ...c, combined_cents: combined, after_fees_cents: c.fees_cents == null ? null : combined - c.fees_cents };
    }).sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : String(a.channel_name).localeCompare(String(b.channel_name))));
    const sum = (f: (x: any) => number) => rows.reduce((s, x) => s + f(x), 0);
    const feeRows = rows.filter((x) => x.fees_cents != null);
    return {
      rows,
      months: [...monthInfo.values()].sort((a, b) => (a.month < b.month ? 1 : -1)),
      totals: {
        shopify_cents: sum((x) => x.shopify.net_cents), manual_cents: sum((x) => x.manual_cents), combined_cents: sum((x) => x.combined_cents),
        fees_cents: feeRows.length ? feeRows.reduce((s, x) => s + x.fees_cents, 0) : null, fees_recorded_rows: feeRows.length, rows: rows.length,
        orders: sum((x) => x.shopify.orders), units: sum((x) => x.shopify.units),
      },
      last_import_at: lastImport?.at ?? null,
      coverage: cov,
    };
  });
}

