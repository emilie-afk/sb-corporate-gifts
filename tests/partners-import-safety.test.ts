// FIXTURE TESTS — import safety: reversal never deletes an edited partner; apply never overwrites a field changed
// between planning and the locked update. Synthetic companies only.
import { describe, it, expect, beforeAll } from "vitest";
import { resetDb, call, S } from "./helpers";
import { getPool, tx } from "../server/db";
import { applyImport } from "../server/lib/partnerImport";

const q = (sql: string, p: unknown[] = []) => getPool().query(sql, p).then((r) => r.rows);
const csv = (...rows: string[]) => ["Priority,Company,Category,Channel model,How Succulents Box could show up,Next action,Primary contact name", ...rows].join("\n");
const byName = async (name: string) => (await q("select * from marketplaces where name = $1", [name]))[0];

beforeAll(async () => { await resetDb(); });

describe("reversal keeps partners edited after the import", () => {
  it("an imported prospect whose owner was edited once survives reversal with the edit", async () => {
    const ap = await call("POST", "/partners/import/apply", { ...S, source_name: "Synthetic owner edit",
      csv: csv("B,Synthetic Owner Co,Event agency,Referral,,,Not researched - priority C (weak fit)") });
    expect(ap.status).toBe(200);
    const m = await byName("Synthetic Owner Co");
    expect(m.version).toBe(1);
    expect((await q("select post_import_version from partner_import_items where marketplace_id = $1", [m.id]))[0].post_import_version).toBe(1);
    await call("PATCH", `/marketplaces/${m.id}`, { ...S, version: m.version, owner: "Example Owner" });
    expect((await byName("Synthetic Owner Co")).version).toBe(2);          // one edit: version 2

    const rv = await call("POST", `/partners/import/batches/${ap.body.batch_id}/reverse`, { ...S });
    expect(rv.status).toBe(200);
    expect(rv.body.partners_removed).toBe(0);
    expect(rv.body.kept.map((k: any) => k.company)).toContain("Synthetic Owner Co");
    expect(await byName("Synthetic Owner Co")).toMatchObject({ id: m.id, owner: "Example Owner" });
  });

  it("an imported prospect whose opportunity was edited survives reversal with the edit", async () => {
    const ap = await call("POST", "/partners/import/apply", { ...S, source_name: "Synthetic opportunity edit",
      csv: csv("B,Synthetic Opportunity Co,Event agency,Referral,Imported opportunity,,Not researched - priority C (weak fit)") });
    const m = await byName("Synthetic Opportunity Co");
    await call("PATCH", `/marketplaces/${m.id}`, { ...S, version: m.version, opportunity_summary: "Edited after import" });
    const rv = (await call("POST", `/partners/import/batches/${ap.body.batch_id}/reverse`, { ...S })).body;
    expect(rv.partners_removed).toBe(0);
    expect(await byName("Synthetic Opportunity Co")).toMatchObject({ id: m.id, opportunity_summary: "Edited after import" });
  });

  it("an untouched imported prospect (also one imported as Skipped) is removed by reversal", async () => {
    const ap = await call("POST", "/partners/import/apply", { ...S, source_name: "Synthetic untouched",
      csv: csv("C,Synthetic Untouched Co,Relocation,Referral,,,", "A,Synthetic Skipped Co,Hospital gift retail,Wholesale,,,"),
      decisions: { "synthetic skipped": { stage: "skipped", stage_reason: "Synthetic requirement; not pursuing" } } });
    expect(ap.status).toBe(200);
    expect((await byName("Synthetic Skipped Co")).version).toBe(2);       // created + imported Skipped stage
    const rv = (await call("POST", `/partners/import/batches/${ap.body.batch_id}/reverse`, { ...S })).body;
    expect(rv.partners_removed).toBe(2);
    expect(await byName("Synthetic Untouched Co")).toBeUndefined();
    expect(await byName("Synthetic Skipped Co")).toBeUndefined();
  });

  it("a Skipped import whose stage reason was then edited (version 3) is kept", async () => {
    const ap = await call("POST", "/partners/import/apply", { ...S, source_name: "Synthetic skipped edit",
      csv: csv("A,Synthetic Skipped Two,Hospital gift retail,Wholesale,,,"),
      decisions: { "synthetic skipped two": { stage: "skipped", stage_reason: "Synthetic requirement; not pursuing" } } });
    const m = await byName("Synthetic Skipped Two");
    await call("PATCH", `/marketplaces/${m.id}`, { ...S, version: m.version, next_action: "Revisit next year" });
    const rv = (await call("POST", `/partners/import/batches/${ap.body.batch_id}/reverse`, { ...S })).body;
    expect(rv.partners_removed).toBe(0);
    expect(await byName("Synthetic Skipped Two")).toMatchObject({ id: m.id, next_action: "Revisit next year" });
  });
});

describe("apply re-checks the locked record", () => {
  it("keeps a field filled between planning and the locked update and reports it as a conflict", async () => {
    const r = await call("POST", "/marketplaces", { ...S, name: "Synthetic Race Partner", provider_type: "marketplace" });
    const id = r.body.marketplace.id;
    const file = csv("A,Synthetic Race Partner,Event agency,Referral,Imported opportunity,Imported next action,");
    const pv = (await call("POST", "/partners/import/preview", { csv: file })).body;
    expect(pv.rows[0].fills.map((f: any) => f.field)).toEqual(expect.arrayContaining(["opportunity_summary", "next_action", "category"]));

    const out = await tx((c) => applyImport(c, { signer: "Test Person", sub: null }, file, "Synthetic race", {}, {
      // Another person saves the opportunity while the import is being applied (separate connection, committed).
      afterPlan: async () => { await getPool().query("update marketplaces set opportunity_summary = 'Typed by a teammate', version = version + 1 where id = $1", [id]); },
    }));
    const m = (await q("select * from marketplaces where id = $1", [id]))[0];
    expect(m.opportunity_summary).toBe("Typed by a teammate");             // not overwritten
    expect(m.next_action).toBe("Imported next action");                   // other empty fields still filled
    expect(m.category).toBe("events_promo");
    expect(out.late_conflicts).toEqual([expect.objectContaining({ company: "Synthetic Race Partner", field: "opportunity_summary", now: "Typed by a teammate", imported: "Imported opportunity" })]);
    const item = (await q("select conflicts, field_changes from partner_import_items where batch_id = $1", [out.batch_id]))[0];
    expect(item.conflicts).toEqual([expect.objectContaining({ field: "opportunity_summary", resolution: "keep", changed_during_import: true })]);
    expect(item.field_changes.map((f: any) => f.field)).not.toContain("opportunity_summary");
  });
});
