// Pricing models — one definition shared by the API, the Excel/CSV import and the screens.
//
//  fixed_supplier  SB receives an agreed amount per gift. Nothing is deducted from it.
//  commission      The marketplace deducts a commission % and/or a fixed fee from a stated basis price.
//  custom          Agreed price + written terms; nothing is calculated automatically.
//  direct          Direct website: the customer pays SB the agreed customer price.
//
// Blank always means unspecified / not applicable — never 0. A "price" without a model is never assumed
// to be what SB earns.

export const PRICING_MODELS = ["fixed_supplier", "commission", "custom", "direct"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];
export const MARKETPLACE_MODELS: PricingModel[] = ["fixed_supplier", "commission", "custom"];

export const MODEL_LABEL: Record<PricingModel, string> = {
  fixed_supplier: "Fixed supplier price",
  commission: "Commission-based",
  custom: "Other / custom terms",
  direct: "Direct sale (website)",
};
export const MODEL_HELP: Record<PricingModel, string> = {
  fixed_supplier: "SB receives an agreed amount per gift. No marketplace commission is deducted from it.",
  commission: "The marketplace sells at a price and deducts a commission % and/or a fixed fee from the commission basis.",
  custom: "Record the agreed price and explain the terms. Nothing is calculated automatically.",
  direct: "The customer pays SB the agreed customer price.",
};
export const BASIS_LABEL: Record<string, string> = {
  selling_price: "Marketplace selling price",
  retail_price: "SB website retail price",
  other: "Other (explained in note)",
};
/** Label of the headline (agreed) price for each model. */
export const HEADLINE_LABEL: Record<string, string> = {
  fixed_supplier: "Agreed supplier price (SB receives)",
  commission: "Marketplace selling price",
  custom: "Agreed price (see terms)",
  direct: "Agreed customer price",
  none: "Agreed price (model not specified)",
};

export type ModelInput = {
  pricing_model?: string | null;
  status?: string | null;
  supplier_price_cents?: number | null;
  selling_price_cents?: number | null;
  agreed_price_cents?: number | null;
  commission_pct?: number | string | null;
  fixed_fee_cents?: number | null;
  commission_basis?: string | null;
  commission_basis_note?: string | null;
  custom_terms?: string | null;
  proposed_supplier_cents?: number | null;
};

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const settled = (s?: string | null) => s === "agreed" || s === "active";

/**
 * Validate the model-specific fields and derive the headline agreed price.
 * Only the fields relevant to the chosen model are required, and only when the price is agreed/active.
 */
export function checkPricingModel(
  r: ModelInput,
  o: { channelType?: string | null; requireModel?: boolean } = {},
): { errors: Record<string, string>; agreedPriceCents: number | null } {
  const errors: Record<string, string> = {};
  const m = r.pricing_model ?? null;
  const isDirectChannel = o.channelType === "direct";
  if (!m) {
    if (o.requireModel || r.status === "proposed" || settled(r.status)) errors.pricing_model = "Choose the pricing model";
    return { errors, agreedPriceCents: r.agreed_price_cents ?? null };
  }
  if (!(PRICING_MODELS as readonly string[]).includes(m)) { errors.pricing_model = "Unknown pricing model"; return { errors, agreedPriceCents: null }; }
  if (o.channelType !== undefined && o.channelType !== null) {
    if (isDirectChannel && m !== "direct") errors.pricing_model = "The direct website uses the Direct sale model";
    if (!isDirectChannel && m === "direct") errors.pricing_model = "Direct sale is only for the direct website — choose a marketplace model";
  }
  const hasCommission = !blank(r.commission_pct) || !blank(r.fixed_fee_cents);
  let agreed: number | null = null;

  if (m === "fixed_supplier") {
    const msg = "A fixed supplier price is already what SB receives — no commission or fee is deducted. Clear this, or choose Other / custom terms.";
    if (!blank(r.commission_pct)) errors.commission_pct = msg;
    if (!blank(r.fixed_fee_cents)) errors.fixed_fee_cents = msg;
    if (!blank(r.commission_basis)) errors.commission_basis = "Commission basis does not apply to a fixed supplier price";
    agreed = r.supplier_price_cents ?? null;
    if (settled(r.status) && agreed == null) errors.supplier_price_cents = "Required: the agreed amount SB receives per gift";
  } else if (m === "commission") {
    if (!blank(r.supplier_price_cents)) errors.supplier_price_cents = "A commission-based price has no supplier price — enter the selling price and the commission";
    agreed = r.selling_price_cents ?? null;
    if (r.commission_basis === "other" && blank(r.commission_basis_note)) errors.commission_basis_note = "Explain what the commission is calculated on";
    if (settled(r.status)) {
      if (agreed == null) errors.selling_price_cents = "Required: the price the marketplace sells at";
      if (blank(r.commission_basis)) errors.commission_basis = "Required: what the commission is calculated on";
      if (!hasCommission) errors.commission_pct = "Enter the commission % and/or fixed fee (0 if there is none)";
    }
  } else if (m === "custom") {
    if (!blank(r.supplier_price_cents)) errors.supplier_price_cents = "Use the agreed price and explain the terms for custom arrangements";
    if (r.commission_basis === "other" && blank(r.commission_basis_note)) errors.commission_basis_note = "Explain what the commission is calculated on";
    agreed = r.agreed_price_cents ?? null;
    if (settled(r.status)) {
      if (agreed == null) errors.agreed_price_cents = "Required: the agreed price";
      if (blank(r.custom_terms)) errors.custom_terms = "Required: explain the additional terms";
    }
  } else {
    for (const k of ["commission_pct", "fixed_fee_cents", "commission_basis", "supplier_price_cents", "selling_price_cents"] as const)
      if (!blank(r[k])) errors[k] = "Does not apply to a direct sale";
    agreed = r.agreed_price_cents ?? null;
    if (settled(r.status) && agreed == null) errors.agreed_price_cents = "Required: the agreed customer price";
  }
  return { errors, agreedPriceCents: agreed };
}

