import { useState, type FormEvent } from "react";
import { get, post, patch, qs } from "../api";
import type { Nav } from "../App";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, StatusBadge, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, useDebounced, usePref,
} from "../components/ui";
import { ProductPicker, type ProductLite } from "../components/ProductPicker";
import {
  STATUS_LABEL, STATUSES, INACTIVE, REASON_LABEL, PROVIDER_LABEL, SUPPLIER_HELP, CATEGORY_LABEL, CONFIRM_LABEL, METHOD_LABEL,
  PROPOSAL_LABEL, OFFER_LABEL, FAMILY_LABEL, TRI_LABEL, date, dateTime, today, productLabel, pct,
} from "../format";

const progressText = (m: any) =>
  m.milestones_applicable === 0 ? "No applicable milestones" : `${m.milestones_done} / ${m.milestones_applicable}`;

export function MarketplacesScreen({ params, nav }: { params: Record<string, string>; nav: Nav }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [status, setStatus] = usePref("mk.status", "");
  const [ptype, setPtype] = usePref("mk.ptype", "");
  const [showInactive, setShowInactive] = usePref("mk.inactive", false);
  const [adding, setAdding] = useState(false);
  const openId = params.m ?? null;
  const list = useLoad(() => get(`/marketplaces${qs({ q: dq, status, provider_type: ptype, include_inactive: showInactive })}`), [dq, status, ptype, showInactive]);

  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Marketplaces</h1>
        {list.data && <span className="hint">{list.data.counts.working} working · {list.data.counts.live} live</span>}
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>Add marketplace</button>
      </div>
      <div className="filters">
        <input type="search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by name" />
        <Select value={status} onChange={setStatus} options={STATUS_LABEL} empty="All working statuses" aria-label="Status" />
        <Select value={ptype} onChange={setPtype} options={PROVIDER_LABEL} empty="All provider types" aria-label="Provider type" />
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive marketplaces</label>
      </div>
      {list.loading && !list.data && <Loading />}
      <ErrorBox error={list.error} />
      {list.data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Marketplace</th><th>Status</th><th>Setup progress</th><th>Last communication</th><th></th></tr></thead>
            <tbody>
              {list.data.marketplaces.length === 0 && <tr><td colSpan={5}><Empty>No marketplaces match these filters.</Empty></td></tr>}
              {list.data.marketplaces.map((m: any) => (
                <tr key={m.id} className={INACTIVE.includes(m.status) ? "muted-row" : ""}>
                  <td data-label="Marketplace">
                    <button className="link strong" onClick={() => nav("marketplaces", { m: m.id })}>{m.name}</button>
                    <div className="hint">{PROVIDER_LABEL[m.provider_type]}{m.priority_note ? ` · ${m.priority_note}` : ""}</div>
                  </td>
                  <td data-label="Status"><StatusBadge status={m.status} /></td>
                  <td data-label="Setup progress">{progressText(m)}</td>
                  <td data-label="Last communication">{date(m.last_communication)}</td>
                  <td><button className="btn small" onClick={() => nav("marketplaces", { m: m.id })}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <MarketplaceForm onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); list.reload(); nav("marketplaces", { m: id }); }} />}
      {openId && <MarketplaceDetail id={openId} nav={nav} onClose={() => { nav("marketplaces"); list.reload(); }} onChanged={list.reload} />}
    </div>
  );
}

