// Collector → app ingestion. Protected by a dedicated private secret (CORPORATE_INGEST_SECRET),
// never by the shared Google login. Uses exactly the same import logic as the manual upload.
import { createHash, timingSafeEqual } from "node:crypto";
import { json, errorResponse } from "./http";
import { ingestPayload } from "./lib/ingest";
import { hit, clientKey, LIMITS } from "./rateLimit";
import { readBounded } from "./body";

const MAX_BYTES = 6 * 1024 * 1024;

function secretOk(header: string | null) {
  const secret = process.env.CORPORATE_INGEST_SECRET ?? "";
  if (secret.length < 32) return "disabled" as const;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function handleIngest(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") return json({ error: { code: "method_not_allowed", message: "POST only" } }, 405);
    const ok = secretOk(req.headers.get("authorization"));
    if (ok === "disabled") return json({ error: { code: "ingest_disabled", message: "Ingestion is not configured." } }, 503);
    // Cheap header checks first (no database work): content type and declared size.
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json({ error: { code: "unsupported_media_type", message: "Send application/json." } }, 415);
    const declared = req.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
      return json({ error: { code: "too_large", message: "Payload larger than 6 MB; split the export window." } }, 413);
    // Then the durable counter — before the credential check, so guessing the secret is limited too, and
    // before the body is read, so unauthenticated senders are limited before any large upload is buffered.
    await hit({ bucket: `ingest:${clientKey(req)}`, ...LIMITS.ingest });
    if (!ok) return json({ error: { code: "unauthorized", message: "Invalid ingestion credential." } }, 401);
    // Byte-limited read (declared length checked first; the stream is abandoned past 6 MB).
    let text: string;
    try { text = await readBounded(req, MAX_BYTES); } catch (e: any) {
      if (e?.status === 413) return json({ error: { code: "too_large", message: "Payload larger than 6 MB; split the export window." } }, 413);
      throw e;
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return json({ error: { code: "invalid_json", message: "Body is not JSON." } }, 400); }
    const out = await ingestPayload(payload, { source: "collector", signer: "Collector", sub: null });
    const r = out.run;
    // Counts only — never order details — so collector logs stay free of business data.
    return json({ ok: true, status: r.status, import_id: r.id, received: r.orders_received, new: r.orders_new, updated: r.orders_updated,
      unchanged: r.orders_unchanged, stale: r.orders_stale, rejected: r.orders_rejected, warnings: (r.warnings ?? []).length });
  } catch (e: any) {
    if (e?.status === 400) return json({ error: { code: "payload_rejected", message: e.message, problems: e.details?.problems ?? [] } }, 400);
    return errorResponse(e);
  }
}