export type Interpretation = {
  model: PricingModel | null;
  modelLabel: string;
  headlineLabel: string;
  headlineCents: number | null;
  /** What SB receives per gift, when it can be stated; null = not calculable (see explanation). */
  sbReceivesCents: number | null;
  basisLabel: string | null;
  basisCents: number | null;
  explanation: string;
  notes: string[];
};

const usd = (c: number | null | undefined) =>
  c == null ? "unknown" : (c < 0 ? "−" : "") + "$" + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Human-readable reading of a price record (or import row). `retailCents` = the retail reference in use. */
export function interpretPricing(r: ModelInput & { retail_ref_cents?: number | null }): Interpretation {
  const m = (r.pricing_model ?? null) as PricingModel | null;
  const notes: string[] = [];
  const pctNum = blank(r.commission_pct) ? null : Number(r.commission_pct);
  const fee = r.fixed_fee_cents ?? null;
  const base = { model: m, modelLabel: m ? MODEL_LABEL[m] : "Model not specified", headlineLabel: HEADLINE_LABEL[m ?? "none"], basisLabel: null as string | null, basisCents: null as number | null };
  if (m === "fixed_supplier") {
    const v = r.supplier_price_cents ?? null;
    if (r.selling_price_cents != null) notes.push(`Marketplace sells at ${usd(r.selling_price_cents)} (informational — not used to calculate what SB receives)`);
    return { ...base, headlineCents: v, sbReceivesCents: v, notes,
      explanation: v == null ? "Supplier price not entered yet" : `SB receives ${usd(v)} per gift. No commission is deducted.` };
  }
  if (m === "commission") {
    const sell = r.selling_price_cents ?? null;
    const basis = r.commission_basis ?? null;
    const basisCents = basis === "selling_price" ? sell : basis === "retail_price" ? r.retail_ref_cents ?? null : null;
    const out = { ...base, headlineCents: sell, basisLabel: basis ? BASIS_LABEL[basis] : null, basisCents };
    if (!basis) return { ...out, sbReceivesCents: null, notes, explanation: "Commission basis not specified — SB's amount can't be calculated" };
    if (basis === "other") return { ...out, sbReceivesCents: null, notes, explanation: `Commission on: ${r.commission_basis_note ?? "other basis"} — not calculated automatically` };
    if (basisCents == null) return { ...out, sbReceivesCents: null, notes, explanation: `${BASIS_LABEL[basis]} unknown — SB's amount can't be calculated` };
    if (pctNum == null && fee == null) return { ...out, sbReceivesCents: null, notes, explanation: "Commission % and fee not specified — SB's amount can't be calculated" };
    const commission = pctNum == null ? 0 : Math.round((basisCents * pctNum) / 100);
    const v = basisCents - commission - (fee ?? 0);
    if (pctNum == null) notes.push("Commission % not specified — only the fixed fee is deducted");
    if (fee == null) notes.push("Fixed fee not specified — only the commission % is deducted");
    if (v < 0) notes.push("Deductions exceed the basis price");
    const parts = [`${BASIS_LABEL[basis]} ${usd(basisCents)}`];
    if (pctNum != null) parts.push(`− ${pctNum}% commission (${usd(commission)})`);
    if (fee != null) parts.push(`− fixed fee ${usd(fee)}`);
    return { ...out, sbReceivesCents: v, notes, explanation: `${parts.join(" ")} = SB receives ${usd(v)}` };
  }
  if (m === "custom") {
    if (pctNum != null || fee != null) notes.push("Commission/fee recorded for reference only — not deducted automatically");
    return { ...base, headlineCents: r.agreed_price_cents ?? null, sbReceivesCents: null, notes,
      explanation: r.custom_terms ? `Custom terms: ${r.custom_terms}` : "Custom terms not described yet" };
  }
  if (m === "direct") {
    const v = r.agreed_price_cents ?? null;
    return { ...base, headlineCents: v, sbReceivesCents: v, notes, explanation: v == null ? "Customer price not agreed yet" : `Customer pays SB ${usd(v)}` };
  }
  return { ...base, headlineCents: r.agreed_price_cents ?? null, sbReceivesCents: null, notes,
    explanation: "Older record without a pricing model — the agreed price's meaning was not recorded. Revise it to choose a model." };
}
