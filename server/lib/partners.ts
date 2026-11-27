// Partners: companies that buy, sell, promote or distribute Succulents Box gifts (stored in the marketplaces table;
// IDs and API paths are unchanged). Product vendors live in the vendors table and are not partners.
//
// Shared vocabulary for the server: categories, channel models, occasions, priorities, stage groups, research
// states, contact roles, and the saved views of the Partners screen.

export const CATEGORIES = [
  "corporate_gifting_platforms", "retail_marketplaces", "employee_recognition", "events_promo", "weddings_registries",
  "real_estate_mortgage", "relocation_resident", "sympathy_memorial", "veterinary_pet_memorial",
  "healthcare_hospital_retail", "caregiving_community", "direct_corporate_buyers", "uncategorized",
] as const;
export const CHANNEL_MODELS = ["catalog_dropship", "wholesale", "direct_purchasing", "referral", "employee_discount", "vendor_directory", "integration"] as const;
export const OCCASIONS = [
  "employee_onboarding", "employee_appreciation", "work_anniversary", "client_appreciation", "closing_housewarming",
  "resident_welcome_renewal", "sympathy_memorial", "get_well", "new_baby", "events_conferences", "wedding_favors", "holiday_gifting", "other",
] as const;
export const PRIORITIES = ["a", "b", "c", "not_assessed"] as const;
export const RESEARCH_STATES = ["not_researched", "route_published", "contact_needed", "responsible_not_identified", "verify_contact", "contact_identified", "no_contact_needed"] as const;
export const CONTACT_ROLES = ["supplier_sourcing", "relevant_partnerships", "routing", "customer_sales", "support", "press", "advertising_only", "historical", "executive_fallback"] as const;
export const ROLE_VERIFICATION = ["current_verified", "needs_verification", "historical", "former"] as const;
export const APPLICATION_PURPOSES = ["supplier_application", "partnership", "self_serve_app", "general_contact", "customer_sales", "support", "press", "portal_admin", "other"] as const;
export const REQUIREMENT_KINDS = ["published", "negotiated", "ordering_assumption", "open_question", "sb_capability"] as const;
export const SB_READINESS = ["meets", "needs_confirmation", "cannot_meet", "not_applicable"] as const;

/** Contacts that may be offered as the "best contact" for outreach. Historical, advertising-only, press, support
 *  and customer-sales contacts are never presented as the person to approach about supplying gifts. */
export const OUTREACH_ROLES = ["supplier_sourcing", "relevant_partnerships", "routing", "executive_fallback"] as const;

/** Stage groups shown in the app. Every stored status is kept; several map into one group. */
export const STAGE_GROUP: Record<string, string> = {
  prospect: "prospect",
  contacted: "contacted", reconnecting: "contacted",
  in_discussion: "discussing", preparing_application: "discussing",
  application_submitted: "application_submitted",
  approved: "onboarding", setting_up_listings: "onboarding",
  live: "active",
  on_hold: "on_hold",
  rejected: "declined", not_qualified: "declined",
  skipped: "skipped",
  inactive: "inactive",
};
export const STAGE_GROUPS = ["prospect", "contacted", "discussing", "application_submitted", "onboarding", "active", "on_hold", "declined", "skipped", "inactive"] as const;
export const statusesInGroups = (groups: string[]) => Object.entries(STAGE_GROUP).filter(([, g]) => groups.includes(g)).map(([s]) => s);

/** Closed: excluded from outreach queues, follow-ups and task suggestions. The record and its history stay. */
export const CLOSED_STATUSES = ["on_hold", "rejected", "not_qualified", "skipped", "inactive"] as const;
export const isClosed = (s: string) => (CLOSED_STATUSES as readonly string[]).includes(s);
/** Still being pursued (before onboarding). */
export const PURSUIT_STATUSES = ["prospect", "contacted", "reconnecting", "in_discussion", "preparing_application", "application_submitted"] as const;
/** Onboarding or live. */
export const ACTIVE_STATUSES = ["approved", "setting_up_listings", "live"] as const;

export const VIEWS = ["follow_ups", "priority_a", "priority_b", "active", "later", "closed", "all"] as const;
export type View = (typeof VIEWS)[number];

/** SQL condition for a saved view on the partner list row alias y (see PARTNER_SQL in routes/marketplaces). */
export function viewCondition(view: View, push: (v: unknown) => string): string {
  const pursuit = () => push([...PURSUIT_STATUSES]);
  const closed = () => push([...CLOSED_STATUSES]);
  switch (view) {
    case "follow_ups": return `(y.next_due is not null and y.status <> all(${closed()}))`;
    case "priority_a": return `(y.priority = 'a' and y.status = any(${pursuit()}))`;
    case "priority_b": return `(y.priority = 'b' and y.status = any(${pursuit()}))`;
    case "later": return `(y.priority = 'c' and y.status = any(${pursuit()}))`;
    case "active": return `y.status = any(${push([...ACTIVE_STATUSES])})`;
    case "closed": return `y.status = any(${closed()})`;
    case "all": return "true";
  }
}

/** The single SB fulfilment capability statement used in partner records and help. */
export const SB_CAPABILITY = "SB can fulfill one gift per order. Partner pricing and fulfillment terms to be agreed separately. Product-specific shipping restrictions apply.";

/** Normalised company name for matching: case, spacing, punctuation and a trailing legal suffix are ignored.
 *  Text in brackets is kept out ("Example Gifts (formerly Old Name)" → "example gifts"). */
export function partnerKey(name: string): string {
  return name
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/^\s*the\s+/, "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Host of a URL without www., for website evidence only (never enough to merge on its own). */
export function hostKey(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}
