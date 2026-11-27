export const money = (cents: number | null | undefined, unknown = "—") =>
  cents === null || cents === undefined
    ? unknown
    : (cents < 0 ? "−" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234.50" | "1234.5" | "" → cents | null. Returns NaN for invalid input. */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const centsToInput = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Number(v)}%`);
export const date = (d: string | null | undefined) => (d ? d.slice(0, 10) : "—");
export const dateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
export const today = () => new Date().toLocaleDateString("en-CA");

export const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect", contacted: "Contacted", reconnecting: "Reconnecting", preparing_application: "Preparing application", in_discussion: "Discussing",
  application_submitted: "Application submitted", approved: "Approved", setting_up_listings: "Setting up listings", live: "Active",
  on_hold: "On hold", rejected: "Declined", not_qualified: "Not qualified", skipped: "Skipped", inactive: "Inactive",
};
export const STATUSES = Object.keys(STATUS_LABEL);
/** Closed stages: kept out of outreach queues, follow-ups and task suggestions (records and history stay). */
export const INACTIVE = ["on_hold", "rejected", "not_qualified", "skipped", "inactive"];
/** Stage groups (Partners). Several stored stages share a group; the stored value is never changed. */
export const STAGE_GROUP: Record<string, string> = {
  prospect: "prospect", contacted: "contacted", reconnecting: "contacted", in_discussion: "discussing", preparing_application: "discussing",
  application_submitted: "application_submitted", approved: "onboarding", setting_up_listings: "onboarding", live: "active",
  on_hold: "on_hold", rejected: "declined", not_qualified: "declined", skipped: "skipped", inactive: "inactive",
};
export const STAGE_GROUP_LABEL: Record<string, string> = {
  prospect: "Prospect", contacted: "Contacted", discussing: "Discussing", application_submitted: "Application submitted", onboarding: "Onboarding",
  active: "Active", on_hold: "On hold", declined: "Declined", skipped: "Skipped", inactive: "Inactive",
};
/** "Onboarding · Approved" when the stored stage is a more specific step of its group. */
export function stageText(status: string) {
  const g = STAGE_GROUP_LABEL[STAGE_GROUP[status]] ?? status;
  const l = STATUS_LABEL[status] ?? status;
  return g === l ? l : `${g} · ${l}`;
}
export const REASON_LABEL: Record<string, string> = {
  fulfillment_requirement: "Fulfillment requirement", pricing_or_margin: "Pricing or margin", product_fit: "Product fit",
  insurance_or_compliance: "Insurance / compliance requirement", application_rejected: "Application rejected", no_current_demand: "No current demand", partnership_paused: "Partnership paused", other: "Other",
};
export const PROVIDER_LABEL: Record<string, string> = { marketplace: "Marketplace", supplier_opportunity: "Potential supplier opportunity" };
export const SUPPLIER_HELP = "Companies we could supply gifts to for their corporate gifting projects.";
export const CATEGORY_LABEL: Record<string, string> = {
  fulfillment: "Fulfillment", product: "Product", customization: "Customization", pricing: "Pricing", payment: "Payment", technical: "Technical", other: "Other",
};
export const CONFIRM_LABEL: Record<string, string> = { unverified: "Unverified", awaiting_clarification: "Awaiting clarification", confirmed: "Confirmed" };
export const METHOD_LABEL: Record<string, string> = { email: "Email", call: "Call", meeting: "Meeting", portal: "Portal", other: "Other" };
export const PROPOSAL_LABEL: Record<string, string> = { proposed: "Proposed", submitted: "Submitted", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" };
export const OFFER_LABEL: Record<string, string> = { individual: "Individual gift (ships to recipient)", bulk_customized: "Bulk customized offer", bulk: "Bulk offer" };
export const PRICE_STATUS_LABEL: Record<string, string> = { draft: "Draft", proposed: "Proposed", agreed: "Agreed", active: "Active", expired: "Expired" };
export const FORMAT_LABEL: Record<string, string> = {
  individual: "Individual", corporate_separate_addresses: "Corporate — separate addresses",
  bulk_one_location: "Bulk — one location", bulk_multiple_shipments: "Bulk — multiple shipments",
};
export const FAMILY_LABEL: Record<string, string> = {
  live_to_give_box: "Live to Give Gift Box", succulent_arrangement: "Succulent arrangement", airplant_gift_set: "Airplant gift set",
  plant_only: "Plant-only gift", custom_pots: "Custom pots (pots only)", pots_plus_succulents: "Custom pots + succulents — complete gift (bulk only)",
  watering_can: "Watering can", other: "Other",
};
export const TRI_LABEL: Record<string, string> = { yes: "Yes", no: "No", unknown: "Unknown" };
export const AVAIL_LABEL: Record<string, string> = { available: "Available", planned: "Planned", paused: "Paused" };

export const productLabel = (name?: string | null, variant?: string | null) => (variant ? `${name} — ${variant}` : name ?? "");

// ---------------------------------------------------------------- Partners
export const PARTNER_CATEGORY_LABEL: Record<string, string> = {
  corporate_gifting_platforms: "Corporate gifting platforms", retail_marketplaces: "Retail marketplaces & distribution",
  employee_recognition: "Employee recognition & benefits", events_promo: "Events & promotional merchandise", weddings_registries: "Weddings & registries",
  real_estate_mortgage: "Real estate & mortgage", relocation_resident: "Relocation & resident services", sympathy_memorial: "Sympathy & memorial",
  veterinary_pet_memorial: "Veterinary & pet memorial", healthcare_hospital_retail: "Healthcare & hospital retail", caregiving_community: "Caregiving & community support",
  direct_corporate_buyers: "Direct corporate buyers", uncategorized: "Uncategorized",
};
export const CHANNEL_MODEL_LABEL: Record<string, string> = {
  catalog_dropship: "Catalog / dropship distribution", wholesale: "Wholesale", direct_purchasing: "Direct corporate / event purchasing", referral: "Referral",
  employee_discount: "Employee discount", vendor_directory: "Vendor directory / lead generation", integration: "Integration",
};
export const OCCASION_LABEL: Record<string, string> = {
  employee_onboarding: "Employee onboarding", employee_appreciation: "Employee appreciation", work_anniversary: "Work anniversary", client_appreciation: "Client appreciation",
  closing_housewarming: "Closing / housewarming", resident_welcome_renewal: "Resident welcome / renewal", sympathy_memorial: "Sympathy / memorial", get_well: "Get well",
  new_baby: "New baby", events_conferences: "Events / conferences", wedding_favors: "Wedding favors", holiday_gifting: "Holiday gifting", other: "Other",
};
export const PRIORITY_LABEL: Record<string, string> = { a: "A", b: "B", c: "C", not_assessed: "Not assessed" };
export const VIEW_LABEL: [string, string][] = [
  ["follow_ups", "Follow-ups"], ["priority_a", "Priority A"], ["priority_b", "Priority B"], ["active", "Active partners"],
  ["later", "Later"], ["closed", "Skipped / closed"], ["all", "All partners"],
];
export const RESEARCH_LABEL: Record<string, string> = {
  not_researched: "Not researched", route_published: "Published route (no person researched)", contact_needed: "Contact needed",
  responsible_not_identified: "Responsible person not identified", verify_contact: "Contact found — verify current role", contact_identified: "Contact identified",
  no_contact_needed: "No contact needed (self-serve)",
};
export const READINESS_LABEL: Record<string, string> = {
  contact: "Has a contact", route: "Published route only", needed: "Contact needed", not_researched: "Not researched", no_contact_needed: "No contact needed",
};
export const CONTACT_ROLE_LABEL: Record<string, string> = {
  supplier_sourcing: "Supplier sourcing / buyer", relevant_partnerships: "Relevant partnerships", routing: "Routing contact", customer_sales: "Customer sales",
  support: "Support", press: "Press", advertising_only: "Advertising only", historical: "Historical contact", executive_fallback: "Executive fallback",
};
export const VERIFICATION_LABEL: Record<string, string> = { current_verified: "Current role verified", needs_verification: "Verify current role", historical: "Historical evidence", former: "Former — not current" };
export const CONFIDENCE_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
export const PURPOSE_LABEL: Record<string, string> = {
  supplier_application: "Supplier application", partnership: "Partnerships", self_serve_app: "Self-serve app", general_contact: "General contact",
  customer_sales: "Customer sales", support: "Support", press: "Press", portal_admin: "Portal / invoice admin", other: "Other",
};
export const REQ_KIND_LABEL: Record<string, string> = {
  published: "Published requirements", negotiated: "Negotiated terms", ordering_assumption: "Expected ordering patterns (assumptions)",
  open_question: "Unresolved questions", sb_capability: "SB capabilities & gaps",
};
export const SB_READINESS_LABEL: Record<string, string> = { meets: "SB meets", needs_confirmation: "Needs confirmation", cannot_meet: "SB cannot meet", not_applicable: "Not applicable" };
/** The fulfilment capability statement used for every partner. Bulk pricing is a separate matter. */
export const SB_CAPABILITY = "SB can fulfill one gift per order. Partner pricing and fulfillment terms to be agreed separately. Product-specific shipping restrictions apply.";
export const PRODUCT_CONSTRAINTS: [string, string][] = [
  ["Live to Give boxes", "Ship to individual addresses with a handwritten card; no other customization."],
  ["Succulent arrangements and airplant gift sets", "Sold individually; no customization."],
  ["Pots with succulents", "Bulk orders only."],
  ["Pots without plants", "Labelled “no plants included”."],
  ["Custom pots and watering cans", "Specs and lead times need confirmation."],
];
export const NOT_PROMISED = "Not promised: address collection, API integration, international delivery, gift messages, custom packaging or replacements.";
