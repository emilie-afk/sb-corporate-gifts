import { useState, type FormEvent } from "react";
import { get, post, patch, qs } from "../api";
import type { Nav } from "../App";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, useDebounced, usePref,
} from "../components/ui";
import { ProductPicker, type ProductLite } from "../components/ProductPicker";
import {
  money, parseMoney, centsToInput, pct, date, dateTime, productLabel, PRICE_STATUS_LABEL, FORMAT_LABEL, FAMILY_LABEL,
} from "../format";
import { GiftsPanel } from "./Gifts";
import { WebsiteRefresh, CostRefresh, SourcesPanel } from "./Refresh";

const statusTone = (s: string) => (s === "active" ? "ok" : s === "agreed" ? "info" : s === "expired" ? "neutral" : "warn") as any;

function shipFeeSummary(r: any) {
  const parts: string[] = [];
  if (r.customer_shipping_cents != null) parts.push(`Cust. ship ${money(r.customer_shipping_cents)}`);
  if (r.expected_shipping_cents != null) parts.push(`Exp. ship ${money(r.expected_shipping_cents)}`);
  if (r.extra_cost_cents != null) parts.push(`Card/handling ${money(r.extra_cost_cents)}`);
  if (r.commission_pct != null) parts.push(`Comm. ${pct(r.commission_pct)}`);
  if (r.fixed_fee_cents != null) parts.push(`Fee ${money(r.fixed_fee_cents)}/unit`);
  return parts.length ? parts.join(" · ") : "Unspecified";
}

