// Slack scan import from the app: a signed-in team member uploads one scan pass (sbcg-slack-v1 JSON) in
// Supplier Resources → Slack scans, previews it, then saves it. Same rules as the secret-protected ingest endpoint
// (server/slackIngestEndpoint.ts): one channel per pass, all-or-nothing, preview rolls back. The import is logged
// under the typed signature and the verified Google account.
import { Router } from "../router";
import { HttpError, badRequest } from "../http";
import { applyPass } from "../lib/slackWorkflow";

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
}
