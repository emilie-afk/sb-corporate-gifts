// Slack scanner → app. Protected by its own private secret (CORPORATE_SLACK_INGEST_SECRET), never by the Google
// login, and separate from the Shopify collector and reporting credentials (equal to any of them = disabled).
//   POST /api/ingest/slack-findings           one scan pass of one channel (see server/lib/slackWorkflow.ts)
//   POST /api/ingest/slack-findings?dry_run=1 the same, rolled back: what would be added, updated and flagged
//   GET  /api/ingest/slack-state              per-channel scan position and the threads to revisit
// Answers contain counts and record references only, never message text or supplier terms.
import { createHash, timingSafeEqual } from "node:crypto";
import { json, errorResponse } from "./http";
import { hit, clientKey, LIMITS } from "./rateLimit";
import { readBounded } from "./body";
import { applyPass, scanState } from "./lib/slackWorkflow";

const MAX_BYTES = 2 * 1024 * 1024;

function credential(header: string | null) {
  const secret = process.env.CORPORATE_SLACK_INGEST_SECRET ?? "";
  if (secret.length < 32) return "disabled" as const;
  if ([process.env.CORPORATE_INGEST_SECRET, process.env.CORPORATE_REPORTING_SECRET, process.env.SESSION_SECRET, process.env.GOOGLE_CLIENT_SECRET].includes(secret)) return "disabled" as const;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function handleSlackIngest(req: Request, path: string): Promise<Response> {
  try {
    const ok = credential(req.headers.get("authorization"));
    if (ok === "disabled") return json({ error: { code: "slack_ingest_disabled", message: "Slack ingestion is not configured." } }, 503);
    if (path === "/ingest/slack-state") {
      if (req.method !== "GET") return json({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
      await hit({ bucket: `slack:${clientKey(req)}`, ...LIMITS.slack });
      if (!ok) return json({ error: { code: "unauthorized", message: "Invalid Slack ingestion credential." } }, 401);
      return json(await scanState());
    }
    if (req.method !== "POST") return json({ error: { code: "method_not_allowed", message: "POST only" } }, 405);
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json({ error: { code: "unsupported_media_type", message: "Send application/json." } }, 415);
    const declared = req.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return json({ error: { code: "too_large", message: "Payload larger than 2 MB; send smaller passes." } }, 413);
    await hit({ bucket: `slack:${clientKey(req)}`, ...LIMITS.slack });
    if (!ok) return json({ error: { code: "unauthorized", message: "Invalid Slack ingestion credential." } }, 401);
    const url = new URL(req.url);
    const keys = [...url.searchParams.keys()];
    if (keys.some((k) => k !== "dry_run") || (url.searchParams.has("dry_run") && url.searchParams.get("dry_run") !== "1")) {
      return json({ error: { code: "bad_query", message: "Only dry_run=1 is accepted." } }, 400);
    }
    let text: string;
    try { text = await readBounded(req, MAX_BYTES); } catch (e: any) {
      if (e?.status === 413) return json({ error: { code: "too_large", message: "Payload larger than 2 MB; send smaller passes." } }, 413);
      throw e;
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return json({ error: { code: "invalid_json", message: "Body is not JSON." } }, 400); }
    const r = await applyPass(payload, { dryRun: url.searchParams.get("dry_run") === "1" });
    return json({ ok: true, ...r });
  } catch (e: any) {
    if (e?.status === 400) return json({ error: { code: e.code ?? "payload_rejected", message: e.message, problems: e.details?.problems ?? [] } }, 400);
    return errorResponse(e);
  }
}
