import { useEffect, useState, type FormEvent } from "react";
import { get, post, patch, qs } from "../api";
import { Field, Select, SignerField, FormActions, ErrorBox, Overlay, Pill, useSave, useSigner, rememberSigner } from "../components/ui";
import { ProductPicker, type ProductLite } from "../components/ProductPicker";
import { money, parseMoney, centsToInput, pct, dateTime, today, productLabel, FORMAT_LABEL } from "../format";
import { checkPricingModel, interpretPricing, MODEL_LABEL, MODEL_HELP, BASIS_LABEL, MARKETPLACE_MODELS, type PricingModel } from "../../shared/pricingModel";

type Mode = { kind: "create" } | { kind: "edit"; rec: any } | { kind: "revise"; rec: any };
type OverrideState = { on: boolean; amount: string; reason: string; source: string; date: string };

const MAIN_MONEY = ["proposed_supplier_cents", "supplier_price_cents", "selling_price_cents", "agreed_price_cents", "customer_shipping_cents", "fixed_fee_cents"] as const;
/** Fields each model uses; everything else is sent as blank so nothing from another model lingers. */
const MODEL_FIELDS: Record<PricingModel, string[]> = {
  fixed_supplier: ["supplier_price_cents", "selling_price_cents", "proposed_supplier_cents"],
  commission: ["selling_price_cents", "commission_pct", "fixed_fee_cents", "commission_basis", "commission_basis_note"],
  custom: ["agreed_price_cents", "custom_terms", "selling_price_cents", "proposed_supplier_cents", "commission_pct", "fixed_fee_cents", "commission_basis", "commission_basis_note"],
  direct: ["agreed_price_cents"],
};
const MODEL_KEYS = ["supplier_price_cents", "selling_price_cents", "agreed_price_cents", "proposed_supplier_cents", "commission_pct", "fixed_fee_cents", "commission_basis", "commission_basis_note", "custom_terms"];
const MORE_MONEY = ["expected_shipping_cents", "extra_cost_cents"] as const;

function initialOverride(rec: any, kind: "retail" | "cost"): OverrideState {
  const src = rec?.[`${kind}_source`];
  const det = rec?.[`${kind}_source_detail`] ?? {};
  const cents = kind === "retail" ? rec?.retail_ref_cents : rec?.internal_cost_cents;
  return src === "manual"
    ? { on: true, amount: centsToInput(cents), reason: det.reason ?? "", source: det.source ?? "", date: det.date ?? today() }
    : { on: false, amount: "", reason: "", source: "", date: today() };
}