export function PricingScreen({ params, nav }: { params: Record<string, string>; nav: Nav }) {
  const [channel, setChannel] = useState(params.channel ?? "");
  const [status, setStatus] = usePref("pr.status", "");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [showExpired, setShowExpired] = usePref("pr.expired", false);
  const [panel, setPanel] = useState<null | { kind: string; rec?: any }>(null);
  const channels = useLoad(() => get("/channels"), []);
  const list = useLoad(() => get(`/pricing${qs({ channel_id: channel, status, q: dq, include_expired: showExpired })}`), [channel, status, dq, showExpired]);
  const runs = useLoad(() => get("/imports"), []);
  const last = (kind: string) => runs.data?.lastSuccess.find((x: any) => x.kind === kind);
  const close = () => setPanel(null);
  const done = () => { setPanel(null); list.reload(); runs.reload(); };

  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Pricing</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setPanel({ kind: "new" })}>Add pricing record</button>
      </div>
      <div className="toolbar secondary">
        <button className="btn small" onClick={() => setPanel({ kind: "gifts" })}>Gifts &amp; collections</button>
        <button className="btn small" onClick={() => setPanel({ kind: "web" })}>Refresh website products</button>
        <button className="btn small" onClick={() => setPanel({ kind: "cost" })}>Refresh Product Master costs</button>
        <button className="btn ghost small" onClick={() => setPanel({ kind: "sources" })}>Cost source settings</button>
        <span className="hint">
          Website: {last("shopify") ? `${dateTime(last("shopify").confirmed_at)} by ${last("shopify").confirmed_by}` : "never refreshed"} ·
          Costs: {last("product_master") ? `${dateTime(last("product_master").confirmed_at)} by ${last("product_master").confirmed_by}` : "never refreshed"}
        </span>
      </div>
      <div className="filters">
        <Select value={channel} onChange={(v) => { setChannel(v); nav("pricing", v ? { channel: v } : {}); }} aria-label="Channel" empty="All channels"
          options={(channels.data?.channels ?? []).map((c: any) => [c.id, c.name + (c.marketplace_status && ["on_hold", "rejected", "not_qualified", "inactive"].includes(c.marketplace_status) ? " (inactive)" : "")])} />
        <input type="search" placeholder="Gift or variant" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Product" />
        <Select value={status} onChange={setStatus} options={PRICE_STATUS_LABEL} empty="All current statuses" aria-label="Price status" />
        <label className="check"><input type="checkbox" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} /> Include expired versions</label>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data && <Loading />}
      {list.data && (
        <div className="table-wrap">
          <table className="table dense">
            <thead><tr>
              <th>Channel</th><th>Gift / variant</th><th className="num">Retail ref.</th><th className="num">Internal gift cost</th>
              <th className="num">Proposed supplier</th><th className="num">Agreed selling</th><th>Shipping / fees</th><th>Status</th><th>From</th><th>To</th><th></th>
            </tr></thead>
            <tbody>
              {list.data.pricing.length === 0 && <tr><td colSpan={11}><Empty>No pricing records. Use “Add pricing record”.</Empty></td></tr>}
              {list.data.pricing.map((r: any) => (
                <tr key={r.id} className={r.status === "expired" ? "muted-row" : ""}>
                  <td data-label="Channel">{r.channel_name}</td>
                  <td data-label="Gift / variant"><strong>{productLabel(r.product_name, r.product_variant)}</strong><div className="hint">{FORMAT_LABEL[r.fulfillment_format]}{r.moq ? ` · MOQ ${r.moq}` : ""}</div></td>
                  <td className="num" data-label="Retail ref.">{money(r.retail_ref_cents)}</td>
                  <td className="num" data-label="Internal gift cost">{money(r.internal_cost_cents)}</td>
                  <td className="num" data-label="Proposed supplier">{money(r.proposed_supplier_cents)}</td>
                  <td className="num" data-label="Agreed selling"><strong>{money(r.agreed_price_cents)}</strong></td>
                  <td data-label="Shipping / fees" className="small-text">{shipFeeSummary(r)}</td>
                  <td data-label="Status"><Pill tone={statusTone(r.status)}>{PRICE_STATUS_LABEL[r.status]}</Pill></td>
                  <td data-label="From">{date(r.effective_from)}</td>
                  <td data-label="To">{date(r.effective_to)}</td>
                  <td><button className="btn small" onClick={() => setPanel({ kind: "view", rec: r })}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {panel?.kind === "new" && <PricingForm channels={channels.data?.channels ?? []} defaultChannel={channel} onClose={close} onSaved={done} />}
      {panel?.kind === "view" && <PricingView id={panel.rec.id} channels={channels.data?.channels ?? []} onClose={close} onChanged={() => { list.reload(); }} />}
      {panel?.kind === "gifts" && <GiftsPanel onClose={() => { close(); list.reload(); }} />}
      {panel?.kind === "web" && <WebsiteRefresh onClose={done} />}
      {panel?.kind === "cost" && <CostRefresh onClose={done} />}
      {panel?.kind === "sources" && <SourcesPanel onClose={close} />}
    </div>
  );
}

// ---------------------------------------------------------------- form
type Mode = { kind: "create" } | { kind: "edit"; rec: any } | { kind: "revise"; rec: any };

const MONEY_KEYS = ["retail_ref_cents", "internal_cost_cents", "proposed_supplier_cents", "agreed_price_cents", "customer_shipping_cents", "expected_shipping_cents", "extra_cost_cents", "fixed_fee_cents"] as const;

export function PricingForm({ channels, defaultChannel, mode = { kind: "create" }, onClose, onSaved }: {
  channels: any[]; defaultChannel?: string; mode?: Mode; onClose: () => void; onSaved: () => void;
}) {
  const rec = mode.kind === "create" ? null : mode.rec;
  const [channelId, setChannelId] = useState<string>(rec?.channel_id ?? defaultChannel ?? "");
  const [product, setProduct] = useState<ProductLite | null>(rec ? ({ id: rec.product_id, name: rec.product_name, variant: rec.product_variant, family: rec.product_family } as any) : null);
  const init: Record<string, string> = {};
  for (const k of MONEY_KEYS) init[k] = centsToInput(rec?.[k]);
  const [m, setM] = useState(init);
  const [f, setF] = useState({
    status: mode.kind === "edit" ? rec.status : "draft",
    customer_discount_pct: rec?.customer_discount_pct == null ? "" : String(rec.customer_discount_pct),
    commission_pct: rec?.commission_pct == null ? "" : String(rec.commission_pct),
    moq: rec?.moq == null ? "" : String(rec.moq),
    fulfillment_format: rec?.fulfillment_format ?? "individual",
    cost_inclusions_note: rec?.cost_inclusions_note ?? "", pricing_basis_note: rec?.pricing_basis_note ?? "",
    shipping_responsibility: rec?.shipping_responsibility ?? "", payment_terms: rec?.payment_terms ?? "",
    dispatch_requirement: rec?.dispatch_requirement ?? "", agreement_notes: rec?.agreement_notes ?? "",
    effective_from: mode.kind === "revise" ? "" : rec?.effective_from ?? "", effective_to: mode.kind === "revise" ? "" : rec?.effective_to ?? "",
    evidence_ref: rec?.evidence_ref ?? "", approved_by: mode.kind === "edit" ? rec?.approved_by ?? "" : "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const [localErr, setLocalErr] = useState<Record<string, string>>({});
  const ch = channels.find((c) => c.id === channelId);
  const isDirect = ch?.type === "direct";
  const bulkOnly = product?.family === "pots_plus_succulents";
  const formats = Object.entries(FORMAT_LABEL).filter(([k]) => !(bulkOnly && (k === "individual" || k === "corporate_separate_addresses")));

  const pickProduct = async (p: ProductLite | null) => {
    setProduct(p);
    if (!p) return;
    if (p.family === "pots_plus_succulents" && ["individual", "corporate_separate_addresses"].includes(f.fulfillment_format)) setF((x) => ({ ...x, fulfillment_format: "bulk_multiple_shipments" }));
    // Pre-fill references (visible & editable): current website retail and current Product Master cost.
    try {
      const d = await get(`/products/${p.id}`);
      setM((x) => ({
        ...x,
        retail_ref_cents: x.retail_ref_cents || centsToInput(d.product.web_price_cents),
        internal_cost_cents: x.internal_cost_cents || centsToInput(d.product.current_cost_cents),
      }));
    } catch { /* ignore */ }
  };

  const retail = parseMoney(m.retail_ref_cents);
  const disc = f.customer_discount_pct === "" ? null : Number(f.customer_discount_pct);
  const suggested = isDirect && retail != null && !Number.isNaN(retail) && disc != null && !Number.isNaN(disc) ? Math.round(retail * (1 - disc / 100)) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const body: Record<string, any> = {};
    for (const k of MONEY_KEYS) {
      const v = parseMoney(m[k]);
      if (Number.isNaN(v)) errs[k] = "Enter an amount like 12.50, or leave blank if unknown";
      body[k] = v;
    }
    const num = (k: "customer_discount_pct" | "commission_pct" | "moq") => (f[k] === "" ? null : Number(f[k]));
    for (const k of ["customer_discount_pct", "commission_pct"] as const) {
      const v = num(k);
      if (v !== null && (Number.isNaN(v) || v < 0 || v > 100)) errs[k] = "0–100";
    }
    const moq = num("moq");
    if (moq !== null && (!Number.isInteger(moq) || moq < 1)) errs.moq = "Whole number ≥ 1";
    if (f.status === "agreed" && body.agreed_price_cents == null) errs.agreed_price_cents = "Required for an agreed price";
    if (f.status === "agreed" && !f.approved_by.trim()) errs.approved_by = "Required for an agreed price";
    setLocalErr(errs);
    if (Object.keys(errs).length) return;
    Object.assign(body, {
      customer_discount_pct: num("customer_discount_pct"), commission_pct: num("commission_pct"), moq,
      fulfillment_format: f.fulfillment_format, cost_inclusions_note: f.cost_inclusions_note, pricing_basis_note: f.pricing_basis_note,
      shipping_responsibility: f.shipping_responsibility, payment_terms: f.payment_terms, dispatch_requirement: f.dispatch_requirement,
      agreement_notes: f.agreement_notes, effective_from: f.effective_from || null, effective_to: f.effective_to || null,
      evidence_ref: f.evidence_ref, approved_by: f.approved_by, signer_name: signer,
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
  const moneyField = (k: (typeof MONEY_KEYS)[number], label: string, hint?: string) => (
    <Field label={label} error={fe(k)} hint={hint}>
      <input inputMode="decimal" value={m[k]} placeholder="Unknown" onChange={(e) => setM({ ...m, [k]: e.target.value })} />
    </Field>
  );
  const title = mode.kind === "create" ? "Add pricing record" : mode.kind === "edit" ? "Edit price (draft/proposed)" : "Revise price — new version";

  return (
    <Overlay kind="modal" title={title} subtitle={mode.kind === "revise" ? "Creates a new linked version. The previous version stays unchanged." : undefined} onClose={onClose}>
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
          {mode.kind === "create" ? <ProductPicker value={product} onChange={pickProduct} selectedOnly /> : <strong>{productLabel(product?.name, product?.variant)}</strong>}
        </Field>
        {bulkOnly && <div className="alert warn wide">Pots plus succulents: bulk only, multiple shipments. Individual and separate-address recipient fulfillment cannot be priced.</div>}
        <Field label="Fulfillment format" required error={fe("fulfillment_format")} hint="Bulk multiple shipments = one bulk order delivered in several shipments, not gifts sent to individual recipients.">
          <Select value={f.fulfillment_format} onChange={(v) => setF({ ...f, fulfillment_format: v })} options={formats} />
        </Field>
        <Field label="MOQ" error={fe("moq")} hint={isDirect && ch?.corporate_moq ? `Internal corporate minimum: ${ch.corporate_moq} gifts (not a blanket rule for individual gifts).` : undefined}>
          <input inputMode="numeric" value={f.moq} placeholder="Unknown" onChange={(e) => setF({ ...f, moq: e.target.value })} />
        </Field>
        <div className="subhead wide">Prices (USD) — blank means unknown, never zero</div>
        {moneyField("retail_ref_cents", "Retail reference price")}
        {moneyField("internal_cost_cents", "Internal gift cost")}
        <Field label="Cost inclusions note" wide hint="Does the internal gift cost already include card / handling? Say so here to avoid double counting.">
          <input value={f.cost_inclusions_note} onChange={(e) => setF({ ...f, cost_inclusions_note: e.target.value })} />
        </Field>
        {isDirect && (
          <Field label="Customer discount %" error={fe("customer_discount_pct")} hint={ch?.default_discount_pct != null ? `Current direct-customer discount: ${pct(ch.default_discount_pct)}` : undefined}>
            <input inputMode="decimal" value={f.customer_discount_pct} placeholder="Unknown" onChange={(e) => setF({ ...f, customer_discount_pct: e.target.value })} />
          </Field>
        )}
        {isDirect && (
          <div className="calc wide">
            Suggested customer price (calculated: retail × (1 − discount)): <strong>{suggested == null ? "—" : money(suggested)}</strong>
            {suggested != null && <button type="button" className="btn ghost small" onClick={() => setM({ ...m, agreed_price_cents: centsToInput(suggested) })}>Copy into agreed price</button>}
            <div className="hint">A suggestion only — it is stored as agreed only when you save an agreed price.</div>
          </div>
        )}
        {!isDirect && moneyField("proposed_supplier_cents", "Proposed supplier price")}
        {moneyField("agreed_price_cents", isDirect ? "Agreed customer price" : "Agreed supplier selling price")}
        <div className="subhead wide">Shipping and fees</div>
        {moneyField("customer_shipping_cents", "Customer shipping charge")}
        {moneyField("expected_shipping_cents", "Expected shipping cost")}
        {moneyField("extra_cost_cents", "Card / handling / customization cost")}
        <Field label="Marketplace commission %" error={fe("commission_pct")}><input inputMode="decimal" value={f.commission_pct} placeholder="Unknown" onChange={(e) => setF({ ...f, commission_pct: e.target.value })} /></Field>
        {moneyField("fixed_fee_cents", "Fixed fee per unit")}
        <Field label="Pricing basis / fee note" wide><input value={f.pricing_basis_note} onChange={(e) => setF({ ...f, pricing_basis_note: e.target.value })} /></Field>
        <div className="subhead wide">Agreement terms for this gift (blank = use channel common terms / unspecified)</div>
        <Field label="Shipping responsibility"><input value={f.shipping_responsibility} onChange={(e) => setF({ ...f, shipping_responsibility: e.target.value })} /></Field>
        <Field label="Payment terms"><input value={f.payment_terms} onChange={(e) => setF({ ...f, payment_terms: e.target.value })} /></Field>
        <Field label="Dispatch requirement"><input value={f.dispatch_requirement} onChange={(e) => setF({ ...f, dispatch_requirement: e.target.value })} /></Field>
        <Field label="Other agreement notes" wide><textarea rows={2} value={f.agreement_notes} onChange={(e) => setF({ ...f, agreement_notes: e.target.value })} /></Field>
        <Field label="Effective from" error={fe("effective_from")}><input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
        <Field label="Effective to" error={fe("effective_to")}><input type="date" value={f.effective_to} onChange={(e) => setF({ ...f, effective_to: e.target.value })} /></Field>
        <Field label="Evidence (URL or short reference)" wide><input value={f.evidence_ref} onChange={(e) => setF({ ...f, evidence_ref: e.target.value })} /></Field>
        <Field label="Approved by" error={fe("approved_by")} hint="Required when agreed."><input value={f.approved_by} onChange={(e) => setF({ ...f, approved_by: e.target.value })} maxLength={80} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} disabled={!channelId || !product} />
      </form>
    </Overlay>
  );
}

// ---------------------------------------------------------------- view
function PricingView({ id, channels, onClose, onChanged }: { id: string; channels: any[]; onClose: () => void; onChanged: () => void }) {
  const d = useLoad(() => get(`/pricing/${id}`), [id]);
  const [modal, setModal] = useState<null | "edit" | "revise" | "activate" | "expire">(null);
  const [showHist, setShowHist] = useState(false);
  const r = d.data?.record;
  const reload = () => { setModal(null); d.reload(); onChanged(); };
  const terms = r?.terms_snapshot;
  return (
    <Overlay title={r ? productLabel(r.product_name, r.product_variant) : "Price"} subtitle={r && <span className="row-gap">{r.channel_name} <Pill tone={statusTone(r.status)}>{PRICE_STATUS_LABEL[r.status]}</Pill></span>} onClose={onClose}>
      {d.loading && !r && <Loading />}
      <ErrorBox error={d.error} />
      {r && (
        <>
          <div className="detail-actions">
            {["draft", "proposed"].includes(r.status) && <button className="btn small" onClick={() => setModal("edit")}>Edit</button>}
            {["agreed", "active", "expired"].includes(r.status) && <button className="btn small" onClick={() => setModal("revise")}>Revise price</button>}
            {["agreed", "proposed"].includes(r.status) && <button className="btn small primary" onClick={() => setModal("activate")}>Activate</button>}
            {r.status === "active" && <button className="btn ghost small" onClick={() => setModal("expire")}>Expire</button>}
            <button className="btn ghost small" onClick={() => setShowHist(!showHist)}>{showHist ? "Hide" : "View"} price history</button>
          </div>
          {r.product_family && <p className="hint">{FAMILY_LABEL[r.product_family]}</p>}
          <dl className="kv">
            <dt>Fulfillment format</dt><dd>{FORMAT_LABEL[r.fulfillment_format]}</dd>
            <dt>MOQ</dt><dd>{r.moq ?? <span className="unknown">Unknown</span>}</dd>
            <dt>Retail reference</dt><dd>{money(r.retail_ref_cents, "Unknown")}</dd>
            <dt>Internal gift cost</dt><dd>{money(r.internal_cost_cents, "Unknown")}{r.cost_inclusions_note && <div className="hint">{r.cost_inclusions_note}</div>}</dd>
            {r.customer_discount_pct != null && <><dt>Customer discount</dt><dd>{pct(r.customer_discount_pct)}</dd></>}
            <dt>Proposed supplier price</dt><dd>{money(r.proposed_supplier_cents, "Unknown")}</dd>
            <dt>Agreed selling price</dt><dd><strong>{money(r.agreed_price_cents, "Not agreed")}</strong></dd>
            <dt>Shipping / fees</dt><dd>{shipFeeSummary(r)}{r.pricing_basis_note && <div className="hint">{r.pricing_basis_note}</div>}</dd>
            <dt>Effective</dt><dd>{date(r.effective_from)} → {date(r.effective_to)}</dd>
            <dt>Evidence</dt><dd>{r.evidence_ref ? (/^https?:/.test(r.evidence_ref) ? <a href={r.evidence_ref} target="_blank" rel="noreferrer noopener">{r.evidence_ref}</a> : r.evidence_ref) : "—"}</dd>
            <dt>Entered by</dt><dd>{r.entered_by} · {dateTime(r.created_at)}</dd>
            {r.approved_by && <><dt>Approved by</dt><dd>{r.approved_by} · {dateTime(r.approved_at)}</dd></>}
          </dl>
          {["agreed", "active", "expired"].includes(r.status) && (
            <Section title="Review: snapshot vs current">
              <table className="table compact">
                <thead><tr><th></th><th className="num">When agreed</th><th className="num">Current</th></tr></thead>
                <tbody>
                  <tr><td>Retail reference</td><td className="num">{money(r.snapshot_retail_cents, "Unknown")}</td><td className="num">{money(r.current_retail_cents, "Unknown")}</td></tr>
                  <tr><td>Gift cost</td><td className="num">{money(r.snapshot_cost_cents, "Unknown")}</td><td className="num">{money(r.current_cost_cents, "Unknown")}</td></tr>
                  <tr><td>Agreed selling price</td><td className="num"><strong>{money(r.agreed_price_cents)}</strong></td><td className="num hint">unchanged by refreshes</td></tr>
                </tbody>
              </table>
              <p className="hint">Website and cost refreshes never change agreed prices. Use Revise price if renegotiating.</p>
            </Section>
          )}
          <Section title="Agreement terms" defaultOpen={!!terms}>
            {terms ? (
              <dl className="kv">
                {(["payment_terms", "shipping_responsibility", "dispatch_requirement", "fee_note"] as const).map((k) => (
                  <div key={k} className="kv-row"><dt>{k.replace(/_/g, " ")}</dt><dd>{terms[k]?.value ?? <span className="unknown">Unspecified</span>} {terms[k]?.source && terms[k].source !== "unspecified" && <span className="hint">({terms[k].source === "gift_override" ? "gift-specific" : "channel common"})</span>}</dd></div>
                ))}
                {r.agreement_notes && <><dt>Notes</dt><dd className="pre">{r.agreement_notes}</dd></>}
              </dl>
            ) : (
              <dl className="kv">
                <dt>Payment terms</dt><dd>{r.payment_terms ?? <span className="unknown">Channel common / unspecified</span>}</dd>
                <dt>Shipping responsibility</dt><dd>{r.shipping_responsibility ?? <span className="unknown">Channel common / unspecified</span>}</dd>
                <dt>Dispatch requirement</dt><dd>{r.dispatch_requirement ?? <span className="unknown">Channel common / unspecified</span>}</dd>
                {r.agreement_notes && <><dt>Notes</dt><dd className="pre">{r.agreement_notes}</dd></>}
              </dl>
            )}
            <p className="hint">Unspecified terms are not recorded — entering a price does not mean the contract is fully recorded.</p>
          </Section>
          {showHist && <PriceHistory id={r.id} />}
          {modal === "edit" && <PricingForm channels={channels} mode={{ kind: "edit", rec: r }} onClose={() => setModal(null)} onSaved={reload} />}
          {modal === "revise" && <PricingForm channels={channels} mode={{ kind: "revise", rec: r }} onClose={() => setModal(null)} onSaved={reload} />}
          {modal === "activate" && <ActivateForm r={r} onClose={() => setModal(null)} onSaved={reload} />}
          {modal === "expire" && <ExpireForm r={r} onClose={() => setModal(null)} onSaved={reload} />}
        </>
      )}
    </Overlay>
  );
}

function PriceHistory({ id }: { id: string }) {
  const h = useLoad(() => get(`/pricing/${id}/history`), [id]);
  if (!h.data) return <Loading />;
  return (
    <Section title="Price history" count={h.data.versions.length}>
      <table className="table compact">
        <thead><tr><th>Version</th><th>Status</th><th className="num">Agreed</th><th className="num">Proposed</th><th>Effective</th><th>Entered / approved</th></tr></thead>
        <tbody>
          {h.data.versions.map((v: any, i: number) => (
            <tr key={v.id} className={v.id === id ? "current-row" : ""}>
              <td>v{i + 1}</td><td>{PRICE_STATUS_LABEL[v.status]}</td><td className="num">{money(v.agreed_price_cents)}</td><td className="num">{money(v.proposed_supplier_cents)}</td>
              <td>{date(v.effective_from)} → {date(v.effective_to)}</td><td>{v.entered_by}{v.approved_by ? ` / ${v.approved_by}` : ""}<div className="hint">{dateTime(v.created_at)}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function ActivateForm({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const [from, setFrom] = useState(r.effective_from ?? "");
  const [to, setTo] = useState(r.effective_to ?? "");
  const [approvedBy, setApprovedBy] = useState(r.approved_by ?? "");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post(`/pricing/${r.id}/activate`, { effective_from: from || null, effective_to: to || null, approved_by: approvedBy || null, version: r.version, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title="Activate price" subtitle={`${money(r.agreed_price_cents)} · ${r.channel_name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <p className="hint wide">An existing active price for the same channel, gift/variant and fulfillment format is closed the day before this start date. Overlapping periods are rejected.</p>
        <Field label="Effective from" required error={s.fe("effective_from")}><input type="date" value={from} disabled={!!r.effective_from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Effective to (optional)" error={s.fe("effective_to")}><input type="date" value={to} disabled={!!r.effective_to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Approved by" required error={s.fe("approved_by")}><input value={approvedBy} disabled={!!r.approved_by} onChange={(e) => setApprovedBy(e.target.value)} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label="Activate" />
      </form>
    </Overlay>
  );
}

function ExpireForm({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const [to, setTo] = useState(r.effective_to ?? "");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post(`/pricing/${r.id}/expire`, { effective_to: to, version: r.version, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title="Expire active price" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Last effective day" required error={s.fe("effective_to")}><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label="Expire" />
      </form>
    </Overlay>
  );
}