// ------------------------------------------------------------- add / edit
function MarketplaceForm({ existing, onClose, onSaved }: { existing?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({
    name: existing?.name ?? "", provider_type: existing?.provider_type ?? "marketplace", status: "prospect",
    contact_name: existing?.contact_name ?? "", contact_email: existing?.contact_email ?? "", website_url: existing?.website_url ?? "",
    portal_url: existing?.portal_url ?? "", description: existing?.description ?? "", priority_note: existing?.priority_note ?? "",
    initial_action: existing?.initial_action ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let id = existing?.id;
    const ok = await s.run(async () => {
      const { status, ...rest } = f;
      if (existing) await patch(`/marketplaces/${existing.id}`, { ...rest, signer_name: signer, version: existing.version });
      else id = (await post("/marketplaces", { ...f, signer_name: signer })).marketplace.id;
    });
    if (ok) { rememberSigner(signer); onSaved(id); }
  };
  return (
    <Overlay kind="modal" title={existing ? "Edit details" : "Add marketplace"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Name" required error={s.fe("name")}><input value={f.name} onChange={set("name")} maxLength={120} /></Field>
        <Field label="Provider type" required hint={f.provider_type === "supplier_opportunity" ? SUPPLIER_HELP : undefined}>
          <Select value={f.provider_type} onChange={set("provider_type")} options={PROVIDER_LABEL} />
        </Field>
        {!existing && (
          <Field label="Initial status"><Select value={f.status} onChange={set("status")} options={STATUSES.filter((x) => !INACTIVE.includes(x)).map((x) => [x, STATUS_LABEL[x]])} /></Field>
        )}
        <Field label="Contact name" error={s.fe("contact_name")}><input value={f.contact_name} onChange={set("contact_name")} /></Field>
        <Field label="Contact email" error={s.fe("contact_email")}><input type="email" value={f.contact_email} onChange={set("contact_email")} /></Field>
        <Field label="Official website" error={s.fe("website_url")}><input type="url" value={f.website_url} onChange={set("website_url")} placeholder="https://" /></Field>
        <Field label="Vendor portal" error={s.fe("portal_url")}><input type="url" value={f.portal_url} onChange={set("portal_url")} placeholder="https://" /></Field>
        <Field label="Priority" error={s.fe("priority_note")}><input value={f.priority_note} onChange={set("priority_note")} /></Field>
        <Field label="Initial action" wide error={s.fe("initial_action")}><textarea rows={2} value={f.initial_action} onChange={set("initial_action")} /></Field>
        <Field label="Description" wide error={s.fe("description")}><textarea rows={3} value={f.description} onChange={set("description")} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}

function StatusForm({ m, onClose, onSaved }: { m: any; onClose: () => void; onSaved: () => void }) {
  const reactivating = INACTIVE.includes(m.status);
  const [to, setTo] = useState(reactivating ? "reconnecting" : "");
  const [f, setF] = useState({ reason: "", detail: "", unmet_requirement: "", what_would_change: "", revisit_date: "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const inactive = INACTIVE.includes(to);
  const options = STATUSES.filter((x) => x !== m.status).map((x) => [x, STATUS_LABEL[x] + (reactivating && (x === "reconnecting" || x === "preparing_application") ? " (suggested)" : "")] as [string, string]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post(`/marketplaces/${m.id}/status-transitions`, {
      to_status: to, version: m.version, signer_name: signer,
      ...(inactive ? { reason: f.reason || null, detail: f.detail, revisit_date: f.revisit_date || null, ...(to === "not_qualified" ? { unmet_requirement: f.unmet_requirement, what_would_change: f.what_would_change } : {}) } : { detail: f.detail }),
    }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={reactivating ? "Reactivate" : "Change status"} subtitle={<>Current: <StatusBadge status={m.status} /></>} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {reactivating && <p className="hint wide">Reactivation keeps every checklist state, price, communication and revenue record. Nothing is reset automatically.</p>}
        <Field label="New status" required error={s.fe("to_status")}><Select value={to} onChange={setTo} options={options} empty="Choose…" /></Field>
        {inactive && (
          <>
            <Field label="Reason" required error={s.fe("reason")}><Select value={f.reason} onChange={(v) => setF({ ...f, reason: v })} options={REASON_LABEL} empty="Choose…" /></Field>
            <Field label="Optional revisit date" hint="Informational only — no reminders." error={s.fe("revisit_date")}><input type="date" value={f.revisit_date} onChange={(e) => setF({ ...f, revisit_date: e.target.value })} /></Field>
            {to === "not_qualified" && (
              <>
                <Field label="Unmet requirement" wide><input value={f.unmet_requirement} onChange={(e) => setF({ ...f, unmet_requirement: e.target.value })} /></Field>
                <Field label="What would need to change (if known)" wide><input value={f.what_would_change} onChange={(e) => setF({ ...f, what_would_change: e.target.value })} /></Field>
              </>
            )}
          </>
        )}
        <Field label="Detail (optional)" wide error={s.fe("detail")}><textarea rows={2} value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} disabled={!to} />
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------------ detail
function MarketplaceDetail({ id, nav, onClose, onChanged }: { id: string; nav: Nav; onClose: () => void; onChanged: () => void }) {
  const d = useLoad(() => get(`/marketplaces/${id}`), [id]);
  const [modal, setModal] = useState<null | "edit" | "status" | "terms">(null);
  const reload = () => { d.reload(); onChanged(); };
  const m = d.data?.marketplace;
  return (
    <Overlay title={m ? m.name : "Marketplace"} subtitle={m && <span className="row-gap">{PROVIDER_LABEL[m.provider_type]} <StatusBadge status={m.status} /></span>} onClose={onClose}>
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {m && (
        <>
          {m.provider_type === "supplier_opportunity" && <p className="hint">{SUPPLIER_HELP}</p>}
          <div className="detail-actions">
            <button className="btn small" onClick={() => setModal("edit")}>Edit details</button>
            <button className="btn small" onClick={() => setModal("status")}>{INACTIVE.includes(m.status) ? "Reactivate" : "Change status"}</button>
            <button className="btn ghost small" onClick={() => nav("pricing", { channel: m.channel_id })}>Pricing for {m.name} →</button>
            <button className="btn ghost small" onClick={() => nav("revenue", { channel: m.channel_id })}>Revenue for {m.name} →</button>
          </div>
          <dl className="kv">
            <dt>Contact</dt><dd>{m.contact_name || <span className="unknown">Not recorded</span>}{m.contact_email && <> · <a href={`mailto:${m.contact_email}`}>{m.contact_email}</a></>}</dd>
            <dt>Website</dt><dd>{m.website_url ? <a href={m.website_url} target="_blank" rel="noreferrer noopener">{m.website_url}</a> : "—"}</dd>
            <dt>Vendor portal</dt><dd>{m.portal_url ? <a href={m.portal_url} target="_blank" rel="noreferrer noopener">{m.portal_url}</a> : "—"}</dd>
            {m.priority_note && <><dt>Priority</dt><dd>{m.priority_note}</dd></>}
            {m.initial_action && <><dt>Initial action</dt><dd>{m.initial_action}</dd></>}
            {m.description && <><dt>Description</dt><dd className="pre">{m.description}</dd></>}
            <dt>Setup progress</dt><dd>{progressText(m)}</dd>
          </dl>
          {d.data.statusHistory[0] && INACTIVE.includes(m.status) && <InactiveNote h={d.data.statusHistory[0]} />}

          <Section title="Setup checklist" count={progressText(m)}>
            <Milestones mid={id} items={d.data.milestones} history={d.data.milestoneHistory} onChanged={reload} />
          </Section>
          <Section title="Requirements" count={d.data.requirements.length}>
            <Requirements mid={id} items={d.data.requirements} onChanged={reload} />
          </Section>
          <Section title="Proposed products" count={d.data.products.length}>
            <Proposals mid={id} items={d.data.products} onChanged={reload} />
          </Section>
          <Section title="Communication notes" count={d.data.communications.length}>
            <Communications mid={id} items={d.data.communications} onChanged={reload} />
          </Section>
          <Section title="Common agreement terms" defaultOpen={false}>
            <TermsView channel={d.data.channel} onEdit={() => setModal("terms")} />
          </Section>
          <Section title="Status history" count={d.data.statusHistory.length} defaultOpen={false}>
            <ul className="timeline">
              {d.data.statusHistory.map((h: any) => (
                <li key={h.id}>
                  <div><strong>{h.from_status ? `${STATUS_LABEL[h.from_status]} → ` : ""}{STATUS_LABEL[h.to_status]}</strong> {h.reason && <span className="hint">· {REASON_LABEL[h.reason] ?? h.reason}</span>}</div>
                  {h.detail && <div className="pre">{h.detail}</div>}
                  {h.unmet_requirement && <div>Unmet requirement: {h.unmet_requirement}</div>}
                  {h.what_would_change && <div>What would change: {h.what_would_change}</div>}
                  {h.revisit_date && <div>Revisit: {h.revisit_date}</div>}
                  <div className="hint">{h.signer_name} · {dateTime(h.created_at)}</div>
                </li>
              ))}
            </ul>
          </Section>
          {modal === "edit" && <MarketplaceForm existing={m} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
          {modal === "status" && <StatusForm m={m} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
          {modal === "terms" && <TermsForm channel={d.data.channel} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
        </>
      )}
    </Overlay>
  );
}

function InactiveNote({ h }: { h: any }) {
  return (
    <div className="alert neutral">
      <strong>{STATUS_LABEL[h.to_status]}</strong>{h.reason && <> — {REASON_LABEL[h.reason] ?? h.reason}</>}
      {h.detail && <div className="pre">{h.detail}</div>}
      {h.revisit_date && <div>Revisit (informational): {h.revisit_date}</div>}
    </div>
  );
}

// ------------------------------------------------------------ milestones
function Milestones({ mid, items, history, onChanged }: { mid: string; items: any[]; history: any[]; onChanged: () => void }) {
  const [act, setAct] = useState<{ m?: any; action: string } | null>(null);
  const [showHist, setShowHist] = useState(false);
  return (
    <>
      {items.length === 0 && <Empty>No milestones.</Empty>}
      <ul className="checklist">
        {items.map((m) => (
          <li key={m.id} className={`state-${m.state}`}>
            <span className="mark" aria-hidden>{m.state === "done" ? "✓" : m.state === "not_applicable" ? "–" : "○"}</span>
            <div className="grow">
              <div><strong>{m.title}</strong> {m.state === "not_applicable" && <Pill>Not applicable</Pill>}</div>
              {m.note && <div className="hint pre">{m.note}</div>}
              {m.state === "not_applicable" && <div className="hint">Reason: {m.not_applicable_reason}</div>}
              {m.state !== "pending" && <div className="hint">{m.state === "done" ? "Done" : "Marked N/A"} by {m.completed_by} · {dateTime(m.completed_at)}</div>}
            </div>
            <div className="row-actions">
              {m.state === "pending" ? (
                <>
                  <button className="btn small" onClick={() => setAct({ m, action: "done" })}>Mark done</button>
                  <button className="btn ghost small" onClick={() => setAct({ m, action: "not_applicable" })}>N/A</button>
                </>
              ) : (
                <button className="btn ghost small" onClick={() => setAct({ m, action: "reopen" })}>Reopen</button>
              )}
              <button className="btn ghost small" onClick={() => setAct({ m, action: "edit" })}>Edit</button>
              <button className="btn ghost small danger" onClick={() => setAct({ m, action: "remove" })}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="row-gap">
        <button className="btn small" onClick={() => setAct({ action: "add" })}>Add milestone</button>
        <button className="btn ghost small" onClick={() => setShowHist(!showHist)}>{showHist ? "Hide" : "Show"} checklist history ({history.length})</button>
      </div>
      {showHist && (
        <ul className="timeline small">
          {history.map((h) => (
            <li key={h.id}><strong>{h.action.replace("_", " ")}</strong> · {h.after?.title ?? h.before?.title}
              {h.after?.not_applicable_reason && <> · {h.after.not_applicable_reason}</>}
              <div className="hint">{h.signer_name} · {dateTime(h.created_at)}</div></li>
          ))}
        </ul>
      )}
      {act && <MilestoneAction mid={mid} {...act} onClose={() => setAct(null)} onSaved={() => { setAct(null); onChanged(); }} />}
    </>
  );
}

function MilestoneAction({ mid, m, action, onClose, onSaved }: { mid: string; m?: any; action: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(m?.title ?? "");
  const [note, setNote] = useState(m?.note ?? "");
  const [reason, setReason] = useState("");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const titles: Record<string, string> = { add: "Add milestone", done: "Mark done", not_applicable: "Mark not applicable", reopen: "Reopen milestone", edit: "Edit milestone", remove: "Remove milestone" };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() =>
      action === "add"
        ? post(`/marketplaces/${mid}/milestones`, { title, note, signer_name: signer })
        : patch(`/marketplaces/${mid}/milestones/${m.id}`, {
            action, version: m.version, signer_name: signer,
            ...(action === "edit" ? { title, note } : action === "done" ? { note } : action === "not_applicable" ? { reason } : {}),
          }),
    );
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={titles[action]} subtitle={m?.title} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {(action === "add" || action === "edit") && <Field label="Title" required wide error={s.fe("title")}><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>}
        {(action === "add" || action === "edit" || action === "done") && <Field label="Short note (optional)" wide><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>}
        {action === "not_applicable" && <Field label="Brief reason" required wide error={s.fe("reason")}><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>}
        {action === "remove" && <p className="wide">Remove this milestone? Use this only for a mistaken milestone. The removal is kept in history.</p>}
        {action === "reopen" && <p className="wide">Reopening clears the current completion. The previous completion stays in history.</p>}
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} label={action === "remove" ? "Remove" : "Save"} />
      </form>
    </Overlay>
  );
}

// ---------------------------------------------------------- requirements
function Requirements({ mid, items, onChanged }: { mid: string; items: any[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      {items.length === 0 && <Empty>No requirements recorded.</Empty>}
      <div className="cards">
        {items.map((r) => (
          <div className="card" key={r.id}>
            <div className="card-head">
              <span className="row-gap"><Pill>{CATEGORY_LABEL[r.category]}</Pill><Pill tone={r.confirmation_state === "confirmed" ? "ok" : r.confirmation_state === "awaiting_clarification" ? "warn" : "neutral"}>{CONFIRM_LABEL[r.confirmation_state]}</Pill></span>
              <button className="btn ghost small" onClick={() => setEdit(r)}>Edit</button>
            </div>
            <div className="req-grid">
              <div><div className="label">Supplier requirement</div><div className="pre">{r.requirement}</div></div>
              <div><div className="label">Our response</div><div className="pre">{r.response || <span className="unknown">No response yet</span>}</div></div>
            </div>
            <div className="hint">
              Source: {r.source_ref ? (/^https?:\/\//.test(r.source_ref) ? <a href={r.source_ref} target="_blank" rel="noreferrer noopener">{r.source_ref}</a> : r.source_ref) : "—"}
              {r.verified_on && <> · researched {r.verified_on}</>}
              {r.confirmation_state === "confirmed" && <> · confirmed by {r.confirmed_by} {dateTime(r.confirmed_at)}</>}
            </div>
          </div>
        ))}
      </div>
      <button className="btn small" onClick={() => setEdit({})}>Add requirement</button>
      {edit && <RequirementForm mid={mid} r={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </>
  );
}

function RequirementForm({ mid, r, onClose, onSaved }: { mid: string; r: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    category: r.category ?? "other", requirement: r.requirement ?? "", response: r.response ?? "",
    confirmation_state: r.confirmation_state ?? "unverified", source_ref: r.source_ref ?? "", verified_on: r.verified_on ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent, remove = false) => {
    e.preventDefault();
    const body = { ...f, verified_on: f.verified_on || null, signer_name: signer };
    const ok = await s.run(() => (r.id ? patch(`/marketplaces/${mid}/requirements/${r.id}`, remove ? { remove: true, version: r.version, signer_name: signer } : { ...body, version: r.version }) : post(`/marketplaces/${mid}/requirements`, body)));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={r.id ? "Edit requirement" : "Add requirement"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Category" required><Select value={f.category} onChange={(v) => setF({ ...f, category: v })} options={CATEGORY_LABEL} /></Field>
        <Field label="Confirmation state" required hint="Confirmed = the actual applicable supplier term, confirmed by the team."><Select value={f.confirmation_state} onChange={(v) => setF({ ...f, confirmation_state: v })} options={CONFIRM_LABEL} /></Field>
        <Field label="Supplier requirement" required wide error={s.fe("requirement")} hint={'"Not publicly available" is a valid researched note — not evidence that no requirement exists.'}>
          <textarea rows={3} value={f.requirement} onChange={(e) => setF({ ...f, requirement: e.target.value })} />
        </Field>
        <Field label="Our response" wide error={s.fe("response")}><textarea rows={3} value={f.response} onChange={(e) => setF({ ...f, response: e.target.value })} /></Field>
        <Field label="Source URL or reference" wide error={s.fe("source_ref")}><input value={f.source_ref} onChange={(e) => setF({ ...f, source_ref: e.target.value })} /></Field>
        <Field label="Research verification date" error={s.fe("verified_on")}><input type="date" value={f.verified_on} onChange={(e) => setF({ ...f, verified_on: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <div className="form-actions">
          {r.id && <button type="button" className="btn ghost danger" disabled={s.saving} onClick={(e) => confirm("Remove this requirement? It stays in the audit history.") && submit(e as any, true)}>Remove</button>}
          <button type="button" className="btn ghost" onClick={onClose} disabled={s.saving}>Cancel</button>
          <button type="submit" className="btn primary" disabled={s.saving}>{s.saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------- proposals
function Proposals({ mid, items, onChanged }: { mid: string; items: any[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      {items.length === 0 && <Empty>No products proposed yet. Select gifts maintained in Pricing → Gifts.</Empty>}
      <div className="cards">
        {items.map((p) => (
          <div className="card" key={p.id}>
            <div className="card-head">
              <strong>{productLabel(p.product_name, p.product_variant)}</strong>
              <button className="btn ghost small" onClick={() => setEdit(p)}>Edit</button>
            </div>
            <div className="row-gap wrap">
              <Pill tone={p.proposal_status === "approved" ? "ok" : p.proposal_status === "declined" ? "danger" : "neutral"}>{PROPOSAL_LABEL[p.proposal_status]}</Pill>
              <Pill tone="info">{OFFER_LABEL[p.offer_type]}</Pill>
              {p.product_family && <Pill>{FAMILY_LABEL[p.product_family]}</Pill>}
              <span className="hint">Card: {TRI_LABEL[p.card_eligible]} · Plants: {TRI_LABEL[p.plants_included]} · Individual fulfillment: {TRI_LABEL[p.individual_recipient_fulfillment]}</span>
            </div>
            {p.product_family === "pots_plus_succulents" && <div className="alert warn small">Complete gift, bulk orders only. Individual recipient shipping is unavailable.</div>}
            {p.offer_note && <div className="pre">{p.offer_note}</div>}
            <div className="hint">
              {p.submitted_on && <>Submitted {p.submitted_on} · </>}
              {p.listing_url && <><a href={p.listing_url} target="_blank" rel="noreferrer noopener">Listing</a> · </>}
              {p.approval_note && <>Approval note: {p.approval_note}</>}
            </div>
          </div>
        ))}
      </div>
      <button className="btn small" onClick={() => setEdit({})}>Propose product</button>
      {edit && <ProposalForm mid={mid} p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </>
  );
}

function ProposalForm({ mid, p, onClose, onSaved }: { mid: string; p: any; onClose: () => void; onSaved: () => void }) {
  const [product, setProduct] = useState<ProductLite | null>(p.id ? ({ id: p.product_id, name: p.product_name, variant: p.product_variant, family: p.product_family } as any) : null);
  const [f, setF] = useState({
    proposal_status: p.proposal_status ?? "proposed", offer_type: p.offer_type ?? "individual", offer_note: p.offer_note ?? "",
    submitted_on: p.submitted_on ?? "", listing_url: p.listing_url ?? "", approval_note: p.approval_note ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const bulkOnly = product?.family === "pots_plus_succulents";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, product_id: product?.id, submitted_on: f.submitted_on || null, signer_name: signer };
    const ok = await s.run(() => (p.id ? patch(`/marketplaces/${mid}/products/${p.id}`, { ...body, version: p.version }) : post(`/marketplaces/${mid}/products`, body)));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={p.id ? "Edit proposed product" : "Propose product"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Gift / variant" required wide error={s.fe("product_id")}>
          <ProductPicker value={product} onChange={(x) => { setProduct(x); if (x?.family === "pots_plus_succulents") setF({ ...f, offer_type: "bulk" }); }} selectedOnly />
        </Field>
        {bulkOnly && <div className="alert warn wide">Pots with succulents: complete gift, bulk orders only. Individual recipient shipping is unavailable.</div>}
        <Field label="Offer type" required error={s.fe("offer_type")}>
          <Select value={f.offer_type} onChange={(v) => setF({ ...f, offer_type: v })} options={Object.entries(OFFER_LABEL).filter(([k]) => !(bulkOnly && k === "individual"))} />
        </Field>
        <Field label="Product status"><Select value={f.proposal_status} onChange={(v) => setF({ ...f, proposal_status: v })} options={PROPOSAL_LABEL} /></Field>
        <Field label="Offer note" wide hint="Distinguish individual Live to Give Gift Boxes from bulk customized offers."><textarea rows={2} value={f.offer_note} onChange={(e) => setF({ ...f, offer_note: e.target.value })} /></Field>
        <Field label="Submission date" error={s.fe("submitted_on")}><input type="date" value={f.submitted_on} onChange={(e) => setF({ ...f, submitted_on: e.target.value })} /></Field>
        <Field label="Listing URL" error={s.fe("listing_url")}><input type="url" value={f.listing_url} onChange={(e) => setF({ ...f, listing_url: e.target.value })} /></Field>
        <Field label="Approval note (optional)" wide><input value={f.approval_note} onChange={(e) => setF({ ...f, approval_note: e.target.value })} /></Field>
        <p className="hint wide">A product decline never changes the marketplace status.</p>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} disabled={!product} />
      </form>
    </Overlay>
  );
}

// -------------------------------------------------------- communications
function Communications({ mid, items, onChanged }: { mid: string; items: any[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <p className="hint">Notes document communication done elsewhere. Nothing is sent from this site.</p>
      {items.length === 0 && <Empty>No communication recorded.</Empty>}
      <ul className="timeline">
        {items.map((c) => (
          <li key={c.id}>
            <div className="row-gap"><strong>{c.occurred_on}</strong> <Pill>{METHOD_LABEL[c.method]}</Pill> {c.contact_name && <span>with {c.contact_name}</span>}
              <span className="spacer" /><button className="btn ghost small" onClick={() => setEdit(c)}>Edit</button></div>
            <div className="pre">{c.summary}</div>
            <div className="hint">Recorded by {c.signer_name}{c.reference_url && <> · <a href={c.reference_url} target="_blank" rel="noreferrer noopener">Reference</a></>}</div>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => setEdit({})}>Add communication</button>
      {edit && <CommForm mid={mid} c={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </>
  );
}

function CommForm({ mid, c, onClose, onSaved }: { mid: string; c: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ occurred_on: c.occurred_on ?? today(), contact_name: c.contact_name ?? "", method: c.method ?? "email", summary: c.summary ?? "", reference_url: c.reference_url ?? "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent, remove = false) => {
    e.preventDefault();
    const ok = await s.run(() =>
      c.id
        ? patch(`/marketplaces/${mid}/communications/${c.id}`, remove ? { remove: true, version: c.version, signer_name: signer } : { ...f, version: c.version, signer_name: signer })
        : post(`/marketplaces/${mid}/communications`, { ...f, signer_name: signer }),
    );
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={c.id ? "Edit communication" : "Add communication"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Communication date" required error={s.fe("occurred_on")}><input type="date" value={f.occurred_on} onChange={(e) => setF({ ...f, occurred_on: e.target.value })} /></Field>
        <Field label="Method" required><Select value={f.method} onChange={(v) => setF({ ...f, method: v })} options={METHOD_LABEL} /></Field>
        <Field label="Contact name (optional)"><input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></Field>
        <Field label="Reference URL (optional)" error={s.fe("reference_url")}><input type="url" value={f.reference_url} onChange={(e) => setF({ ...f, reference_url: e.target.value })} /></Field>
        <Field label="Summary" required wide error={s.fe("summary")}><textarea rows={4} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <div className="form-actions">
          {c.id && <button type="button" className="btn ghost danger" disabled={s.saving} onClick={(e) => confirm("Remove this note? It stays in the audit history.") && submit(e as any, true)}>Remove</button>}
          <button type="button" className="btn ghost" onClick={onClose} disabled={s.saving}>Cancel</button>
          <button type="submit" className="btn primary" disabled={s.saving}>{s.saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------------ common terms
export function TermsView({ channel, onEdit }: { channel: any; onEdit: () => void }) {
  const v = (x: any) => (x === null || x === undefined || x === "" ? <span className="unknown">Unspecified</span> : x);
  return (
    <>
      <p className="hint">Recorded once for this channel. Gift-specific overrides live on each price. Agreed prices snapshot these terms, so later edits never rewrite history.</p>
      <dl className="kv">
        <dt>Payment terms</dt><dd>{v(channel.payment_terms)}</dd>
        <dt>Shipping responsibility</dt><dd>{v(channel.shipping_responsibility)}</dd>
        <dt>Fees / fee basis</dt><dd>{v(channel.fee_note)}</dd>
        <dt>Dispatch requirement</dt><dd>{v(channel.dispatch_requirement)}</dd>
        {channel.default_discount_pct != null && <><dt>Customer discount</dt><dd>{pct(channel.default_discount_pct)}</dd></>}
        {channel.corporate_moq != null && <><dt>Corporate MOQ</dt><dd>{channel.corporate_moq}</dd></>}
        <dt>Notes</dt><dd className="pre">{v(channel.terms_note)}</dd>
        {channel.terms_updated_by && <><dt>Last updated</dt><dd>{channel.terms_updated_by} · {dateTime(channel.terms_updated_at)}</dd></>}
      </dl>
      <button className="btn small" onClick={onEdit}>Edit common terms</button>
    </>
  );
}

export function TermsForm({ channel, onClose, onSaved }: { channel: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    payment_terms: channel.payment_terms ?? "", shipping_responsibility: channel.shipping_responsibility ?? "", fee_note: channel.fee_note ?? "",
    dispatch_requirement: channel.dispatch_requirement ?? "", terms_note: channel.terms_note ?? "",
    default_discount_pct: channel.default_discount_pct == null ? "" : String(channel.default_discount_pct),
    corporate_moq: channel.corporate_moq == null ? "" : String(channel.corporate_moq),
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => patch(`/channels/${channel.id}/terms`, {
      ...f, default_discount_pct: f.default_discount_pct === "" ? null : Number(f.default_discount_pct),
      corporate_moq: f.corporate_moq === "" ? null : Number(f.corporate_moq), version: channel.version, signer_name: signer,
    }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const t = (k: keyof typeof f, label: string, rows = 2) => (
    <Field label={label} wide error={s.fe(k)}><textarea rows={rows} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder="Leave blank if unknown" /></Field>
  );
  return (
    <Overlay kind="modal" title={`Common terms — ${channel.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {t("payment_terms", "Payment terms")}
        {t("shipping_responsibility", "Shipping responsibility")}
        {t("fee_note", "Fees and fee basis")}
        {t("dispatch_requirement", "Dispatch requirement")}
        {channel.type === "direct" && (
          <>
            <Field label="Customer discount %" error={s.fe("default_discount_pct")}><input inputMode="decimal" value={f.default_discount_pct} onChange={(e) => setF({ ...f, default_discount_pct: e.target.value })} /></Field>
            <Field label="Corporate MOQ" error={s.fe("corporate_moq")}><input inputMode="numeric" value={f.corporate_moq} onChange={(e) => setF({ ...f, corporate_moq: e.target.value })} /></Field>
          </>
        )}
        {t("terms_note", "Other notes", 3)}
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}
