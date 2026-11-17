import { useState, type FormEvent } from "react";
import { get, post, patch } from "../api";
import type { Nav } from "../App";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, usePref,
} from "../components/ui";
import { PROVIDER_LABEL, CONFIRM_LABEL, dateTime, today } from "../format";

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
  decisions_followups: "Confirmed supplier decisions, linked to open actions or requirements.",
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

type View = "suppliers" | "review" | "followups" | "samples" | "scans";
const VIEWS: [View, string][] = [["suppliers", "By supplier"], ["review", "Review queue"], ["followups", "Follow-ups"], ["samples", "Sample boxes"], ["scans", "Slack scans"]];

const ExtLink = ({ href, children }: { href: string | null; children: React.ReactNode }) =>
  href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : null;

export function SupplierResourcesScreen({ params, nav }: { params: Record<string, string>; nav: Nav }) {
  const view = (VIEWS.some(([v]) => v === params.view) ? params.view : "suppliers") as View;
  const go = (v: View, extra: Record<string, string> = {}) => nav("resources", { view: v, ...extra });
  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Supplier Resources</h1>
        <div className="spacer" />
        <div className="segmented" role="tablist" aria-label="Supplier Resources views">
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

// ------------------------------------------------------------- by supplier
function BySupplier({ selected, onSelect, nav }: { selected: string; onSelect: (ref: string) => void; nav: Nav }) {
  const list = useLoad(() => get("/suppliers"), []);
  const [kind, setKind] = usePref("res.kind", "");
  const [addVendor, setAddVendor] = useState<string | null>(null);
  const rows = list.data ? [
    ...list.data.partners.map((p: any) => ({ ...p, label: PROVIDER_LABEL[p.provider_type] })),
    ...list.data.vendors.map((v: any) => ({ ...v, label: "Product vendor" })),
  ].filter((r) => !kind || r.kind === kind) : [];
  return (
    <div className="split">
      <aside className="split-list">
        <div className="filters">
          <Select value={kind} onChange={setKind} options={{ partner: "Partners", vendor: "Product vendors" }} empty="Partners and vendors" aria-label="Supplier type" />
          <button className="btn small" onClick={() => setAddVendor("")}>Add vendor</button>
        </div>
        {list.loading && !list.data && <Loading />}
        <ErrorBox error={list.error} />
        <ul className="pick-list">
          {rows.map((r: any) => (
            <li key={r.ref}>
              <button className={selected === r.ref ? "active" : ""} onClick={() => onSelect(r.ref)}>
                <strong>{r.name}</strong> <span className="hint">{r.label}</span>
                <span className="count">{r.current_resources}</span>
              </button>
            </li>
          ))}
        </ul>
        {list.data?.unlinked_vendor_names?.length > 0 && (
          <div className="hint">
            Vendor names used on gifts or cost sources without a vendor record:{" "}
            {list.data.unlinked_vendor_names.map((n: string) => <button key={n} className="btn ghost small" onClick={() => setAddVendor(n)}>+ {n}</button>)}
          </div>
        )}
      </aside>
      <div className="split-detail">
        {selected ? <SupplierDetail supplier={selected} nav={nav} onChanged={list.reload} /> : <Empty>Choose a partner or vendor to see its resources.</Empty>}
      </div>
      {addVendor !== null && <VendorForm initialName={addVendor} onClose={() => setAddVendor(null)} onSaved={(id) => { setAddVendor(null); list.reload(); onSelect(`vendor:${id}`); }} />}
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
  const bySection = (sec: string, status: string) => d.data.resources.filter((r: any) => r.section === sec && r.status === status);
  return (
    <div>
      <div className="toolbar">
        <h2>{s.name}</h2>
        <span className="hint">{s.kind === "partner" ? "Partner record" : "Product vendor"}</span>
        <div className="spacer" />
        {s.kind === "partner" && <button className="btn ghost small" onClick={() => nav("marketplaces", { m: s.id })}>Open partner record →</button>}
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
      {(d.data.actions.length > 0 || d.data.samples.length > 0) && (
        <Section title="Open work for this supplier" count={d.data.actions.filter((a: any) => a.status === "open").length} defaultOpen={false}>
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

function VendorForm({ initialName, onClose, onSaved }: { initialName: string; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({ name: initialName, website_url: "", note: "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let id = "";
    const ok = await s.run(async () => { id = (await post("/vendors", { ...f, signer_name: signer })).vendor.id; });
    if (ok) { rememberSigner(signer); onSaved(id); }
  };
  return (
    <Overlay kind="modal" title="Add product vendor" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Vendor name" required error={s.fe("name")} hint="Use the same name as on gifts and cost sources."><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Website" error={s.fe("website_url")}><input type="url" value={f.website_url} onChange={(e) => setF({ ...f, website_url: e.target.value })} /></Field>
        <Field label="Note" wide><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------- review queue
function ReviewQueue() {
  const [status, setStatus] = usePref("res.review", "open");
  const d = useLoad(() => get(`/review-items?status=${status}`), [status]);
  const [resolve, setResolve] = useState<any | null>(null);
  return (
    <>
      <p className="hint">Slack findings that were tentative, conflicting, ambiguous, or could not be matched to exactly one record. Nothing here has changed any record yet.</p>
      <div className="filters"><Select value={status} onChange={setStatus} options={{ open: "Open", resolved: "Resolved", dismissed: "Dismissed", all: "All" }} aria-label="Review status" /></div>
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {d.data && d.data.items.length === 0 && <Empty>No items.</Empty>}
      <ul className="timeline">
        {d.data?.items.map((i: any) => (
          <li key={i.id}>
            <div className="row-gap"><Pill tone="warn">{i.kind}</Pill> <strong>{i.title}</strong> {i.supplier_hint && <span className="hint">· {i.supplier_hint}</span>}
              <span className="spacer" />{i.status === "open" ? <button className="btn small" onClick={() => setResolve(i)}>Resolve</button> : <Pill>{i.status}</Pill>}</div>
            {i.summary && <div className="pre">{i.summary}</div>}
            <div><strong>Question:</strong> {i.question}</div>
            <div className="hint">
              {i.sources.map((s: any, n: number) => <span key={n}>{n > 0 && " · "}<ExtLink href={s.permalink}>{CHANNEL_LABEL[s.channel] ?? s.channel} {s.date ?? ""}</ExtLink></span>)}
              {i.resolution_note && <> · Resolution: {i.resolution_note} ({i.resolved_by})</>}
            </div>
          </li>
        ))}
      </ul>
      {resolve && <ResolveForm item={resolve} onClose={() => setResolve(null)} onSaved={() => { setResolve(null); d.reload(); }} />}
    </>
  );
}

function ResolveForm({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState("resolved");
  const [note, setNote] = useState("");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => patch(`/review-items/${item.id}`, { status, resolution_note: note, version: item.version, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title="Resolve review item" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <p className="hint wide">Make the change in the right record first (or add the missing vendor or partner), then note what you did here.</p>
        <Field label="Outcome" required><Select value={status} onChange={setStatus} options={{ resolved: "Resolved", dismissed: "Dismissed (not needed)" }} /></Field>
        <Field label="What was done" required wide error={s.fe("resolution_note")}><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

// ---------------------------------------------------------------- follow-ups
function FollowUps() {
  const [status, setStatus] = usePref("res.actions", "open");
  const d = useLoad(() => get(`/actions?status=${status}`), [status]);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <div className="filters">
        <Select value={status} onChange={setStatus} options={{ open: "Open", all: "All" }} aria-label="Status" />
        <button className="btn small" onClick={() => setEdit({})}>Add action, blocker or decision</button>
      </div>
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {d.data && d.data.actions.length === 0 && <Empty>Nothing open.</Empty>}
      {d.data && d.data.actions.length > 0 && (
        <div className="table-wrap"><table className="dense">
          <thead><tr><th>Type</th><th>What</th><th>Supplier</th><th>Owner</th><th>Due</th><th>Status</th><th /></tr></thead>
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
    </>
  );
}

function SupplierSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useLoad(() => get("/suppliers"), []);
  const opts: [string, string][] = list.data ? [
    ...list.data.partners.map((p: any) => [p.ref, `${p.name} (partner)`] as [string, string]),
    ...list.data.vendors.map((v: any) => [v.ref, `${v.name} (vendor)`] as [string, string]),
  ] : [];
  return <Select value={value} onChange={onChange} options={opts} empty="No supplier" aria-label="Supplier" />;
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
        {!a.id && <Field label="Supplier (optional)"><SupplierSelect value={f.supplier} onChange={(v) => setF({ ...f, supplier: v })} /></Field>}
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
        {!x.id && <Field label="Linked supplier (optional)"><SupplierSelect value={f.supplier} onChange={(v) => setF({ ...f, supplier: v })} /></Field>}
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
              <td>{s.last_counts ? `${s.last_counts.added} added · ${s.last_counts.updated} updated · ${s.last_counts.flagged} flagged` : "—"}</td>
              <td>{s.last_error ? <Pill tone="danger">{s.last_error}</Pill> : "—"}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}

