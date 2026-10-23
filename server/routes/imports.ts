import { z } from "zod";
import type pg from "pg";
import { Router, updateVersioned } from "../router";
import { query, one, tx, getPool } from "../db";
import { audit } from "../audit";
import { redact } from "../redact";
import { HttpError, badRequest, notFound } from "../http";
import { parse, text, reqText, version, assertUuid, defined } from "../validate";
import { fetchCatalogPage, fetchCollectionProductIds, MAX_PAGES, SHOPIFY_ORIGIN, type CatalogItem } from "../lib/shopify";
import { readSheet, spreadsheetIdFrom, gidFrom, type TabRef } from "../lib/sheets";
import { parseSheet, missingHeaders, computeComponent, giftCost, normCol, type Mapping, type Link } from "../lib/costs";

const tabRef = (m: any): TabRef => ({ spreadsheetId: m.spreadsheet_id, tabName: m.tab_name, gid: m.tab_gid, headerRow: m.header_row, lastColumn: m.last_column });

/** Store column names with whitespace collapsed so they match the sheet headers exactly. */
function normalizeColumns(d: any) {
  if (Array.isArray(d.match_columns)) d.match_columns = d.match_columns.map(normCol).filter(Boolean);
  for (const k of ["cost_column", "quantity_column", "retail_column"]) if (typeof d[k] === "string") d[k] = normCol(d[k]) || null;
  return d;
}

const PREVIEW_TTL_MS = 60 * 60 * 1000;

async function loadRun(c: pg.PoolClient | pg.Pool, id: string, kind: string) {
  assertUuid(id);
  const r = await c.query("select * from import_runs where id = $1 and kind = $2", [id, kind]);
  if (!r.rowCount) throw notFound("Import run");
  return r.rows[0];
}

// ===================================================================== Shopify
async function shopifyPreview(runId: string) {
  const pool = getPool();
  const pages = await pool.query("select items from import_run_items where run_id = $1 order by page", [runId]);
  const items = new Map<number, CatalogItem>();
  for (const p of pages.rows) for (const it of p.items as CatalogItem[]) items.set(it.variant_id, it); // dedupe
  const existing = await pool.query(
    "select id, shopify_variant_id, name, variant, sku, handle, product_url, image_url, website_vendor, web_price_cents, web_availability, selected, not_seen_since from products where source = 'shopify'",
  );
  const byVariant = new Map<number, any>(existing.rows.map((r) => [Number(r.shopify_variant_id), r]));
  let newCount = 0, changedCount = 0, unchanged = 0, unselectedPriceChanges = 0;
  const newSample: any[] = [];
  const selectedPriceChanges: any[] = [];
  for (const it of items.values()) {
    const ex = byVariant.get(it.variant_id);
    if (!ex) { newCount++; if (newSample.length < 25) newSample.push({ name: it.name, variant: it.variant, price_cents: it.price_cents }); continue; }
    const infoChanged = ex.name !== it.name || ex.variant !== it.variant || ex.sku !== it.sku || ex.product_url !== it.product_url ||
      ex.image_url !== it.image_url || ex.web_availability !== it.web_availability || ex.website_vendor !== it.website_vendor || ex.not_seen_since;
    const priceChanged = ex.web_price_cents !== it.price_cents;
    if (priceChanged && ex.selected) selectedPriceChanges.push({ product_id: ex.id, name: ex.name, variant: ex.variant, old_cents: ex.web_price_cents, new_cents: it.price_cents });
    else if (priceChanged) unselectedPriceChanges++;
    if (infoChanged || priceChanged) changedCount++; else unchanged++;
  }
  const notSeen = existing.rows.filter((r) => !items.has(Number(r.shopify_variant_id)) && !r.not_seen_since);
  return {
    variants_fetched: items.size,
    new_count: newCount,
    new_sample: newSample,
    changed_count: changedCount,
    unchanged_count: unchanged,
    unselected_price_changes: unselectedPriceChanges,
    selected_price_changes: selectedPriceChanges,
    not_seen_count: notSeen.length,
    not_seen_sample: notSeen.slice(0, 25).map((r) => ({ id: r.id, name: r.name, variant: r.variant, selected: r.selected })),
  };
}

