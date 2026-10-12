// Validation and revenue arithmetic for the "sbcg-orders-v1" payload.
//
// Field meanings (Shopify orders export; same reading as the GP engine, shared/allocation.js):
//   Subtotal        = line items after ALL discounts (line + order level), before shipping, taxes, duties.
//   Shipping        = shipping charged to the customer.
//   Taxes, Duties   = pass-through; excluded from revenue.
//   Discount Amount = informational only; already reflected in Subtotal, never subtracted again.
//   Refunded Amount = cumulative order-level refunds (no event dates, no tax split in the export).
//
// Revenue per order (what Succulents Box earns; the team confirmed Shopify amounts are SB's):
//   gift sales      = Subtotal − excluded lines (Route protection, gift-card purchases) after their line discounts
//   shipping        = Shipping
//   refunds applied = min(Refunded Amount, gift sales + shipping); any excess (tax / Route refunds) is not deducted
//   net revenue     = gift sales + shipping − refunds applied
// Cancelled orders and voided payments are kept as records but excluded from totals (GP excludes
// cancelled orders too). Pending / authorized / partially paid orders are counted (GP does not filter
// by payment status) and flagged "awaiting payment". Refunds are attributed to the order's month.
import { createHash } from "node:crypto";
import { laDateOf, looksPersonal, PAYLOAD_FORMAT, type OrdersPayload, type PayloadOrder } from "../../shared/corporateOrders.js";
import { badRequest } from "../http";

export const STORES = ["succulentsbox"];
export const MAX_ORDERS = 20000;
const ORDER_KEYS = new Set(["id", "name", "createdAt", "cancelledAt", "financialStatus", "currency", "subtotal", "shipping", "taxes", "duties", "total", "discountAmount", "refundedAmount", "source", "tags", "billingCompany", "lines"]);
const LINE_KEYS = new Set(["sku", "name", "quantity", "price", "discount"]);
const PAYLOAD_KEYS = new Set(["format", "store", "exportedAt", "coverageFrom", "coverageTo", "fileName", "fields", "orders"]);
const AWAITING = new Set(["pending", "authorized", "partially_paid", "unpaid", "payment_pending", "partially paid"]);

export const isRouteLine = (sku: string | null, name: string | null) =>
  /^ROUTEINS/i.test(String(sku ?? "").trim()) || String(name ?? "").toUpperCase().includes("SHIPPING PROTECTION BY ROUTE");
export const isGiftCardLine = (sku: string | null) => /^GC\d/i.test(String(sku ?? "").trim());

