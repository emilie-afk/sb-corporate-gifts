import { describe, it, expect, beforeAll } from "vitest";
import { resetDb, call, cookieFor, OUTSIDER, S } from "./helpers";

let mk: Record<string, any> = {};

beforeAll(async () => {
  await resetDb();
  const r = await call("GET", "/marketplaces?include_inactive=1");
  mk = Object.fromEntries(r.body.marketplaces.map((m: any) => [m.name, m]));
});

describe("access control", () => {
  it("rejects requests without a session", async () => {
    expect((await call("GET", "/marketplaces", undefined, { cookie: null })).status).toBe(401);
  });
  it("rejects a valid session for a login not on the allowlist", async () => {
    expect((await call("GET", "/marketplaces", undefined, { cookie: await cookieFor(OUTSIDER) })).status).toBe(401);
  });
  it("rejects tampered cookies", async () => {
    expect((await call("GET", "/marketplaces", undefined, { cookie: "sbg_session=abc.def.ghi" })).status).toBe(401);
  });
  it("requires the anti-CSRF header on mutations", async () => {
    const r = await call("POST", `/marketplaces/${mk["Demo Market Delta"].id}/communications`, { ...S, occurred_on: "2026-10-01", method: "email", summary: "x" }, { noCsrf: true });
    expect(r.status).toBe(403);
  });
  it("requires a typed signer name on mutations", async () => {
    const r = await call("POST", `/marketplaces/${mk["Demo Market Delta"].id}/communications`, { signer_name: "  ", occurred_on: "2026-10-01", method: "email", summary: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields.signer_name).toBeTruthy();
  });
});

describe("seed data", () => {
  it("has all 8 providers correctly classified, with no invented contacts or completions", async () => {
    expect(Object.keys(mk)).toHaveLength(8);
    expect(mk["Demo Market Alpha"].status).toBe("reconnecting");
    expect(mk["Demo Market Bravo"].status).toBe("reconnecting");
    for (const n of ["Demo Market Charlie", "Demo Market Delta", "Demo Market Echo", "Demo Market Foxtrot", "Demo Supplier Golf", "Demo Supplier Hotel"]) expect(mk[n].status).toBe("prospect");
    expect(mk["Demo Supplier Golf"].provider_type).toBe("supplier_opportunity");
    expect(mk["Demo Supplier Hotel"].provider_type).toBe("supplier_opportunity");
    expect(Object.values(mk).filter((m: any) => m.provider_type === "marketplace")).toHaveLength(6);
    for (const m of Object.values(mk) as any[]) {
      expect(m.contact_name).toBeNull();
      expect(m.contact_email).toBeNull();
      expect(m.milestones_done).toBe(0);
      expect(m.milestones_total).toBe(6);
      expect(m.last_communication).toBeNull();
    }
  });
  it("never seeds a requirement as confirmed", async () => {
    for (const m of Object.values(mk) as any[]) {
      const d = await call("GET", `/marketplaces/${m.id}`);
      expect(d.body.requirements.length).toBeGreaterThan(0);
      for (const r of d.body.requirements) expect(r.confirmation_state).not.toBe("confirmed");
    }
  });
  it("demo data has Direct website as a channel (not a marketplace) with the demo discount and MOQ", async () => {
    const ch = (await call("GET", "/channels")).body.channels;
    const direct = ch.find((c: any) => c.name === "Direct website");
    expect(direct.type).toBe("direct");
    expect(direct.marketplace_id).toBeNull();
    expect(Number(direct.default_discount_pct)).toBe(15);
    expect(direct.corporate_moq).toBe(12);
  });
  it("seeds no revenue and no prices", async () => {
    expect((await call("GET", "/revenue/monthly")).body.revenue).toHaveLength(0);
    expect((await call("GET", "/pricing")).body.pricing).toHaveLength(0);
  });
});

describe("setup checklist", () => {
  it("records signer and server time on done; reopen keeps history; N/A adjusts denominator", async () => {
    const id = mk["Demo Market Delta"].id;
    let d = (await call("GET", `/marketplaces/${id}`)).body;
    const [m1, m2, ...rest] = d.milestones;
    const done = await call("PATCH", `/marketplaces/${id}/milestones/${m1.id}`, { ...S, action: "done", version: m1.version });
    expect(done.status).toBe(200);
    expect(done.body.milestone.completed_by).toBe("Test Person");
    expect(done.body.milestone.completed_at).toBeTruthy();

    const na = await call("PATCH", `/marketplaces/${id}/milestones/${m2.id}`, { ...S, action: "not_applicable", version: m2.version });
    expect(na.status).toBe(400); // reason required
    const na2 = await call("PATCH", `/marketplaces/${id}/milestones/${m2.id}`, { ...S, action: "not_applicable", reason: "No requirements step for this provider", version: m2.version });
    expect(na2.status).toBe(200);

    let list = (await call("GET", "/marketplaces?q=Demo Market Delta")).body.marketplaces[0];
    expect(list.milestones_done).toBe(1);
    expect(list.milestones_applicable).toBe(5);

    const reopen = await call("PATCH", `/marketplaces/${id}/milestones/${m1.id}`, { ...S, action: "reopen", version: done.body.milestone.version });
    expect(reopen.body.milestone.state).toBe("pending");
    expect(reopen.body.milestone.completed_by).toBeNull();
    d = (await call("GET", `/marketplaces/${id}`)).body;
    const hist = d.milestoneHistory.filter((h: any) => h.entity_id === m1.id).map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(["done", "reopen"]));
    expect(d.marketplace.status).toBe("prospect"); // status is never inferred from milestones

    // All N/A → 0 applicable (UI shows "No applicable milestones", not 100%)
    for (const m of d.milestones.filter((x: any) => x.state !== "not_applicable")) {
      await call("PATCH", `/marketplaces/${id}/milestones/${m.id}`, { ...S, action: "not_applicable", reason: "test", version: m.version });
    }
    list = (await call("GET", "/marketplaces?q=Demo Market Delta")).body.marketplaces[0];
    expect(list.milestones_applicable).toBe(0);
  });

  it("adds, edits and removes a custom milestone, keeping removal in history", async () => {
    const id = mk["Demo Market Echo"].id;
    const add = await call("POST", `/marketplaces/${id}/milestones`, { ...S, title: "SLA confirmed" });
    expect(add.status).toBe(200);
    const ed = await call("PATCH", `/marketplaces/${id}/milestones/${add.body.milestone.id}`, { ...S, action: "edit", title: "Dispatch SLA confirmed", version: 1 });
    expect(ed.body.milestone.title).toBe("Dispatch SLA confirmed");
    const rm = await call("PATCH", `/marketplaces/${id}/milestones/${add.body.milestone.id}`, { ...S, action: "remove", version: 2 });
    expect(rm.status).toBe(200);
    const d = (await call("GET", `/marketplaces/${id}`)).body;
    expect(d.milestones.find((m: any) => m.id === add.body.milestone.id)).toBeUndefined();
    expect(d.milestoneHistory.some((h: any) => h.action === "remove")).toBe(true);
  });

  it("returns a conflict for stale versions instead of overwriting", async () => {
    const id = mk["Demo Market Foxtrot"].id;
    const m = (await call("GET", `/marketplaces/${id}`)).body.milestones[0];
    await call("PATCH", `/marketplaces/${id}/milestones/${m.id}`, { ...S, action: "done", version: m.version });
    const stale = await call("PATCH", `/marketplaces/${id}/milestones/${m.id}`, { ...S, action: "edit", note: "x", version: m.version });
    expect(stale.status).toBe(409);
  });
});

