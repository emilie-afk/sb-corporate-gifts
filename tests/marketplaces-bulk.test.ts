// FIXTURE TESTS — bulk add of marketplaces (names + type + working status). Synthetic names only.
import { describe, it, expect, beforeAll } from "vitest";
import { resetDb, call, S } from "./helpers";

beforeAll(async () => { await resetDb(); });

describe("bulk add marketplaces", () => {
  it("dry run flags names already in use (any case/spacing) and repeats, and creates nothing", async () => {
    const before = (await call("GET", "/marketplaces?include_inactive=1")).body.marketplaces.length;
    const r = await call("POST", "/marketplaces/bulk", { ...S, dry_run: true, items: [
      { name: "Synthetic Gifts One" }, { name: "  demo market delta  " }, { name: "synthetic gifts   one" }, { name: "Synthetic Gifts Two", status: "in_discussion" },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.invalid).toBe(2);
    expect(r.body.rows[0].errors).toEqual([]);
    expect(r.body.rows[1].errors.join()).toMatch(/Already exists as “Demo Market Delta”/);
    expect(r.body.rows[2].errors.join()).toMatch(/Repeated \(same as line 1\)/);
    expect(r.body.rows[3]).toMatchObject({ status: "in_discussion", errors: [] });
    expect((await call("GET", "/marketplaces?include_inactive=1")).body.marketplaces.length).toBe(before);
  });

  it("saving is all-or-nothing: one bad name blocks the batch", async () => {
    const before = (await call("GET", "/marketplaces?include_inactive=1")).body.marketplaces.length;
    const r = await call("POST", "/marketplaces/bulk", { ...S, items: [{ name: "Synthetic Gifts Three" }, { name: "Demo Market Delta" }] });
    expect(r.status).toBe(400);
    expect((await call("GET", "/marketplaces?include_inactive=1")).body.marketplaces.length).toBe(before);
  });

  it("creates each name with its own type and status, default milestones and a signed status history", async () => {
    const r = await call("POST", "/marketplaces/bulk", { ...S, items: [
      { name: "Synthetic Gifts One", status: "prospect" },
      { name: "Synthetic Gifts Two", status: "in_discussion" },
      { name: "Synthetic Supplier Co", provider_type: "supplier_opportunity", status: "live" },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.created.map((m: any) => [m.name, m.status, m.provider_type])).toEqual([
      ["Synthetic Gifts One", "prospect", "marketplace"],
      ["Synthetic Gifts Two", "in_discussion", "marketplace"],
      ["Synthetic Supplier Co", "live", "supplier_opportunity"],
    ]);
    const d = (await call("GET", `/marketplaces/${r.body.created[1].id}`)).body;
    expect(d.milestones.length).toBeGreaterThan(0);
    expect(d.statusHistory[0]).toMatchObject({ to_status: "in_discussion", signer_name: S.signer_name });
    const chans = (await call("GET", "/channels")).body.channels.map((c: any) => [c.name, c.type]);
    expect(chans).toEqual(expect.arrayContaining([["Synthetic Gifts One", "marketplace"], ["Synthetic Supplier Co", "sourcing"]]));
  });

  it("refuses inactive statuses, a missing name or signature, and more than 200 names", async () => {
    const inactive = await call("POST", "/marketplaces/bulk", { ...S, dry_run: true, items: [{ name: "Synthetic Paused", status: "on_hold" }] });
    expect(inactive.body.rows[0].errors.join()).toMatch(/working status/);
    expect((await call("POST", "/marketplaces/bulk", { ...S, items: [{ name: "  " }] })).status).toBe(400);
    expect((await call("POST", "/marketplaces/bulk", { items: [{ name: "Synthetic Unsigned" }] })).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `Synthetic ${i}` }));
    expect((await call("POST", "/marketplaces/bulk", { ...S, items: many })).status).toBe(400);
  });
});