/** "$1,234.50" → 123450; blank → null; anything else → NaN. */
export function moneyCents(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,]/g, "").trim();
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Contract check. Any privacy or shape violation rejects the whole payload (paths only, never values). */
export function assertPayload(p: any): asserts p is OrdersPayload {
  const errs: string[] = [];
  if (!p || typeof p !== "object") throw badRequest("Payload must be a JSON object");
  for (const k of Object.keys(p)) if (!PAYLOAD_KEYS.has(k)) errs.push(`$.${k}: not allowed`);
  if (p.format !== PAYLOAD_FORMAT) errs.push(`$.format: must be ${PAYLOAD_FORMAT}`);
  if (!STORES.includes(p.store)) errs.push("$.store: unknown store");
  const exp = Date.parse(p.exportedAt);
  if (!p.exportedAt || Number.isNaN(exp)) errs.push("$.exportedAt: ISO timestamp required");
  else if (exp > Date.now() + 10 * 60_000) errs.push("$.exportedAt: in the future");
  for (const k of ["coverageFrom", "coverageTo"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p[k] ?? ""))) errs.push(`$.${k}: YYYY-MM-DD required`);
  if (p.coverageFrom > p.coverageTo) errs.push("$.coverageTo: before coverageFrom");
  if (!Array.isArray(p.fields) || p.fields.some((f: any) => !["source", "tags", "billing_company"].includes(f))) errs.push("$.fields: unknown classification field");
  if (p.fileName != null && (typeof p.fileName !== "string" || p.fileName.length > 200)) errs.push("$.fileName: invalid");
  if (!Array.isArray(p.orders)) errs.push("$.orders: array required");
  else if (p.orders.length > MAX_ORDERS) errs.push(`$.orders: more than ${MAX_ORDERS}`);
  else p.orders.forEach((o: any, i: number) => {
    if (!o || typeof o !== "object") { errs.push(`$.orders[${i}]: object required`); return; }
    for (const k of Object.keys(o)) if (!ORDER_KEYS.has(k)) errs.push(`$.orders[${i}].${k}: not allowed`);
    if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 64) errs.push(`$.orders[${i}].name: required`);
    for (const k of ["id", "createdAt", "cancelledAt", "financialStatus", "currency", "subtotal", "shipping", "taxes", "duties", "total", "discountAmount", "refundedAmount", "source", "billingCompany"])
      if (o[k] != null && (typeof o[k] !== "string" || o[k].length > 200)) errs.push(`$.orders[${i}].${k}: string required`);
    for (const k of ["source", "billingCompany"]) if (typeof o[k] === "string" && looksPersonal(o[k])) errs.push(`$.orders[${i}].${k}: looks like personal data`);
    if (o.tags != null) {
      if (!Array.isArray(o.tags) || o.tags.length > 100 || o.tags.some((t: any) => typeof t !== "string" || t.length > 200)) errs.push(`$.orders[${i}].tags: string array required`);
      else if (o.tags.some((t: string) => looksPersonal(t))) errs.push(`$.orders[${i}].tags: looks like personal data`);
    }
    if (!Array.isArray(o.lines) || o.lines.length > 500) errs.push(`$.orders[${i}].lines: array required`);
    else o.lines.forEach((l: any, j: number) => {
      if (!l || typeof l !== "object") { errs.push(`$.orders[${i}].lines[${j}]: object required`); return; }
      for (const k of Object.keys(l)) if (!LINE_KEYS.has(k)) errs.push(`$.orders[${i}].lines[${j}].${k}: not allowed`);
      for (const k of ["sku", "name", "price", "discount"]) if (l[k] != null && (typeof l[k] !== "string" || l[k].length > 300)) errs.push(`$.orders[${i}].lines[${j}].${k}: string required`);
      if (l.quantity != null && (!Number.isInteger(l.quantity) || l.quantity < 0 || l.quantity > 100000)) errs.push(`$.orders[${i}].lines[${j}].quantity: whole number required`);
      if (typeof l.name === "string" && looksPersonal(l.name)) errs.push(`$.orders[${i}].lines[${j}].name: looks like personal data`);
    });
  });
  if (errs.length) throw badRequest(`The report payload was rejected (${errs.length} problem${errs.length > 1 ? "s" : ""}). Nothing was imported.`, { problems: errs.slice(0, 50) });
}

export type ComputedOrder = {
  order_key: string; order_id: string | null; order_name: string; created_at_raw: string; created_at: string; order_date: string; order_month: string;
  financial_status: string | null; cancelled_at_raw: string | null; currency: string | null;
  subtotal_cents: number | null; shipping_cents: number | null; taxes_cents: number | null; duties_cents: number | null; total_cents: number | null;
  discount_cents: number | null; refunded_cents: number | null; excluded_lines_cents: number; gift_sales_cents: number; refund_applied_cents: number;
  net_revenue_cents: number; units: number; revenue_status: "counted" | "cancelled" | "voided"; awaiting_payment: boolean; warnings: string[];
  match_fields: { source: string | null; tags: string[] | null; billing_company: string | null };
  lines: { sku: string | null; name: string | null; quantity: number | null; price_cents: number | null; discount_cents: number | null; excluded: string | null }[];
  content_hash: string;
};

