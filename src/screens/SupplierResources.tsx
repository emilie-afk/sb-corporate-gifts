import { useState, type FormEvent } from "react";
import { get, post, patch } from "../api";
import type { Nav } from "../App";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, usePref,
} from "../components/ui";
import { PROVIDER_LABEL, CONFIRM_LABEL, STATUS_LABEL, REASON_LABEL, INACTIVE, dateTime, today } from "../format";

// --------------------------------------------------------------- labels
export const SECTION_LABEL: Record<string, string> = {
  catalogs_pricing: "Catalogs and pricing",
  gift_terms: "Gift options and terms",
  assets_documents: "Assets and documents",
  decisions_followups: "Decisions and follow-ups",
};
const SECTION_HELP: Record<string, string> = {
  catalogs_pricing: "Catalogs, availability lists, quotes and price sheets, with effective dates.",
  gift_terms: "Sample options, minimum quantities, customization, lead times, shipping methods and order cutoffs.",
  assets_documents: "Product photos, logos, packaging guides, proofs and order forms.",
  decisions_followups: "Confirmed decisions about this marketplace, linked to open actions or requirements.",
};
export const TYPE_LABEL: Record<string, [string, string]> = {
  catalog: ["Catalog", "catalogs_pricing"], availability_list: ["Availability list", "catalogs_pricing"], quote: ["Quote", "catalogs_pricing"], price_sheet: ["Price sheet", "catalogs_pricing"],
  sample_option: ["Sample option", "gift_terms"], minimum_quantity: ["Minimum quantity", "gift_terms"], customization: ["Customization", "gift_terms"],
  lead_time: ["Lead time", "gift_terms"], shipping_method: ["Shipping method", "gift_terms"], order_cutoff: ["Order cutoff", "gift_terms"], other_term: ["Other term", "gift_terms"],
  product_photos: ["Product photos", "assets_documents"], logo: ["Logo", "assets_documents"], packaging_guide: ["Packaging guide", "assets_documents"],
  proof: ["Proof", "assets_documents"], order_form: ["Order form", "assets_documents"], other_document: ["Other document", "assets_documents"],
  decision: ["Decision", "decisions_followups"], follow_up: ["Follow-up", "decisions_followups"],
};
const SAMPLE_LABEL: Record<string, string> = { requested: "Requested", approved: "Approved", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };
const ACTION_KIND: Record<string, string> = { action: "Action", blocker: "Blocker", decision: "Decision" };
const ACTION_STATUS: Record<string, string> = { open: "Open", done: "Done", cancelled: "Cancelled" };
const CHANNEL_LABEL: Record<string, string> = { seo: "#seo", teammarketing: "#teammarketing" };
export const APPLICATION_LABEL: Record<string, string> = {
  not_applied: "Not applied", preparing: "Preparing", submitted: "Submitted", under_review: "Under review",
  approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn",
};
const FIELD_LABEL: Record<string, string> = { relationship_status: "Relationship status", application_status: "Application status", application_date: "Application date" };
const DELIVERY_LABEL: Record<string, [string, string]> = {
  pending: ["Waiting for the dashboard", "warn"], in_review: ["In review (Marketing Dashboard)", "info"], delivered: ["In Task Tracker", "ok"],
  failed: ["Delivery failed", "danger"], dismissed: ["Dismissed", "neutral"],
};
const fmtValue = (field: string, v: string | null) => v == null ? "not set" : field === "relationship_status" ? (STATUS_LABEL[v] ?? v) : field === "application_status" ? (APPLICATION_LABEL[v] ?? v) : v;

// View keys are kept from Supplier Resources so existing links (?tab=resources&view=suppliers…) still work.
type View = "suppliers" | "review" | "followups" | "samples" | "scans";
const VIEWS: [View, string][] = [["suppliers", "By marketplace"], ["review", "Review queue"], ["followups", "Tasks"], ["samples", "Sample boxes"], ["scans", "Slack scans"]];

const ExtLink = ({ href, children }: { href: string | null; children: React.ReactNode }) =>
  href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : null;

export function SupplierResourcesScreen({ params, nav }: { params: Record<string, string>; nav: Nav }) {
  const view = (VIEWS.some(([v]) => v === params.view) ? params.view : "suppliers") as View;
  const go = (v: View, extra: Record<string, string> = {}) => nav("resources", { view: v, ...extra });
  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Marketplace Resources</h1>
        <div className="spacer" />
        <div className="segmented" role="tablist" aria-label="Marketplace Resources views">
          {VIEWS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={`btn small ${view === v ? "primary" : "ghost"}`} onClick={() => go(v)}>{label}</button>
          ))}
        </div>
      </div>
      {view === "suppliers" && <BySupplier selected={params.supplier ?? ""} onSelect={(s) => go("suppliers", s ? { supplier: s } : {})} nav={nav} />}
      {view === "review" && <ReviewQueue />}
      {view === "followups" && <FollowUps />}
      {view === "samples" && <Samples />}
      {view === "scans" && <SlackScans />}
    </div>
  );
}

