// FIXTURE TESTS — Partners: saved views, filters, contacts, bulk updates with preview, and the research import
// (preview → decisions → apply → re-import → reverse). Synthetic companies and example.test addresses only.
import { describe, it, expect, beforeAll } from "vitest";
import { resetDb, call, S } from "./helpers";
import { getPool } from "../server/db";
import { mapRows, inferRole, mapCategory } from "../server/lib/partnerImport";
import { partnerKey } from "../server/lib/partners";

const q = (sql: string, p: unknown[] = []) => getPool().query(sql, p).then((r) => r.rows);
const HEADER = ["Priority", "Company", "Category", "Channel model", "Parent company", "Contact / apply", "Contact type", "Requirements & notes",
  "Partner ordering & fulfillment terms", "SB capability notes", "How Succulents Box could show up", "Verification", "Source URLs", "Last checked", "Next action",
  "Primary contact name", "Primary contact title & company", "Why this person fits", "Primary contact profile URL", "Published business email / phone",
  "Backup contact", "Contact sources (checked 2026-11-20)", "Contact confidence", "Contact next step", "Status"];
const CAP = "SB can fulfill one gift per order. Partner pricing and fulfillment terms to be agreed separately. SB corporate bulk pricing starts at 10 gifts. Product-specific shipping restrictions apply.";
type R = Partial<Record<(typeof HEADER)[number], string>>;
const row = (r: R) => HEADER.map((h) => r[h] ?? "");
const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvOf = (rows: R[]) => [HEADER, ...rows.map(row)].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
const base = (r: R): R => ({ "Last checked": "2026-11-20", Status: "To contact", "SB capability notes": CAP, "Source URLs": "https://example.test/source", ...r });

const ROWS: R[] = [
  base({ Priority: "A", Company: "Demo Market Alpha", Category: "Retail marketplace network", "Channel model": "Catalog supplier", "Requirements & notes": "Synthetic published requirement for Alpha.",
    "Contact / apply": "Vendor form https://example.test/alpha/vendors", "Contact type": "Supplier application", "Primary contact name": "Not researched - supplier/partnership route already published",
    "Partner ordering & fulfillment terms": "Commission 0% stated nowhere. Expected ordering pattern (not published by the company): single gifts." }),
  base({ Priority: "A", Company: "Synthetic Hospital Shop", Category: "Hospital gift retail", "Channel model": "Wholesale", "Requirements & notes": "Synthetic insurance certificate requirement.",
    "Contact / apply": "Product form https://example.test/hospital-shop/vendors", "Contact type": "Supplier application", "Primary contact name": "Not researched - supplier/partnership route already published" }),
  base({ Priority: "A", Company: "Synthetic Care Store", Category: "Hospital gift retail", "Channel model": "Wholesale", "Next action": "Synthetic: check UPC labels.",
    "Contact / apply": "New vendors https://example.test/care-store", "Contact type": "Supplier application", "Primary contact name": "Not researched - supplier/partnership route already published" }),
  base({ Priority: "B", Company: "Synthetic Events Group", Category: "Event agency (DMC)", "Channel model": "Direct corporate/event buyer",
    "Contact / apply": "https://example.test/events/contact", "Contact type": "Customer sales", "Primary contact name": "Riley Fixture",
    "Primary contact title & company": "Senior Vice President, Strategic Partnerships, Synthetic Events Group", "Why this person fits": "Role focuses on hotel partnerships.",
    "Published business email / phone": "riley@example.test (published on leadership page)", "Contact confidence": "Needs verification (possible routing contact)",
    "Backup contact": "Morgan Sample, Chief Growth Officer - executive fallback" }),
  base({ Priority: "B", Company: "Synthetic Registry", Category: "Registry", "Channel model": "Integration", "Contact / apply": "App https://example.test/registry-app", "Contact type": "Partnerships",
    "Primary contact name": "Not applicable - registry integration is a self-serve app",
    "Backup contact": "Paid advertising only: Casey Placeholder (named on the booking link, title not stated) - https://example.test/book/casey", "Contact confidence": "Not applicable" }),
  base({ Priority: "B", Company: "Synthetic Brokerage", Category: "Brokerage network", "Channel model": "Vendor directory / lead generation", "Contact / apply": "Supplier contact not found (unverified).",
    "Contact type": "General contact", "Primary contact name": "Replacement needed (former contact: Jordan Sample)", "Primary contact title & company": "Former VP of Industry Relations, Synthetic Brokerage",
    "Contact confidence": "Needs verification" }),
  base({ Priority: "B", Company: "Synthetic Memorial Site", Category: "Obituary network", "Channel model": "Catalog supplier", "Contact / apply": "https://example.test/memorial/contact", "Contact type": "General contact",
    "Primary contact name": "Taylor Mockname", "Primary contact title & company": "Vice President, Merchandise, Synthetic Memorial Site (2023 report)", "Contact confidence": "Needs verification",
    "Contact next step": "Confirm Taylor Mockname still leads Merchandise before outreach." }),
  base({ Priority: "C", Company: "Synthetic Relocation", Category: "Relocation", "Channel model": "Referral", "Primary contact name": "Not researched - priority C (weak fit)" }),
  base({ Priority: "B", Company: "Synthetic Catalog for Brands (formerly Demo Market Bravo)", Category: "Retail marketplace network", "Channel model": "Catalog supplier / dropship distribution",
    "Contact / apply": "https://example.test/catalog", "Contact type": "Supplier application (self-serve app) / partnerships (sales)", "Primary contact name": "Not researched - supplier/partnership route already published" }),
];
const CSV = csvOf(ROWS);
const SKIP = { stage: "skipped", stage_reason: "Requires a synthetic insurance certificate; not pursuing" };
const DECISIONS = { [partnerKey("Synthetic Hospital Shop")]: SKIP };

