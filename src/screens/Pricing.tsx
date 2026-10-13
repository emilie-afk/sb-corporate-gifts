import { useState, type FormEvent } from "react";
import { get, post, patch, qs } from "../api";
import type { Nav } from "../App";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, useDebounced, usePref,
} from "../components/ui";
import {
  money, pct, date, dateTime, productLabel, PRICE_STATUS_LABEL, FORMAT_LABEL, FAMILY_LABEL,
} from "../format";
import { GiftsPanel } from "./Gifts";
import { WebsiteRefresh, CostRefresh, SourcesPanel } from "./Refresh";
import { PricingForm } from "./PricingForm";
import { PricingImport } from "./PricingImport";
import { interpretPricing, BASIS_LABEL } from "../../shared/pricingModel";

const interp = (r: any) => interpretPricing({ ...r, retail_ref_cents: r.snapshot_retail_cents ?? r.retail_ref_cents });

const statusTone = (s: string) => (s === "active" ? "ok" : s === "agreed" ? "info" : s === "expired" ? "neutral" : "warn") as any;

function shipFeeSummary(r: any) {
  const parts: string[] = [];
  if (r.customer_shipping_cents != null) parts.push(`Cust. ship ${money(r.customer_shipping_cents)}`);
  if (r.expected_shipping_cents != null) parts.push(`Exp. ship ${money(r.expected_shipping_cents)}`);
  if (r.extra_cost_cents != null) parts.push(`Card/handling ${money(r.extra_cost_cents)}`);
  if (r.commission_pct != null) parts.push(`Comm. ${pct(r.commission_pct)}${r.commission_basis ? ` of ${BASIS_LABEL[r.commission_basis].toLowerCase()}` : ""}`);
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
        <button className="btn small" onClick={() => setPanel({ kind: "excel" })}>Import pricing file</button>
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
              <th>Pricing model</th><th className="num">Agreed price</th><th className="num">SB receives</th><th>Shipping / fees</th><th>Status</th><th>From</th><th>To</th><th></th>
            </tr></thead>
            <tbody>
              {list.data.pricing.length === 0 && <tr><td colSpan={12}><Empty>No pricing records. Use “Add pricing record”.</Empty></td></tr>}
              {list.data.pricing.map((r: any) => { const i = interp(r); return (
                <tr key={r.id} className={r.status === "expired" ? "muted-row" : ""}>
                  <td data-label="Channel">{r.channel_name}</td>
                  <td data-label="Gift / variant"><strong>{productLabel(r.product_name, r.product_variant)}</strong><div className="hint">{FORMAT_LABEL[r.fulfillment_format]}{r.moq ? ` · MOQ ${r.moq}` : ""}</div></td>
                  <td className="num" data-label="Retail ref.">{money(r.retail_ref_cents)}</td>
                  <td className="num" data-label="Internal gift cost">{money(r.internal_cost_cents)}</td>
                  <td data-label="Pricing model">{r.pricing_model ? i.modelLabel : <span className="unknown">Not specified</span>}</td>
                  <td className="num" data-label="Agreed price"><strong>{money(r.agreed_price_cents)}</strong>{r.agreed_price_cents == null && r.proposed_supplier_cents != null && <div className="hint">proposed {money(r.proposed_supplier_cents)}</div>}<div className="hint">{r.pricing_model ? i.headlineLabel : ""}</div></td>
                  <td className="num" data-label="SB receives">{i.sbReceivesCents != null ? money(i.sbReceivesCents) : <span className="unknown" title={i.explanation}>{r.pricing_model === "custom" ? "See terms" : "Unknown"}</span>}</td>
                  <td data-label="Shipping / fees" className="small-text">{shipFeeSummary(r)}</td>
                  <td data-label="Status"><Pill tone={statusTone(r.status)}>{PRICE_STATUS_LABEL[r.status]}</Pill></td>
                  <td data-label="From">{date(r.effective_from)}</td>
                  <td data-label="To">{date(r.effective_to)}</td>
                  <td><button className="btn small" onClick={() => setPanel({ kind: "view", rec: r })}>Open</button></td>
                </tr>
              ); })}
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
      {panel?.kind === "excel" && <PricingImport channels={channels.data?.channels ?? []} onClose={done} />}
    </div>
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
            <dt>Retail reference</dt><dd>{money(r.retail_ref_cents, "Unknown")} <SourceTag kind="retail" r={r} /></dd>
            <dt>Internal gift cost</dt><dd>{money(r.internal_cost_cents, "Unknown")} <SourceTag kind="cost" r={r} />{r.cost_inclusions_note && <div className="hint">Includes: {r.cost_inclusions_note}</div>}</dd>
            {r.customer_discount_pct != null && <><dt>Customer discount</dt><dd>{pct(r.customer_discount_pct)}</dd></>}
            <dt>Pricing model</dt><dd>{r.pricing_model ? interp(r).modelLabel : <span className="unknown">Not specified (older record — revise to choose a model)</span>}</dd>
            {r.supplier_price_cents != null && <><dt>Agreed supplier price (SB receives)</dt><dd>{money(r.supplier_price_cents)}</dd></>}
            {r.selling_price_cents != null && <><dt>Marketplace selling price</dt><dd>{money(r.selling_price_cents)}{r.pricing_model === "fixed_supplier" && <span className="hint"> · reference only</span>}</dd></>}
            {(r.pricing_model === "commission" || r.commission_basis) && <><dt>Commission basis</dt><dd>{r.commission_basis ? BASIS_LABEL[r.commission_basis] : <span className="unknown">Not specified</span>}{r.commission_basis_note && <div className="hint">{r.commission_basis_note}</div>}</dd></>}
            {r.proposed_supplier_cents != null && <><dt>Proposed supplier price</dt><dd>{money(r.proposed_supplier_cents)}</dd></>}
            <dt>{interp(r).headlineLabel}</dt><dd><strong>{money(r.agreed_price_cents, "Not agreed")}</strong></dd>
            <dt>SB receives per gift</dt><dd>{interp(r).sbReceivesCents != null ? <strong>{money(interp(r).sbReceivesCents)}</strong> : <span className="unknown">Not calculated</span>}<div className="hint">{interp(r).explanation}</div>{interp(r).notes.map((n, k) => <div key={k} className="hint">{n}</div>)}</dd>
            {r.custom_terms && <><dt>Custom terms</dt><dd className="pre">{r.custom_terms}</dd></>}
            <dt>Shipping / fees</dt><dd>{shipFeeSummary(r)}{r.pricing_basis_note && <div className="hint">{r.pricing_basis_note}</div>}</dd>
            <dt>Effective</dt><dd>{date(r.effective_from)} → {date(r.effective_to)}</dd>
            <dt>Evidence</dt><dd>{r.evidence_ref ? (/^https?:/.test(r.evidence_ref) ? <a href={r.evidence_ref} target="_blank" rel="noreferrer noopener">{r.evidence_ref}</a> : r.evidence_ref) : "—"}</dd>
            <dt>Entered by</dt><dd>{r.entered_by} · {dateTime(r.created_at)}{r.import_row_ref && <div className="hint">Imported from {r.import_row_ref}</div>}</dd>
            {r.approved_by && <><dt>Approved by</dt><dd>{r.approved_by} · {dateTime(r.approved_at)}</dd></>}
          </dl>
          {["agreed", "active", "expired"].includes(r.status) && (
            <Section title="Review: snapshot vs current">
              <table className="table compact">
                <thead><tr><th></th><th className="num">When agreed</th><th className="num">Current</th></tr></thead>
                <tbody>
                  <tr><td>Retail reference</td><td className="num">{money(r.snapshot_retail_cents, "Unknown")}</td><td className="num">{money(r.current_retail_cents, "Unknown")}</td></tr>
                  <tr><td>Gift cost</td><td className="num">{money(r.snapshot_cost_cents, "Unknown")}</td><td className="num">{money(r.current_cost_cents, "Unknown")}</td></tr>
                  <tr><td>{interp(r).headlineLabel}</td><td className="num"><strong>{money(r.agreed_price_cents)}</strong></td><td className="num hint">unchanged by refreshes</td></tr>
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
        <thead><tr><th>Version</th><th>Status</th><th>Model</th><th className="num">Agreed</th><th className="num">SB receives</th><th>Effective</th><th>Entered / approved</th></tr></thead>
        <tbody>
          {h.data.versions.map((v: any, i: number) => (
            <tr key={v.id} className={v.id === id ? "current-row" : ""}>
              <td>v{i + 1}</td><td>{PRICE_STATUS_LABEL[v.status]}</td><td>{v.pricing_model ? interp(v).modelLabel : "—"}</td><td className="num">{money(v.agreed_price_cents)}</td><td className="num">{money(interp(v).sbReceivesCents)}</td>
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

function SourceTag({ kind, r }: { kind: "retail" | "cost"; r: any }) {
  const src = r[`${kind}_source`];
  const d = r[`${kind}_source_detail`] ?? {};
  if (src === "manual") return <span className="hint"><Pill tone="warn">Manual</Pill> {d.reason} · source: {d.source} · {d.date}</span>;
  if (src === "shopify") return <span className="hint">Website (Shopify){d.refreshed_at ? ` · refreshed ${dateTime(d.refreshed_at)}` : ""}</span>;
  if (src === "product_master") return <span className="hint">Product Master · {dateTime(d.refreshed_at)}</span>;
  return null;
}
