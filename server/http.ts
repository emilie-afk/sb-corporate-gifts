import { logServerError } from "./redact";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "invalid_request", msg, details);
export const notFound = (what = "Record") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (msg = "This record was changed by someone else. Reload to see the latest version, then re-apply your edit.") =>
  new HttpError(409, "conflict", msg);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private", "x-content-type-options": "nosniff", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const retry = (e as any).retryAfter;
    return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status, retry ? { "retry-after": String(retry) } : {});
  }
  const pg = e as { code?: string; constraint?: string; message?: string };
  if (pg?.code === "23505") {
    return json({ error: { code: "duplicate", message: duplicateMessage(pg.constraint) } }, 409);
  }
  if (pg?.code === "23P01") {
    return json({ error: { code: "overlap", message: "Another active price already covers this channel, gift/variant and fulfillment format for an overlapping period." } }, 409);
  }
  if (pg?.code === "23514" || pg?.code === "23503" || pg?.code === "22P02" || pg?.code === "22007" || pg?.code === "22008") {
    return json({ error: { code: "constraint", message: constraintMessage(pg.message ?? "") } }, 422);
  }
  logServerError("api", e); // no stack, SQL parameters, row values or URLs
  return json({ error: { code: "server_error", message: "Something went wrong on the server. Your input was not saved." } }, 500);
}

function duplicateMessage(constraint?: string) {
  if (constraint?.includes("monthly_revenue")) return "A revenue record already exists for this channel and month. Open it and edit instead.";
  if (constraint?.includes("marketplaces_name") || constraint?.includes("channels_name")) return "That name is already used.";
  return "A matching record already exists.";
}

function constraintMessage(msg: string) {
  if (msg.includes("pots_plus_succulents_bulk_only"))
    return "Pots with succulents are a complete gift for bulk orders only. Individual recipient shipping is unavailable, so individual or separate-address fulfillment cannot be saved for this offer.";
  if (msg.includes("pricing_record_immutable")) return "Agreed and active prices are immutable. Use Revise price to create a new version.";
  return "The data did not pass validation. Check required fields and values.";
}
