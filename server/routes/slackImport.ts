// Slack scans from the app (signed-in, no secret):
//   POST /api/slack/import   one scan pass (sbcg-slack-v2 JSON): preview (dry_run) shows the partner fields, resources,
//                            tasks and conflicts it would change, then Save applies them. Same rules as the optional
//                            script route (server/slackIngestEndpoint.ts): eligibility is checked here, on the server.
//   POST /api/slack/cleanup  one-time cleanup of imports made before Marketplace Resources (format 1): closes their
//                            open review items, excludes product-supplier and unlisted-company records from views and
//                            summaries (nothing deleted), and marks findings that the v2 reprocessing replaces.
// Every change is recorded under the typed signature and the verified Google account.
import type pg from "pg";
import { Router } from "../router";
import { HttpError, badRequest } from "../http";
import { tx } from "../db";
import { audit, type Actor } from "../audit";
import { applyPass } from "../lib/slackWorkflow";
import { matchEligiblePartner } from "../lib/suppliers";

class DryRun extends Error {}

export function slackImportRoutes(r: Router) {
  r.post("/slack/import", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    if (b?.dry_run !== undefined && typeof b.dry_run !== "boolean") throw badRequest("dry_run must be true or false.");
    if (!b?.pass || typeof b.pass !== "object") throw badRequest("Choose a scan file.", { fields: { pass: "Required" } });
    try {
      const res = await applyPass(b.pass, { dryRun: b.dry_run === true, importedBy: a });
      return { ok: true, ...res };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 400) {
        const problems: string[] = (e.details as any)?.problems ?? [];
        throw badRequest(problems.length ? `${e.message} ${problems.slice(0, 3).join("; ")}` : e.message);
      }
      throw e;
    }
  });

  r.post("/slack/cleanup", async ({ body, actor }) => {
    const b = await body();
    const a = actor(b);
    if (typeof b?.dry_run !== "boolean") throw badRequest("dry_run must be true or false.");
    let out: CleanupCounts | null = null;
    try {
      await tx(async (c) => {
        out = await cleanupFormat1(c, a);
        if (b.dry_run) throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    return { ok: true, dry_run: b.dry_run, ...out! };
  });
}

export type CleanupCounts = {
  review_closed_replaced: number;      // open items about an eligible partner: reprocessed by the v2 scan instead
  review_closed_out_of_scope: number;  // open items about product suppliers, unlisted companies or nothing specific
  resources_excluded: number;          // imported resources attached to product vendors
  actions_replaced: number;            // imported actions/decisions/blockers for eligible partners (now tasks or resources)
  actions_excluded: number;            // imported actions/decisions/blockers with no eligible partner
  samples_excluded: number;            // imported sample requests with no eligible partner
  findings_in_scope: number;
  findings_replaced: number;
  findings_out_of_scope: number;
};

const REASON_SUPPLIER = "Product supplier, not a Marketplaces sales partner (Marketplace Resources cleanup)";
const REASON_UNLISTED = "No eligible Marketplaces record (Marketplace Resources cleanup)";
const REASON_REPLACED = "Replaced by Marketplace Resources (task or resource after reprocessing)";

async function eligible(c: pg.PoolClient, id: string | null) {
  if (!id) return false;
  const m = await matchEligiblePartner(c, { id });
  return m.ok;
}

/** Idempotent: a second run finds nothing left to change. */
export async function cleanupFormat1(c: pg.PoolClient, a: Actor): Promise<CleanupCounts> {
  const n: CleanupCounts = {
    review_closed_replaced: 0, review_closed_out_of_scope: 0, resources_excluded: 0, actions_replaced: 0, actions_excluded: 0,
    samples_excluded: 0, findings_in_scope: 0, findings_replaced: 0, findings_out_of_scope: 0,
  };
  const findingScope = new Map<string, "replaced" | "out_of_scope">();

  for (const it of (await c.query("select * from review_items where status = 'open' and format = 1 for update")).rows) {
    const names = String(it.supplier_hint ?? "").split("/").map((x: string) => x.trim()).filter(Boolean);
    const m = names.length ? await matchEligiblePartner(c, { names }) : { ok: false as const };
    const replaced = m.ok;
    await c.query(
      `update review_items set status = 'dismissed', resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = now(), updated_at = now(), version = version + 1 where id = $1`,
      [it.id, replaced ? "replaced" : "out_of_scope", replaced ? REASON_REPLACED : (names.length ? REASON_UNLISTED : "No partner named (Marketplace Resources cleanup)"), a.signer]);
    if (replaced) n.review_closed_replaced++; else n.review_closed_out_of_scope++;
    findingScope.set(it.finding_key, replaced ? "replaced" : "out_of_scope");
  }

  for (const r of (await c.query("select id, finding_key from supplier_resources where origin = 'slack' and vendor_id is not null and excluded_at is null for update")).rows) {
    await c.query("update supplier_resources set excluded_at = now(), excluded_reason = $2, updated_at = now(), version = version + 1 where id = $1", [r.id, REASON_SUPPLIER]);
    n.resources_excluded++;
    if (r.finding_key) findingScope.set(r.finding_key, "out_of_scope");
  }

  for (const r of (await c.query("select id, finding_key, marketplace_id, vendor_id from corporate_actions where origin = 'slack' and excluded_at is null for update")).rows) {
    const ok = await eligible(c, r.marketplace_id);
    await c.query("update corporate_actions set excluded_at = now(), excluded_reason = $2, updated_at = now(), version = version + 1 where id = $1",
      [r.id, ok ? REASON_REPLACED : (r.vendor_id ? REASON_SUPPLIER : REASON_UNLISTED)]);
    if (ok) n.actions_replaced++; else n.actions_excluded++;
    if (r.finding_key) findingScope.set(r.finding_key, ok ? "replaced" : "out_of_scope");
  }

  for (const r of (await c.query("select id, finding_key, marketplace_id, vendor_id from sample_requests where origin = 'slack' and excluded_at is null for update")).rows) {
    if (await eligible(c, r.marketplace_id)) continue;
    await c.query("update sample_requests set excluded_at = now(), excluded_reason = $2, updated_at = now(), version = version + 1 where id = $1",
      [r.id, r.vendor_id ? REASON_SUPPLIER : REASON_UNLISTED]);
    n.samples_excluded++;
    if (r.finding_key) findingScope.set(r.finding_key, "out_of_scope");
  }

  for (const f of (await c.query("select key, scope from slack_findings where format = 1 for update")).rows) {
    const scope = findingScope.get(f.key) ?? f.scope;
    if (scope !== f.scope) await c.query("update slack_findings set scope = $2, updated_at = now() where key = $1", [f.key, scope]);
    if (scope === "in_scope") n.findings_in_scope++; else if (scope === "replaced") n.findings_replaced++; else n.findings_out_of_scope++;
  }

  await audit(c, a, { entityType: "slack_scan", entityId: null, action: "cleanup_format1", after: n });
  return n;
}
