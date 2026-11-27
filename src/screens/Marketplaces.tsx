import { useState, type FormEvent } from "react";
import { SampleSignups } from "../components/SampleSignups";
import { get, post, patch, qs } from "../api";
import type { Nav } from "../App";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, StatusBadge, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, useDebounced, usePref,
} from "../components/ui";
import { ProductPicker, type ProductLite } from "../components/ProductPicker";
import { BulkAddMarketplaces } from "./BulkAddMarketplaces";
import { BulkProposeProducts, BulkRequirements } from "./MarketplaceBulk";
import { APPLICATION_LABEL } from "./SupplierResources";
import {
  STATUS_LABEL, STATUSES, INACTIVE, REASON_LABEL, PROVIDER_LABEL, SUPPLIER_HELP, CATEGORY_LABEL, CONFIRM_LABEL, METHOD_LABEL,
  PROPOSAL_LABEL, OFFER_LABEL, FAMILY_LABEL, TRI_LABEL, date, dateTime, today, productLabel, pct,
  PARTNER_CATEGORY_LABEL, CHANNEL_MODEL_LABEL, OCCASION_LABEL, PRIORITY_LABEL, VIEW_LABEL, STAGE_GROUP_LABEL, READINESS_LABEL, RESEARCH_LABEL,
  CONTACT_ROLE_LABEL, REQ_KIND_LABEL, SB_READINESS_LABEL, SB_CAPABILITY, PRODUCT_CONSTRAINTS, NOT_PROMISED, stageText,
} from "../format";
import { ImportPartners, BulkUpdatePartners, BulkStagePartners, Contacts, ContactRoutes, MultiCheck } from "./PartnerParts";

const progressText = (m: any) =>
  m.milestones_applicable === 0 ? "No applicable milestones" : `${m.milestones_done} / ${m.milestones_applicable}`;

const isOverdue = (d: string | null) => !!d && String(d).slice(0, 10) < today();
const GROUPED_VIEWS = ["priority_a", "priority_b"];

