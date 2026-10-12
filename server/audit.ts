import type { Db } from "./db";

export type Actor = { signer: string; sub: string | null };

export async function audit(
  db: Db,
  actor: Actor,
  e: { entityType: string; entityId: string | null; marketplaceId?: string | null; action: string; before?: unknown; after?: unknown },
) {
  await db.query(
    `insert into audit_events (entity_type, entity_id, marketplace_id, action, before, after, signer_name, auth_subject)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.entityType,
      e.entityId,
      e.marketplaceId ?? null,
      e.action,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      actor.signer,
      actor.sub,
    ],
  );
}

/** Only the fields that changed, for compact audit diffs. */
export function diff(before: Record<string, any>, after: Record<string, any>) {
  const b: Record<string, any> = {};
  const a: Record<string, any> = {};
  for (const k of Object.keys(after)) {
    if (["updated_at", "version"].includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}