export function importRoutes(r: Router) {
  r.get("/imports", async ({ query: q }) => {
    const kind = q.get("kind");
    const params: unknown[] = [];
    let where = "";
    if (kind) { params.push(kind); where = "where kind = $1"; }
    const runs = await query(
      `select id, kind, status, complete, pages_fetched, summary, errors, started_by, confirmed_by, confirmed_at, started_at, finished_at
       from import_runs ${where} order by started_at desc limit 20`,
      params,
    );
    const lastSuccess = await query(
      `select distinct on (kind) kind, id, status, confirmed_by, confirmed_at, finished_at from import_runs
       where status in ('confirmed', 'no_change') order by kind, coalesce(confirmed_at, finished_at) desc`,
    );
    return { runs, lastSuccess };
  });

  r.post("/imports/shopify", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    return tx(async (c) => {
      await c.query("update import_runs set status = 'discarded', finished_at = now() where kind = 'shopify' and status in ('fetching', 'previewed')");
      const run = await c.query(
        "insert into import_runs (kind, status, next_page, started_by, started_auth_subject, summary) values ('shopify', 'fetching', 1, $1, $2, $3) returning *",
        [a.signer, a.sub, JSON.stringify({ origin: SHOPIFY_ORIGIN })],
      );
      return { run: run.rows[0] };
    });
  });

  /** Fetch exactly one page per call (bounded, resumable). Client repeats until status != 'fetching'. */
  r.post("/imports/shopify/:id/next", async ({ params, body, actor }) => {
    actor(await body());
    const run = await loadRun(getPool(), params.id, "shopify");
    if (run.status !== "fetching") return { run };
    const page = run.next_page as number;
    try {
      if (page > MAX_PAGES) throw new Error(`Stopped after ${MAX_PAGES} pages without reaching the end of the catalog`);
      const { items, productCount } = await fetchCatalogPage(page);
      if (productCount === 0) {
        const preview = await shopifyPreview(run.id);
        const upd = await getPool().query(
          "update import_runs set status = 'previewed', complete = true, next_page = null, preview = $2, finished_at = now(), version = version + 1 where id = $1 and status = 'fetching' returning *",
          [run.id, JSON.stringify(preview)],
        );
        return { run: upd.rows[0] ?? run };
      }
      await getPool().query("insert into import_run_items (run_id, page, items) values ($1,$2,$3) on conflict (run_id, page) do update set items = excluded.items", [run.id, page, JSON.stringify(items)]);
      const upd = await getPool().query(
        "update import_runs set next_page = $2, pages_fetched = $3, version = version + 1 where id = $1 and status = 'fetching' returning *",
        [run.id, page + 1, page],
      );
      return { run: upd.rows[0] ?? run };
    } catch (e: any) {
      // Partial or failed refresh: nothing is written to products; previous data stays.
      const upd = await getPool().query(
        "update import_runs set status = 'failed', finished_at = now(), errors = errors || $2::jsonb, version = version + 1 where id = $1 returning *",
        [run.id, JSON.stringify([{ page, message: redact(e?.message ?? e) }])],
      );
      return { run: upd.rows[0] };
    }
  });

  r.post("/imports/shopify/:id/confirm", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ apply_price_for: z.array(z.string().uuid()).optional() }), b);
    return tx(async (c) => {
      const run = await c.query("select * from import_runs where id = $1 and kind = 'shopify' for update", [params.id]);
      if (!run.rowCount) throw notFound("Import run");
      const rr = run.rows[0];
      if (rr.status !== "previewed" || !rr.complete) throw badRequest("Only a complete, previewed import can be confirmed.");
      if (Date.now() - new Date(rr.finished_at).getTime() > PREVIEW_TTL_MS) throw badRequest("This preview is more than an hour old. Run the refresh again.");
      const pv = rr.preview;
      const nothing = pv.new_count === 0 && pv.changed_count === 0 && pv.not_seen_count === 0;
      if (nothing) {
        await c.query("update import_runs set status = 'no_change', confirmed_by = $2, confirmed_at = now() where id = $1", [rr.id, a.signer]);
        await c.query("update products set last_seen_at = now(), last_seen_run_id = $1 where source = 'shopify'", [rr.id]);
        return { status: "no_change" };
      }
      const applyPriceFor: string[] = d.apply_price_for ?? pv.selected_price_changes.map((x: any) => x.product_id);
      // Single set-based upsert from the staged pages. Team annotations are never touched.
      const res = await c.query(
        `with items as (
           select distinct on ((x->>'variant_id')::bigint) x from import_run_items i, jsonb_array_elements(i.items) x where i.run_id = $1
         ), src as (
           select (x->>'product_id')::bigint pid, (x->>'variant_id')::bigint vid, x->>'name' name, x->>'variant' variant, x->>'sku' sku,
                  x->>'handle' handle, x->>'product_url' url, x->>'image_url' img, x->>'website_vendor' wv,
                  (x->>'price_cents')::bigint price, x->>'web_availability' avail from items
         ), upd as (
           update products p set name = s.name, variant = s.variant, sku = s.sku, handle = s.handle, product_url = s.url,
                  image_url = s.img, website_vendor = s.wv, web_availability = s.avail, web_currency = 'USD',
                  web_price_cents = case when p.selected and not (p.id = any($2::uuid[])) then p.web_price_cents else s.price end,
                  last_seen_at = now(), last_seen_run_id = $1, not_seen_since = null, updated_at = now(), version = p.version + 1
             from src s where p.shopify_variant_id = s.vid returning p.id
         ), ins as (
           insert into products (source, shopify_product_id, shopify_variant_id, name, variant, sku, handle, product_url, image_url,
                                 website_vendor, web_price_cents, web_currency, web_availability, last_seen_at, last_seen_run_id)
           select 'shopify', s.pid, s.vid, s.name, s.variant, s.sku, s.handle, s.url, s.img, s.wv, s.price, 'USD', s.avail, now(), $1
             from src s where not exists (select 1 from products p where p.shopify_variant_id = s.vid)
           returning id
         )
         select (select count(*) from upd)::int as updated, (select count(*) from ins)::int as inserted`,
        [rr.id, applyPriceFor],
      );
      // Flag (never delete/archive) items missing from this COMPLETE import.
      const flagged = await c.query(
        "update products set not_seen_since = now() where source = 'shopify' and not_seen_since is null and (last_seen_run_id is distinct from $1) returning id",
        [rr.id],
      );
      const summary = { ...rr.summary, ...res.rows[0], flagged_not_seen: flagged.rowCount, price_changes_applied_for_selected: applyPriceFor.length };
      await c.query("update import_runs set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), summary = $3 where id = $1", [rr.id, a.signer, JSON.stringify(summary)]);
      await c.query("delete from import_run_items where run_id = $1", [rr.id]);
      await audit(c, a, { entityType: "import_run", entityId: rr.id, action: "confirm_shopify", after: summary });
      return { status: "confirmed", summary };
    });
  });

  r.post("/imports/:id/discard", async ({ params, body, actor }) => {
    actor(await body());
    assertUuid(params.id);
    await getPool().query("update import_runs set status = 'discarded', finished_at = now() where id = $1 and status in ('fetching', 'previewed')", [params.id]);
    await getPool().query("delete from import_run_items where run_id = $1", [params.id]);
    return { ok: true };
  });

  r.get("/imports/:id", async ({ params }) => {
    assertUuid(params.id);
    const run = await one("select * from import_runs where id = $1", [params.id]);
    if (!run) throw notFound("Import run");
    return { run };
  });

  // Optional: collection membership from the public storefront for a collection reference URL.
  r.post("/collections/:id/refresh-membership", async ({ params, body, actor }) => {
    const a = actor(await body());
    assertUuid(params.id);
    const col = await one("select * from collection_references where id = $1 and removed_at is null", [params.id]);
    if (!col) throw notFound("Collection");
    const m = /^https?:\/\/(?:www\.)?succulentsbox\.com\/collections\/([a-z0-9-]+)\/?$/.exec(String(col.url ?? "").split("?")[0]);
    if (!m) throw badRequest("Membership import only works for succulentsbox.com/collections/<handle> URLs. Link gifts manually instead.");
    let ids: number[];
    try { ids = await fetchCollectionProductIds(m[1]); } catch (e: any) { throw new HttpError(502, "upstream", `Could not read the collection: ${redact(e?.message)}. Nothing was changed.`); }
    return tx(async (c) => {
      const res = await c.query(
        `insert into product_collections (product_id, collection_id)
         select id, $1 from products where shopify_product_id = any($2::bigint[]) on conflict do nothing`,
        [col.id, ids],
      );
      await audit(c, a, { entityType: "collection", entityId: col.id, action: "membership_refresh", after: { products_on_site: ids.length, links_added: res.rowCount } });
      return { products_on_site: ids.length, links_added: res.rowCount, note: "Links are only added, never removed, by this refresh." };
    });
  });

  // ============================================================= Product Master
  const mappingSchema = z.object({
    label: reqText(120),
    spreadsheet: reqText(500),
    vendor: reqText(120),
    tab_name: reqText(200),
    tab_gid: z.union([z.string().trim().regex(/^\d{0,12}$/, "Digits only (the number after gid=)"), z.null()]).optional().transform((v) => (v ? v : v === undefined ? undefined : null)),
    header_row: z.number().int().min(1).max(1000).default(1),
    last_column: z.string().regex(/^[A-Z]{1,3}$/).default("ZZ"),
    match_columns: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
    cost_column: reqText(120),
    cost_basis: z.enum(["per_piece", "per_pack"]),
    quantity_column: text(120),
    retail_column: text(120),
    cost_inclusions_note: text(2000),
    active: z.boolean().optional(),
  });

  // Sheet locations (spreadsheet ID + tab gid) are not sent in ordinary responses. Signed-in team members can
  // reveal one explicitly to edit it (GET /sources/:id/location), which is recorded in the audit log.
  r.get("/sources", async () => ({
    sources: (await query(
      `select m.*, (select count(*) from gift_source_links l where l.source_mapping_id = m.id and l.removed_at is null)::int as link_count
       from source_mappings m order by m.vendor, m.label`,
    )).map(maskSource),
  }));

  r.get("/sources/:id/location", async ({ params, session }) => {
    assertUuid(params.id);
    const m = await one("select id, spreadsheet_id, tab_gid from source_mappings where id = $1", [params.id]);
    if (!m) throw notFound("Source mapping");
    await audit(getPool(), { signer: "(revealed in settings)", sub: session.sub }, { entityType: "source_mapping", entityId: m.id, action: "reveal_location" });
    return { link: `https://docs.google.com/spreadsheets/d/${m.spreadsheet_id}/edit${m.tab_gid ? `#gid=${m.tab_gid}` : ""}`, tab_gid: m.tab_gid };
  });

  r.post("/sources", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = normalizeColumns(parse(mappingSchema, b));
    const sid = spreadsheetIdFrom(d.spreadsheet);
    if (!d.tab_gid) d.tab_gid = gidFrom(d.spreadsheet);
    if (!sid) throw badRequest("Enter a Google Sheets link or spreadsheet ID.", { fields: { spreadsheet: "Not a spreadsheet link/ID" } });
    return tx(async (c) => {
      const ins = await c.query(
        `insert into source_mappings (label, spreadsheet_id, vendor, tab_name, tab_gid, header_row, last_column, match_columns, cost_column,
           cost_basis, quantity_column, retail_column, cost_inclusions_note, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [d.label, sid, d.vendor, d.tab_name, d.tab_gid ?? null, d.header_row, d.last_column, d.match_columns, d.cost_column, d.cost_basis,
          d.quantity_column ?? null, d.retail_column ?? null, d.cost_inclusions_note ?? null, a.signer],
      );
      await audit(c, a, { entityType: "source_mapping", entityId: ins.rows[0].id, action: "create", after: maskSource(ins.rows[0]) });
      return { source: maskSource(ins.rows[0]) };
    });
  });

  r.patch("/sources/:id", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = normalizeColumns(defined(parse(mappingSchema.partial().extend({ version }), b)) as any);
    const { version: v, spreadsheet, ...fields } = d;
    if (spreadsheet !== undefined && spreadsheet !== null && spreadsheet !== "") {
      const sid = spreadsheetIdFrom(spreadsheet);
      if (!sid) throw badRequest("Enter a Google Sheets link or spreadsheet ID.", { fields: { spreadsheet: "Not a spreadsheet link/ID" } });
      fields.spreadsheet_id = sid;
      if (!fields.tab_gid && gidFrom(spreadsheet)) fields.tab_gid = gidFrom(spreadsheet);
    }
    return tx(async (c) => {
      const cur = await c.query("select * from source_mappings where id = $1", [params.id]);
      if (!cur.rowCount) throw notFound("Source mapping");
      const mappingKeys = ["spreadsheet_id", "tab_name", "tab_gid", "header_row", "last_column", "match_columns", "cost_column", "cost_basis", "quantity_column"];
      if (mappingKeys.some((k) => k in fields && JSON.stringify(fields[k]) !== JSON.stringify(cur.rows[0][k]))) fields.mapping_version = cur.rows[0].mapping_version + 1;
      fields.updated_by = a.signer;
      const { before, after } = await updateVersioned(c, "source_mappings", params.id, v, fields);
      await audit(c, a, { entityType: "source_mapping", entityId: params.id, action: "update", before: maskSource(before), after: maskSource(after) });
      return { source: maskSource(after) };
    });
  });

  /** Reads the tab and lists candidate rows so the team can choose the exact unique identifier. */
  r.post("/sources/:id/lookup", async ({ params, body }) => {
    const b = await body();
    assertUuid(params.id);
    const q = parse(z.object({ query: z.string().trim().max(200).default("") }), b).query.toLowerCase();
    const m = await one("select * from source_mappings where id = $1", [params.id]);
    if (!m) throw notFound("Source mapping");
    let values: unknown[][];
    try { values = await readSheet(tabRef(m)); }
    catch (e: any) { throw new HttpError(502, "sheet_access", redact(e?.message)); }
    const sheet = parseSheet(values, m.header_row);
    const missing = missingHeaders(m, sheet.headers);
    const cols = [...m.match_columns, m.cost_column, m.quantity_column, m.retail_column].filter(Boolean).map(normCol);
    const rows = sheet.rows
      .filter((r) => !q || m.match_columns.some((k: string) => String(r.cells[normCol(k)] ?? "").toLowerCase().includes(q)))
      .slice(0, 50)
      .map((r) => ({ rowNumber: r.rowNumber, cells: Object.fromEntries(cols.map((k) => [k, r.cells[k] ?? null])) }));
    return { headers: sheet.headers, missing_headers: missing, rows };
  });

  r.get("/products/:id/source-links", async ({ params }) => {
    assertUuid(params.id);
    return {
      links: await query(
        `select l.*, m.label as mapping_label, m.vendor, m.tab_name, m.cost_basis, m.match_columns
         from gift_source_links l join source_mappings m on m.id = l.source_mapping_id where l.product_id = $1 and l.removed_at is null order by l.created_at`,
        [params.id],
      ),
    };
  });

  const linkSchema = z.object({
    source_mapping_id: z.string().uuid(),
    match_values: z.record(z.string(), z.string().trim().min(1).max(200)),
    component_label: text(200),
    quantity_per_gift: z.union([z.number().int().min(1).max(100000), z.null()]).optional(),
    note: text(1000),
  });

  r.post("/products/:id/source-links", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id);
    const d = parse(linkSchema, b);
    return tx(async (c) => {
      const m = await c.query("select * from source_mappings where id = $1", [d.source_mapping_id]);
      if (!m.rowCount) throw badRequest("Unknown source mapping");
      const missing = m.rows[0].match_columns.filter((k: string) => !d.match_values[k]);
      if (missing.length) throw badRequest(`Provide a value for: ${missing.join(", ")}`, { fields: { match_values: "Missing match values" } });
      const existing = await c.query("select count(*)::int n from gift_source_links where product_id = $1 and removed_at is null", [params.id]);
      if (existing.rows[0].n > 0 && !d.component_label)
        throw badRequest("This gift already has a source row. For composite gifts, name each component.", { fields: { component_label: "Required for an additional component" } });
      const ins = await c.query(
        `insert into gift_source_links (product_id, source_mapping_id, match_values, component_label, quantity_per_gift, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [params.id, d.source_mapping_id, JSON.stringify(d.match_values), d.component_label ?? null, d.quantity_per_gift ?? null, d.note ?? null, a.signer],
      );
      await audit(c, a, { entityType: "gift_source_link", entityId: ins.rows[0].id, action: "create", after: ins.rows[0] });
      return { link: ins.rows[0] };
    });
  });

  r.patch("/products/:id/source-links/:lid", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    assertUuid(params.id); assertUuid(params.lid);
    const d = defined(parse(linkSchema.partial().extend({ version, remove: z.boolean().optional() }), b)) as any;
    const { version: v, remove, ...fields } = d;
    if (fields.match_values) fields.match_values = JSON.stringify(fields.match_values);
    if (remove) fields.removed_at = new Date();
    return tx(async (c) => {
      const { before, after } = await updateVersioned(c, "gift_source_links", params.lid, v, fields);
      await audit(c, a, { entityType: "gift_source_link", entityId: params.lid, action: remove ? "remove" : "update", before, after });
      return { link: after };
    });
  });

  r.post("/imports/product-master", async ({ body, actor }) => {
    const a = actor(await body());
    const mappings = (await query("select * from source_mappings where active")) as Mapping[] & any[];
    const links = (await query(
      `select l.* from gift_source_links l join source_mappings m on m.id = l.source_mapping_id
       join products p on p.id = l.product_id where l.removed_at is null and m.active and p.archived_at is null`,
    )) as Link[];
    const sheetErrors: { mapping: string; message: string }[] = [];
    const sheets = new Map<string, ReturnType<typeof parseSheet> | null>();
    for (const m of mappings) {
      if (!links.some((l) => l.source_mapping_id === m.id)) continue;
      try {
        const sheet = parseSheet(await readSheet(tabRef(m)), m.header_row);
        const missing = missingHeaders(m, sheet.headers);
        if (missing.length) { sheetErrors.push({ mapping: m.label, message: `Missing columns: ${missing.join(", ")}` }); sheets.set(m.id, null); }
        else sheets.set(m.id, sheet);
      } catch (e: any) {
        sheetErrors.push({ mapping: m.label, message: redact(e?.message ?? e) });
        sheets.set(m.id, null);
      }
    }
    const byProduct = new Map<string, Link[]>();
    for (const l of links) byProduct.set(l.product_id, [...(byProduct.get(l.product_id) ?? []), l]);
    const products = await query(
      `select p.id, p.name, p.variant, cs.gift_cost_exact, cs.gift_cost_cents, cs.created_at as cost_at, cs.detail
       from products p left join lateral (select * from cost_snapshots s where s.product_id = p.id order by created_at desc limit 1) cs on true
       where p.id = any($1)`,
      [[...byProduct.keys()]],
    );
    const items = products.map((p) => {
      const comps = (byProduct.get(p.id) ?? []).map((l) => {
        const m = mappings.find((x) => x.id === l.source_mapping_id)!;
        const sheet = sheets.get(m.id);
        if (!sheet) return { link_id: l.id, component_label: l.component_label, vendor: m.vendor, tab: m.tab_name, mapping_id: m.id, mapping_version: m.mapping_version, error: "Sheet could not be read", component_cost: null } as any;
        return computeComponent(sheet, m, l);
      });
      const g = giftCost(comps);
      const old = p.gift_cost_exact ?? null;
      const status = g.error ? "error" : old !== null && Number(old) === g.exact && stripLocators(p.detail) === stripLocators(comps) ? "unchanged" : "changed";
      return {
        product_id: p.id, name: p.name, variant: p.variant, status, error: g.error,
        old_cents: p.gift_cost_cents ?? null, old_at: p.cost_at ?? null, new_cents: g.cents, new_exact: g.exact, components: comps,
      };
    });
    const unmapped = await query(
      "select id, name, variant from products p where p.selected and p.archived_at is null and not exists (select 1 from gift_source_links l where l.product_id = p.id and l.removed_at is null) order by name limit 200",
    );
    const summary = {
      changed: items.filter((i) => i.status === "changed").length,
      unchanged: items.filter((i) => i.status === "unchanged").length,
      errors: items.filter((i) => i.status === "error").length,
      unmapped_selected: unmapped.length,
      sheet_errors: sheetErrors.length,
    };
    const run = await one(
      `insert into import_runs (kind, status, complete, preview, summary, errors, started_by, started_auth_subject, finished_at)
       values ('product_master', 'previewed', $1, $2, $3, $4, $5, $6, now()) returning *`,
      [sheetErrors.length === 0, JSON.stringify({ items, unmapped }), JSON.stringify(summary), JSON.stringify(sheetErrors), a.signer, a.sub],
    );
    return { run };
  });

  r.post("/imports/product-master/:id/confirm", async ({ params, body, actor }) => {
    const b = await body();
    const a = actor(b);
    const d = parse(z.object({ product_ids: z.array(z.string().uuid()).optional() }), b);
    return tx(async (c) => {
      const run = await c.query("select * from import_runs where id = $1 and kind = 'product_master' for update", [params.id]);
      if (!run.rowCount) throw notFound("Import run");
      const rr = run.rows[0];
      if (rr.status !== "previewed") throw badRequest("This preview was already handled.");
      if (Date.now() - new Date(rr.finished_at).getTime() > PREVIEW_TTL_MS) throw badRequest("This preview is more than an hour old. Run the refresh again.");
      const approved = new Set(d.product_ids ?? rr.preview.items.filter((i: any) => i.status === "changed").map((i: any) => i.product_id));
      // Only valid, changed, approved items are saved. Errors never overwrite known costs.
      const toSave = rr.preview.items.filter((i: any) => i.status === "changed" && approved.has(i.product_id) && i.new_cents !== null && !i.error);
      for (const i of toSave) {
        await c.query(
          `insert into cost_snapshots (product_id, import_run_id, gift_cost_cents, gift_cost_exact, detail, confirmed_by, auth_subject)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [i.product_id, rr.id, i.new_cents, i.new_exact, JSON.stringify(i.components), a.signer, a.sub],
        );
      }
      const status = toSave.length ? "confirmed" : "no_change";
      const summary = { ...rr.summary, saved: toSave.length };
      await c.query("update import_runs set status = $2, confirmed_by = $3, confirmed_at = now(), summary = $4 where id = $1", [rr.id, status, a.signer, JSON.stringify(summary)]);
      await audit(c, a, { entityType: "import_run", entityId: rr.id, action: "confirm_product_master", after: summary });
      return { status, saved: toSave.length };
    });
  });
}

/** Stable, key-order-independent comparison basis (jsonb reorders keys); row numbers are locators only. */
function stripLocators(detail: any): string | null {
  if (!Array.isArray(detail)) return null;
  return stable(detail.map(({ row_locator, ...rest }: any) => rest));
}
function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`;
  return JSON.stringify(v);
}

/** A source mapping without its sheet location: only the last 4 characters identify which sheet it is. */
export function maskSource(m: any) {
  if (!m) return m;
  const { spreadsheet_id, ...rest } = m;
  return { ...rest, spreadsheet_ref: spreadsheet_id ? `…${String(spreadsheet_id).slice(-4)}` : null };
}