export function MarketplacesScreen({ params, nav }: { params: Record<string, string>; nav: Nav }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [view, setView] = usePref("pt.view", "priority_a");
  const [category, setCategory] = usePref("pt.category", "");
  const [channel, setChannel] = usePref("pt.channel", "");
  const [stage, setStage] = usePref("pt.stage", "");
  const [owner, setOwner] = usePref("pt.owner", "");
  const [readiness, setReadiness] = usePref("pt.readiness", "");
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bulkEdit, setBulkEdit] = useState<null | "fields" | "stage">(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const openId = params.m ?? null;
  const list = useLoad(
    () => get(`/marketplaces${qs({ view, q: dq, category, channel_model: channel, stage, owner, readiness })}`),
    [view, dq, category, channel, stage, owner, readiness],
  );
  const rows: any[] = list.data?.marketplaces ?? [];
  const counts = list.data?.view_counts ?? {};
  const filtered = !!(dq || category || channel || stage || owner || readiness);
  const groups = GROUPED_VIEWS.includes(view)
    ? Object.keys(PARTNER_CATEGORY_LABEL).map((k) => [k, rows.filter((m) => m.category === k)] as [string, any[]]).filter(([, ms]) => ms.length)
      // Groups with the earliest due work first; rows inside a group stay due-first (server order).
      .sort(([, a], [, b]) => String(a[0]?.next_due ?? "9999").localeCompare(String(b[0]?.next_due ?? "9999")))
    : [["", rows] as [string, any[]]];
  const toggle = (id: string) => { const n = new Set(picked); n.has(id) ? n.delete(id) : n.add(id); setPicked(n); };
  const allPicked = rows.length > 0 && rows.every((m) => picked.has(m.id));
  const pickedRows = rows.filter((m) => picked.has(m.id));

  return (
    <div className="screen">
      <div className="toolbar">
        <h1>Partners</h1>
        <SampleSignups />
        <div className="spacer" />
        <button className="btn" onClick={() => setImporting(true)}>Import research</button>
        <button className="btn" onClick={() => setBulk(true)}>Add in bulk</button>
        <button className="btn primary" onClick={() => setAdding(true)}>Add partner</button>
      </div>
      <p className="hint lead">Companies that buy, sell, promote or distribute our gifts. Product vendors (who supply what we sell) are not partners.</p>
      <div className="view-tabs" role="tablist" aria-label="Saved views">
        {VIEW_LABEL.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => { setView(k); setPicked(new Set()); }}>
            {label} <span className="count">{counts[k] ?? "–"}</span>
          </button>
        ))}
      </div>
      <div className="filters">
        <input type="search" placeholder="Search names, aliases, contacts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search names, aliases and contacts" />
        <Select value={category} onChange={setCategory} options={PARTNER_CATEGORY_LABEL} empty="All categories" aria-label="Category" />
        <Select value={channel} onChange={setChannel} options={CHANNEL_MODEL_LABEL} empty="All channel models" aria-label="Channel model" />
        <Select value={stage} onChange={setStage} options={STAGE_GROUP_LABEL} empty="All stages" aria-label="Stage" />
        <Select value={owner} onChange={setOwner} options={[...(list.data?.owners ?? []).map((o: string) => [o.toLowerCase(), o] as [string, string]), ["none", "No owner"]]} empty="All owners" aria-label="Owner" />
        <Select value={readiness} onChange={setReadiness} options={READINESS_LABEL} empty="Any contact readiness" aria-label="Contact readiness" />
        {filtered && <button className="btn ghost small" onClick={() => { setQ(""); setCategory(""); setChannel(""); setStage(""); setOwner(""); setReadiness(""); }}>Clear filters</button>}
      </div>
      {list.data?.uncategorized > 0 && category !== "uncategorized" && (
        <div className="alert warn small" role="status">
          {list.data.uncategorized} partner{list.data.uncategorized === 1 ? " has" : "s have"} no category yet. “Uncategorized” is only a temporary fallback from the upgrade.{" "}
          <button className="btn ghost small" onClick={() => { setView("all"); setCategory("uncategorized"); }}>Show them</button>
        </div>
      )}
      {picked.size > 0 && (
        <div className="selection-bar" role="region" aria-label="Selected partners">
          <strong>{picked.size} selected</strong>
          <button className="btn small" onClick={() => setBulkEdit("fields")}>Update category / priority / owner…</button>
          <button className="btn small" onClick={() => setBulkEdit("stage")}>Change stage…</button>
          <button className="btn ghost small" onClick={() => setPicked(new Set())}>Clear selection</button>
        </div>
      )}
      {list.loading && !list.data && <Loading />}
      <ErrorBox error={list.error} />
      {list.data && (
        <div className="table-wrap">
          <table className="table partners">
            <thead><tr>
              <th className="pick"><input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((m) => m.id)))} /></th>
              <th>Company</th><th>Category</th><th>Channel model</th><th>Priority</th><th>Stage</th><th>Best contact</th><th>Next action</th><th>Due</th><th>Owner</th>
            </tr></thead>
            {rows.length === 0 && <tbody><tr><td colSpan={10}><Empty>{filtered ? "No partners match these filters." : "No partners in this view."}</Empty></td></tr></tbody>}
            {groups.map(([g, ms]) => (
              <tbody key={g || "all"}>
                {g && <tr className="group-row"><th colSpan={10} scope="colgroup">{PARTNER_CATEGORY_LABEL[g]} <span className="hint">({ms.length})</span></th></tr>}
                {ms.map((m) => (
                  <tr key={m.id} className={INACTIVE.includes(m.status) ? "muted-row" : ""}>
                    <td className="pick"><input type="checkbox" aria-label={`Select ${m.name}`} checked={picked.has(m.id)} onChange={() => toggle(m.id)} /></td>
                    <td data-label="Company"><button className="link strong" onClick={() => nav("marketplaces", { m: m.id })}>{m.name}</button></td>
                    <td data-label="Category">{m.category === "uncategorized" ? <span className="unknown">Uncategorized</span> : PARTNER_CATEGORY_LABEL[m.category]}</td>
                    <td data-label="Channel model">{m.channel_models?.length ? m.channel_models.map((c: string) => CHANNEL_MODEL_LABEL[c]).join(", ") : <span className="unknown">—</span>}</td>
                    <td data-label="Priority">{m.priority === "not_assessed" ? <span className="unknown">Not assessed</span> : <Pill tone={m.priority === "a" ? "ok" : m.priority === "b" ? "info" : "neutral"}>{PRIORITY_LABEL[m.priority]}</Pill>}</td>
                    <td data-label="Stage"><StatusBadge status={m.status} /></td>
                    <td data-label="Best contact">{bestContact(m)}</td>
                    <td data-label="Next action" className="clip">{m.next_action || <span className="unknown">No next action</span>}</td>
                    <td data-label="Due">{m.next_due ? <span className={isOverdue(m.next_due) ? "overdue" : ""}>{isOverdue(m.next_due) ? "Overdue · " : ""}{date(m.next_due)}</span> : <span className="unknown">—</span>}</td>
                    <td data-label="Owner">{m.owner || <span className="unknown">No owner</span>}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {notice && <div className="alert success" role="status">{notice} <button className="btn ghost small" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {bulk && <BulkAddMarketplaces onClose={() => setBulk(false)} onSaved={(n) => { setBulk(false); setNotice(`${n} partner${n === 1 ? "" : "s"} added.`); list.reload(); }} />}
      {importing && <ImportPartners onClose={() => setImporting(false)} onApplied={(msg) => { setImporting(false); setNotice(msg); list.reload(); }} />}
      {bulkEdit === "fields" && <BulkUpdatePartners rows={pickedRows} onClose={() => setBulkEdit(null)} onSaved={(n) => { setBulkEdit(null); setPicked(new Set()); setNotice(`${n} partner${n === 1 ? "" : "s"} updated.`); list.reload(); }} />}
      {bulkEdit === "stage" && <BulkStagePartners rows={pickedRows} onClose={() => setBulkEdit(null)} onSaved={(n) => { setBulkEdit(null); setPicked(new Set()); setNotice(`Stage changed for ${n} partner${n === 1 ? "" : "s"}.`); list.reload(); }} />}
      {adding && <MarketplaceForm onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); list.reload(); nav("marketplaces", { m: id }); }} />}
      {openId && <MarketplaceDetail id={openId} nav={nav} onClose={() => { nav("marketplaces"); list.reload(); }} onChanged={list.reload} />}
    </div>
  );
}

function bestContact(m: any) {
  if (m.best_contact_name) return <>{m.best_contact_name} <span className="hint">· {CONTACT_ROLE_LABEL[m.best_contact_role]}{m.best_contact_verification === "needs_verification" ? " · verify" : ""}</span></>;
  if (m.readiness === "route") return <span className="hint">Published route</span>;
  if (m.readiness === "no_contact_needed") return <span className="hint">No contact needed</span>;
  if (m.readiness === "not_researched") return <span className="unknown">Not researched</span>;
  return <span className="gap">Contact needed</span>;
}

// ------------------------------------------------------------- add / edit
function MarketplaceForm({ existing, onClose, onSaved }: { existing?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({
    name: existing?.name ?? "", provider_type: existing?.provider_type ?? "marketplace", status: "prospect",
    contact_name: existing?.contact_name ?? "", contact_email: existing?.contact_email ?? "", website_url: existing?.website_url ?? "",
    portal_url: existing?.portal_url ?? "", description: existing?.description ?? "", priority_note: existing?.priority_note ?? "",
    initial_action: existing?.initial_action ?? "",
    sales_role: existing?.sales_role ?? "confirmed", aliases: (existing?.aliases ?? []).join(", "),
    application_status: existing?.application_status ?? "",
    application_date: existing?.application_date ? String(existing.application_date).slice(0, 10) : "",
    category: existing?.category ?? "uncategorized", priority: existing?.priority ?? "not_assessed", owner: existing?.owner ?? "",
    parent_company: existing?.parent_company ?? "", opportunity_summary: existing?.opportunity_summary ?? "",
    next_action: existing?.next_action ?? "", next_action_due: existing?.next_action_due ? String(existing.next_action_due).slice(0, 10) : "",
    research_state: existing?.research_state ?? "", contact_next_step: existing?.contact_next_step ?? "",
  });
  const [models, setModels] = useState<string[]>(existing?.channel_models ?? []);
  const [occasions, setOccasions] = useState<string[]>(existing?.occasion_tags ?? []);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let id = existing?.id;
    const ok = await s.run(async () => {
      const { status, sales_role, aliases, application_status, application_date, next_action_due, research_state, ...rest } = f;
      // Application fields are sent only when they changed (each change records when it was confirmed).
      const appChanged = existing && (application_status !== (existing.application_status ?? "") || application_date !== (existing.application_date ? String(existing.application_date).slice(0, 10) : ""));
      const extra = {
        aliases: (aliases as string).split(",").map((x: string) => x.trim()).filter(Boolean),
        channel_models: models, occasion_tags: occasions, next_action_due: next_action_due || null, research_state: research_state || null,
        ...(appChanged ? { application_status: application_status || null, application_date: application_date || null } : {}),
      };
      if (existing) await patch(`/marketplaces/${existing.id}`, { ...rest, ...extra, sales_role, signer_name: signer, version: existing.version });
      else id = (await post("/marketplaces", { ...rest, ...extra, status, signer_name: signer })).marketplace.id;
    });
    if (ok) { rememberSigner(signer); onSaved(id); }
  };
  return (
    <Overlay kind="modal" wide title={existing ? "Edit partner" : "Add partner"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <h3 className="wide form-heading">Overview</h3>
        <Field label="Name" required error={s.fe("name")}><input value={f.name} onChange={set("name")} maxLength={120} /></Field>
        <Field label="Other names (verified)" error={s.fe("aliases")} hint="Comma-separated. Used for search and Slack matching; add only names confirmed to mean this company.">
          <input value={f.aliases} onChange={set("aliases")} />
        </Field>
        <Field label="Primary category" required><Select value={f.category} onChange={set("category")} options={PARTNER_CATEGORY_LABEL} /></Field>
        <Field label="Priority" hint="Independent of the stage."><Select value={f.priority} onChange={set("priority")} options={PRIORITY_LABEL} /></Field>
        <Field label="Channel models" wide hint="How we would work with them. Separate from the pricing model on each price.">
          <MultiCheck options={CHANNEL_MODEL_LABEL} value={models} onChange={setModels} />
        </Field>
        <Field label="Occasions (optional)" wide><MultiCheck options={OCCASION_LABEL} value={occasions} onChange={setOccasions} /></Field>
        <Field label="Provider type" required hint={f.provider_type === "supplier_opportunity" ? SUPPLIER_HELP : undefined}>
          <Select value={f.provider_type} onChange={set("provider_type")} options={PROVIDER_LABEL} />
        </Field>
        {!existing && (
          <Field label="Initial stage"><Select value={f.status} onChange={set("status")} options={STATUSES.filter((x) => !INACTIVE.includes(x)).map((x) => [x, stageText(x)])} /></Field>
        )}
        <Field label="Owner" error={s.fe("owner")}><input value={f.owner} onChange={set("owner")} maxLength={80} /></Field>
        <Field label="Parent company" error={s.fe("parent_company")} hint="Information only — never used to merge records."><input value={f.parent_company} onChange={set("parent_company")} /></Field>
        <Field label="Official website" error={s.fe("website_url")}><input type="url" value={f.website_url} onChange={set("website_url")} placeholder="https://" /></Field>
        <Field label="Vendor portal" error={s.fe("portal_url")}><input type="url" value={f.portal_url} onChange={set("portal_url")} placeholder="https://" /></Field>
        <Field label="Opportunity summary" wide error={s.fe("opportunity_summary")}><textarea rows={3} value={f.opportunity_summary} onChange={set("opportunity_summary")} /></Field>
        <Field label="Next action" wide error={s.fe("next_action")}><textarea rows={2} value={f.next_action} onChange={set("next_action")} /></Field>
        <Field label="Next action due" error={s.fe("next_action_due")}><input type="date" value={f.next_action_due} onChange={set("next_action_due")} /></Field>
        <Field label="Contact research" hint="Research readiness, separate from the stage."><Select value={f.research_state} onChange={set("research_state")} options={RESEARCH_LABEL} empty="Not recorded" /></Field>
        <Field label="Contact next step" wide error={s.fe("contact_next_step")}><textarea rows={2} value={f.contact_next_step} onChange={set("contact_next_step")} /></Field>
        {existing && <>
          <h3 className="wide form-heading">Slack and application</h3>
          <Field label="Sells our corporate gifts" hint="Unclear keeps this record out of the Slack scan until confirmed.">
            <Select value={f.sales_role} onChange={set("sales_role")} options={{ confirmed: "Confirmed", unclear: "Unclear" }} />
          </Field>
          <Field label="Application status" hint="Separate from the stage.">
            <Select value={f.application_status} onChange={set("application_status")} options={APPLICATION_LABEL} empty="Not recorded" />
          </Field>
          <Field label="Application date" error={s.fe("application_date")} hint="Leave blank if unknown."><input type="date" value={f.application_date} onChange={set("application_date")} /></Field>
        </>}
        <h3 className="wide form-heading">Older fields</h3>
        <Field label="Contact name" error={s.fe("contact_name")} hint="Add people under Contacts & applications."><input value={f.contact_name} onChange={set("contact_name")} /></Field>
        <Field label="Contact email" error={s.fe("contact_email")}><input type="email" value={f.contact_email} onChange={set("contact_email")} /></Field>
        <Field label="Priority note" error={s.fe("priority_note")}><input value={f.priority_note} onChange={set("priority_note")} /></Field>
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
  const options = STATUSES.filter((x) => x !== m.status).map((x) => [x, stageText(x) + (reactivating && (x === "reconnecting" || x === "preparing_application") ? " (suggested)" : "")] as [string, string]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => post(`/marketplaces/${m.id}/status-transitions`, {
      to_status: to, version: m.version, signer_name: signer,
      ...(inactive ? { reason: f.reason || null, detail: f.detail, revisit_date: f.revisit_date || null, ...(to === "not_qualified" ? { unmet_requirement: f.unmet_requirement, what_would_change: f.what_would_change } : {}) } : { detail: f.detail }),
    }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={reactivating ? "Reactivate" : "Change stage"} subtitle={<>Current: <StatusBadge status={m.status} /></>} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {reactivating && <p className="hint wide">Reactivation keeps every checklist state, price, communication and revenue record. Nothing is reset automatically.</p>}
        {inactive && <p className="hint wide">Closed stages keep the record and its history, and leave it out of outreach views, follow-ups and task suggestions. Open tasks are listed on the record for you to reconcile; they are not closed automatically.</p>}
        <Field label="New stage" required error={s.fe("to_status")}><Select value={to} onChange={setTo} options={options} empty="Choose…" /></Field>
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
  const none = (t = "Not recorded") => <span className="unknown">{t}</span>;
  const due = m?.next_action_due ? String(m.next_action_due).slice(0, 10) : null;
  return (
    <Overlay title={m ? m.name : "Partner"} subtitle={m && <span className="row-gap">{PARTNER_CATEGORY_LABEL[m.category]} <StatusBadge status={m.status} /> {m.priority !== "not_assessed" && <Pill>Priority {PRIORITY_LABEL[m.priority]}</Pill>}</span>} onClose={onClose}>
      {d.loading && !d.data && <Loading />}
      <ErrorBox error={d.error} />
      {m && (
        <>
          <div className="detail-actions">
            <button className="btn small" onClick={() => setModal("edit")}>Edit details</button>
            <button className="btn small" onClick={() => setModal("status")}>{INACTIVE.includes(m.status) ? "Reactivate" : "Change stage"}</button>
            {m.sales_role === "confirmed" && <button className="btn small" onClick={() => nav("resources", { view: "suppliers", supplier: `partner:${m.id}` })}>Partner Resources{d.data.resource_count ? ` (${d.data.resource_count})` : ""}</button>}
            <button className="btn ghost small" onClick={() => nav("pricing", { channel: m.channel_id })}>Pricing for {m.name} →</button>
            <button className="btn ghost small" onClick={() => nav("revenue", { channel: m.channel_id })}>Revenue for {m.name} →</button>
          </div>
          {d.data.closed && (
            <div className="alert neutral" role="note">
              <strong>{stageText(m.status)}</strong> — left out of outreach views, follow-ups and task suggestions. The record and its history are kept.
              {d.data.statusHistory[0] && <InactiveNote h={d.data.statusHistory[0]} bare />}
              {(d.data.open_tasks.length > 0 || d.data.open_actions.length > 0) && (
                <div className="reconcile">
                  <strong>Open tasks to reconcile ({d.data.open_tasks.length + d.data.open_actions.length})</strong> — not closed automatically. Close or keep each one where it lives.
                  <ul>
                    {d.data.open_tasks.map((t: any) => <li key={t.id}>{t.title} <span className="hint">· task request · {t.delivery_status}{t.tracker_status ? ` · Task Tracker: ${t.tracker_status}` : ""}</span>{t.tracker_open_url && <> · <a href={t.tracker_open_url} target="_blank" rel="noreferrer noopener">Open</a></>}</li>)}
                    {d.data.open_actions.map((t: any) => <li key={t.id}>{t.title} <span className="hint">· {t.kind}{t.due_date ? ` · due ${date(t.due_date)}` : ""}</span></li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          <Section title="Overview">
            <dl className="kv">
              <dt>Website</dt><dd>{m.website_url ? <a href={m.website_url} target="_blank" rel="noreferrer noopener">{m.website_url}</a> : none()}</dd>
              <dt>Other names</dt><dd>{m.aliases?.length ? m.aliases.join(", ") : none("None recorded")}</dd>
              <dt>Parent company</dt><dd>{m.parent_company || none()}</dd>
              <dt>Category</dt><dd>{PARTNER_CATEGORY_LABEL[m.category]}</dd>
              <dt>Channel models</dt><dd>{m.channel_models?.length ? m.channel_models.map((c: string) => CHANNEL_MODEL_LABEL[c]).join(", ") : none()}</dd>
              <dt>Occasions</dt><dd>{m.occasion_tags?.length ? m.occasion_tags.map((c: string) => OCCASION_LABEL[c]).join(", ") : none("None tagged")}</dd>
              <dt>Priority</dt><dd>{PRIORITY_LABEL[m.priority]}</dd>
              <dt>Stage</dt><dd><StatusBadge status={m.status} /></dd>
              <dt>Owner</dt><dd>{m.owner || none("No owner")}</dd>
              <dt>Opportunity</dt><dd className="pre">{m.opportunity_summary || none()}</dd>
              <dt>Next action</dt><dd className="pre">{m.next_action || none("No next action")}{due && <> · <span className={due < today() ? "overdue" : ""}>due {due}</span></>}</dd>
              <dt>Application</dt><dd>{m.application_status ? APPLICATION_LABEL[m.application_status] : none()}{m.application_date && ` · ${String(m.application_date).slice(0, 10)}`}</dd>
              {m.sales_role === "unclear" && <><dt>Sales role</dt><dd>Unclear: not included in the Slack scan until confirmed</dd></>}
              <dt>Provider type</dt><dd>{PROVIDER_LABEL[m.provider_type]}</dd>
              {m.priority_note && <><dt>Priority note</dt><dd>{m.priority_note}</dd></>}
              {m.initial_action && <><dt>Initial action</dt><dd>{m.initial_action}</dd></>}
              {m.description && <><dt>Description</dt><dd className="pre">{m.description}</dd></>}
            </dl>
          </Section>

          <Section title="Contacts & applications" count={d.data.contacts.length + d.data.applications.length}>
            <p className="hint">Research: {m.research_state ? RESEARCH_LABEL[m.research_state] : "not recorded"}{m.contact_next_step && <> · Next step: {m.contact_next_step}</>}</p>
            {(m.contact_name || m.contact_email) && <p className="hint">Older contact field: {m.contact_name}{m.contact_email && <> · <a href={`mailto:${m.contact_email}`}>{m.contact_email}</a></>}</p>}
            <Contacts mid={id} items={d.data.contacts} onChanged={reload} />
            <ContactRoutes mid={id} items={d.data.applications} onChanged={reload} />
          </Section>

          <Section title="Requirements & terms" count={d.data.requirements.length}>
            <div className="alert neutral small"><strong>SB capability:</strong> {SB_CAPABILITY} Bulk pricing is separate from this capability.</div>
            <Requirements mid={id} items={d.data.requirements} onChanged={reload} />
            <h4>Common agreement terms</h4>
            <TermsView channel={d.data.channel} onEdit={() => setModal("terms")} />
          </Section>

          <Section title="Products & pricing" count={d.data.products.length}>
            <details className="constraints"><summary>Product constraints</summary>
              <ul>{PRODUCT_CONSTRAINTS.map(([k, v]) => <li key={k}><strong>{k}:</strong> {v}</li>)}</ul>
              <p className="hint">{NOT_PROMISED} Products are never proposed automatically.</p>
            </details>
            <Proposals mid={id} items={d.data.products} onChanged={reload} />
            <h4>Setup checklist <span className="hint">({progressText(m)})</span></h4>
            <Milestones mid={id} items={d.data.milestones} history={d.data.milestoneHistory} onChanged={reload} />
          </Section>

          <Section title="Resources & activity" count={d.data.communications.length}>
            <p className="hint">Documents, quotes and decisions are kept in <button className="link" onClick={() => nav("resources", { view: "suppliers", supplier: `partner:${m.id}` })}>Partner Resources</button> for this same record.</p>
            <h4>Communication notes</h4>
            <Communications mid={id} items={d.data.communications} onChanged={reload} />
            <h4>Stage history</h4>
            <ul className="timeline">
              {d.data.statusHistory.map((h: any) => (
                <li key={h.id}>
                  <div><strong>{h.from_status ? `${stageText(h.from_status)} → ` : ""}{stageText(h.to_status)}</strong> {h.reason && <span className="hint">· {REASON_LABEL[h.reason] ?? h.reason}</span>}</div>
                  {h.detail && <div className="pre">{h.detail}</div>}
                  {h.unmet_requirement && <div>Unmet requirement: {h.unmet_requirement}</div>}
                  {h.what_would_change && <div>What would change: {h.what_would_change}</div>}
                  {h.revisit_date && <div>Revisit: {h.revisit_date}</div>}
                  <div className="hint">{h.signer_name} · {dateTime(h.created_at)}</div>
                </li>
              ))}
            </ul>
            {d.data.imports.length > 0 && <>
              <h4>Research imports</h4>
              <ul className="timeline small">{d.data.imports.map((i: any) => <li key={i.batch_id + i.line}>{i.source_name} · line {i.line} · {i.outcome.replace(/_/g, " ")}{i.status === "reversed" ? " · reversed" : ""} <span className="hint">· {dateTime(i.created_at)}</span></li>)}</ul>
            </>}
          </Section>
          {modal === "edit" && <MarketplaceForm existing={m} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
          {modal === "status" && <StatusForm m={m} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
          {modal === "terms" && <TermsForm channel={d.data.channel} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
        </>
      )}
    </Overlay>
  );
}

function InactiveNote({ h, bare }: { h: any; bare?: boolean }) {
  return (
    <div className={bare ? "" : "alert neutral"}>
      {!bare && <strong>{stageText(h.to_status)}</strong>}{h.reason && <>{bare ? "Reason: " : " — "}{REASON_LABEL[h.reason] ?? h.reason}</>}
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
  const [bulk, setBulk] = useState(false);
  const kinds = Object.keys(REQ_KIND_LABEL).filter((k) => items.some((r) => (r.kind ?? "published") === k));
  return (
    <>
      {items.length === 0 && <Empty>No requirements or terms recorded.</Empty>}
      {kinds.map((k) => (
        <div key={k} className="req-kind">
          <h4>{REQ_KIND_LABEL[k]}</h4>
          {k === "ordering_assumption" && <p className="hint">Assumptions about how the partner would order — not published or agreed terms.</p>}
          <div className="cards">
            {items.filter((r) => (r.kind ?? "published") === k).map((r) => (
              <div className="card" key={r.id}>
                <div className="card-head">
                  <span className="row-gap wrap"><Pill>{CATEGORY_LABEL[r.category]}</Pill><Pill tone={r.confirmation_state === "confirmed" ? "ok" : r.confirmation_state === "awaiting_clarification" ? "warn" : "neutral"}>{CONFIRM_LABEL[r.confirmation_state]}</Pill>
                    {r.sb_readiness && <Pill tone={r.sb_readiness === "meets" ? "ok" : r.sb_readiness === "cannot_meet" ? "danger" : r.sb_readiness === "needs_confirmation" ? "warn" : "neutral"}>{SB_READINESS_LABEL[r.sb_readiness]}</Pill>}</span>
                  <button className="btn ghost small" onClick={() => setEdit(r)}>Edit</button>
                </div>
                <div className="req-grid">
                  <div><div className="label">{k === "sb_capability" ? "SB note" : k === "open_question" ? "Question" : "Requirement / term"}</div><div className="pre">{r.requirement}</div></div>
                  <div><div className="label">Our response</div><div className="pre">{r.response || <span className="unknown">No response yet</span>}</div></div>
                </div>
                {r.applicability && <div className="hint">Applies to: {r.applicability}</div>}
                {r.verification && <div className="hint">Verification: {r.verification}</div>}
                <div className="hint">
                  Source: {r.source_ref ? (/^https?:\/\//.test(r.source_ref) ? <a href={r.source_ref.split(" ; ")[0]} target="_blank" rel="noreferrer noopener">{r.source_ref}</a> : r.source_ref) : "—"}
                  {r.verified_on && <> · checked {r.verified_on}</>}
                  {r.confirmation_state === "confirmed" && <> · confirmed by {r.confirmed_by} {dateTime(r.confirmed_at)}</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="row-gap">
        <button className="btn small" onClick={() => setEdit({})}>Add requirement or term</button>
        <button className="btn small" onClick={() => setBulk(true)}>Add several</button>
      </div>
      {bulk && <BulkRequirements mid={mid} onClose={() => setBulk(false)} onSaved={() => { setBulk(false); onChanged(); }} />}
      {edit && <RequirementForm mid={mid} r={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </>
  );
}

function RequirementForm({ mid, r, onClose, onSaved }: { mid: string; r: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    kind: r.kind ?? "published", category: r.category ?? "other", requirement: r.requirement ?? "", response: r.response ?? "",
    confirmation_state: r.confirmation_state ?? "unverified", source_ref: r.source_ref ?? "", verified_on: r.verified_on ?? "",
    applicability: r.applicability ?? "", sb_readiness: r.sb_readiness ?? "", verification: r.verification ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent, remove = false) => {
    e.preventDefault();
    const body = { ...f, verified_on: f.verified_on || null, sb_readiness: f.sb_readiness || null, signer_name: signer };
    const ok = await s.run(() => (r.id ? patch(`/marketplaces/${mid}/requirements/${r.id}`, remove ? { remove: true, version: r.version, signer_name: signer } : { ...body, version: r.version }) : post(`/marketplaces/${mid}/requirements`, body)));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const t = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target ? e.target.value : e });
  return (
    <Overlay kind="modal" title={r.id ? "Edit requirement or term" : "Add requirement or term"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Kind" required hint="Keep published requirements, negotiated terms, assumptions, open questions and SB notes apart."><Select value={f.kind} onChange={t("kind")} options={REQ_KIND_LABEL} /></Field>
        <Field label="Category" required><Select value={f.category} onChange={t("category")} options={CATEGORY_LABEL} /></Field>
        <Field label="Confirmation state" required hint="Confirmed = the actual applicable term, confirmed by the team."><Select value={f.confirmation_state} onChange={t("confirmation_state")} options={CONFIRM_LABEL} /></Field>
        <Field label="SB readiness"><Select value={f.sb_readiness} onChange={t("sb_readiness")} options={SB_READINESS_LABEL} empty="Not assessed" /></Field>
        <Field label="Requirement, term or question" required wide error={s.fe("requirement")} hint={'Unknown fees stay unknown — write "not published", never 0%. "Not publicly available" is a valid researched note.'}>
          <textarea rows={3} value={f.requirement} onChange={t("requirement")} />
        </Field>
        <Field label="Applies to" wide error={s.fe("applicability")} hint="e.g. a program, product type or region. Leave blank if it applies to the whole partnership."><input value={f.applicability} onChange={t("applicability")} /></Field>
        <Field label="Our response" wide error={s.fe("response")}><textarea rows={3} value={f.response} onChange={t("response")} /></Field>
        <Field label="Source URL or reference" wide error={s.fe("source_ref")}><input value={f.source_ref} onChange={t("source_ref")} /></Field>
        <Field label="Verification note" wide error={s.fe("verification")}><input value={f.verification} onChange={t("verification")} /></Field>
        <Field label="Date checked" error={s.fe("verified_on")}><input type="date" value={f.verified_on} onChange={t("verified_on")} /></Field>
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
  const [bulk, setBulk] = useState(false);
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
      <div className="row-gap">
        <button className="btn small" onClick={() => setEdit({})}>Propose product</button>
        <button className="btn small" onClick={() => setBulk(true)}>Propose several</button>
      </div>
      {bulk && <BulkProposeProducts mid={mid} onClose={() => setBulk(false)} onSaved={() => { setBulk(false); onChanged(); }} />}
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
        <p className="hint wide">A product decline never changes the partner stage.</p>
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
