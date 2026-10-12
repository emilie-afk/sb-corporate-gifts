import { useState, type FormEvent } from "react";
import { get, post, qs, ApiError } from "../api";
import type { Nav } from "../App";
import { Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, Pill, Loading, Empty, useLoad, useSave, useSigner, rememberSigner, usePref, useDebounced } from "../components/ui";
import { money, parseMoney, dateTime, today } from "../format";
import { parseCsvObjects, prepareCorporateOrdersPayload } from "../../shared/corporateOrders.js";

const FIELD_LABEL: Record<string, string> = { source: "Order source", tags: "Order tags", billing_company: "Billing company" };
const CLASS_LABEL: Record<string, [string, any]> = {
  assigned: ["Assigned", "ok"], unclassified: ["Unclassified", "neutral"], conflict: ["Conflict", "danger"], excluded: ["Excluded (retail)", "neutral"],
};
const RECON_LABEL: Record<string, string> = { needs_review: "Needs review", additional: "Additional off-Shopify revenue", covered_by_shopify: "Already covered by Shopify" };
const KIND_LABEL: Record<string, string> = { off_shopify_sale: "Off-Shopify sale", correction: "Correction", fee: "Marketplace fee" };
const monthLabel = (m: string) => new Date(m.slice(0, 7) + "-15T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export function RevenueScreen({ params }: { params: Record<string, string>; nav: Nav }) {
  const [from, setFrom] = usePref("rv.from", `${new Date().getFullYear()}-01`);
  const [to, setTo] = usePref("rv.to", "");
  const [channel, setChannel] = useState(params.channel ?? "");
  const [modal, setModal] = useState<null | "upload" | "entry">(null);
  const channels = useLoad(() => get("/channels"), []);
  const summary = useLoad(() => get(`/revenue/summary${qs({ from, to, channel_id: channel })}`), [from, to, channel]);
  const imports = useLoad(() => get("/revenue/imports"), []);
  const reload = () => { summary.reload(); imports.reload(); };
  const sm = summary.data;
  const chOpts = (channels.data?.channels ?? []).map((c: any) => [c.id, c.name] as [string, string]);
  const lastOk = imports.data?.last_success ?? [];
  const counts = imports.data?.counts;

  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Revenue</h1>
        <span className="hint">Shopify orders + manual entries · America/Los_Angeles months · totals include inactive channels</span>
        <div className="spacer" />
        <button className="btn small" onClick={() => setModal("upload")}>Upload Shopify report</button>
        <button className="btn primary" onClick={() => setModal("entry")}>Add manual entry</button>
      </div>
      <div className="filters">
        <label className="inline">From <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">To <input type="month" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Select value={channel} onChange={setChannel} options={chOpts} empty="All channels" aria-label="Channel" />
      </div>
      <div className="freshness">
        <span><strong>Last Shopify import:</strong> {lastOk.length ? lastOk.map((l: any) => `${l.source === "collector" ? "collector" : "manual upload"} ${dateTime(l.completed_at)}`).join(" · ") : "none yet"}</span>
        <span><strong>Coverage:</strong> {imports.data?.coverage?.length ? imports.data.coverage.map((c: any) => `${c.from} → ${c.to}`).join(", ") : "no reports imported"}</span>
        {counts && counts.orders > 0 && <span>{counts.orders} orders · {counts.assigned} assigned · {counts.conflicts > 0 ? <span className="warn-text">{counts.conflicts} conflicts</span> : "0 conflicts"} · {counts.unclassified} unclassified · {counts.excluded} excluded</span>}
      </div>
      <ErrorBox error={summary.error} />
      {summary.loading && !sm && <Loading />}
      {sm && (
        <>
          <div className="summary">
            <div><span className="label">Combined net revenue</span><strong>{money(sm.totals.combined_cents)}</strong><span className="hint">gift sales + shipping − refunds</span></div>
            <div><span className="label">From Shopify</span><strong>{money(sm.totals.shopify_cents)}</strong></div>
            <div><span className="label">Manual / adjustments</span><strong>{money(sm.totals.manual_cents)}</strong></div>
            <div><span className="label">Marketplace fees</span><strong>{sm.totals.fees_cents == null ? <span className="unknown">Fees not recorded</span> : money(sm.totals.fees_cents)}</strong>
              {sm.totals.fees_cents != null && sm.totals.fees_recorded_rows < sm.totals.rows && <span className="hint">recorded for {sm.totals.fees_recorded_rows} of {sm.totals.rows} rows</span>}</div>
            <div><span className="label">Orders / units</span><strong>{sm.totals.orders} / {sm.totals.units}</strong></div>
          </div>
          {sm.months.some((m: any) => !m.complete || m.conflicts) && (
            <div className="month-flags">
              {sm.months.filter((m: any) => !m.complete || m.conflicts).map((m: any) => (
                <span key={m.month} className="pill warn">{monthLabel(m.month)}: {!m.complete && (m.covered_days ? `partial coverage ${m.covered_days}/${m.days} days` : "no Shopify report")}{m.conflicts ? `${!m.complete ? " · " : ""}${m.conflicts} conflicting order(s)` : ""}</span>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table className="table dense">
              <thead><tr><th>Month</th><th>Channel</th><th className="num">From Shopify</th><th className="num">Manual</th><th className="num">Combined</th><th className="num">Fees</th><th className="num">After fees</th><th className="num">Orders / units</th><th>Notes</th></tr></thead>
              <tbody>
                {sm.rows.length === 0 && <tr><td colSpan={9}><Empty>No revenue for these filters yet. Shopify orders appear once they are assigned to a channel.</Empty></td></tr>}
                {sm.rows.map((r: any) => (
                  <tr key={`${r.channel_id}|${r.month}`}>
                    <td data-label="Month">{monthLabel(r.month)}</td>
                    <td data-label="Channel">{r.channel_name}{r.marketplace_status && ["on_hold", "rejected", "not_qualified", "inactive"].includes(r.marketplace_status) && <span className="hint"> (inactive)</span>}</td>
                    <td className="num" data-label="From Shopify">{money(r.shopify.net_cents)}</td>
                    <td className="num" data-label="Manual">{r.manual_entries ? money(r.manual_cents) : "—"}</td>
                    <td className="num" data-label="Combined"><strong>{money(r.combined_cents)}</strong></td>
                    <td className="num" data-label="Fees">{r.fees_cents == null ? <span className="unknown">Fees not recorded</span> : money(r.fees_cents)}</td>
                    <td className="num" data-label="After fees">{r.after_fees_cents == null ? "—" : money(r.after_fees_cents)}</td>
                    <td className="num" data-label="Orders / units">{r.shopify.orders} / {r.shopify.units}</td>
                    <td data-label="Notes" className="small-text">{r.warnings.map((w: string, i: number) => <div key={i} className="warn-text">{w}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">“Revenue after marketplace fees” is not gross profit. Fees are actual recorded deductions only — pricing percentages are never used as fees.</p>
        </>
      )}

      <Section title="Shopify matching rules" defaultOpen={false}><RulesPanel channels={chOpts} onChanged={reload} /></Section>
      <Section title="Orders & classification" defaultOpen={false}><OrdersPanel channels={chOpts} onChanged={reload} /></Section>
      <Section title="Manual entries & reconciliation" defaultOpen={false}><ManualPanel onChanged={reload} /></Section>
      <Section title="Import history" count={imports.data?.runs.length} defaultOpen={false}><ImportHistory runs={imports.data?.runs ?? []} /></Section>

      {modal === "upload" && <ShopifyUpload onClose={() => setModal(null)} onDone={reload} />}
      {modal === "entry" && <EntryForm channels={chOpts} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}

// ------------------------------------------------------------- upload
function ShopifyUpload({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [signer, setSigner] = useSigner();
  const [prep, setPrep] = useState<any | null>(null);
  const [exportedAt, setExportedAt] = useState("");
  const [cov, setCov] = useState({ from: "", to: "" });
  const [result, setResult] = useState<any | null>(null);
  const s = useSave();
  const read = async (file: File) => {
    setResult(null);
    const text = await file.text();
    const { headers, rows } = parseCsvObjects(text);
    // The raw export is reduced HERE, in your browser: names, emails, addresses, phones and notes never leave this computer.
    const tmp = prepareCorporateOrdersPayload(rows, { headers, exportedAt: new Date(file.lastModified).toISOString(), coverageFrom: "2000-01-01", coverageTo: "2000-01-01", fileName: file.name });
    if (tmp.refused) { setPrep({ refused: tmp.missingColumns, fileName: file.name }); return; }
    const dates = tmp.payload.orders.map((o) => String(o.createdAt ?? "").slice(0, 10)).filter(Boolean).sort();
    setPrep({ ...tmp, fileName: file.name });
    const lm = new Date(file.lastModified);
    setExportedAt(new Date(lm.getTime() - lm.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    setCov({ from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(async () => {
      const payload = { ...prep.payload, exportedAt: new Date(exportedAt).toISOString(), coverageFrom: cov.from, coverageTo: cov.to };
      setResult((await post("/revenue/imports/manual", { payload, signer_name: signer })).run);
    });
    if (ok) { rememberSigner(signer); onDone(); }
  };
  return (
    <Overlay kind="modal" title="Upload Shopify report" subtitle="Manual fallback / backfill. Uses the same validation and import as the collector." onClose={onClose}>
      <ErrorBox error={s.error} />
      {!result && (
        <form onSubmit={submit} className="form-grid">
          <p className="hint wide">Shopify Admin → Orders → Export (CSV for Excel). The file is reduced in your browser to order amounts, line items and three matching fields (source, tags, billing company) before anything is sent. Use a wider date range here to backfill refunds on older orders outside the collector’s rolling window.</p>
          <Field label="Shopify orders export (.csv)" required wide><input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} /></Field>
          {prep?.refused && <div className="alert error wide">This doesn’t look like a Shopify orders export. Missing columns: {prep.refused.join(", ")}</div>}
          {prep?.payload && (
            <>
              <div className="alert neutral wide">{prep.facts.orderCount} orders from {prep.facts.rowCount} rows · matching fields found: {prep.facts.fields.map((f: string) => FIELD_LABEL[f]).join(", ") || "none"}
                {prep.problems.length > 0 && <div className="warn-text">{prep.problems.length} line title(s) looked like personal data and were removed.</div>}</div>
              <Field label="Report exported at" required hint="When the export was generated. Defaults to the file’s saved time; newer exports win over older ones.">
                <input type="datetime-local" value={exportedAt} onChange={(e) => setExportedAt(e.target.value)} />
              </Field>
              <div />
              <Field label="Export covers orders from" required hint="The export’s date filter (America/Los_Angeles)."><input type="date" value={cov.from} onChange={(e) => setCov({ ...cov, from: e.target.value })} /></Field>
              <Field label="Export covers orders to" required><input type="date" value={cov.to} onChange={(e) => setCov({ ...cov, to: e.target.value })} /></Field>
            </>
          )}
          <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
          <FormActions saving={s.saving} onCancel={onClose} label="Import" disabled={!prep?.payload || !exportedAt || !cov.from || !cov.to} />
        </form>
      )}
      {result && (
        <div className={`alert ${result.status === "failed" ? "error" : "success"}`}>
          <strong>{result.status === "duplicate" ? "Identical report — nothing changed." : result.status === "no_change" ? "No changes." : "Imported."}</strong>{" "}
          {result.orders_new} new · {result.orders_updated} updated · {result.orders_unchanged} unchanged · {result.orders_stale} older/uncertain not applied · {result.orders_rejected} rejected
          {result.warnings?.length > 0 && <details><summary>{result.warnings.length} warning(s)</summary><ul>{result.warnings.slice(0, 50).map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></details>}
          <div className="form-actions"><button className="btn small" onClick={onClose}>Close</button></div>
        </div>
      )}
    </Overlay>
  );
}

// -------------------------------------------------------------- rules
function RulesPanel({ channels, onChanged }: { channels: [string, string][]; onChanged: () => void }) {
  const rules = useLoad(() => get("/revenue/rules"), []);
  const fields = useLoad(() => get("/revenue/rules/fields"), []);
  const [edit, setEdit] = useState<null | { op: string; rule?: any }>(null);
  const done = () => { setEdit(null); rules.reload(); onChanged(); };
  const avail = fields.data?.fields ?? [];
  return (
    <>
      <p className="hint">Rules assign imported Shopify orders to a channel. Case and spacing are ignored. Several rules may point to the same channel; an order matching rules for different channels is a <strong>conflict</strong> and is never assigned automatically. Every change is previewed first.</p>
      {avail.length === 0 && <div className="alert neutral">No Shopify report imported yet — rules can be added once orders arrive (only fields present in the reports are offered).</div>}
      <ErrorBox error={rules.error} />
      {rules.data?.rules.length === 0 && avail.length > 0 && <Empty>No rules yet.</Empty>}
      {rules.data?.rules.length > 0 && (
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Channel</th><th>Rule</th><th className="num">Orders</th><th>Status</th><th>Entered</th><th></th></tr></thead>
            <tbody>
              {rules.data.rules.map((r: any) => (
                <tr key={r.id} className={r.enabled ? "" : "muted-row"}>
                  <td>{r.channel_name}</td>
                  <td>{FIELD_LABEL[r.source_field]} {r.operator === "equals" ? "is exactly" : "contains"} “{r.match_value}”{r.note && <div className="hint">{r.note}</div>}</td>
                  <td className="num">{r.match_count}</td>
                  <td>{r.enabled ? <Pill tone="ok">Enabled</Pill> : <Pill>Disabled</Pill>}</td>
                  <td className="small-text">{r.entered_by} · {dateTime(r.created_at)}{r.updated_by && <div className="hint">changed by {r.updated_by}</div>}</td>
                  <td className="row-actions">
                    <button className="btn ghost small" onClick={() => setEdit({ op: "update", rule: r })}>Edit</button>
                    <button className="btn ghost small" onClick={() => setEdit({ op: r.enabled ? "disable" : "enable", rule: r })}>{r.enabled ? "Disable" : "Enable"}</button>
                    <button className="btn ghost small danger" onClick={() => setEdit({ op: "remove", rule: r })}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {avail.length > 0 && <button className="btn small" onClick={() => setEdit({ op: "create" })}>Add rule</button>}
      {edit && <RuleForm {...edit} channels={channels} fields={avail} onClose={() => setEdit(null)} onDone={done} />}
    </>
  );
}

function RuleForm({ op, rule, channels, fields, onClose, onDone }: { op: string; rule?: any; channels: [string, string][]; fields: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ channel_id: rule?.channel_id ?? "", source_field: rule?.source_field ?? fields[0]?.field ?? "", operator: rule?.operator ?? "equals", match_value: rule?.match_value ?? "", note: rule?.note ?? "" });
  const [preview, setPreview] = useState<any | null>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const editable = op === "create" || op === "update";
  const proposal = () => ({ op, rule_id: rule?.id, ...(editable ? { rule: { ...f, note: f.note || null } } : {}) });
  const doPreview = () => s.run(async () => setPreview(await post("/revenue/rules/preview", proposal())));
  const apply = () => s.run(async () => { await post("/revenue/rules/apply", { ...proposal(), token: preview.token, signer_name: signer }); rememberSigner(signer); onDone(); });
  const top = fields.find((x) => x.field === f.source_field)?.top_values ?? [];
  const title = { create: "Add matching rule", update: "Edit matching rule", enable: "Enable rule", disable: "Disable rule", remove: "Remove rule" }[op];
  return (
    <Overlay kind="modal" title={title} onClose={onClose}>
      <div className="form-grid">
        <ErrorBox error={s.error} />
        {editable ? (
          <>
            <Field label="Channel" required><Select value={f.channel_id} onChange={(v) => { setF({ ...f, channel_id: v }); setPreview(null); }} options={channels} empty="Choose…" /></Field>
            <Field label="Source field" required><Select value={f.source_field} onChange={(v) => { setF({ ...f, source_field: v }); setPreview(null); }} options={fields.map((x) => [x.field, x.label])} /></Field>
            <Field label="Operator" required><Select value={f.operator} onChange={(v) => { setF({ ...f, operator: v }); setPreview(null); }} options={[["equals", "Exact match"], ["contains", "Contains"]]} /></Field>
            <Field label="Match value" required hint="Case-insensitive; extra spaces ignored. No wildcards or regex.">
              <input list="rule-values" value={f.match_value} onChange={(e) => { setF({ ...f, match_value: e.target.value }); setPreview(null); }} />
              <datalist id="rule-values">{top.map((t: any) => <option key={t.v} value={t.v}>{t.n} orders</option>)}</datalist>
            </Field>
            <Field label="Note (optional)" wide><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          </>
        ) : <p className="wide">{FIELD_LABEL[rule.source_field]} {rule.operator === "equals" ? "is exactly" : "contains"} “{rule.match_value}” → {rule.channel_name}</p>}
        {!preview && <div className="form-actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={s.saving || (editable && (!f.channel_id || !f.match_value.trim()))} onClick={doPreview}>{s.saving ? "Checking…" : "Preview impact"}</button></div>}
      </div>
      {preview && (
        <div className="impact">
          <ul className="stats">
            {editable && <li><strong>{preview.rule_matches.count}</strong> orders match this rule</li>}
            <li><strong>{preview.moved.count}</strong> orders change channel/state</li>
            <li className={preview.new_conflicts.count ? "warn-text" : ""}><strong>{preview.new_conflicts.count}</strong> new conflicts</li>
            <li><strong>{preview.manual_overrides_kept.count}</strong> keep their manual decision</li>
            <li>Months affected: {preview.affected_months.length ? preview.affected_months.map(monthLabel).join(", ") : "none"}</li>
          </ul>
          {editable && preview.rule_matches.sample.length > 0 && (
            <details open><summary>Sample matching orders</summary>
              <table className="table compact"><thead><tr><th>Order</th><th>Date</th><th>Matched value</th><th className="num">Net</th></tr></thead>
                <tbody>{preview.rule_matches.sample.map((x: any) => <tr key={x.order}><td>{x.order}</td><td>{x.date}</td><td>{x.value}</td><td className="num">{money(x.net_revenue_cents)}{!x.counted && <span className="hint"> (not counted)</span>}</td></tr>)}</tbody></table>
            </details>
          )}
          {preview.moved.sample.length > 0 && (
            <details open><summary>Orders moving</summary>
              <table className="table compact"><thead><tr><th>Order</th><th>Date</th><th>From</th><th>To</th><th className="num">Net</th></tr></thead>
                <tbody>{preview.moved.sample.map((x: any) => <tr key={x.id}><td>{x.order}</td><td>{x.date}</td><td>{x.from}</td><td>{x.to}</td><td className="num">{money(x.net_revenue_cents)}</td></tr>)}</tbody></table>
            </details>
          )}
          {preview.new_conflicts.sample.length > 0 && <div className="alert warn">Conflicts: {preview.new_conflicts.sample.map((x: any) => `${x.order} (${x.channels.join(" vs ")})`).join(", ")}. Conflicting orders stay unassigned until resolved.</div>}
          <div className="form-grid">
            <SignerField value={signer} onChange={setSigner} />
            <div className="form-actions"><button className="btn ghost" onClick={() => setPreview(null)}>Back</button><button className="btn primary" disabled={s.saving || !signer.trim()} onClick={apply}>{s.saving ? "Applying…" : "Confirm and apply"}</button></div>
          </div>
        </div>
      )}
    </Overlay>
  );
}

// ------------------------------------------------------------- orders
function OrdersPanel({ channels, onChanged }: { channels: [string, string][]; onChanged: () => void }) {
  const [status, setStatus] = useState("unclassified");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [monthF, setMonthF] = useState("");
  const [offset, setOffset] = useState(0);
  const [act, setAct] = useState<any | null>(null);
  const list = useLoad(() => get(`/revenue/orders${qs({ status, q: dq, month: monthF, limit: 50, offset })}`), [status, dq, monthF, offset]);
  return (
    <>
      <p className="hint">Purchases of gift products are not assumed to be corporate. Unclassified orders are normal retail until a rule or a person assigns them.</p>
      <div className="filters">
        <Select value={status} onChange={(v) => { setStatus(v); setOffset(0); }} options={Object.entries(CLASS_LABEL).map(([k, v]) => [k, v[0]])} empty="All orders" />
        <input type="month" value={monthF} onChange={(e) => { setMonthF(e.target.value); setOffset(0); }} aria-label="Month" />
        <input type="search" placeholder="Order #, source, tag or company" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </div>
      <ErrorBox error={list.error} />
      {list.data && (
        <>
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th>Order</th><th>Date</th><th className="num">Net</th><th>Matching values</th><th>Classification</th><th></th></tr></thead>
              <tbody>
                {list.data.orders.length === 0 && <tr><td colSpan={6}><Empty>No orders.</Empty></td></tr>}
                {list.data.orders.map((o: any) => (
                  <tr key={o.id}>
                    <td>{o.order_name}{o.revenue_status !== "counted" && <div className="hint">{o.revenue_status} — not counted</div>}{o.awaiting_payment && <div className="hint">awaiting payment</div>}</td>
                    <td>{o.order_date}</td>
                    <td className="num">{money(o.net_revenue_cents)}</td>
                    <td className="small-text">{[o.match_fields.source && `source: ${o.match_fields.source}`, o.match_fields.billing_company && `company: ${o.match_fields.billing_company}`, o.match_fields.tags?.length && `tags: ${o.match_fields.tags.join(", ")}`].filter(Boolean).join(" · ") || "—"}</td>
                    <td><Pill tone={CLASS_LABEL[o.class_status][1]}>{CLASS_LABEL[o.class_status][0]}</Pill> {o.channel_name}{o.class_manual && <div className="hint">manual · {o.manual_by}: {o.manual_reason}</div>}</td>
                    <td className="row-actions">
                      <button className="btn ghost small" onClick={() => setAct({ o, action: "assign" })}>Assign</button>
                      {o.class_status !== "excluded" && <button className="btn ghost small" onClick={() => setAct({ o, action: "exclude" })}>Exclude</button>}
                      {o.class_manual && <button className="btn ghost small" onClick={() => setAct({ o, action: "clear" })}>Clear manual</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button className="btn ghost small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>← Prev</button>
            <span className="hint">{list.data.total ? `${offset + 1}–${Math.min(offset + 50, list.data.total)} of ${list.data.total}` : "0"}</span>
            <button className="btn ghost small" disabled={offset + 50 >= list.data.total} onClick={() => setOffset(offset + 50)}>Next →</button>
          </div>
        </>
      )}
      {act && <ClassifyForm {...act} channels={channels} onClose={() => setAct(null)} onSaved={() => { setAct(null); list.reload(); onChanged(); }} />}
    </>
  );
}

function ClassifyForm({ o, action, channels, onClose, onSaved }: { o: any; action: string; channels: [string, string][]; onClose: () => void; onSaved: () => void }) {
  const [channelId, setChannelId] = useState(o.channel_id ?? "");
  const [reason, setReason] = useState("");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post(`/revenue/orders/${o.id}/classify`, { action, channel_id: action === "assign" ? channelId : undefined, reason, version: o.version, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={`${action === "assign" ? "Assign" : action === "exclude" ? "Exclude" : "Clear manual decision for"} ${o.order_name}`} subtitle={action === "clear" ? "The order goes back to the matching rules." : "A manual decision overrides the rules until it is cleared."} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {action === "assign" && <Field label="Channel" required error={s.fe("channel_id")}><Select value={channelId} onChange={setChannelId} options={channels} empty="Choose…" /></Field>}
        {action !== "clear" && <Field label="Reason" required wide error={s.fe("reason")}><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action === "exclude" ? "e.g. ordinary retail order" : "e.g. confirmed on partner invoice"} /></Field>}
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------- manual
function ManualPanel({ onChanged }: { onChanged: () => void }) {
  const legacy = useLoad(() => get("/revenue/monthly"), []);
  const adj = useLoad(() => get("/revenue/adjustments"), []);
  const [rec, setRec] = useState<any | null>(null);
  const [voiding, setVoiding] = useState<any | null>(null);
  const reload = () => { legacy.reload(); adj.reload(); onChanged(); };
  return (
    <>
      <p className="hint">Manual entries are for off-Shopify sales, explicit corrections and actual marketplace fees. Older monthly totals may duplicate Shopify sales: they stay out of totals until someone marks them “additional” or “already covered by Shopify”.</p>
      <h3 className="subhead">Monthly totals entered before Shopify import</h3>
      {legacy.data?.revenue.length === 0 && <Empty>None.</Empty>}
      {legacy.data?.revenue.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Month</th><th>Channel</th><th className="num">Net</th><th className="num">Fees</th><th>Reconciliation</th><th></th></tr></thead>
          <tbody>
            {legacy.data.revenue.map((r: any) => (
              <tr key={r.id}>
                <td>{r.reporting_month}</td><td>{r.channel_name}</td>
                <td className="num">{r.complete ? money(r.net_revenue_cents) : <Pill tone="warn">Incomplete</Pill>}</td>
                <td className="num">{r.marketplace_fees_cents == null ? "—" : money(r.marketplace_fees_cents)}</td>
                <td><Pill tone={r.reconciliation === "needs_review" ? "warn" : "neutral"}>{RECON_LABEL[r.reconciliation]}</Pill>{r.reconciliation_note && <div className="hint">{r.reconciliation_note} · {r.reconciled_by}</div>}</td>
                <td><button className="btn ghost small" onClick={() => setRec(r)}>Reconcile</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="subhead">Manual entries</h3>
      {adj.data?.adjustments.length === 0 && <Empty>None.</Empty>}
      {adj.data?.adjustments.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Month</th><th>Channel</th><th>Kind</th><th className="num">Revenue</th><th className="num">Fee</th><th>Reference / reason</th><th></th></tr></thead>
          <tbody>
            {adj.data.adjustments.map((a: any) => (
              <tr key={a.id}>
                <td>{a.reporting_month.slice(0, 7)}</td><td>{a.channel_name}</td><td>{KIND_LABEL[a.kind]}</td>
                <td className="num">{a.kind === "fee" ? "—" : money(Number(a.gift_sales_cents ?? 0) + Number(a.shipping_revenue_cents ?? 0) - Number(a.refunds_cents ?? 0))}</td>
                <td className="num">{a.marketplace_fees_cents == null ? "—" : money(a.marketplace_fees_cents)}</td>
                <td className="small-text">{a.reference} · {a.reason}<div className="hint">{a.signer_name} · {a.entry_date}</div></td>
                <td><button className="btn ghost small danger" onClick={() => setVoiding(a)}>Void</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rec && <ReconcileForm r={rec} onClose={() => setRec(null)} onSaved={() => { setRec(null); reload(); }} />}
      {voiding && <VoidForm a={voiding} onClose={() => setVoiding(null)} onSaved={() => { setVoiding(null); reload(); }} />}
    </>
  );
}

function ReconcileForm({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(r.reconciliation);
  const [note, setNote] = useState(r.reconciliation_note ?? "");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await s.run(() => post(`/revenue/monthly/${r.id}/reconcile`, { reconciliation: value, note, version: r.version, signer_name: signer }))) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={`Reconcile ${r.channel_name} — ${r.reporting_month}`} subtitle={r.complete ? `Recorded net ${money(r.net_revenue_cents)}` : "Incomplete record"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="This monthly total is" required wide><Select value={value} onChange={setValue} options={RECON_LABEL} /></Field>
        <Field label="Explanation / reference" required={value !== "needs_review"} wide error={s.fe("note")}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. invoice INV-…, or ‘same orders as Shopify #…’" /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

function VoidForm({ a, onClose, onSaved }: { a: any; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState("");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await s.run(() => post(`/revenue/adjustments/${a.id}/void`, { reason, version: a.version, signer_name: signer }))) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title="Void manual entry" subtitle={`${a.reference} — the entry stays in history`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Reason" required wide error={s.fe("reason")}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label="Void" />
      </form>
    </Overlay>
  );
}

function EntryForm({ channels, onClose, onSaved }: { channels: [string, string][]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ channel_id: "", reporting_month: "", kind: "off_shopify_sale", order_count: "", units_sold: "", gift: "", ship: "", refunds: "", fees: "", reason: "", reference: "", entry_date: today() });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const [errs, setErrs] = useState<Record<string, string>>({});
  const neg = f.kind === "correction";
  const money2 = (v: string, k: string, e: Record<string, string>) => {
    const t = v.trim();
    if (!t) return null;
    const isNeg = neg && t.startsWith("-");
    const c = parseMoney(isNeg ? t.slice(1) : t);
    if (c == null || Number.isNaN(c)) { e[k] = neg ? "Amount like 12.50 or -12.50" : "Amount like 12.50"; return null; }
    return isNeg ? -c : c;
  };
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    const body = {
      channel_id: f.channel_id, reporting_month: f.reporting_month, kind: f.kind, reason: f.reason, reference: f.reference, entry_date: f.entry_date,
      order_count: f.order_count === "" ? null : Number(f.order_count), units_sold: f.units_sold === "" ? null : Number(f.units_sold),
      gift_sales_cents: money2(f.gift, "gift", e), shipping_revenue_cents: money2(f.ship, "ship", e), refunds_cents: money2(f.refunds, "refunds", e),
      marketplace_fees_cents: money2(f.fees, "fees", e), signer_name: signer,
    };
    setErrs(e);
    if (Object.keys(e).length) return;
    if (await s.run(() => post("/revenue/adjustments", body))) { rememberSigner(signer); onSaved(); }
  };
  const fe = (k: string, api?: string) => errs[k] ?? s.fe(api ?? k);
  return (
    <Overlay kind="modal" title="Add manual entry" subtitle="For off-Shopify sales, explicit corrections or actual marketplace fees. Shopify orders are imported automatically." onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error as ApiError | null} />
        <Field label="Kind" required><Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={KIND_LABEL} /></Field>
        <Field label="Channel" required error={fe("channel_id")}><Select value={f.channel_id} onChange={(v) => setF({ ...f, channel_id: v })} options={channels} empty="Choose…" /></Field>
        <Field label="Reporting month" required error={fe("reporting_month")}><input type="month" value={f.reporting_month} onChange={(e) => setF({ ...f, reporting_month: e.target.value })} /></Field>
        <Field label="Entry date" required error={fe("entry_date")}><input type="date" value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></Field>
        {f.kind !== "fee" && (
          <>
            <Field label="Gift sales (USD)" error={fe("gift", "gift_sales_cents")} hint={neg ? "May be negative for a correction." : "After discounts; blank = not part of this entry."}><input inputMode="decimal" value={f.gift} onChange={(e) => setF({ ...f, gift: e.target.value })} /></Field>
            <Field label="Shipping revenue (USD)" error={fe("ship", "shipping_revenue_cents")}><input inputMode="decimal" value={f.ship} onChange={(e) => setF({ ...f, ship: e.target.value })} /></Field>
            <Field label="Refunds (USD)" error={fe("refunds", "refunds_cents")}><input inputMode="decimal" value={f.refunds} onChange={(e) => setF({ ...f, refunds: e.target.value })} /></Field>
            <Field label="Orders / units (optional)"><div className="row-gap"><input inputMode="numeric" value={f.order_count} onChange={(e) => setF({ ...f, order_count: e.target.value })} placeholder="orders" /><input inputMode="numeric" value={f.units_sold} onChange={(e) => setF({ ...f, units_sold: e.target.value })} placeholder="units" /></div></Field>
          </>
        )}
        <Field label="Marketplace fees (USD)" required={f.kind === "fee"} error={fe("fees", "marketplace_fees_cents")} hint="Actual deductions recorded on a statement — not an estimate from pricing."><input inputMode="decimal" value={f.fees} onChange={(e) => setF({ ...f, fees: e.target.value })} /></Field>
        <Field label="Reference" required error={fe("reference")} hint="Invoice, statement or order ID."><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Reason" required wide error={fe("reason")}><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

function ImportHistory({ runs }: { runs: any[] }) {
  if (!runs.length) return <Empty>No imports yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead><tr><th>Started</th><th>Source</th><th>Coverage</th><th>Status</th><th>Counts</th><th>Notes</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{dateTime(r.started_at)}<div className="hint">export {dateTime(r.exported_at)}{r.chronology === "declared" ? " (declared)" : ""}</div></td>
              <td>{r.source === "collector" ? "Collector" : `Manual — ${r.signer_name}`}{r.file_name && <div className="hint">{r.file_name}</div>}</td>
              <td>{r.coverage_from} → {r.coverage_to}</td>
              <td><Pill tone={r.status === "failed" ? "danger" : r.status === "completed" ? "ok" : "neutral"}>{r.status}</Pill></td>
              <td className="small-text">{r.orders_received} received · {r.orders_new} new · {r.orders_updated} updated · {r.orders_unchanged} unchanged · {r.orders_stale} not applied · {r.orders_rejected} rejected</td>
              <td className="small-text">{(r.errors ?? []).map((e: any, i: number) => <div key={i} className="field-error">{e.message}</div>)}
                {(r.warnings ?? []).length > 0 && <details><summary>{r.warnings.length} warning(s)</summary><ul>{r.warnings.slice(0, 30).map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></details>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
