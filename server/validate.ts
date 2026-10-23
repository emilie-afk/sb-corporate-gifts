import { z } from "zod";
import { badRequest } from "./http";

const trimmed = (max: number) => z.string().trim().max(max);

/** Optional free text: '' → null. */
export const text = (max = 2000) =>
  z.union([trimmed(max), z.null()]).optional().transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : v));

export const reqText = (max = 2000) => trimmed(max).min(1, "Required");

export const signer = z.string().trim().min(1, "Your name is required").max(80, "Name is too long (max 80)");

export const url = z
  .union([z.string().trim().max(2000), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      return u.toString();
    } catch {
      ctx.addIssue({ code: "custom", message: "Must be a valid http(s) URL" });
      return z.NEVER;
    }
  });

export const email = z
  .union([z.string().trim().max(254), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      ctx.addIssue({ code: "custom", message: "Must be a valid email" });
      return z.NEVER;
    }
    return v;
  });

/** Money in integer cents; null = unknown. */
export const cents = z.union([z.number().int().min(0).max(1e12), z.null()]).optional();
export const pct = z.union([z.number().min(0).max(100).multipleOf(0.01), z.null()]).optional();
export const count = z.union([z.number().int().min(0).max(1e9), z.null()]).optional();
export const date = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"), z.null()])
  .optional()
  .refine((v) => v == null || !Number.isNaN(Date.parse(v + "T00:00:00Z")), "Invalid date");
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
export const uuid = z.string().uuid();
export const version = z.number().int().min(1);

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) fields[issue.path.join(".") || "_"] = issue.message;
    throw badRequest("Please fix the highlighted fields.", { fields });
  }
  return r.data;
}

/** Remove undefined keys (PATCH semantics). */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function assertUuid(id: string) {
  if (!uuid.safeParse(id).success) throw badRequest("Invalid id");
}

/** Names shown in downloads and spreadsheets must not start like a formula (= + - @). */
export const displayName = (max = 120) =>
  reqText(max).refine((v) => !/^[=+\-@]/.test(v), "Must not start with = + - or @");