/** Source-backed reference value with an explicit manual override. Unknown stays unknown. */
function ReferenceBox({ title, value, sourceLine, extra, ov, setOv, fe }: {
  title: string; value: number | null | undefined; sourceLine: React.ReactNode; extra?: React.ReactNode;
  ov: OverrideState; setOv: (o: OverrideState) => void; fe: (k: string) => string | undefined;
}) {
  return (
    <div className="ref-box wide">
      <div className="ref-head">
        <span className="label">{title}</span>
        {ov.on ? <Pill tone="warn">Manual value</Pill> : value == null ? <Pill tone="neutral">Unknown</Pill> : <Pill tone="info">From source</Pill>}
      </div>
      {!ov.on && (
        <div className="ref-value">
          <strong>{value == null ? "Unknown — not available from the source" : money(value)}</strong>
          <div className="hint">{sourceLine}</div>
          {extra}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={ov.on} onChange={(e) => setOv({ ...ov, on: e.target.checked })} /> Enter a manual value instead</label>
      {ov.on && (
        <div className="ref-manual">
          <Field label="Manual amount (USD)" required error={fe("amount")}><input inputMode="decimal" value={ov.amount} onChange={(e) => setOv({ ...ov, amount: e.target.value })} /></Field>
          <Field label="Value date" required error={fe("date")}><input type="date" value={ov.date} onChange={(e) => setOv({ ...ov, date: e.target.value })} /></Field>
          <Field label="Reason" required wide error={fe("reason")}><input value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} placeholder="Why the source value isn't used" /></Field>
          <Field label="Source" required wide error={fe("source")}><input value={ov.source} onChange={(e) => setOv({ ...ov, source: e.target.value })} placeholder="e.g. vendor quote, email, invoice" /></Field>
        </div>
      )}
    </div>
  );
}

export function PricingForm({ channels, defaultChannel, mode = { kind: "create" }, onClose, onSaved }: {
  channels: any[]; defaultChannel?: string; mode?: Mode; onClose: () => void; onSaved: () => void;
}) {
  const rec = mode.kind === "create" ? null : mode.rec;
  const [channelId, setChannelId] = useState<string>(rec?.channel_id ?? defaultChannel ?? "");
  const [product, setProduct] = useState<ProductLite | null>(rec ? ({ id: rec.product_id, name: rec.product_name, variant: rec.product_variant, family: rec.product_family } as any) : null);
  const [refs, setRefs] = useState<any | null>(null);
  const [refsErr, setRefsErr] = useState<string | null>(null);
  const [m, setM] = useState<Record<string, string>>(() => Object.fromEntries([...MAIN_MONEY, ...MORE_MONEY].map((k) => [k, centsToInput(rec?.[k])])));
  const [f, setF] = useState({
    status: mode.kind === "edit" ? rec.status : "draft",
    customer_discount_pct: rec?.customer_discount_pct == null ? "" : String(rec.customer_discount_pct),
    commission_pct: rec?.commission_pct == null ? "" : String(rec.commission_pct),
    pricing_model: (rec?.pricing_model ?? "") as PricingModel | "",
    commission_basis: rec?.commission_basis ?? "", commission_basis_note: rec?.commission_basis_note ?? "", custom_terms: rec?.custom_terms ?? "",
    moq: rec?.moq == null ? "" : String(rec.moq),
    fulfillment_format: rec?.fulfillment_format ?? "individual",
    cost_inclusions_note: rec?.cost_inclusions_note ?? "", pricing_basis_note: rec?.pricing_basis_note ?? "",
    shipping_responsibility: rec?.shipping_responsibility ?? "", payment_terms: rec?.payment_terms ?? "",
    dispatch_requirement: rec?.dispatch_requirement ?? "", agreement_notes: rec?.agreement_notes ?? "",
    effective_from: mode.kind === "revise" ? "" : rec?.effective_from ?? "", effective_to: mode.kind === "revise" ? "" : rec?.effective_to ?? "",
    evidence_ref: rec?.evidence_ref ?? "", approved_by: mode.kind === "edit" ? rec?.approved_by ?? "" : "",
  });
  const [retailOv, setRetailOv] = useState<OverrideState>(() => initialOverride(rec, "retail"));
  const [costOv, setCostOv] = useState<OverrideState>(() => initialOverride(rec, "cost"));
  const [more, setMore] = useState(false);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const [localErr, setLocalErr] = useState<Record<string, string>>({});

  useEffect(() => {
    setRefs(null); setRefsErr(null);
    if (!product?.id) return;
    get(`/pricing/references${qs({ product_id: product.id, channel_id: channelId })}`)
      .then((r) => {
        setRefs(r.references);
        // Channel defaults pre-fill empty fields only (visible and editable).
        const c = r.references.channel;
        if (c && mode.kind === "create") {
          setF((x) => ({
            ...x,
            moq: x.moq || (c.corporate_moq && x.fulfillment_format !== "individual" ? String(c.corporate_moq) : x.moq),
            customer_discount_pct: c.type === "direct" && !x.customer_discount_pct && c.default_discount_pct != null ? String(c.default_discount_pct) : x.customer_discount_pct,
          }));
        }
      })
      .catch((e) => setRefsErr(e.message));
  }, [product?.id, channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const ch = channels.find((c) => c.id === channelId);
  const isDirect = ch?.type === "direct";
  const model: PricingModel | "" = isDirect ? "direct" : f.pricing_model === "direct" ? "" : f.pricing_model;
  const uses = (k: string) => !!model && MODEL_FIELDS[model].includes(k);
  const live = (() => {
    const c = (k: string) => { const v = parseMoney(m[k] ?? ""); return v == null || Number.isNaN(v) ? null : v; };
    const p = f.commission_pct === "" ? null : Number(f.commission_pct);
    return interpretPricing({
      pricing_model: model || null, supplier_price_cents: c("supplier_price_cents"), selling_price_cents: c("selling_price_cents"),
      agreed_price_cents: c("agreed_price_cents"), commission_pct: p == null || Number.isNaN(p) ? null : p, fixed_fee_cents: uses("fixed_fee_cents") ? c("fixed_fee_cents") : null,
      commission_basis: f.commission_basis || null, commission_basis_note: f.commission_basis_note, custom_terms: f.custom_terms,
      retail_ref_cents: retailOv.on ? parseMoney(retailOv.amount) : refs?.retail?.cents ?? null,
    });
  })();
  const bulkOnly = product?.family === "pots_plus_succulents";
  const formats = Object.entries(FORMAT_LABEL).filter(([k]) => !(bulkOnly && (k === "individual" || k === "corporate_separate_addresses")));
  const retailNow = retailOv.on ? parseMoney(retailOv.amount) : refs?.retail?.cents ?? null;
  const disc = f.customer_discount_pct === "" ? null : Number(f.customer_discount_pct);
  const suggested = isDirect && retailNow != null && !Number.isNaN(retailNow) && disc != null && !Number.isNaN(disc) ? Math.round(retailNow * (1 - disc / 100)) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const body: Record<string, any> = {};
    for (const k of [...MAIN_MONEY, ...MORE_MONEY]) {
      const v = parseMoney(m[k]);
      if (Number.isNaN(v)) errs[k] = "Enter an amount like 12.50, or leave blank if unknown";
      body[k] = v;
    }
    const num = (k: "customer_discount_pct" | "commission_pct" | "moq") => (f[k] === "" ? null : Number(f[k]));
    for (const k of ["customer_discount_pct", "commission_pct"] as const) { const v = num(k); if (v !== null && (Number.isNaN(v) || v < 0 || v > 100)) errs[k] = "0–100"; }
    const moq = num("moq");
    if (moq !== null && (!Number.isInteger(moq) || moq < 1)) errs.moq = "Whole number ≥ 1";
    if (!model) errs.pricing_model = "Choose how this marketplace pays SB";
    if (f.status === "agreed" && !f.approved_by.trim()) errs.approved_by = "Required for an agreed price";
    // Only the chosen model's fields are sent; the others are cleared (blank = not applicable).
    const modelBody: Record<string, any> = {};
    for (const k of MODEL_KEYS) {
      if (!model || !MODEL_FIELDS[model].includes(k)) { modelBody[k] = null; continue; }
      modelBody[k] = k in body ? body[k] : k === "commission_pct" ? num("commission_pct") : (f as any)[k] || null;
    }
    if (model === "commission" && modelBody.commission_basis !== "other") modelBody.commission_basis_note = null;
    if (model) Object.assign(errs, checkPricingModel({ ...modelBody, pricing_model: model, status: f.status }, { channelType: ch?.type }).errors);
    const ov = (o: OverrideState, prefix: string) => {
      if (!o.on) return null;
      const c = parseMoney(o.amount);
      if (c == null || Number.isNaN(c)) errs[`${prefix}.amount`] = "Enter the manual amount";
      if (!o.reason.trim()) errs[`${prefix}.reason`] = "Reason required";
      if (!o.source.trim()) errs[`${prefix}.source`] = "Source required";
      if (!o.date) errs[`${prefix}.date`] = "Date required";
      return { cents: c, reason: o.reason.trim(), source: o.source.trim(), date: o.date };
    };
    const retail_override = ov(retailOv, "retail"), cost_override = ov(costOv, "cost");
    setLocalErr(errs);
    if (Object.keys(errs).length) { if (Object.keys(errs).some((k) => MORE_MONEY.includes(k as any))) setMore(true); return; }
    Object.assign(body, modelBody, { pricing_model: model });
    Object.assign(body, {
      customer_discount_pct: isDirect ? num("customer_discount_pct") : null, moq,
      fulfillment_format: f.fulfillment_format, cost_inclusions_note: f.cost_inclusions_note, pricing_basis_note: f.pricing_basis_note,
      shipping_responsibility: f.shipping_responsibility, payment_terms: f.payment_terms, dispatch_requirement: f.dispatch_requirement,
      agreement_notes: f.agreement_notes, effective_from: f.effective_from || null, effective_to: f.effective_to || null,
      evidence_ref: f.evidence_ref, approved_by: f.approved_by, signer_name: signer, retail_override, cost_override,
    });
    const ok = await s.run(async () => {
      if (mode.kind === "create") await post("/pricing", { ...body, channel_id: channelId, product_id: product?.id, status: f.status });
      else if (mode.kind === "edit") await patch(`/pricing/${rec.id}`, { ...body, status: f.status, version: rec.version });
      else {
        const created = await post(`/pricing/${rec.id}/revisions`, body);
        if (f.status !== "draft") await patch(`/pricing/${created.record.id}`, { status: f.status, version: created.record.version, signer_name: signer, approved_by: f.approved_by });
      }
    });
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const fe = (k: string) => localErr[k] ?? s.fe(k);
  const moneyField = (k: string, label: string, hint?: string) => (
    <Field label={label} error={fe(k)} hint={hint}>
      <input inputMode="decimal" value={m[k]} placeholder="Unknown" onChange={(e) => setM({ ...m, [k]: e.target.value })} />
    </Field>
  );
  const title = mode.kind === "create" ? "Add pricing record" : mode.kind === "edit" ? "Edit price (draft/proposed)" : "Revise price — new version";
  const cost = refs?.cost;
  const terms = refs?.channel;

  return (
    <Overlay kind="modal" title={title} subtitle={mode.kind === "revise" ? "Creates a new dated version. The previous version stays unchanged." : undefined} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {Object.keys(localErr).length > 0 && <div className="alert error wide">Please fix the highlighted fields.</div>}
        <Field label="Channel" required error={fe("channel_id")}>
          <Select value={channelId} onChange={setChannelId} empty="Choose…" disabled={mode.kind !== "create"} options={channels.map((c) => [c.id, c.name])} />
        </Field>
        <Field label="Status" required hint="Agreed and active versions become immutable.">
          <Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[["draft", "Draft"], ["proposed", "Proposed"], ["agreed", "Agreed"]]} />
        </Field>
        <Field label="Gift / variant" required wide error={fe("product_id")}>
          {mode.kind === "create" ? <ProductPicker value={product} onChange={setProduct} selectedOnly /> : <strong>{productLabel(product?.name, product?.variant)}</strong>}
        </Field>
        {bulkOnly && <div className="alert warn wide">Pots with succulents: complete gift, bulk orders only. Individual recipient shipping is unavailable, so individual and separate-address fulfillment cannot be priced.</div>}

        {product && (
          <>
            {refsErr && <div className="alert error wide">Could not load reference values: {refsErr}</div>}
            <ReferenceBox title="Retail reference price" value={refs?.retail?.cents} ov={retailOv} setOv={setRetailOv} fe={(k) => fe(`retail.${k}`)}
              sourceLine={refs?.retail ? <>Website (Shopify) · {refs.retail.refreshed_at ? `refreshed ${dateTime(refs.retail.refreshed_at)}` : "not yet refreshed from the website"}</> : "No website price recorded for this gift."} />
            <ReferenceBox title="Internal gift cost" value={cost?.cents} ov={costOv} setOv={setCostOv} fe={(k) => fe(`cost.${k}`)}
              sourceLine={cost ? <>Product Master · confirmed {dateTime(cost.refreshed_at)} by {cost.confirmed_by}</> : "No confirmed Product Master cost — map this gift and refresh costs."}
              extra={cost && (
                <ul className="ref-components">
                  {cost.components.map((c: any, i: number) => (
                    <li key={i}>{c.label ? `${c.label}: ` : ""}{c.vendor} / {c.tab} — {c.basis === "per_piece" ? `$${c.source_cost} per piece × ${c.quantity}` : `$${c.source_cost} complete pack`}{c.includes ? ` · includes: ${c.includes}` : ""}</li>
                  ))}
                </ul>
              )} />
          </>
        )}

        <Field label="Fulfillment format" required error={fe("fulfillment_format")} hint="Bulk multiple shipments = one bulk order in several shipments, not gifts sent to individual recipients.">
          <Select value={f.fulfillment_format} onChange={(v) => setF({ ...f, fulfillment_format: v })} options={formats} />
        </Field>
        <Field label="MOQ" error={fe("moq")} hint={terms?.corporate_moq ? `Channel default: ${terms.corporate_moq} (corporate orders; not a blanket rule for individual gifts).` : undefined}>
          <input inputMode="numeric" value={f.moq} placeholder="Unknown" onChange={(e) => setF({ ...f, moq: e.target.value })} />
        </Field>
        {isDirect && (
          <>
            <Field label="Customer discount %" error={fe("customer_discount_pct")} hint={terms?.default_discount_pct != null ? `Current direct-customer discount: ${pct(terms.default_discount_pct)}` : undefined}>
              <input inputMode="decimal" value={f.customer_discount_pct} placeholder="Unknown" onChange={(e) => setF({ ...f, customer_discount_pct: e.target.value })} />
            </Field>
            <div className="calc wide">
              Suggested customer price (calculated: retail × (1 − discount)): <strong>{suggested == null ? "—" : money(suggested)}</strong>
              {suggested != null && <button type="button" className="btn ghost small" onClick={() => setM({ ...m, agreed_price_cents: centsToInput(suggested) })}>Copy into agreed customer price</button>}
              <div className="hint">A suggestion for Direct website only. It never sets marketplace prices and is stored only when you save it as the agreed price.</div>
            </div>
          </>
        )}
        {!isDirect && (
          <fieldset className="model-pick wide" aria-describedby="model-help">
            <legend>How this marketplace pays SB <span className="req">*</span></legend>
            {MARKETPLACE_MODELS.map((k) => (
              <label key={k} className={`model-option${f.pricing_model === k ? " on" : ""}`}>
                <input type="radio" name="pricing_model" value={k} checked={f.pricing_model === k} onChange={() => setF({ ...f, pricing_model: k })} />
                <strong>{MODEL_LABEL[k]}</strong>
                <span className="hint">{MODEL_HELP[k]}</span>
              </label>
            ))}
            {fe("pricing_model") && <div className="field-error" id="model-help">{fe("pricing_model")}</div>}
            {terms?.fee_note && <div className="hint">Channel fee terms on file: {terms.fee_note}</div>}
          </fieldset>
        )}
        {model === "fixed_supplier" && (
          <>
            {moneyField("supplier_price_cents", "Agreed supplier price — SB receives per gift", f.status === "agreed" ? "Required. Nothing is deducted from this amount." : "Nothing is deducted from this amount. Blank = not agreed yet.")}
            {moneyField("proposed_supplier_cents", "Proposed supplier price (SB's offer)")}
            {moneyField("selling_price_cents", "Marketplace selling price (optional)", "What the marketplace charges its customer — for reference only, never used to reduce SB's amount.")}
          </>
        )}
        {model === "commission" && (
          <>
            {moneyField("selling_price_cents", "Marketplace selling price", f.status === "agreed" ? "Required: what the marketplace's customer pays." : "What the marketplace's customer pays.")}
            <Field label="Commission is calculated on" required={f.status === "agreed"} error={fe("commission_basis")}>
              <Select value={f.commission_basis} onChange={(v) => setF({ ...f, commission_basis: v })} empty="Not specified" options={Object.entries(BASIS_LABEL)} />
            </Field>
            {f.commission_basis === "other" && (
              <Field label="Commission basis — explain" required wide error={fe("commission_basis_note")}><input value={f.commission_basis_note} onChange={(e) => setF({ ...f, commission_basis_note: e.target.value })} /></Field>
            )}
            <Field label="Commission % (optional)" error={fe("commission_pct")} hint="Blank = not specified (never assumed 0%). Enter 0 if there is none.">
              <input inputMode="decimal" value={f.commission_pct} placeholder="Not specified" onChange={(e) => setF({ ...f, commission_pct: e.target.value })} />
            </Field>
            {moneyField("fixed_fee_cents", "Fixed fee per unit (optional)", "Blank = not specified.")}
          </>
        )}
        {model === "custom" && (
          <>
            {moneyField("agreed_price_cents", "Agreed price", f.status === "agreed" ? "Required." : undefined)}
            <Field label="Custom terms" required={f.status === "agreed"} wide error={fe("custom_terms")} hint="Explain how SB is paid (rebates, tiers, minimums…). Nothing is calculated automatically.">
              <textarea rows={2} value={f.custom_terms} onChange={(e) => setF({ ...f, custom_terms: e.target.value })} />
            </Field>
            {moneyField("selling_price_cents", "Marketplace selling price (optional)")}
            <Field label="Commission % (optional, reference only)" error={fe("commission_pct")}>
              <input inputMode="decimal" value={f.commission_pct} placeholder="Not specified" onChange={(e) => setF({ ...f, commission_pct: e.target.value })} />
            </Field>
            {moneyField("fixed_fee_cents", "Fixed fee per unit (optional, reference only)")}
          </>
        )}
        {model === "direct" && moneyField("agreed_price_cents", "Agreed customer price", f.status === "agreed" ? "Required." : undefined)}
        {model && (
          <div className="calc wide interpret" aria-live="polite">
            <span className="label">{live.modelLabel}</span> — {live.sbReceivesCents != null ? <>SB receives <strong>{money(live.sbReceivesCents)}</strong> per gift</> : <strong>SB's amount not calculated</strong>}
            <div className="hint">{live.explanation}</div>
            {live.notes.map((n, i) => <div key={i} className="hint">{n}</div>)}
          </div>
        )}
        {moneyField("customer_shipping_cents", "Customer shipping charge")}
        <Field label="Effective from" error={fe("effective_from")}><input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
        <Field label="Effective to" error={fe("effective_to")}><input type="date" value={f.effective_to} onChange={(e) => setF({ ...f, effective_to: e.target.value })} /></Field>
        {f.status === "agreed" && <Field label="Approved by" required error={fe("approved_by")}><input value={f.approved_by} onChange={(e) => setF({ ...f, approved_by: e.target.value })} maxLength={80} /></Field>}

        <button type="button" className="btn ghost small wide-left" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "▾" : "▸"} More details</button>
        {more && (
          <>
            {moneyField("expected_shipping_cents", "Expected shipping cost")}
            {moneyField("extra_cost_cents", "Card / handling / customization cost")}
            <Field label="What the gift cost already includes" wide hint="Avoid double counting: e.g. ‘includes handwritten card’. Filled from Product Master when recorded there.">
              <input value={f.cost_inclusions_note} onChange={(e) => setF({ ...f, cost_inclusions_note: e.target.value })} placeholder={cost?.includes ?? ""} />
            </Field>
            <Field label="Payment terms" hint={terms?.payment_terms ? `Channel default: ${terms.payment_terms}` : "Blank = channel common terms / unspecified"}><input value={f.payment_terms} onChange={(e) => setF({ ...f, payment_terms: e.target.value })} /></Field>
            <Field label="Shipping responsibility" hint={terms?.shipping_responsibility ? `Channel default: ${terms.shipping_responsibility}` : undefined}><input value={f.shipping_responsibility} onChange={(e) => setF({ ...f, shipping_responsibility: e.target.value })} /></Field>
            <Field label="Dispatch requirements" hint={terms?.dispatch_requirement ? `Channel default: ${terms.dispatch_requirement}` : undefined}><input value={f.dispatch_requirement} onChange={(e) => setF({ ...f, dispatch_requirement: e.target.value })} /></Field>
            <Field label="Pricing basis / fee note"><input value={f.pricing_basis_note} onChange={(e) => setF({ ...f, pricing_basis_note: e.target.value })} /></Field>
            <Field label="Evidence / reference" wide><input value={f.evidence_ref} onChange={(e) => setF({ ...f, evidence_ref: e.target.value })} /></Field>
            <Field label="Other agreement notes" wide><textarea rows={2} value={f.agreement_notes} onChange={(e) => setF({ ...f, agreement_notes: e.target.value })} /></Field>
          </>
        )}
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} disabled={!channelId || !product} />
      </form>
    </Overlay>
  );
}
