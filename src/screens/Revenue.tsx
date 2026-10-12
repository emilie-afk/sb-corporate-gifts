import { useState, type FormEvent } from "react";
import { get, post, patch, qs } from "../api";
import type { Nav } from "../App";
import { Field, Select, SignerField, FormActions, ErrorBox, Overlay, Pill, Loading, Empty, useLoad, useSave, useSigner, rememberSigner, usePref } from "../components/ui";
import { money, parseMoney, centsToInput, dateTime } from "../format";

const MONEY = [
  ["gift_sales_cents", "Gift sales revenue", "After discounts, before refunds and marketplace fees. For marketplaces: what SB earns under the supplier agreement, not the end-customer retail amount."],
  ["shipping_revenue_cents", "Customer shipping revenue", ""],
  ["refunds_cents", "Refunds", "May exceed this month's sales (refunds can relate to earlier months)."],
  ["marketplace_fees_cents", "Marketplace fees", "Actual additional deductions only — don't subtract a margin already built into the supplier price."],
] as const;
const COUNTS = [["order_count", "Order count"], ["units_sold", "Gift units sold"]] as const;

export function RevenueScreen({ params }: { params: Record<string, string>; nav: Nav }) {
  const now = new Date();
  const [from, setFrom] = usePref("rv.from", `${now.getFullYear()}-01`);
  const [to, setTo] = usePref("rv.to", "");
  const [channel, setChannel] = useState(params.channel ?? "");
  const [edit, setEdit] = useState<any | null>(null);
  const channels = useLoad(() => get("/channels"), []);
  const list = useLoad(() => get(`/revenue/monthly${qs({ from, to, channel_id: channel })}`), [from, to, channel]);
  const t = list.data?.totals;
  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Revenue</h1>
        <span className="hint">Monthly manual records · totals include inactive channels</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEdit({})}>Add monthly revenue</button>
      </div>
      <div className="filters">
        <label className="inline">From <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">To <input type="month" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Select value={channel} onChange={setChannel} options={(channels.data?.channels ?? []).map((c: any) => [c.id, c.name])} empty="All channels" aria-label="Channel" />
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data && <Loading />}
      {t && (
        <div className="summary">
          <div><span className="label">Net revenue</span><strong>{money(t.net_revenue_cents)}</strong><span className="hint">gift sales + shipping − refunds</span></div>
          <div><span className="label">Marketplace fees</span><strong>{money(t.marketplace_fees_cents)}</strong></div>
          <div><span className="label">Revenue after marketplace fees</span><strong>{money(t.revenue_after_fees_cents)}</strong><span className="hint">not gross profit</span></div>
          <div><span className="label">Orders / units</span><strong>{t.order_count} / {t.units_sold}</strong></div>
          {t.records_incomplete > 0 && <div className="warn-text">{t.records_incomplete} incomplete record(s) excluded from totals</div>}
        </div>
      )}
      {list.data?.byChannel.length > 0 && (
        <div className="breakdown">
          {list.data.byChannel.map((c: any) => <span key={c.channel_id} className="pill neutral">{c.channel_name}: {money(c.net_revenue_cents)}</span>)}
        </div>
      )}
      {list.data && (
        <div className="table-wrap">
          <table className="table dense">
            <thead><tr><th>Month</th><th>Channel</th><th className="num">Orders</th><th className="num">Units</th><th className="num">Gift sales</th><th className="num">Shipping</th><th className="num">Refunds</th><th className="num">Net revenue</th><th className="num">Fees</th><th className="num">After fees</th><th>Recorded</th><th></th></tr></thead>
            <tbody>
              {list.data.revenue.length === 0 && <tr><td colSpan={12}><Empty>No revenue records for these filters.</Empty></td></tr>}
              {list.data.revenue.map((r: any) => (
                <tr key={r.id}>
                  <td data-label="Month">{r.reporting_month}</td>
                  <td data-label="Channel">{r.channel_name}{r.marketplace_status && ["on_hold", "rejected", "not_qualified", "inactive"].includes(r.marketplace_status) && <span className="hint"> (inactive)</span>}</td>
                  <td className="num" data-label="Orders">{r.order_count ?? <Missing />}</td>
                  <td className="num" data-label="Units">{r.units_sold ?? <Missing />}</td>
                  <td className="num" data-label="Gift sales">{r.gift_sales_cents == null ? <Missing /> : money(r.gift_sales_cents)}</td>
                  <td className="num" data-label="Shipping">{r.shipping_revenue_cents == null ? <Missing /> : money(r.shipping_revenue_cents)}</td>
                  <td className="num" data-label="Refunds">{r.refunds_cents == null ? <Missing /> : money(r.refunds_cents)}</td>
                  <td className="num" data-label="Net revenue"><strong>{r.complete ? money(r.net_revenue_cents) : <Pill tone="warn">Incomplete</Pill>}</strong></td>
                  <td className="num" data-label="Fees">{r.marketplace_fees_cents == null ? <Missing /> : money(r.marketplace_fees_cents)}</td>
                  <td className="num" data-label="After fees">{r.complete ? money(r.revenue_after_fees_cents) : "—"}</td>
                  <td data-label="Recorded" className="small-text">{r.recorded_by}<div className="hint">{dateTime(r.updated_at)}</div></td>
                  <td><button className="btn small" onClick={() => setEdit(r)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <RevenueForm r={edit} channels={channels.data?.channels ?? []} defaultChannel={channel} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

const Missing = () => <span className="missing">Missing</span>;

function RevenueForm({ r, channels, defaultChannel, onClose, onSaved }: { r: any; channels: any[]; defaultChannel: string; onClose: () => void; onSaved: () => void }) {
  const [channelId, setChannelId] = useState(r.channel_id ?? defaultChannel ?? "");
  const [month, setMonth] = useState(r.reporting_month ?? "");
  const [v, setV] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const [k] of MONEY) o[k] = centsToInput(r[k]);
    o.payment_received_cents = centsToInput(r.payment_received_cents);
    for (const [k] of COUNTS) o[k] = r[k] == null ? "" : String(r[k]);
    o.notes = r.notes ?? "";
    return o;
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const [errs, setErrs] = useState<Record<string, string>>({});
  const history = useLoad(() => (r.id ? get(`/revenue/monthly/${r.id}/history`) : Promise.resolve({ events: [] })), [r.id]);

  const parsed = () => {
    const e: Record<string, string> = {};
    const body: Record<string, any> = {};
    for (const [k] of [...MONEY, ["payment_received_cents"] as const]) {
      const c = parseMoney(v[k]);
      if (Number.isNaN(c)) e[k] = "Enter a non-negative amount like 120.00";
      body[k] = c;
    }
    for (const [k] of COUNTS) {
      if (v[k] === "") body[k] = null;
      else if (!/^\d+$/.test(v[k])) e[k] = "Whole number ≥ 0";
      else body[k] = Number(v[k]);
    }
    return { body, e };
  };
  const { body: pb } = parsed();
  const complete = [...MONEY.map(([k]) => k), ...COUNTS.map(([k]) => k)].every((k) => pb[k] !== null && pb[k] !== undefined && !Number.isNaN(pb[k]));
  const net = complete ? pb.gift_sales_cents + pb.shipping_revenue_cents - pb.refunds_cents : null;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const { body, e } = parsed();
    if (!r.id && !channelId) e.channel_id = "Required";
    if (!r.id && !/^\d{4}-\d{2}$/.test(month)) e.reporting_month = "Required";
    setErrs(e);
    if (Object.keys(e).length) return;
    const ok = await s.run(() =>
      r.id ? patch(`/revenue/monthly/${r.id}`, { ...body, notes: v.notes, version: r.version, signer_name: signer })
        : post("/revenue/monthly", { ...body, notes: v.notes, channel_id: channelId, reporting_month: month, signer_name: signer }),
    );
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const fe = (k: string) => errs[k] ?? s.fe(k);
  const state = (k: string) => (v[k] === "" ? <span className="missing">Missing</span> : null);
  return (
    <Overlay kind="modal" title={r.id ? `Correct ${r.channel_name} — ${r.reporting_month}` : "Add monthly revenue"} subtitle="One record per channel and month. Enter 0 explicitly where nothing applies." onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {Object.keys(errs).length > 0 && <div className="alert error wide">Please fix the highlighted fields.</div>}
        <Field label="Channel" required error={fe("channel_id")}><Select value={channelId} onChange={setChannelId} disabled={!!r.id} options={channels.map((c) => [c.id, c.name])} empty="Choose…" /></Field>
        <Field label="Reporting month" required error={fe("reporting_month")}><input type="month" value={month} disabled={!!r.id} onChange={(e) => setMonth(e.target.value)} /></Field>
        {COUNTS.map(([k, label]) => (
          <Field key={k} label={label} required error={fe(k)} hint={state(k)}><input inputMode="numeric" value={v[k]} placeholder="Missing" onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>
        ))}
        {MONEY.map(([k, label, hint]) => (
          <Field key={k} label={`${label} (USD)`} required error={fe(k)} hint={<>{state(k)} {hint}</>}><input inputMode="decimal" value={v[k]} placeholder="Missing" onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>
        ))}
        <Field label="Payment received (optional, USD)" error={fe("payment_received_cents")}><input inputMode="decimal" value={v.payment_received_cents} onChange={(e) => setV({ ...v, payment_received_cents: e.target.value })} /></Field>
        <Field label="Notes" wide><textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        <div className="calc wide">
          Net revenue (calculated): <strong>{net == null ? "— (incomplete — will be excluded from totals)" : money(net)}</strong>
          {net != null && <> · Revenue after marketplace fees: <strong>{money(net - pb.marketplace_fees_cents)}</strong></>}
        </div>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
      {r.id && history.data?.events.length > 0 && (
        <details>
          <summary>Change history ({history.data.events.length})</summary>
          <ul className="timeline small">
            {history.data.events.map((h: any, i: number) => (
              <li key={i}><strong>{h.action}</strong> by {h.signer_name} · {dateTime(h.created_at)}
                {h.before && <div className="small-text">{Object.keys(h.after ?? {}).filter((k) => !["recorded_by", "auth_subject"].includes(k)).map((k) => `${k}: ${h.before[k] ?? "—"} → ${h.after[k] ?? "—"}`).join("; ")}</div>}</li>
            ))}
          </ul>
        </details>
      )}
    </Overlay>
  );
}
