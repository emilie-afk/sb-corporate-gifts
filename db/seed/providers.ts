// Seed data from the approved brief (sections 11 and 16).
// Research notes are evidence only — never negotiated commitments. No contacts, prices,
// applications or completed milestones are invented here.

export const DEFAULT_MILESTONES = [
  "Contact established",
  "Requirements confirmed",
  "Products selected",
  "Pricing agreed",
  "Account approved",
  "Listings live",
];

type Req = {
  category: "fulfillment" | "product" | "customization" | "pricing" | "payment" | "technical" | "other";
  requirement: string;
  response?: string;
  state: "unverified" | "awaiting_clarification";
  source: string;
};

export type ProviderSeed = {
  name: string;
  providerType: "marketplace" | "supplier_opportunity";
  status: "prospect" | "reconnecting";
  priority: string;
  initialAction: string;
  proposedGifts: string;
  websiteUrl: string;
  routeNote?: string;
  requirements: Req[];
};

export const PROVIDERS: ProviderSeed[] = [
  {
    name: "Reachdesk",
    providerType: "marketplace",
    status: "reconnecting",
    priority: "Reactivate first (previous partner)",
    initialAction: "Reconnect with former contact, refresh gift range and vendor account. Confirm card workflow, plant fulfillment and terms.",
    proposedGifts: "Live to Give Thank You, Birthday, neutral encouragement boxes; compact arrangement; bulk customization separately.",
    websiteUrl: "https://www.reachdesk.com/become-a-vendor",
    routeNote: "Public vendor route lists marketplace@reachdesk.com.",
    requirements: [
      { category: "other", requirement: "Public vendor page advertises onboarding/product support and no complex setup or long-term contracts.", state: "unverified", source: "https://www.reachdesk.com/become-a-vendor" },
      { category: "customization", requirement: "Handwritten card workflow for vendor-fulfilled gifts.", state: "awaiting_clarification", source: "To confirm with former contact" },
      { category: "fulfillment", requirement: "Live plant fulfillment terms.", state: "awaiting_clarification", source: "To confirm with former contact" },
    ],
  },
  {
    name: "Postal.io / Postal",
    providerType: "marketplace",
    status: "reconnecting",
    priority: "Reactivate first (previous partner)",
    initialAction: "Reconnect with former contact and confirm current account/contracting process.",
    proposedGifts: "Live to Give Thank You and Birthday boxes; compact arrangement; air-plant gift.",
    websiteUrl: "https://www.postal.com/become-a-vendor",
    requirements: [
      { category: "technical", requirement: "Public vendor page advertises onboarding support, no required technical integration, and no long-term commitment.", state: "unverified", source: "https://www.postal.com/become-a-vendor" },
      { category: "other", requirement: "Current account / contracting process.", state: "awaiting_clarification", source: "To confirm with former contact" },
    ],
  },
  {
    name: "CorporateGift.com",
    providerType: "marketplace",
    status: "prospect",
    priority: "First new application",
    initialAction: "Apply with standard gifts plus separate corporate MOQ-10/bulk offers.",
    proposedGifts: "Live to Give boxes, arrangements, plant-only bulk gifts; available custom pots (pots only) and watering cans; custom pots with succulents as a complete gift for bulk orders only.",
    websiteUrl: "https://corporategift.com/become-a-supplier/",
    requirements: [
      { category: "other", requirement: "Public supplier application exists; a customized succulent listing establishes the category.", state: "unverified", source: "https://corporategift.com/become-a-supplier/" },
      { category: "pricing", requirement: "Detailed commercial terms.", state: "awaiting_clarification", source: "Not publicly available — needs confirmation" },
    ],
  },
  {
    name: "Goody",
    providerType: "marketplace",
    status: "prospect",
    priority: "First new application",
    initialAction: "Submit focused individual-gift assortment and confirm handwritten-message transfer.",
    proposedGifts: "Live to Give Thank You, Birthday and neutral encouragement boxes; compact plant gift.",
    websiteUrl: "https://www.ongoody.com/partner",
    requirements: [
      { category: "product", requirement: "Public brand-partner route; Grow by Gifting succulent listings establish category relevance.", state: "unverified", source: "https://www.ongoody.com/partner" },
      { category: "customization", requirement: "Transfer of handwritten gift messages to the vendor.", state: "awaiting_clarification", source: "To confirm with Goody" },
    ],
  },
  {
    name: "Snappy",
    providerType: "marketplace",
    status: "prospect",
    priority: "Conditional on SLA",
    initialAction: "Confirm selected gifts can dispatch within 1–3 business days before applying.",
    proposedGifts: "Reliably stocked individual Live to Give boxes; handwritten cards only if supported within SLA.",
    websiteUrl: "https://www.snappy.com/partner-program",
    requirements: [
      { category: "pricing", requirement: "Published wholesale dropship model.", state: "unverified", source: "https://www.snappy.com/partner-program" },
      { category: "fulfillment", requirement: "No backorders.", state: "unverified", source: "https://www.snappy.com/partner-program" },
      { category: "fulfillment", requirement: "Dispatch within 1–3 business days.", response: "Reviewed SB gift page showed 3–5 business-day processing — fulfillment readiness needs checking.", state: "unverified", source: "https://www.snappy.com/partner-program" },
      { category: "fulfillment", requirement: "Delivery within 14 calendar days.", state: "unverified", source: "https://www.snappy.com/partner-program" },
      { category: "technical", requirement: "Tracking required; integration via API, Shopify, Magento or manual.", state: "unverified", source: "https://www.snappy.com/partner-program" },
    ],
  },
  {
    name: "Loop & Tie",
    providerType: "marketplace",
    status: "prospect",
    priority: "Next round",
    initialAction: "Ask about live-plant eligibility and vendor-direct shipping.",
    proposedGifts: "Neutral Live to Give box, compact arrangement, air-plant gift.",
    websiteUrl: "https://www.loopandtie.com/become-a-vendor",
    requirements: [
      { category: "other", requirement: "Public vendor route; curated small-business positioning.", state: "unverified", source: "https://www.loopandtie.com/become-a-vendor" },
      { category: "product", requirement: "Live-plant approval.", state: "awaiting_clarification", source: "Unverified — ask Loop & Tie" },
      { category: "fulfillment", requirement: "Vendor-direct shipping terms.", state: "awaiting_clarification", source: "Unverified — ask Loop & Tie" },
    ],
  },
  {
    name: "Teak & Twine",
    providerType: "supplier_opportunity",
    status: "prospect",
    priority: "Secondary",
    initialAction: "Pitch plants for custom projects and confirm packing/fulfillment arrangements.",
    proposedGifts: "Arrangements, air-plant sets, customized bulk plant gifts; available pots (pots only) and watering cans; custom pots with succulents as a complete gift for bulk orders only.",
    websiteUrl: "https://www.teakandtwine.com/corporate-gifting",
    requirements: [
      { category: "other", requirement: "Custom gifting services (publicly listed).", state: "unverified", source: "https://www.teakandtwine.com/corporate-gifting" },
      { category: "product", requirement: "Open supplier intake and plant sourcing needs.", state: "awaiting_clarification", source: "Unverified" },
      { category: "fulfillment", requirement: "Packing / fulfillment arrangements for supplied plants.", state: "awaiting_clarification", source: "To confirm with Teak & Twine" },
    ],
  },
  {
    name: "Packed with Purpose",
    providerType: "supplier_opportunity",
    status: "prospect",
    priority: "Conditional",
    initialAction: "Check documented impact qualification and plant acceptance before pitching.",
    proposedGifts: "Plant gifts only if qualification and fulfillment fit.",
    websiteUrl: "https://packedwithpurpose.gifts/",
    requirements: [
      { category: "other", requirement: "Impact Partner route exists; plants alone do not establish impact eligibility.", state: "awaiting_clarification", source: "https://packedwithpurpose.gifts/" },
      { category: "product", requirement: "Plant acceptance.", state: "awaiting_clarification", source: "Unverified" },
    ],
  },
];

