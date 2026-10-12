// Team-defined Shopify channel matching. Case-insensitive, whitespace-normalised, exact or contains.
// No regex. Several rules may point at one channel; matches for different channels are a conflict.
// The first matching rule is never silently chosen.

export type MatchField = "source" | "tags" | "billing_company";
export type Rule = { id: string; channel_id: string; source_field: MatchField; operator: "equals" | "contains"; match_value: string; enabled: boolean };
export type MatchFields = { source?: string | null; tags?: string[] | null; billing_company?: string | null };
export type RuleResult = { status: "assigned" | "unclassified" | "conflict"; channel_id: string | null; conflict_channel_ids: string[]; rule_ids: string[]; values: string[] };

export const normalize = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function valuesOf(f: MatchFields, field: MatchField): string[] {
  if (field === "tags") return (f.tags ?? []).map(normalize).filter(Boolean);
  const v = field === "source" ? f.source : f.billing_company;
  const n = normalize(v);
  return n ? [n] : [];
}

/** The matched field value (normalised), or null. */
export function ruleMatch(rule: Rule, f: MatchFields): string | null {
  const want = normalize(rule.match_value);
  if (!want) return null;
  for (const v of valuesOf(f, rule.source_field)) {
    if (rule.operator === "equals" ? v === want : v.includes(want)) return v;
  }
  return null;
}

export function classify(f: MatchFields, rules: Rule[]): RuleResult {
  const hits = rules.filter((r) => r.enabled).map((r) => ({ r, v: ruleMatch(r, f) })).filter((x) => x.v !== null);
  const channels = [...new Set(hits.map((h) => h.r.channel_id))];
  return {
    status: channels.length === 0 ? "unclassified" : channels.length === 1 ? "assigned" : "conflict",
    channel_id: channels.length === 1 ? channels[0] : null,
    conflict_channel_ids: channels.length > 1 ? channels.sort() : [],
    rule_ids: hits.map((h) => h.r.id),
    values: [...new Set(hits.map((h) => h.v as string))],
  };
}

/** Effective classification: a manual decision wins over rules until it is explicitly cleared. */
export function effective(o: { manual_state: string | null; manual_channel_id: string | null }, rule: { status: string; channel_id: string | null }) {
  if (o.manual_state === "excluded") return { status: "excluded", channel_id: null as string | null, manual: true };
  if (o.manual_state === "assigned") return { status: "assigned", channel_id: o.manual_channel_id, manual: true };
  return { status: rule.status, channel_id: rule.channel_id, manual: false };
}
