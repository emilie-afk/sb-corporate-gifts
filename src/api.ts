export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields: Record<string, string> = {}) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-requested-with": "sbg" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Network error — check your connection and try again. Your input is still in the form.");
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("sbg:unauthorized"));
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? `Request failed (HTTP ${res.status})`, e.details?.fields ?? {});
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v === true ? 1 : v));
  const s = u.toString();
  return s ? `?${s}` : "";
}