// Website products referenced in the brief (section 22). IDs verified against the public
// succulentsbox.com catalog on 2026-10-09; the website refresh keeps them current.
// Team-confirmed: custom pots and watering cans are Available (2026-10-09).
export const SEED_PRODUCTS = [
  {
    shopifyProductId: 10320783737006,
    variants: [{ id: 50527104991406, title: "Black", sku: "CC-WC-PLANT-LOVER-BL", price: 4500 }],
    name: "Watering Can - Plant Lover",
    handle: "watering-can-plant-lover",
    family: "watering_can",
    plantsIncluded: "no",
    individual: "unknown",
    customizationNote: "Exact customization, MOQ, card eligibility and fulfillment terms are offer-specific — confirm per offer.",
  },
  {
    shopifyProductId: 15405481099438,
    variants: [
      { id: 67649360036014, title: "5-Pack / No Plant", sku: "CC-PPOT-COFAVOR-SUCCESS-5", price: 6740 },
      { id: 67649360068782, title: "5-Pack / With Succulent", sku: "CC-PPOT-COFAVOR-SUCCESS-5-SUCC", price: 8990 },
      { id: 67649360101550, title: "10-Pack / No Plant", sku: "CC-PPOT-COFAVOR-SUCCESS-10", price: 13480 },
      { id: 67649360134318, title: "10-Pack / With Succulent", sku: "CC-PPOT-COFAVOR-SUCCESS-10-SUCC", price: 17980 },
    ],
    name: "Pack of Personalized Succulent Pot for Corporate Favor - Rooted In Success",
    handle: "pack-of-personalized-succulent-pot-for-corporate-favor-rooted-in-success",
    family: "by_variant",
  },
] as const;
