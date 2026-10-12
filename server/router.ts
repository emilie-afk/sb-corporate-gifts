import { HttpError, badRequest, conflict, notFound } from "./http";
import { signer as signerSchema } from "./validate";
import type { Actor } from "./audit";
import type { Session } from "./auth";
import type { Db } from "./db";

export type Ctx = {
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  session: Session;
  body: () => Promise<any>;
  /** Validated typed signer + private auth subject. Required for all mutations. */
  actor: (body: any) => Actor;
};

export type Handler = (ctx: Ctx) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export class Router {
  routes: Route[] = [];
  add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$",
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }
  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  patch = (p: string, h: Handler) => this.add("PATCH", p, h);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h);

  match(method: string, path: string) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return null;
  }
}

export function makeActor(session: Session) {
  return (body: any): Actor => {
    const r = signerSchema.safeParse(body?.signer_name);
    if (!r.success) throw badRequest("Your name is required to save changes.", { fields: { signer_name: r.error.issues[0].message } });
    return { signer: r.data, sub: session.sub };
  };
}

/**
 * Optimistic-concurrency update. `fields` keys must be trusted column names.
 * Throws 409 when the stored version differs from `expectedVersion`.
 */
export async function updateVersioned(
  db: Db,
  table: string,
  id: string,
  expectedVersion: number,
  fields: Record<string, unknown>,
): Promise<{ before: any; after: any }> {
  const cur = await db.query(`select * from ${table} where id = $1 for update`, [id]);
  if (!cur.rowCount) throw notFound();
  const before = cur.rows[0];
  if (before.version !== expectedVersion) throw conflict();
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  sets.push("updated_at = now()", "version = version + 1");
  const r = await db.query(
    `update ${table} set ${sets.join(", ")} where id = $1 and version = $2 returning *`,
    [id, expectedVersion, ...keys.map((k) => fields[k])],
  );
  if (!r.rowCount) throw conflict();
  return { before, after: r.rows[0] };
}
