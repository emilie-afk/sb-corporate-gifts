export const PAYLOAD_FORMAT: "sbcg-orders-v1";
export const CLASSIFICATION_FIELDS: ("source" | "tags" | "billing_company")[];
export const READ_COLUMNS: readonly string[];
export const REQUIRED_COLUMNS: readonly string[];
export function looksPersonal(s: string): boolean;
export function parseCsvObjects(text: string): { headers: string[]; rows: Record<string, string>[] };

export type PayloadLine = { sku: string | null; name: string | null; quantity: number | null; price: string | null; discount: string | null };
export type PayloadOrder = {
  id: string | null; name: string; createdAt: string | null; cancelledAt: string | null; financialStatus: string | null; currency: string | null;
  subtotal: string | null; shipping: string | null; taxes: string | null; duties: string | null; total: string | null;
  discountAmount: string | null; refundedAmount: string | null;
  source: string | null; tags: string[] | null; billingCompany: string | null;
  lines: PayloadLine[];
};
export type OrdersPayload = {
  format: "sbcg-orders-v1"; store: string; exportedAt: string; coverageFrom: string; coverageTo: string;
  fileName?: string | null; fields: string[]; orders: PayloadOrder[];
};
export function reduceShopifyOrderRows(rows: Record<string, string>[], headers?: string[]): {
  orders: PayloadOrder[]; problems: { order: number; field: string; rule: string }[]; missingColumns: string[]; fields: string[];
};
export function laDateOf(createdAt: string | null): string | null;
export function prepareCorporateOrdersPayload(
  rows: Record<string, string>[],
  o: { headers?: string[]; exportedAt: string; coverageFrom: string; coverageTo: string; store?: string; fileName?: string | null },
): { refused: "missing_columns"; missingColumns: string[] } | { refused?: undefined; payload: OrdersPayload; problems: { order: number; field: string; rule: string }[]; facts: { orderCount: number; rowCount: number; fields: string[] } };