describe("status transitions", () => {
  it("requires a reason for inactive statuses, hides them by default, and reactivation preserves records", async () => {
    const id = mk["Demo Supplier Hotel"].id;
    await call("POST", `/marketplaces/${id}/communications`, { ...S, occurred_on: "2026-10-02", method: "email", summary: "Asked about impact qualification" });
    let m = (await call("GET", `/marketplaces/${id}`)).body.marketplace;
    const noReason = await call("POST", `/marketplaces/${id}/status-transitions`, { ...S, to_status: "not_qualified", version: m.version });
    expect(noReason.status).toBe(400);
    const ok = await call("POST", `/marketplaces/${id}/status-transitions`, {
      ...S, to_status: "not_qualified", reason: "product_fit", unmet_requirement: "Impact certification", what_would_change: "Partner with certified nonprofit", revisit_date: "2027-01-15", version: m.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.transition.unmet_requirement).toBe("Impact certification");

    const def = (await call("GET", "/marketplaces")).body.marketplaces.map((x: any) => x.name);
    expect(def).not.toContain("Demo Supplier Hotel");
    const all = (await call("GET", "/marketplaces?include_inactive=1")).body.marketplaces.map((x: any) => x.name);
    expect(all).toContain("Demo Supplier Hotel");

    const before = (await call("GET", `/marketplaces/${id}`)).body;
    const re = await call("POST", `/marketplaces/${id}/status-transitions`, { ...S, to_status: "reconnecting", version: before.marketplace.version });
    expect(re.status).toBe(200);
    const after = (await call("GET", `/marketplaces/${id}`)).body;
    expect(after.communications).toHaveLength(before.communications.length);
    expect(after.milestones.map((x: any) => x.state)).toEqual(before.milestones.map((x: any) => x.state));
    expect(after.statusHistory[0].to_status).toBe("reconnecting");
    expect(after.marketplace.last_communication).toBe("2026-10-02");
  });

  it("derives last communication from communication date, not edit time", async () => {
    const id = mk["Demo Market Alpha"].id;
    await call("POST", `/marketplaces/${id}/communications`, { ...S, occurred_on: "2026-09-20", method: "call", summary: "Older call" });
    await call("POST", `/marketplaces/${id}/communications`, { ...S, occurred_on: "2026-09-01", method: "email", summary: "Even older email, entered later" });
    const m = (await call("GET", `/marketplaces?q=Demo Market Alpha`)).body.marketplaces[0];
    expect(m.last_communication).toBe("2026-09-20");
    const d = (await call("GET", `/marketplaces/${id}`)).body;
    expect(d.communications[0].occurred_on).toBe("2026-09-20"); // newest first
  });
});

describe("requirements", () => {
  it("keeps requirement and response separate; confirmation records signer", async () => {
    const id = mk["Demo Market Charlie"].id;
    const c = await call("POST", `/marketplaces/${id}/requirements`, { ...S, category: "payment", requirement: "Net-30 payment", response: "Accept Net-30", confirmation_state: "unverified" });
    expect(c.body.requirement.requirement).toBe("Net-30 payment");
    expect(c.body.requirement.response).toBe("Accept Net-30");
    expect(c.body.requirement.confirmed_by).toBeNull();
    const u = await call("PATCH", `/marketplaces/${id}/requirements/${c.body.requirement.id}`, { ...S, confirmation_state: "confirmed", version: 1 });
    expect(u.body.requirement.confirmed_by).toBe("Test Person");
    const back = await call("PATCH", `/marketplaces/${id}/requirements/${c.body.requirement.id}`, { ...S, confirmation_state: "awaiting_clarification", version: 2 });
    expect(back.body.requirement.confirmed_by).toBeNull();
  });
  it("validates URLs and enums server-side", async () => {
    const id = mk["Demo Market Charlie"].id;
    const bad = await call("POST", `/marketplaces/${id}/communications`, { ...S, occurred_on: "2026-10-01", method: "fax", summary: "x", reference_url: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields)).toEqual(expect.arrayContaining(["method", "reference_url"]));
  });
});