let partners: Record<string, any> = {};
const reload = async () => { partners = Object.fromEntries((await call("GET", "/marketplaces?view=all")).body.marketplaces.map((m: any) => [m.name, m])); };
const view = async (v: string, extra = "") => (await call("GET", `/marketplaces?view=${v}${extra}`)).body;

beforeAll(async () => { await resetDb(); await reload(); });

describe("mapping rules", () => {
  it("maps research categories and roles; historical, routing and advertising-only stay distinct", () => {
    expect(mapCategory("Promo / recognition")).toBe("events_promo");
    expect(mapCategory("Pet aftercare")).toBe("veterinary_pet_memorial");
    expect(mapCategory("Funeral websites")).toBe("sympathy_memorial");
    expect(mapCategory("Something new")).toBe("uncategorized");
    expect(inferRole("COO, Example Co", "mention only as a routing reference")).toBe("routing");
    expect(inferRole("Director of Floral & Support Services", "")).toBe("relevant_partnerships");
    expect(inferRole("Senior Vice President of the Supplier Network", "")).toBe("supplier_sourcing");
    const { rows } = mapRows(CSV);
    const brokerage = rows.find((r) => r.company === "Synthetic Brokerage")!;
    expect(brokerage.fields.research_state).toBe("contact_needed");
    expect(brokerage.contacts).toMatchObject([{ name: "Jordan Sample", role: "historical", role_verification: "former" }]);
    const registry = rows.find((r) => r.company === "Synthetic Registry")!;
    expect(registry.fields.research_state).toBe("no_contact_needed");
    expect(registry.contacts).toMatchObject([{ name: "Casey Placeholder", role: "advertising_only", rank: "backup" }]);
    const events = rows.find((r) => r.company === "Synthetic Events Group")!;
    expect(events.contacts.map((c) => [c.name, c.role, c.rank, c.email])).toEqual([["Riley Fixture", "routing", "primary", "riley@example.test"], ["Morgan Sample", "executive_fallback", "backup", null]]);
    expect(events.provider_type).toBe("supplier_opportunity");
  });

  it("keeps the single-gift capability separate from bulk pricing and labels expected ordering as an assumption", () => {
    const alpha = mapRows(CSV).rows[0];
    const caps = alpha.requirements.filter((r) => r.kind === "sb_capability");
    // The standard one-gift statement is shown once app-wide, not copied per partner; bulk pricing is its own pricing note.
    expect(caps).toEqual([expect.objectContaining({ category: "pricing", requirement: "SB corporate bulk pricing starts at 10 gifts." })]);
    expect(alpha.requirements.find((r) => r.kind === "ordering_assumption")!.requirement).toMatch(/^Expected ordering pattern/);
    expect(alpha.requirements.find((r) => r.kind === "published" && r.category === "fulfillment")!.requirement).toBe("Commission 0% stated nowhere.");
  });
});

