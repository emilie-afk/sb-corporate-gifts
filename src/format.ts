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
  prospect: "Prospect", reconnecting: "Reconnecting", preparing_application: "Preparing application", in_discussion: "In discussion",
  application_submitted: "Application submitted", approved: "Approved", setting_up_listings: "Setting up listings", live: "Live",
  on_hold: "On hold", rejected: "Rejected", not_qualified: "Not qualified", inactive: "Inactive",
};
export const STATUSES = Object.keys(STATUS_LABEL);
export const INACTIVE = ["on_hold", "rejected", "not_qualified", "inactive"];
export const REASON_LABEL: Record<string, string> = {
  fulfillment_requirement: "Fulfillment requirement", pricing_or_margin: "Pricing or margin", product_fit: "Product fit",
  application_rejected: "Application rejected", no_current_demand: "No current demand", partnership_paused: "Partnership paused", other: "Other",
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
  plant_only: "Plant-only gift", custom_pots: "Custom pots (pots only)", pots_plus_succulents: "Custom pots + succulents (bulk only)",
  watering_can: "Watering can", other: "Other",
};
export const TRI_LABEL: Record<string, string> = { yes: "Yes", no: "No", unknown: "Unknown" };
export const AVAIL_LABEL: Record<string, string> = { available: "Available", planned: "Planned", paused: "Paused" };

export const productLabel = (name?: string | null, variant?: string | null) => (variant ? `${name} — ${variant}` : name ?? "");