/** Compute one order, or return the reason it cannot be imported (counted as rejected). */
export function computeOrder(o: PayloadOrder): { order: ComputedOrder } | { rejected: string } {
  const name = o.name.trim();
  const date = laDateOf(o.createdAt);
  if (!o.createdAt || !date) return { rejected: `${name}: unreadable Created at` };
  const createdIso = toIso(o.createdAt);
  if (!createdIso) return { rejected: `${name}: unreadable Created at` };
  if (o.currency && o.currency.toUpperCase() !== "USD") return { rejected: `${name}: currency ${o.currency} is not USD` };
  const m: Record<string, number | null> = {};
  for (const [k, v] of Object.entries({ subtotal: o.subtotal, shipping: o.shipping, taxes: o.taxes, duties: o.duties, total: o.total, discount: o.discountAmount, refunded: o.refundedAmount })) {
    const c = moneyCents(v);
    if (Number.isNaN(c)) return { rejected: `${name}: ${k} is not an amount` };
    m[k] = c;
  }
  const warnings: string[] = [];
  const lines = o.lines.map((l) => {
    const price = moneyCents(l.price), disc = moneyCents(l.discount);
    const excluded = isRouteLine(l.sku, l.name) ? "route_protection" : isGiftCardLine(l.sku) ? "gift_card" : null;
    return { sku: l.sku, name: l.name, quantity: l.quantity, price_cents: Number.isNaN(price) ? null : price, discount_cents: Number.isNaN(disc) ? null : disc, excluded };
  });
  if (lines.some((l) => l.price_cents === null && l.name)) warnings.push("A line price could not be read");
  const lineNet = (l: (typeof lines)[number]) => (l.price_cents ?? 0) * (l.quantity ?? 0) - (l.discount_cents ?? 0);
  const excludedLines = lines.filter((l) => l.excluded).reduce((s, l) => s + lineNet(l), 0);
  let subtotal = m.subtotal;
  if (subtotal === null) {
    subtotal = lines.reduce((s, l) => s + lineNet(l), 0);
    warnings.push("Subtotal missing — computed from line items");
  }
  let gift = subtotal - excludedLines;
  if (gift < 0) { warnings.push("Excluded lines exceed the subtotal — gift sales set to 0"); gift = 0; }
  const shipping = m.shipping ?? 0;
  if (m.shipping === null) warnings.push("Shipping missing — treated as 0");
  const refunded = m.refunded ?? 0;
  const countable = gift + shipping;
  const refundApplied = Math.min(Math.max(refunded, 0), countable);
  if (refunded > countable) warnings.push("Refund exceeds gift sales + shipping (likely includes tax or Route) — the excess is not deducted");
  if (m.total !== null && m.subtotal !== null) {
    const parts = (m.subtotal ?? 0) + (m.shipping ?? 0) + (m.taxes ?? 0) + (m.duties ?? 0);
    if (Math.abs(parts - m.total) > 1) warnings.push("Subtotal + shipping + taxes + duties does not equal Total");
  }
  const status = String(o.financialStatus ?? "").trim().toLowerCase();
  const revenue_status = o.cancelledAt ? "cancelled" : status === "voided" ? "voided" : "counted";
  if (revenue_status === "cancelled" && countable - refundApplied > 0) warnings.push("Cancelled with an unrefunded amount — excluded from revenue; review in Shopify");
  const units = lines.filter((l) => !l.excluded).reduce((s, l) => s + (l.quantity ?? 0), 0);
  const order: ComputedOrder = {
    // Canonical key = the Shopify order Name (#1234), present in every export path; the numeric Id is kept when exported.
    order_key: name,
    order_id: o.id, order_name: name, created_at_raw: o.createdAt, created_at: createdIso, order_date: date, order_month: date.slice(0, 7) + "-01",
    financial_status: o.financialStatus, cancelled_at_raw: o.cancelledAt, currency: o.currency,
    subtotal_cents: m.subtotal, shipping_cents: m.shipping, taxes_cents: m.taxes, duties_cents: m.duties, total_cents: m.total,
    discount_cents: m.discount, refunded_cents: m.refunded, excluded_lines_cents: excludedLines, gift_sales_cents: gift,
    refund_applied_cents: refundApplied, net_revenue_cents: countable - refundApplied, units,
    revenue_status, awaiting_payment: revenue_status === "counted" && AWAITING.has(status), warnings,
    match_fields: { source: o.source, tags: o.tags, billing_company: o.billingCompany }, lines, content_hash: "",
  };
  const { content_hash, ...rest } = order;
  order.content_hash = sha256(stable(rest));
  return { order };
}

function toIso(createdAt: string): string | null {
  const s = createdAt.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T12:00:00-08:00").toISOString() : null;
  const off = !m[3] ? "-08:00" : m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const d = new Date(`${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}${off}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Hash of the report CONTENT (orders + coverage + store), so a re-sent identical report is a no-op. */
export function payloadHash(p: OrdersPayload) {
  const orders = [...p.orders].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(stable({ store: p.store, coverageFrom: p.coverageFrom, coverageTo: p.coverageTo, fields: [...p.fields].sort(), orders }));
}