describe("import preview and apply", () => {
  it("previews new rows, existing matches, possible duplicates and decisions, writing nothing", async () => {
    const before = (await q("select count(*)::int n from marketplaces"))[0].n;
    const p = (await call("POST", "/partners/import/preview", { csv: CSV, decisions: DECISIONS })).body;
    const by = Object.fromEntries(p.rows.map((r: any) => [r.company, r]));
    expect(by["Demo Market Alpha"]).toMatchObject({ outcome: "existing_match", match: { name: "Demo Market Alpha", how: "same name" } });
    expect(by["Synthetic Hospital Shop"]).toMatchObject({ outcome: "skipped_by_decision", create: { stage: "skipped", sales_role: "unclear" } });
    expect(by["Synthetic Care Store"].outcome).toBe("new");
    // A former name stated in the research is evidence, not an automatic merge.
    expect(by["Synthetic Catalog for Brands (formerly Demo Market Bravo)"]).toMatchObject({ outcome: "possible_duplicate", needs_decision: true });
    expect(by["Synthetic Catalog for Brands (formerly Demo Market Bravo)"].candidates[0]).toMatchObject({ name: "Demo Market Bravo" });
    expect(p.blocking).toBe(1);
    expect(p.by_priority).toEqual({ a: 2, b: 5, c: 1, skipped: 1 });
    expect((await q("select count(*)::int n from marketplaces"))[0].n).toBe(before);
  });

  it("refuses to apply while a possible duplicate has no decision", async () => {
    const r = await call("POST", "/partners/import/apply", { ...S, csv: CSV, decisions: DECISIONS });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/possible duplicate/);
    expect((await q("select count(*)::int n from partner_import_batches"))[0].n).toBe(0);
  });

  it("keeps an active partner's stage, owner, sales role and negotiated terms; conflicting fields keep the existing value", async () => {
    const alpha = partners["Demo Market Alpha"];
    const d0 = (await call("GET", `/marketplaces/${alpha.id}`)).body.marketplace;
    await call("POST", `/marketplaces/${alpha.id}/status-transitions`, { ...S, to_status: "live", version: d0.version });
    const d1 = (await call("GET", `/marketplaces/${alpha.id}`)).body.marketplace;
    await call("PATCH", `/marketplaces/${alpha.id}`, { ...S, version: d1.version, category: "corporate_gifting_platforms", owner: "Example Owner" });
    await call("POST", `/marketplaces/${alpha.id}/requirements`, { ...S, kind: "negotiated", category: "pricing", requirement: "Synthetic negotiated commission 12%.", confirmation_state: "confirmed" });
    const p = (await call("POST", "/partners/import/preview", { csv: CSV, decisions: DECISIONS })).body;
    const r = p.rows.find((x: any) => x.company === "Demo Market Alpha");
    expect(r.outcome).toBe("conflict");
    expect(r.conflicts).toEqual([{ field: "category", existing: "corporate_gifting_platforms", imported: "retail_marketplaces", resolution: "keep" }]);
    expect(r.fills.map((f: any) => f.field)).toEqual(expect.arrayContaining(["priority", "channel_models", "research_state"]));
    expect(r.kept.join(" ")).toMatch(/Stage kept: live/);
  });

  it("applies with decisions as one batch; re-importing the same file adds nothing", async () => {
    const decisions = { ...DECISIONS, [partnerKey("Synthetic Catalog for Brands (formerly Demo Market Bravo)")]: { create_new: true } };
    const a = await call("POST", "/partners/import/apply", { ...S, csv: CSV, source_name: "Synthetic research", decisions });
    expect(a.status).toBe(200);
    expect(a.body.totals.created).toBe(8);
    await reload();
    const alpha = partners["Demo Market Alpha"];
    expect(alpha).toMatchObject({ status: "live", category: "corporate_gifting_platforms", owner: "Example Owner", priority: "a", sales_role: "confirmed" });
    const neg = await q("select requirement from requirements where marketplace_id = $1 and kind = 'negotiated' and removed_at is null", [alpha.id]);
    expect(neg).toEqual([{ requirement: "Synthetic negotiated commission 12%." }]);
    expect(partners["Synthetic Care Store"]).toMatchObject({ status: "prospect", priority: "a", category: "healthcare_hospital_retail", sales_role: "unclear" });
    // No outreach tasks or product proposals are created by an import.
    expect((await q("select count(*)::int n from corporate_task_requests"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from marketplace_products mp join partner_import_items i on i.marketplace_id = mp.marketplace_id"))[0].n).toBe(0);

    const counts = async () => (await q(`select (select count(*) from marketplaces)::int m, (select count(*) from partner_contacts)::int c,
      (select count(*) from partner_applications)::int a, (select count(*) from requirements)::int r`))[0];
    const before = await counts();
    const again = await call("POST", "/partners/import/apply", { ...S, csv: CSV, source_name: "Synthetic research (again)", decisions: {
      ...DECISIONS, [partnerKey("Synthetic Catalog for Brands (formerly Demo Market Bravo)")]: { create_new: true } } });
    expect(again.status).toBe(200);
    expect(again.body.totals).toMatchObject({ created: 0, contacts: 0, routes: 0, requirements: 0 });
    expect(await counts()).toEqual(before);
  });
});

describe("Partners views and filters", () => {
  it("Priority A holds A prospects and ongoing A work only; skipped and active partners are elsewhere", async () => {
    const a = await view("priority_a");
    const names = a.marketplaces.map((m: any) => m.name);
    expect(names).toContain("Synthetic Care Store");               // other hospital prospects stay available
    expect(names).not.toContain("Synthetic Hospital Shop");          // skipped by decision
    expect(names).not.toContain("Demo Market Alpha");                // active, any priority
    expect((await view("active")).marketplaces.map((m: any) => m.name)).toContain("Demo Market Alpha");
    expect((await view("closed")).marketplaces.map((m: any) => m.name)).toContain("Synthetic Hospital Shop");
    expect(a.view_counts.priority_a).toBe(a.marketplaces.length);
  });

  it("filters by category, channel model, stage, owner and readiness; counts follow the filters", async () => {
    const f = await view("priority_b", "&category=events_promo");
    expect(f.marketplaces.map((m: any) => m.name)).toEqual(["Synthetic Events Group"]);
    expect(f.view_counts.priority_b).toBe(1);
    expect((await view("all", "&channel_model=integration")).marketplaces.map((m: any) => m.name)).toEqual(["Synthetic Registry"]);
    expect((await view("all", "&stage=skipped")).marketplaces.map((m: any) => m.name)).toEqual(["Synthetic Hospital Shop"]);
    expect((await view("all", "&owner=example owner")).marketplaces.map((m: any) => m.name)).toEqual(["Demo Market Alpha"]);
    expect((await call("GET", "/marketplaces?view=all&category=nope")).status).toBe(400);
  });

  it("C rows are in Later and searchable by name, alias and contact name", async () => {
    expect((await view("later")).marketplaces.map((m: any) => m.name)).toContain("Synthetic Relocation");
    expect((await view("all", "&q=relocation")).marketplaces.map((m: any) => m.name)).toEqual(["Synthetic Relocation"]);
    expect((await view("all", "&q=Riley")).marketplaces.map((m: any) => m.name)).toEqual(["Synthetic Events Group"]);
    expect((await view("all", "&q=Demo Market Bravo")).marketplaces.map((m: any) => m.name)).toEqual(expect.arrayContaining(["Demo Market Bravo"]));
  });

  it("never shows historical or advertising-only contacts as the best contact", async () => {
    await reload();
    expect(partners["Synthetic Brokerage"]).toMatchObject({ best_contact_name: null, readiness: "needed" });
    expect(partners["Synthetic Registry"]).toMatchObject({ best_contact_name: null, readiness: "route" });   // self-serve app; the advertising contact is not offered
    expect(partners["Synthetic Events Group"]).toMatchObject({ best_contact_name: "Riley Fixture", best_contact_role: "routing", readiness: "contact" });
    expect(partners["Synthetic Care Store"]).toMatchObject({ best_contact_name: null, readiness: "route" });
    const d = (await call("GET", `/marketplaces/${partners["Synthetic Registry"].id}`)).body;
    expect(d.contacts).toMatchObject([{ name: "Casey Placeholder", role: "advertising_only" }]);
  });

  it("follow-ups list due work first and leave out skipped partners", async () => {
    const care = partners["Synthetic Care Store"], hosp = partners["Synthetic Hospital Shop"];
    await call("PATCH", `/marketplaces/${care.id}`, { ...S, version: care.version, next_action_due: "2026-11-01" });
    await call("PATCH", `/marketplaces/${hosp.id}`, { ...S, version: hosp.version, next_action_due: "2026-11-01" });
    const f = await view("follow_ups");
    expect(f.marketplaces.map((m: any) => m.name)).toEqual(["Synthetic Care Store"]);
    expect((await view("priority_a")).marketplaces[0].name).toBe("Synthetic Care Store");   // due first
  });
});

describe("skipped partners", () => {
  it("keep their record and open tasks (listed, not completed) and get no new tasks", async () => {
    await reload();
    const care = partners["Synthetic Care Store"];
    // Give it a sales role so a task can be created, then skip it.
    await call("PATCH", `/marketplaces/${care.id}`, { ...S, version: care.version, sales_role: "confirmed" });
    const t = await call("POST", "/task-requests", { ...S, title: "Synthetic outreach task", marketplace_ids: [care.id], route: "checkoff" });
    expect(t.status).toBe(200);
    const m = (await call("GET", `/marketplaces/${care.id}`)).body.marketplace;
    const s = await call("POST", `/marketplaces/${care.id}/status-transitions`, { ...S, to_status: "skipped", reason: "insurance_or_compliance", detail: "Synthetic reason", version: m.version });
    expect(s.status).toBe(200);
    const d = (await call("GET", `/marketplaces/${care.id}`)).body;
    expect(d.closed).toBe(true);
    expect(d.open_tasks).toMatchObject([{ title: "Synthetic outreach task", slack_status: "open" }]);
    const blocked = await call("POST", "/task-requests", { ...S, title: "Another task", marketplace_ids: [care.id], route: "checkoff" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/skipped or closed/);
    // Back to prospect for the other tests.
    const m2 = (await call("GET", `/marketplaces/${care.id}`)).body.marketplace;
    await call("POST", `/marketplaces/${care.id}/status-transitions`, { ...S, to_status: "prospect", version: m2.version });
  });
});

describe("bulk updates", () => {
  it("previews category/priority/owner changes and applies exactly those", async () => {
    await reload();
    const ids = [partners["Demo Market Charlie"].id, partners["Demo Market Delta"].id];
    const pv = await call("POST", "/marketplaces/bulk-update", { ...S, dry_run: true, ids, set: { category: "retail_marketplaces", priority: "b", owner: "Example Owner" } });
    expect(pv.body.rows.map((r: any) => r.diff.map((x: any) => x.field).sort())).toEqual([["category", "owner", "priority"], ["category", "owner", "priority"]]);
    await reload();
    expect(partners["Demo Market Charlie"].category).toBe("uncategorized");    // preview wrote nothing
    expect((await call("POST", "/marketplaces/bulk-update", { ...S, ids, set: { category: "retail_marketplaces", priority: "b", owner: "Example Owner" } })).body.changed).toBe(2);
    await reload();
    expect(partners["Demo Market Delta"]).toMatchObject({ category: "retail_marketplaces", priority: "b", owner: "Example Owner" });
    expect((await call("POST", "/marketplaces/bulk-update", { ...S, ids, set: { status: "live" } })).status).toBe(400);
  });

  it("never changes stages without the previewed list", async () => {
    const ids = [partners["Demo Market Echo"].id, partners["Demo Market Foxtrot"].id];
    const pv = await call("POST", "/marketplaces/bulk-stage", { ...S, dry_run: true, ids, to_status: "on_hold", reason: "no_current_demand" });
    expect(pv.body.rows.map((r: any) => [r.name, r.from, r.to])).toEqual([["Demo Market Echo", "prospect", "on_hold"], ["Demo Market Foxtrot", "prospect", "on_hold"]]);
    expect((await call("POST", "/marketplaces/bulk-stage", { ...S, ids, to_status: "on_hold", reason: "no_current_demand" })).status).toBe(400);
    expect((await call("POST", "/marketplaces/bulk-stage", { ...S, ids, confirm_ids: [ids[0]], to_status: "on_hold", reason: "no_current_demand" })).status).toBe(400);
    const ok = await call("POST", "/marketplaces/bulk-stage", { ...S, ids, confirm_ids: ids, to_status: "on_hold", reason: "no_current_demand" });
    expect(ok.body.changing).toBe(2);
    expect((await q("select count(*)::int n from status_history where to_status = 'on_hold'"))[0].n).toBe(2);
  });
});

describe("linked data and reversal", () => {
  it("pricing, revenue, resources and task links on a matched partner survive an import and its reversal", async () => {
    await reload();
    const alpha = partners["Demo Market Alpha"];
    const gift = (await q("select id from products where family <> 'pots_plus_succulents' and archived_at is null limit 1"))[0];
    const pr = await call("POST", "/pricing", { ...S, channel_id: alpha.channel_id, product_id: gift.id, fulfillment_format: "individual", pricing_model: "commission", status: "draft", commission_pct: 15 });
    expect(pr.status).toBe(200);
    const rev = await call("POST", "/revenue/monthly", { ...S, channel_id: alpha.channel_id, reporting_month: "2026-10", order_count: 2, gift_sales_cents: 6000 });
    expect(rev.status).toBe(200);
    const res = await call("POST", "/supplier-resources", { ...S, supplier: `partner:${alpha.id}`, resource_type: "catalog", title: "Synthetic catalog", link_url: "https://example.test/catalog.pdf" });
    expect(res.status).toBe(200);
    const task = await call("POST", "/task-requests", { ...S, title: "Synthetic Alpha follow-up", marketplace_ids: [alpha.id], route: "checkoff" });
    expect(task.status).toBe(200);

    const csv2 = csvOf([base({ Priority: "B", Company: "Demo Market Alpha", Category: "Retail marketplace network", "Requirements & notes": "Second synthetic requirement.", "Parent company": "Synthetic Parent" })]);
    const ap = await call("POST", "/partners/import/apply", { ...S, csv: csv2, source_name: "Second synthetic file" });
    expect(ap.status).toBe(200);
    const rv = await call("POST", `/partners/import/batches/${ap.body.batch_id}/reverse`, { ...S });
    expect(rv.status).toBe(200);
    expect(rv.body.removed).toBeGreaterThan(0);

    const d = (await call("GET", `/marketplaces/${alpha.id}`)).body;
    expect(d.marketplace).toMatchObject({ id: alpha.id, status: "live", priority: "a", parent_company: null });
    expect(d.resource_count).toBe(1);
    expect((await call("GET", `/pricing?channel_id=${alpha.channel_id}`)).body.pricing.length).toBeGreaterThan(0);
    expect((await q("select count(*)::int n from monthly_revenue where channel_id = $1", [alpha.channel_id]))[0].n).toBe(1);
    expect((await q("select count(*)::int n from corporate_task_requests where $1 = any(marketplace_ids)", [alpha.id]))[0].n).toBe(1);
    // The first batch is untouched by reversing the second.
    expect((await q("select count(*)::int n from requirements where marketplace_id = $1 and requirement = 'Synthetic published requirement for Alpha.'", [alpha.id]))[0].n).toBe(1);
  });

  it("reversing the first batch removes the partners it created when nothing was added to them, and keeps the others", async () => {
    // The re-import batch refers to the same partners, so it is reversed first (it changed nothing).
    const [again] = await q("select id from partner_import_batches where source_name = 'Synthetic research (again)'");
    expect((await call("POST", `/partners/import/batches/${again.id}/reverse`, { ...S })).body).toMatchObject({ removed: 0, restored: 0, partners_removed: 0 });
    const [first] = await q("select id from partner_import_batches where source_name = 'Synthetic research'");
    const pv = await call("POST", `/partners/import/batches/${first.id}/reverse`, { ...S, dry_run: true });
    expect(pv.status).toBe(200);
    expect((await q("select status from partner_import_batches where id = $1", [first.id]))[0].status).toBe("applied");   // dry run only
    const rv = (await call("POST", `/partners/import/batches/${first.id}/reverse`, { ...S })).body;
    await reload();
    expect(partners["Synthetic Relocation"]).toBeUndefined();
    expect(partners["Synthetic Care Store"]).toBeDefined();              // edited and given a task after the import
    expect(rv.kept.map((k: any) => k.company)).toContain("Synthetic Care Store");
    expect(partners["Demo Market Alpha"]).toMatchObject({ status: "live", category: "corporate_gifting_platforms", owner: "Example Owner" });
    expect((await call("POST", `/partners/import/batches/${first.id}/reverse`, { ...S })).status).toBe(400);
  });
});

describe("categorising existing partners by record ID", () => {
  it("fills an Uncategorized record's category and channel models without touching its stage or other fields", async () => {
    await reload();
    const echo = partners["Demo Market Echo"];
    expect(echo.category).toBe("uncategorized");
    const csv = ["Partner ID,Company,Category,Channel model", `${echo.id},Demo Market Echo,events_promo,catalog_dropship`].join("\n");
    const p = (await call("POST", "/partners/import/preview", { csv })).body;
    expect(p.rows[0]).toMatchObject({ outcome: "existing_match", match: { how: "record ID" } });
    expect(p.rows[0].fills.map((f: any) => f.field).sort()).toEqual(["category", "channel_models"]);
    expect((await call("POST", "/partners/import/apply", { ...S, csv, source_name: "Synthetic categories" })).status).toBe(200);
    await reload();
    expect(partners["Demo Market Echo"]).toMatchObject({ id: echo.id, status: echo.status, category: "events_promo", channel_models: ["catalog_dropship"], priority: echo.priority });
  });
});
