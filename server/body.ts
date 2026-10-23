// Reads a request body with a hard BYTE limit. The declared Content-Length is checked first, then the stream
// is read chunk by chunk and abandoned as soon as the limit is passed, so an oversized body is never fully
// buffered. Invalid UTF-8 is refused.
import { HttpError } from "./http";

export async function readBounded(req: Request, maxBytes: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw tooLarge(maxBytes);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    throw new HttpError(400, "invalid_request", "Request body is not valid UTF-8.");
  }
}

function tooLarge(max: number) {
  return new HttpError(413, "too_large", `Request too large (limit ${Math.round(max / 1024 / 1024 * 10) / 10} MB).`);
}
