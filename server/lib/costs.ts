// Pure Product Master cost logic (no I/O) — unit tested.
// Rules: explicit row mapping only (no fuzzy name matching); per-piece cost × confirmed quantity;
// per-pack cost used directly; any problem → error, never a zero cost.

export type Mapping = {
  id: string;
  label: string;
  vendor: string;
  tab_name: string;
  header_row: number;
  match_columns: string[];
  cost_column: string;
  cost_basis: "per_piece" | "per_pack";
  quantity_column: string | null;
  retail_column: string | null;
  mapping_version: number;
};

export type Link = {
  id: string;
  product_id: string;
  source_mapping_id: string;
  match_values: Record<string, string>;
  component_label: string | null;
  quantity_per_gift: number | null;
};

export type ParsedSheet = { headers: string[]; rows: { rowNumber: number; cells: Record<string, unknown> }[] };

export function parseSheet(values: unknown[][], headerRow: number): ParsedSheet {
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1).map((r, i) => ({
    rowNumber: headerRow + 1 + i,
    cells: Object.fromEntries(headers.map((h, j) => [h, r[j] ?? null])),
  }));
  return { headers, rows };
}

export function missingHeaders(m: Mapping, headers: string[]) {
  const need = [...m.match_columns, m.cost_column, ...(m.quantity_column ? [m.quantity_column] : []), ...(m.retail_column ? [m.retail_column] : [])];
  return need.filter((h) => !headers.includes(h));
}

/** Strict non-negative decimal parse: "$4.00", "1,234.5", 4 → number; anything else → null. */
export function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseQuantity(v: unknown): number | null {
  const n = parseAmount(v);
  return n !== null && Number.isInteger(n) && n >= 1 ? n : null;
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function findRows(sheet: ParsedSheet, m: Mapping, matchValues: Record<string, string>) {
  const keys = m.match_columns;
  if (keys.some((k) => !norm(matchValues[k]))) return { rows: [], error: "Mapping is missing a value for every match column" };
  const rows = sheet.rows.filter((r) => keys.every((k) => norm(r.cells[k]) === norm(matchValues[k])));
  return { rows, error: null as string | null };
}

export type ComponentResult = {
  link_id: string;
  component_label: string | null;
  vendor: string;
  tab: string;
  mapping_id: string;
  mapping_version: number;
  matched: Record<string, string>;
  row_locator: number | null; // locator only, not identity
  source_cost: number | null;
  basis: "per_piece" | "per_pack";
  quantity: number | null;
  quantity_source: "link" | "sheet" | "not_applicable" | null;
  component_cost: number | null;
  error: string | null;
};

export function computeComponent(sheet: ParsedSheet, m: Mapping, link: Link): ComponentResult {
  const base: ComponentResult = {
    link_id: link.id, component_label: link.component_label, vendor: m.vendor, tab: m.tab_name, mapping_id: m.id,
    mapping_version: m.mapping_version, matched: link.match_values, row_locator: null, source_cost: null,
    basis: m.cost_basis, quantity: null, quantity_source: null, component_cost: null, error: null,
  };
  const { rows, error } = findRows(sheet, m, link.match_values);
  if (error) return { ...base, error };
  if (rows.length === 0) return { ...base, error: "No row matches the mapped identifier" };
  if (rows.length > 1) return { ...base, error: `Duplicate match: rows ${rows.map((r) => r.rowNumber).join(", ")}` };
  const row = rows[0];
  const cost = parseAmount(row.cells[m.cost_column]);
  const withRow = { ...base, row_locator: row.rowNumber };
  if (cost === null) return { ...withRow, error: `Invalid cost value in "${m.cost_column}"` };
  if (m.cost_basis === "per_pack") {
    return { ...withRow, source_cost: cost, quantity: 1, quantity_source: "not_applicable", component_cost: cost };
  }
  let qty: number | null = null;
  let qsrc: ComponentResult["quantity_source"] = null;
  if (link.quantity_per_gift) { qty = link.quantity_per_gift; qsrc = "link"; }
  else if (m.quantity_column) { qty = parseQuantity(row.cells[m.quantity_column]); qsrc = qty ? "sheet" : null; }
  if (!qty) return { ...withRow, source_cost: cost, error: "Missing pack quantity — confirm quantity per gift" };
  return { ...withRow, source_cost: cost, quantity: qty, quantity_source: qsrc, component_cost: round4(cost * qty) };
}

export const round4 = (n: number) => Math.round(n * 10000) / 10000;
export const toCents = (n: number) => Math.round(n * 100);

export function giftCost(components: ComponentResult[]) {
  if (!components.length) return { exact: null, cents: null, error: "No source mapping" };
  const bad = components.find((c) => c.error);
  if (bad) return { exact: null, cents: null, error: bad.error };
  const exact = round4(components.reduce((s, c) => s + (c.component_cost ?? 0), 0));
  return { exact, cents: toCents(exact), error: null };
}
