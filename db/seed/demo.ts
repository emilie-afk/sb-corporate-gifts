// FICTIONAL demo data for local development, tests and screenshots only.
// Every name, URL, requirement and product below is invented. Real operational data (partners,
// priorities, proposals, vendors, prices, sheet locations) lives only in the protected database and is
// moved between environments with scripts/private-data.ts — never in this repository.

export { DEFAULT_MILESTONES } from "../../server/lib/milestones";

type Req = {
  category: "fulfillment" | "product" | "customization" | "pricing" | "payment" | "technical" | "other";
  requirement: string;
  response?: string;
  state: "unverified" | "awaiting_clarification";
  source: string;
};

export type DemoProvider = {
  name: string;
  providerType: "marketplace" | "supplier_opportunity";
  status: "prospect" | "reconnecting";
  priority: string;
  initialAction: string;
  description: string;
  websiteUrl: string;
  requirements: Req[];
};

const demoUrl = (slug: string) => `https://example.com/demo/${slug}`;
const req = (category: Req["category"], requirement: string, state: Req["state"] = "unverified", response?: string): Req =>
  ({ category, requirement, state, source: "Fictional demo data", ...(response ? { response } : {}) });

export const DEMO_PROVIDERS: DemoProvider[] = [
  { name: "Demo Market Alpha", providerType: "marketplace", status: "reconnecting", priority: "Demo priority A",
    initialAction: "Demo: reconnect and confirm the vendor account.", description: "Fictional marketplace for local demos.",
    websiteUrl: demoUrl("alpha"), requirements: [req("other", "Demo onboarding requirement."), req("customization", "Demo card workflow question.", "awaiting_clarification"), req("fulfillment", "Demo live-plant shipping question.", "awaiting_clarification")] },
  { name: "Demo Market Bravo", providerType: "marketplace", status: "reconnecting", priority: "Demo priority A",
    initialAction: "Demo: confirm the account process.", description: "Fictional marketplace for local demos.",
    websiteUrl: demoUrl("bravo"), requirements: [req("technical", "Demo integration requirement."), req("other", "Demo contracting question.", "awaiting_clarification")] },
  { name: "Demo Market Charlie", providerType: "marketplace", status: "prospect", priority: "Demo priority B",
    initialAction: "Demo: submit an application.", description: "Fictional marketplace for local demos.",
    websiteUrl: demoUrl("charlie"), requirements: [req("other", "Demo application requirement."), req("pricing", "Demo commercial terms question.", "awaiting_clarification")] },
  { name: "Demo Market Delta", providerType: "marketplace", status: "prospect", priority: "Demo priority B",
    initialAction: "Demo: send a short gift assortment.", description: "Fictional marketplace for local demos.",
    websiteUrl: demoUrl("delta"), requirements: [req("product", "Demo category requirement."), req("customization", "Demo gift-message question.", "awaiting_clarification")] },
  { name: "Demo Market Echo", providerType: "marketplace", status: "prospect", priority: "Demo priority C",
    initialAction: "Demo: check dispatch times first.", description: "Fictional marketplace for local demos.",
    websiteUrl: demoUrl("echo"), requirements: [req("pricing", "Demo wholesale model."), req("fulfillment", "Demo: no backorders."),
      req("fulfillment", "Demo dispatch window.", "unverified", "Demo response: check readiness."), req("fulfillment", "Demo delivery window."), req("technical", "Demo tracking requirement.")] },
  { name: "Demo Market Foxtrot", providerType: "marketplace", status: "prospect", priority: "Demo priority C",
    initialAction: "Demo: ask about plant eligibility.", description: "Fictional marketplace for local demos.",
    websiteUrl: demoUrl("foxtrot"), requirements: [req("other", "Demo positioning note."), req("product", "Demo plant approval question.", "awaiting_clarification"), req("fulfillment", "Demo shipping terms question.", "awaiting_clarification")] },
  { name: "Demo Supplier Golf", providerType: "supplier_opportunity", status: "prospect", priority: "Demo priority D",
    initialAction: "Demo: pitch plants for custom projects.", description: "Fictional supplier opportunity for local demos.",
    websiteUrl: demoUrl("golf"), requirements: [req("other", "Demo custom-project requirement."), req("product", "Demo sourcing question.", "awaiting_clarification"), req("fulfillment", "Demo packing question.", "awaiting_clarification")] },
  { name: "Demo Supplier Hotel", providerType: "supplier_opportunity", status: "prospect", priority: "Demo priority D",
    initialAction: "Demo: check qualification first.", description: "Fictional supplier opportunity for local demos.",
    websiteUrl: demoUrl("hotel"), requirements: [req("other", "Demo qualification question.", "awaiting_clarification"), req("product", "Demo plant acceptance question.", "awaiting_clarification")] },
];

/** Demo channel terms (deliberately NOT the real direct-customer terms). */
export const DEMO_DIRECT_TERMS = { defaultDiscountPct: 15, corporateMoq: 12 };

/** Fictional website products. IDs are in a range no real catalog uses. */
export const DEMO_PRODUCTS = [
  {
    shopifyProductId: 990000000001,
    variants: [{ id: 990000000101, title: "Black", sku: "DEMO-WC-BL", price: 4500 }],
    name: "Demo Watering Can",
    handle: "demo-watering-can",
    family: "watering_can",
    plantsIncluded: "no",
    individual: "unknown",
    customizationNote: "Demo: customization, MOQ, card eligibility and fulfillment are offer-specific.",
  },
  {
    shopifyProductId: 990000000002,
    variants: [
      { id: 990000000201, title: "5-Pack / No Plant", sku: "DEMO-POT-5", price: 6000 },
      { id: 990000000202, title: "5-Pack / With Succulent", sku: "DEMO-POT-5-SUCC", price: 8000 },
      { id: 990000000203, title: "10-Pack / No Plant", sku: "DEMO-POT-10", price: 12000 },
      { id: 990000000204, title: "10-Pack / With Succulent", sku: "DEMO-POT-10-SUCC", price: 16000 },
    ],
    name: "Demo Personalized Pot Pack",
    handle: "demo-personalized-pot-pack",
    family: "by_variant",
  },
] as const;