// ---------------------------------------------------------- by marketplace
// The partner list is Corporate Gifts → Marketplaces: records that sell, or are being pursued to sell, our corporate
// gifts. A record whose sales role is unclear is shown but stays out of the Slack scan until someone confirms it.
function BySupplier({ selected, onSelect, nav }: { selected: string; onSelect: (ref: string) => void; nav: Nav }) {
  const list = useLoad(() => get("/suppliers"), []);
  const rows = list.data ? list.data.partners : [];
  return (
    <div className="split">
      <aside className="split-list">
        {list.loading && !list.data && <Loading />}
        <ErrorBox error={list.error} />
        <ul className="pick-list">
          {rows.map((r: any) => (
            <li key={r.ref}>
              <button className={selected === r.ref ? "active" : ""} onClick={() => onSelect(r.ref)}>
                <strong>{r.name}</strong> <span className="hint">{PROVIDER_LABEL[r.provider_type]}{r.sales_role === "unclear" ? " · role unclear" : ""}</span>
                <span className="count">{r.current_resources}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="hint">Product suppliers are not listed here. To add a marketplace, use Marketplaces.</p>
      </aside>
      <div className="split-detail">
        {selected ? <SupplierDetail supplier={selected} nav={nav} onChanged={list.reload} /> : <Empty>Choose a marketplace to see its resources.</Empty>}
      </div>
    </div>
  );
}

function SupplierDetail({ supplier, nav, onChanged }: { supplier: string; nav: Nav; onChanged: () => void }) {
  const d = useLoad(() => get(`/supplier-resources?supplier=${encodeURIComponent(supplier)}`), [supplier]);
  const [edit, setEdit] = useState<{ r: any; section?: string; replacing?: any } | null>(null);
  const reload = () => { d.reload(); onChanged(); };
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const s = d.data.supplier;
  if (s.kind !== "partner") return <Empty>Product suppliers are not part of Marketplace Resources.</Empty>;
  const bySection = (sec: string, status: string) => d.data.resources.filter((r: any) => r.section === sec && r.status === status);
  const openTasks = d.data.tasks.filter((t: any) => t.slack_status === "open" && t.tracker_status !== "done");
  return (
    <div>
      <div className="toolbar">
        <h2>{s.name}</h2>
        <span className="row-gap hint">
          {STATUS_LABEL[s.status] ?? s.status}
          {s.application_status && <> · Application: {APPLICATION_LABEL[s.application_status]}{s.application_date ? ` (${s.application_date})` : ""}</>}
          {s.sales_role === "unclear" && <Pill tone="warn">Sales role unclear: not scanned</Pill>}
        </span>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => nav("marketplaces", { m: s.id })}>Open marketplace record →</button>
      </div>
      {Object.keys(SECTION_LABEL).map((sec) => {
        const current = bySection(sec, "current"), old = bySection(sec, "superseded");
        return (
          <Section key={sec} title={SECTION_LABEL[sec]} count={current.length}
            actions={<button className="btn small" onClick={() => setEdit({ r: {}, section: sec })}>Add</button>}>
            <p className="hint">{SECTION_HELP[sec]}</p>
            {current.length === 0 && <Empty>Nothing recorded yet.</Empty>}
            <ResourceList items={current} onEdit={(r) => setEdit({ r })} onReplace={(r) => setEdit({ r: { resource_type: r.resource_type, title: r.title, series_key: r.series_key }, replacing: r })} />
            {old.length > 0 && (
              <details className="history">
                <summary>Superseded ({old.length})</summary>
                <ResourceList items={old} onEdit={(r) => setEdit({ r })} />
              </details>
            )}
          </Section>
        );
      })}
      <Section title="Corporate Gifts tasks" count={openTasks.length} defaultOpen={d.data.tasks.length > 0}>
        <p className="hint">Tasks are reviewed and assigned in the Marketing Dashboard, then appear in Marketing Tasks (Task Tracker).</p>
        {d.data.tasks.length === 0 && <Empty>No tasks for this marketplace.</Empty>}
        <TaskList tasks={d.data.tasks} />
      </Section>
      {(d.data.actions.length > 0 || d.data.samples.length > 0) && (
        <Section title="Other follow-ups and samples" count={d.data.actions.filter((a: any) => a.status === "open").length} defaultOpen={false}>
          <ul className="timeline">
            {d.data.actions.map((a: any) => <li key={a.id}><Pill tone={a.kind === "blocker" ? "danger" : "neutral"}>{ACTION_KIND[a.kind]}</Pill> {a.title} <span className="hint">· {ACTION_STATUS[a.status]}{a.owner && ` · ${a.owner}`}{a.due_date && ` · due ${a.due_date}`}</span></li>)}
            {d.data.samples.map((x: any) => <li key={x.id}><Pill tone="info">Sample</Pill> {x.label} <span className="hint">· {SAMPLE_LABEL[x.status]}{x.status_on && ` ${x.status_on}`}</span></li>)}
          </ul>
        </Section>
      )}
      {edit && <ResourceForm supplier={supplier} data={d.data} r={edit.r} section={edit.section} replacing={edit.replacing}
        onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function TaskList({ tasks, onRetry, onDismiss }: { tasks: any[]; onRetry?: (t: any) => void; onDismiss?: (t: any) => void }) {
  return (
    <ul className="timeline">
      {tasks.map((t) => {
        const [label, tone] = DELIVERY_LABEL[t.delivery_status] ?? [t.delivery_status, "neutral"];
        return (
          <li key={t.id}>
            <div className="row-gap">
              <strong>{t.title}</strong>
              <Pill tone={tone as any}>{label}</Pill>
              {t.tracker_status === "done" && <Pill tone="ok">Done in Task Tracker</Pill>}
              {t.slack_status !== "open" && <Pill>{t.slack_status === "done" ? "Done (Slack)" : "Cancelled (Slack)"}</Pill>}
              {t.overdue && <Pill tone="danger">Overdue</Pill>}
              <span className="spacer" />
              {t.tracker_open_url && <ExtLink href={t.tracker_open_url}>Open in Task Tracker</ExtLink>}
              {onRetry && t.delivery_status === "failed" && <button className="btn small" onClick={() => onRetry(t)}>Retry delivery</button>}
              {onDismiss && ["pending", "in_review", "failed"].includes(t.delivery_status) && <button className="btn ghost small" onClick={() => onDismiss(t)}>Dismiss</button>}
            </div>
            {t.brief && <div className="pre">{t.brief}</div>}
            <div className="hint">
              {(t.marketplace_names ?? []).join(", ")}
              {(t.tracker_assignee || t.owner_hint) && <> · Owner: {t.tracker_assignee ?? `${t.owner_hint} (from Slack)`}</>}
              {(t.tracker_due_date || t.due_date) && <> · Due {t.tracker_due_date ?? t.due_date}</>}
              {t.delivery_error && <> · {t.delivery_error}</>}
              {(t.source_refs ?? []).map((x: any, n: number) => <span key={n}> · <ExtLink href={x.permalink}>{CHANNEL_LABEL[x.channel] ?? x.channel} {x.date ?? ""}</ExtLink></span>)}
              {" · "}{t.origin === "slack" ? "From Slack" : `Added by ${t.created_by}`}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ResourceList({ items, onEdit, onReplace }: { items: any[]; onEdit: (r: any) => void; onReplace?: (r: any) => void }) {
  return (
    <ul className="timeline">
      {items.map((r) => (
        <li key={r.id}>
          <div className="row-gap">
            <Pill>{TYPE_LABEL[r.resource_type]?.[0] ?? r.resource_type}</Pill>
            <strong>{r.link_url ? <ExtLink href={r.link_url}>{r.title}</ExtLink> : r.title}</strong>
            {r.status === "superseded" && <Pill tone="warn">Superseded</Pill>}
            {r.origin === "slack" && <Pill tone="info">From Slack</Pill>}
            <span className="spacer" />
            {onReplace && <button className="btn ghost small" onClick={() => onReplace(r)}>Replace</button>}
            <button className="btn ghost small" onClick={() => onEdit(r)}>Edit</button>
          </div>
          {r.note && <div className="pre">{r.note}</div>}
          <div className="hint">
            {r.effective_date && <>Effective {r.effective_date} · </>}
            Last confirmed {r.last_confirmed_on ?? "—"}
            {r.source_url && <> · <ExtLink href={r.source_url}>Source message</ExtLink></>}
            {r.requirement_text && <> · Requirement: {r.requirement_text} ({CONFIRM_LABEL[r.requirement_state]})</>}
            {r.action_title && <> · Action: {r.action_title} ({ACTION_STATUS[r.action_status]}{r.action_due ? `, due ${r.action_due}` : ""})</>}
            {r.status === "superseded" && r.superseded_at && <> · Superseded {dateTime(r.superseded_at)}</>}
            {" · "}Added by {r.created_by}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ResourceForm({ supplier, data, r, section, replacing, onClose, onSaved }: {
  supplier: string; data: any; r: any; section?: string; replacing?: any; onClose: () => void; onSaved: () => void;
}) {
  const types = Object.entries(TYPE_LABEL).filter(([, [, sec]]) => !section || sec === section).map(([k, [l]]) => [k, l] as [string, string]);
  const [f, setF] = useState({
    resource_type: r.resource_type ?? types[0][0], title: r.title ?? "", link_url: r.link_url ?? "", note: r.note ?? "", source_url: r.source_url ?? "",
    effective_date: r.effective_date ?? "", last_confirmed_on: r.last_confirmed_on ?? (r.id ? "" : today()), series_key: r.series_key ?? "",
    requirement_id: r.requirement_id ?? "", action_id: r.action_id ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  // Blank optional fields are sent as null (never as an empty date or id).
  const body = { ...f, effective_date: f.effective_date || null, last_confirmed_on: f.last_confirmed_on || null,
    requirement_id: f.requirement_id || null, action_id: f.action_id || null, signer_name: signer };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => r.id
      ? patch(`/supplier-resources/${r.id}`, { ...body, version: r.version })
      : post("/supplier-resources", { ...body, supplier, supersedes_id: replacing?.id ?? null }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const openActions = data.actions.filter((a: any) => a.status === "open" || a.id === f.action_id);
  return (
    <Overlay kind="modal" title={replacing ? `Replace "${replacing.title}"` : r.id ? "Edit resource" : "Add resource"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {replacing && <p className="hint wide">The earlier version is marked Superseded and stays in this supplier's history.</p>}
        <Field label="Type" required><Select value={f.resource_type} onChange={(v) => setF({ ...f, resource_type: v })} options={types} /></Field>
        <Field label="Title" required error={s.fe("title")}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} /></Field>
        <Field label="Link" error={s.fe("link_url")} hint="Drive, sheet, PDF or page."><input type="url" value={f.link_url} onChange={(e) => setF({ ...f, link_url: e.target.value })} /></Field>
        <Field label="Source message link" error={s.fe("source_url")} hint="Slack or email link that confirms it, if any."><input type="url" value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} /></Field>
        <Field label="Effective date" error={s.fe("effective_date")} hint="Only when stated."><input type="date" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} /></Field>
        <Field label="Last confirmed" error={s.fe("last_confirmed_on")}><input type="date" value={f.last_confirmed_on} onChange={(e) => setF({ ...f, last_confirmed_on: e.target.value })} /></Field>
        {data.requirements.length > 0 && (
          <Field label="Linked requirement"><Select value={f.requirement_id} onChange={(v) => setF({ ...f, requirement_id: v })} empty="None"
            options={data.requirements.map((q: any) => [q.id, q.requirement.slice(0, 80)] as [string, string])} /></Field>
        )}
        {openActions.length > 0 && (
          <Field label="Linked action"><Select value={f.action_id} onChange={(v) => setF({ ...f, action_id: v })} empty="None"
            options={openActions.map((a: any) => [a.id, a.title.slice(0, 80)] as [string, string])} /></Field>
        )}
        <Field label="Short note" wide error={s.fe("note")}><textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={2000} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label={replacing ? "Save replacement" : "Save"} />
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------- review queue
// Only conflicts that block one specific change on a marketplace come here. Each choice applies that change; the
// item closes when the change is saved or when someone dismisses it.
function ReviewQueue() {
  const [status, setStatus] = usePref("res.review", "open");
  const d = useLoad(() => get(`/review-items?status=${status}`), [status]);
  const [decide, setDecide] = useState<{ item: any; option: number | null } | null>(null);
  return (
    <>
      <p className="hint">Conflicting Slack evidence about a marketplace field. Nothing has changed the record yet.</p>
      <div className="filters"><Select value={status} onChange={setStatus} options={{ open: "Open", resolved: "Applied", dismissed: "Dismissed", all: "All" }} aria-label="Review status" /></div>
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {d.data && d.data.items.length === 0 && <Empty>No items.</Empty>}
      <ul className="timeline">
        {d.data?.items.map((i: any) => (
          <li key={i.id}>
            <div className="row-gap">
              <Pill tone="warn">{i.format === 2 ? FIELD_LABEL[i.field] ?? "Conflict" : i.kind}</Pill>
              <strong>{i.title}</strong> {i.supplier_hint && <span className="hint">· {i.supplier_hint}</span>}
              <span className="spacer" />
              {i.status !== "open" && <Pill>{i.resolution === "applied" ? "Applied" : i.resolution === "replaced" ? "Replaced" : i.resolution === "out_of_scope" ? "Out of scope" : "Dismissed"}</Pill>}
            </div>
            {i.summary && <div className="pre">{i.summary}</div>}
            {i.format === 2 ? (
              <div className="hint">
                <strong>{FIELD_LABEL[i.field]}</strong>: current value {fmtValue(i.field, i.current_value)}. Competing values:
                {i.options.map((o: any, n: number) => <span key={n}> {n > 0 && "vs"} <strong>{fmtValue(i.field, o.change.to)}</strong>
                  {(o.sources ?? []).map((x: any, k: number) => <span key={k}> (<ExtLink href={x.permalink}>{CHANNEL_LABEL[x.channel] ?? x.channel} {x.date ?? ""}</ExtLink>)</span>)}</span>)}
              </div>
            ) : <div><strong>Question:</strong> {i.question}</div>}
            <div className="hint">
              {i.sources.map((x: any, n: number) => <span key={n}>{n > 0 && " · "}<ExtLink href={x.permalink}>{CHANNEL_LABEL[x.channel] ?? x.channel} {x.date ?? ""}</ExtLink></span>)}
              {i.resolution_note && <> · {i.resolution_note} ({i.resolved_by})</>}
            </div>
            {i.status === "open" && (
              <div className="row-gap">
                {i.format === 2 && i.options.map((o: any, n: number) => <button key={n} className="btn small primary" onClick={() => setDecide({ item: i, option: n })}>{
                  i.field === "application_date" ? `Apply date: ${o.change.to}` : `Apply status: ${fmtValue(i.field, o.change.to)}`}</button>)}
                <button className="btn small ghost" onClick={() => setDecide({ item: i, option: null })}>Dismiss</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {decide && <DecisionForm item={decide.item} option={decide.option} onClose={() => setDecide(null)} onSaved={() => { setDecide(null); d.reload(); }} />}
    </>
  );
}

function DecisionForm({ item, option, onClose, onSaved }: { item: any; option: number | null; onClose: () => void; onSaved: () => void }) {
  const opt = option === null ? null : item.options[option];
  const needsReason = !!opt && item.field === "relationship_status" && INACTIVE.includes(opt.change.to);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => opt
      ? post(`/review-items/${item.id}/apply`, { option, reason: needsReason ? reason || null : null, note, version: item.version, signer_name: signer })
      : post(`/review-items/${item.id}/dismiss`, { note, version: item.version, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const title = opt ? (item.field === "application_date" ? `Apply date: ${opt.change.to}` : `Apply status: ${fmtValue(item.field, opt.change.to)}`) : "Dismiss";
  return (
    <Overlay kind="modal" title={title} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <p className="hint wide">{opt
          ? `${item.supplier_hint}: ${FIELD_LABEL[item.field]} changes from ${fmtValue(item.field, item.current_value)} to ${fmtValue(item.field, opt.change.to)}. The item closes once this is saved.`
          : "Closes the item without changing the marketplace."}</p>
        {needsReason && <Field label="Reason" required><Select value={reason} onChange={setReason} options={REASON_LABEL} empty="Choose…" /></Field>}
        <Field label="Note (optional)" wide><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label={opt ? "Apply" : "Dismiss"} />
      </form>
    </Overlay>
  );
}

// --------------------------------------------------------------------- tasks
function FollowUps() {
  const [status, setStatus] = usePref("res.tasks", "active");
  const t = useLoad(() => get(`/task-requests?status=${status}`), [status]);
  const d = useLoad(() => get(`/actions?status=open`), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [addTask, setAddTask] = useState(false);
  const [act, setAct] = useState<{ t: any; kind: "retry" | "dismiss" } | null>(null);
  return (
    <>
      <p className="hint">Corporate Gifts tasks go to the Marketing Dashboard, where they are reviewed and assigned, then appear in Marketing Tasks (Task Tracker). Task Tracker keeps the owner and completion.</p>
      <div className="filters">
        <Select value={status} onChange={setStatus} options={{ active: "Not dismissed", all: "All" }} aria-label="Tasks shown" />
        <button className="btn small" onClick={() => setAddTask(true)}>Add task</button>
      </div>
      {t.loading && !t.data && <Loading />}
      <ErrorBox error={t.error} />
      {t.data && t.data.tasks.length === 0 && <Empty>No Corporate Gifts tasks.</Empty>}
      {t.data && <TaskList tasks={t.data.tasks} onRetry={(x) => setAct({ t: x, kind: "retry" })} onDismiss={(x) => setAct({ t: x, kind: "dismiss" })} />}
      <h3>Other follow-ups (entered by hand)</h3>
      <div className="filters"><button className="btn small" onClick={() => setEdit({})}>Add action, blocker or decision</button></div>
      {d.data && d.data.actions.length === 0 && <Empty>Nothing open.</Empty>}
      {d.data && d.data.actions.length > 0 && (
        <div className="table-wrap"><table className="dense">
          <thead><tr><th>Type</th><th>What</th><th>Marketplace</th><th>Owner</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{d.data.actions.map((a: any) => (
            <tr key={a.id}>
              <td><Pill tone={a.kind === "blocker" ? "danger" : "neutral"}>{ACTION_KIND[a.kind]}</Pill></td>
              <td>{a.title}{a.source_url && <> · <ExtLink href={a.source_url}>source</ExtLink></>}</td>
              <td>{a.supplier_name ?? "—"}</td><td>{a.owner ?? "—"}</td>
              <td>{a.due_date ?? "—"} {a.overdue && <Pill tone="danger">Overdue</Pill>}</td>
              <td>{ACTION_STATUS[a.status]}</td>
              <td><button className="btn ghost small" onClick={() => setEdit(a)}>Edit</button></td>
            </tr>))}</tbody>
        </table></div>
      )}
      {edit && <ActionForm a={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); d.reload(); }} />}
      {addTask && <TaskForm onClose={() => setAddTask(false)} onSaved={() => { setAddTask(false); t.reload(); }} />}
      {act && <TaskActionForm t={act.t} kind={act.kind} onClose={() => setAct(null)} onSaved={() => { setAct(null); t.reload(); }} />}
    </>
  );
}

function TaskActionForm({ t, kind, onClose, onSaved }: { t: any; kind: "retry" | "dismiss"; onClose: () => void; onSaved: () => void }) {
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post(`/task-requests/${t.id}/${kind}`, { version: t.version, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={kind === "retry" ? "Retry delivery" : "Dismiss task"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <p className="hint wide">{kind === "retry"
          ? `"${t.title}" goes back to the Marketing Dashboard. It is sent with the same id, so Task Tracker can never get a second copy.`
          : `"${t.title}" will not be sent to Task Tracker. Its history is kept.`}</p>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label={kind === "retry" ? "Retry delivery" : "Dismiss"} />
      </form>
    </Overlay>
  );
}

function TaskForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const list = useLoad(() => get("/suppliers"), []);
  const [f, setF] = useState({ title: "", brief: "", owner_hint: "", due_date: "", marketplace_ids: [] as string[] });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post("/task-requests", { ...f, due_date: f.due_date || null, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const eligible = (list.data?.partners ?? []).filter((p: any) => p.sales_role === "confirmed");
  const toggle = (id: string) => setF({ ...f, marketplace_ids: f.marketplace_ids.includes(id) ? f.marketplace_ids.filter((x) => x !== id) : [...f.marketplace_ids, id] });
  return (
    <Overlay kind="modal" title="Add Corporate Gifts task" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Task" required wide error={s.fe("title")} hint="An action, e.g. “Send the marketplace our holiday catalog”."><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={300} /></Field>
        <Field label="Marketplaces" required wide error={s.fe("marketplace_ids")}>
          <div className="row-gap wrap">{eligible.map((p: any) => (
            <label key={p.id} className="check"><input type="checkbox" checked={f.marketplace_ids.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>))}</div>
        </Field>
        <Field label="Suggested owner" hint="The assignee is chosen in the Marketing Dashboard."><input value={f.owner_hint} onChange={(e) => setF({ ...f, owner_hint: e.target.value })} maxLength={80} /></Field>
        <Field label="Due date" error={s.fe("due_date")}><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <Field label="Details" wide><textarea rows={3} value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} maxLength={1500} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label="Add task" />
      </form>
    </Overlay>
  );
}

function SupplierSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useLoad(() => get("/suppliers"), []);
  const opts: [string, string][] = list.data ? list.data.partners.map((p: any) => [p.ref, p.name] as [string, string]) : [];
  return <Select value={value} onChange={onChange} options={opts} empty="No marketplace" aria-label="Marketplace" />;
}

function ActionForm({ a, onClose, onSaved }: { a: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ kind: a.kind ?? "action", title: a.title ?? "", owner: a.owner ?? "", due_date: a.due_date ?? "", note: a.note ?? "",
    source_url: a.source_url ?? "", status: a.status ?? "open", supplier: a.supplier ?? "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => a.id
      ? patch(`/actions/${a.id}`, { title: f.title, owner: f.owner, due_date: f.due_date || null, note: f.note, source_url: f.source_url, status: f.status, version: a.version, signer_name: signer })
      : post("/actions", { kind: f.kind, title: f.title, owner: f.owner, due_date: f.due_date || null, note: f.note, source_url: f.source_url, supplier: f.supplier || undefined, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={a.id ? "Edit" : "Add action, blocker or decision"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {!a.id && <Field label="Type" required><Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={ACTION_KIND} /></Field>}
        {!a.id && <Field label="Marketplace (optional)"><SupplierSelect value={f.supplier} onChange={(v) => setF({ ...f, supplier: v })} /></Field>}
        <Field label="What" required wide error={s.fe("title")}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={300} /></Field>
        <Field label="Owner" error={s.fe("owner")}><input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} /></Field>
        <Field label="Due date" error={s.fe("due_date")} hint="Only when one was agreed."><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        {a.id && <Field label="Status"><Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={ACTION_STATUS} /></Field>}
        <Field label="Source message link" error={s.fe("source_url")}><input type="url" value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} /></Field>
        <Field label="Note" wide><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------------ samples
function Samples() {
  const d = useLoad(() => get("/samples"), []);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <p className="hint">Workflow status of sample boxes (no contact details). The Google Form signup count on Marketplaces is separate and is not changed here.</p>
      <div className="filters"><button className="btn small" onClick={() => setEdit({})}>Add sample request</button></div>
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {d.data && d.data.samples.length === 0 && <Empty>No sample requests tracked.</Empty>}
      <ul className="timeline">
        {d.data?.samples.map((x: any) => (
          <li key={x.id}>
            <div className="row-gap"><strong>{x.label}</strong> <Pill tone="info">{SAMPLE_LABEL[x.status]}</Pill> {x.status_on && <span className="hint">{x.status_on}</span>}
              {x.supplier_name && <span className="hint">· {x.supplier_name}</span>}<span className="spacer" /><button className="btn ghost small" onClick={() => setEdit(x)}>Edit</button></div>
            {x.note && <div className="pre">{x.note}</div>}
            {x.source_url && <div className="hint"><ExtLink href={x.source_url}>Source message</ExtLink></div>}
          </li>
        ))}
      </ul>
      {edit && <SampleForm x={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); d.reload(); }} />}
    </>
  );
}

function SampleForm({ x, onClose, onSaved }: { x: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ label: x.label ?? "", status: x.status ?? "requested", status_on: x.status_on ?? today(), note: x.note ?? "", source_url: x.source_url ?? "", supplier: x.supplier ?? "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { label: f.label, status: f.status, status_on: f.status_on || null, note: f.note, source_url: f.source_url, signer_name: signer };
    const ok = await s.run(() => x.id ? patch(`/samples/${x.id}`, { ...body, version: x.version }) : post("/samples", { ...body, supplier: f.supplier || undefined }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={x.id ? "Edit sample request" : "Add sample request"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Company or partner" required error={s.fe("label")} hint="No personal contact details."><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        {!x.id && <Field label="Linked marketplace (optional)"><SupplierSelect value={f.supplier} onChange={(v) => setF({ ...f, supplier: v })} /></Field>}
        <Field label="Status" required><Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={SAMPLE_LABEL} /></Field>
        <Field label="Status date"><input type="date" value={f.status_on} onChange={(e) => setF({ ...f, status_on: e.target.value })} /></Field>
        <Field label="Source message link" error={s.fe("source_url")}><input type="url" value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} /></Field>
        <Field label="Note" wide><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

// --------------------------------------------------------------- Slack scans
function SlackScans() {
  const d = useLoad(() => get("/slack/scans"), []);
  return (
    <>
      <p className="hint">Each channel is scanned separately. A failed scan changes no records; the last successful scan time stays as it was.</p>
      <SlackImport onSaved={d.reload} />
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {d.data && (
        <div className="table-wrap"><table className="dense">
          <thead><tr><th>Channel</th><th>Last successful scan</th><th>Last attempt</th><th>Last pass</th><th>Problem</th></tr></thead>
          <tbody>{d.data.scans.map((s: any) => (
            <tr key={s.channel_key}>
              <td>{CHANNEL_LABEL[s.channel_key]}</td>
              <td>{s.last_success_at ? dateTime(s.last_success_at) : "Never"}</td>
              <td>{s.last_attempt_at ? dateTime(s.last_attempt_at) : "—"}</td>
              <td>{s.last_counts ? `${s.last_counts.added} added · ${s.last_counts.updated} updated · ${s.last_counts.flagged} conflicts${s.last_counts.skipped != null ? ` · ${s.last_counts.skipped} out of scope` : ""}` : "—"}</td>
              <td>{s.last_error ? <Pill tone="danger">{s.last_error}</Pill> : "—"}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <Cleanup onDone={d.reload} />
    </>
  );
}

const SKIP_LABEL: Record<string, string> = {
  supplier_role: "about a company's product-supplier role", not_listed: "not about an eligible Marketplaces record",
  role_unclear: "about a marketplace whose sales role is unclear", not_confirmed: "not confirmed", not_open: "about work already done",
};

/** What a scan will change (preview) or changed (save). Out-of-scope findings are counted, never listed. */
function ChangeList({ r }: { r: any }) {
  const status = r.changes.filter((c: any) => c.type === "status");
  const resources = r.changes.filter((c: any) => c.type === "resource");
  const tasks = r.changes.filter((c: any) => c.type === "task");
  const conflicts = r.changes.filter((c: any) => c.type === "conflict");
  const skipped = Object.entries(r.skipped_reasons ?? {}).filter(([, n]) => (n as number) > 0);
  return (
    <div className="wide">
      {status.length > 0 && <><h4>Marketplace fields ({status.length})</h4><div className="table-wrap"><table className="dense">
        <thead><tr><th>Marketplace</th><th>Field</th><th>From</th><th>To</th></tr></thead>
        <tbody>{status.map((c: any, n: number) => <tr key={n}><td>{c.partner.name}</td><td>{FIELD_LABEL[c.field]}</td><td>{fmtValue(c.field, c.from)}</td><td><strong>{fmtValue(c.field, c.to)}</strong></td></tr>)}</tbody>
      </table></div></>}
      {resources.length > 0 && <><h4>Resources ({resources.length})</h4><ul className="timeline">
        {resources.map((c: any, n: number) => <li key={n}><Pill tone={c.action === "add" ? "ok" : "info"}>{c.action === "add" ? "Add" : "Update"}</Pill> {c.title} <span className="hint">· {c.partner.name}{c.supersedes ? ` · supersedes ${c.supersedes} earlier version${c.supersedes > 1 ? "s" : ""}` : ""}</span></li>)}
      </ul></>}
      {tasks.length > 0 && <><h4>Tasks for Marketing Tasks ({tasks.length})</h4><ul className="timeline">
        {tasks.map((c: any, n: number) => <li key={n}><Pill tone={c.action === "create" ? "ok" : "info"}>{c.action === "create" ? "Create" : "Update"}</Pill> {c.title}
          <span className="hint"> · {c.partners.map((p: any) => p.name).join(", ")}{c.owner ? ` · owner ${c.owner}` : ""}{c.due_date ? ` · due ${c.due_date}` : ""}{c.note ? ` · ${c.note}` : ""}</span></li>)}
      </ul></>}
      {conflicts.length > 0 && <><h4>Conflicts needing a decision ({conflicts.length})</h4><ul className="timeline">
        {conflicts.map((c: any, n: number) => <li key={n}><Pill tone="warn">{FIELD_LABEL[c.field]}</Pill> {c.partner.name}: current {fmtValue(c.field, c.current)}; messages say {c.values.map((v: string) => fmtValue(c.field, v)).join(" vs ")}</li>)}
      </ul></>}
      {r.changes.length === 0 && <p>No changes.</p>}
      <p className="hint">{r.unchanged} already up to date · {r.skipped} out of scope{skipped.length ? ` (${skipped.map(([k, n]) => `${n} ${SKIP_LABEL[k]}`).join(", ")})` : ""}.</p>
    </div>
  );
}

// One-time cleanup of scans imported before Marketplace Resources. Preview first; nothing is deleted.
function Cleanup({ onDone }: { onDone: () => void }) {
  const [res, setRes] = useState<any>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const run = async (dry: boolean) => {
    let out: any;
    const ok = await s.run(async () => { out = await post("/slack/cleanup", { dry_run: dry, signer_name: signer }); });
    if (ok) { rememberSigner(signer); setRes(out); if (!dry) onDone(); }
  };
  return (
    <Section title="Clean up earlier imports" defaultOpen={false}>
      <p className="hint">For scans imported before Marketplace Resources: closes their open review items, and hides product-supplier and unlisted-company records from these views and the dashboard summary. Their history is kept. Then import the rebuilt scan files to turn eligible findings into updates and tasks.</p>
      <div className="form-grid">
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <ErrorBox error={s.error} />
        <p className="wide"><button type="button" className="btn small" disabled={s.saving} onClick={() => run(true)}>Preview cleanup</button>{" "}
          {res?.dry_run && <button type="button" className="btn small primary" disabled={s.saving} onClick={() => run(false)}>Apply cleanup</button>}</p>
        {res && <p className="wide">{res.dry_run ? "Preview (nothing changed): " : "Done: "}
          {res.review_closed_replaced + res.review_closed_out_of_scope} open review items closed ({res.review_closed_replaced} to be reprocessed, {res.review_closed_out_of_scope} out of scope) ·
          {" "}{res.resources_excluded} supplier resources, {res.actions_excluded} follow-ups and {res.samples_excluded} samples hidden as out of scope ·
          {" "}{res.actions_replaced} follow-ups replaced by tasks or resources · findings: {res.findings_in_scope} in scope, {res.findings_replaced} replaced, {res.findings_out_of_scope} out of scope.</p>}
      </div>
    </Section>
  );
}

// Upload one scan pass file (one channel), preview it, then save it. Nothing is saved by the preview.
function SlackImport({ onSaved }: { onSaved: () => void }) {
  const [pass, setPass] = useState<any>(null);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const pick = async (file: File | undefined) => {
    setPass(null); setPreview(null); setSaved(null); setFileError(""); s.clear();
    if (!file) return;
    setFileName(file.name);
    if (file.size > 2 * 1024 * 1024) { setFileError("The file is larger than 2 MB; split the scan into smaller passes."); return; }
    try { setPass(JSON.parse(await file.text())); } catch { setFileError("This file is not valid JSON."); }
  };
  const send = async (dry: boolean) => {
    let res: any;
    const ok = await s.run(async () => { res = await post("/slack/import", { pass, dry_run: dry, signer_name: signer }); });
    if (!ok) return;
    rememberSigner(signer);
    if (dry) setPreview(res);
    else { setSaved(res); setPreview(null); setPass(null); onSaved(); }
  };
  const counts = (r: any) => `${r.added} added · ${r.updated} updated · ${r.flagged} conflicts for review · ${r.unchanged} unchanged · ${r.skipped} out of scope`;
  return (
    <Section title="Import a scan">
      <div className="form-grid">
        <Field label="Scan file (one channel)" error={fileError} hint="JSON in the sbcg-slack-v2 format. Preview first; nothing is saved until you press Save.">
          <input type="file" accept=".json,application/json" onChange={(e) => pick(e.target.files?.[0])} />
        </Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <ErrorBox error={s.error} />
        {pass && (
          <p className="wide">
            <span className="hint">{fileName}{pass.channel ? ` · ${CHANNEL_LABEL[pass.channel] ?? pass.channel}` : ""}{Array.isArray(pass.findings) ? ` · ${pass.findings.length} findings` : ""}</span>{" "}
            <button type="button" className="btn small" disabled={s.saving} onClick={() => send(true)}>Preview</button>{" "}
            {preview && <button type="button" className="btn small primary" disabled={s.saving} onClick={() => send(false)}>Save</button>}
          </p>
        )}
        {preview && <><p className="wide"><strong>Preview ({CHANNEL_LABEL[preview.channel]}), nothing saved yet:</strong> {counts(preview)}</p><ChangeList r={preview} /></>}
        {saved && <><p className="wide"><strong>Saved {CHANNEL_LABEL[saved.channel]}:</strong> {counts(saved)}. Tasks now wait in the Marketing Dashboard for review; conflicts are in the Review queue.</p><ChangeList r={saved} /></>}
      </div>
    </Section>
  );
}
