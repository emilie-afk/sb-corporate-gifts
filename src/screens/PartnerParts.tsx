// Partners: contacts, contact routes / applications, bulk updates with preview, and the research import.
import { useState, type FormEvent } from "react";
import { get, post, patch } from "../api";
import { Field, Select, SignerField, FormActions, ErrorBox, Overlay, Pill, Empty, Loading, useSave, useSigner, rememberSigner, useLoad, StatusBadge } from "../components/ui";
import {
  PARTNER_CATEGORY_LABEL, CHANNEL_MODEL_LABEL, OCCASION_LABEL, PRIORITY_LABEL, CONTACT_ROLE_LABEL, VERIFICATION_LABEL, CONFIDENCE_LABEL,
  PURPOSE_LABEL, STATUSES, INACTIVE, REASON_LABEL, REQ_KIND_LABEL, RESEARCH_LABEL, stageText, dateTime,
} from "../format";

export function MultiCheck({ options, value, onChange }: { options: Record<string, string>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="multi-check">
      {Object.entries(options).map(([k, label]) => (
        <label key={k} className="check"><input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} /> {label}</label>
      ))}
    </div>
  );
}

const OUTREACH = ["supplier_sourcing", "relevant_partnerships", "routing", "executive_fallback"];
const roleTone = (role: string, ver: string) =>
  ["historical", "advertising_only", "press", "support"].includes(role) || ver === "former" ? "neutral" : role === "supplier_sourcing" && ver === "current_verified" ? "ok" : "info";

// ------------------------------------------------------------------ contacts
export function Contacts({ mid, items, onChanged }: { mid: string; items: any[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <h4>People</h4>
      {items.length === 0 && <Empty>No people recorded. “Responsible person not identified” and “Not researched” are research states, not names.</Empty>}
      <div className="cards">
        {items.map((c) => (
          <div className="card" key={c.id}>
            <div className="card-head">
              <span className="row-gap wrap"><strong>{c.name}</strong>
                <Pill tone={roleTone(c.role, c.role_verification)}>{CONTACT_ROLE_LABEL[c.role]}</Pill>
                {c.rank !== "other" && <Pill>{c.rank === "primary" ? "Primary" : "Backup"}</Pill>}
                <Pill tone={c.role_verification === "current_verified" ? "ok" : c.role_verification === "former" ? "danger" : "warn"}>{VERIFICATION_LABEL[c.role_verification]}</Pill>
                {c.confidence && <span className="hint">Confidence: {CONFIDENCE_LABEL[c.confidence]}</span>}</span>
              <button className="btn ghost small" onClick={() => setEdit(c)}>Edit</button>
            </div>
            {!OUTREACH.includes(c.role) || c.role_verification === "former" ? <div className="hint">Not offered as an outreach contact.</div> : null}
            {c.title && <div>{c.title}{c.company ? `, ${c.company}` : ""}</div>}
            {c.note && <div className="pre hint">{c.note}</div>}
            <div className="hint">
              {c.email && <><a href={`mailto:${c.email}`}>{c.email}</a> · </>}
              {c.phone && <>{c.phone} · </>}
              {c.profile_url && <><a href={c.profile_url} target="_blank" rel="noreferrer noopener">Profile</a> · </>}
              {c.source_urls?.length > 0 && <>Sources: {c.source_urls.map((u: string, i: number) => <a key={u} href={u} target="_blank" rel="noreferrer noopener">{i + 1}</a>).reduce((a: any[], x: any) => (a.length ? [...a, ", ", x] : [x]), [])} · </>}
              {c.checked_on ? `checked ${String(c.checked_on).slice(0, 10)}` : "date checked not recorded"}
            </div>
          </div>
        ))}
      </div>
      <button className="btn small" onClick={() => setEdit({})}>Add person</button>
      {edit && <ContactForm mid={mid} c={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </>
  );
}

function ContactForm({ mid, c, onClose, onSaved }: { mid: string; c: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: c.name ?? "", title: c.title ?? "", company: c.company ?? "", role: c.role ?? "relevant_partnerships", rank: c.rank ?? "other",
    email: c.email ?? "", phone: c.phone ?? "", profile_url: c.profile_url ?? "", sources: (c.source_urls ?? []).join("\n"),
    checked_on: c.checked_on ? String(c.checked_on).slice(0, 10) : "", role_verification: c.role_verification ?? "needs_verification", confidence: c.confidence ?? "", note: c.note ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const t = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const submit = async (e: FormEvent, remove = false) => {
    e.preventDefault();
    const { sources, ...rest } = f;
    const body = { ...rest, source_urls: sources.split(/\s+/).filter(Boolean), checked_on: f.checked_on || null, confidence: f.confidence || null, signer_name: signer };
    const ok = await s.run(() => c.id
      ? patch(`/marketplaces/${mid}/contacts/${c.id}`, remove ? { remove: true, version: c.version, signer_name: signer } : { ...body, version: c.version })
      : post(`/marketplaces/${mid}/contacts`, body));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={c.id ? "Edit person" : "Add person"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <p className="hint wide">Record only published business details. No personal emails, private phone numbers or guessed addresses.</p>
        <Field label="Name" required error={s.fe("name")}><input value={f.name} onChange={t("name")} maxLength={120} /></Field>
        <Field label="Role in this opportunity" required><Select value={f.role} onChange={t("role")} options={CONTACT_ROLE_LABEL} /></Field>
        <Field label="Title" error={s.fe("title")}><input value={f.title} onChange={t("title")} /></Field>
        <Field label="Company" error={s.fe("company")}><input value={f.company} onChange={t("company")} /></Field>
        <Field label="Primary / backup"><Select value={f.rank} onChange={t("rank")} options={{ primary: "Primary", backup: "Backup", other: "Other" }} /></Field>
        <Field label="Current role" required><Select value={f.role_verification} onChange={t("role_verification")} options={VERIFICATION_LABEL} /></Field>
        <Field label="Confidence"><Select value={f.confidence} onChange={t("confidence")} options={CONFIDENCE_LABEL} empty="Not stated" /></Field>
        <Field label="Date checked" error={s.fe("checked_on")}><input type="date" value={f.checked_on} onChange={t("checked_on")} /></Field>
        <Field label="Public business email" error={s.fe("email")}><input type="email" value={f.email} onChange={t("email")} /></Field>
        <Field label="Public business phone" error={s.fe("phone")}><input value={f.phone} onChange={t("phone")} /></Field>
        <Field label="Profile URL" wide error={s.fe("profile_url")}><input type="url" value={f.profile_url} onChange={t("profile_url")} /></Field>
        <Field label="Source URLs" wide error={s.fe("source_urls")} hint="One per line."><textarea rows={2} value={f.sources} onChange={t("sources")} /></Field>
        <Field label="Why this person / limitations" wide error={s.fe("note")}><textarea rows={3} value={f.note} onChange={t("note")} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <div className="form-actions">
          {c.id && <button type="button" className="btn ghost danger" disabled={s.saving} onClick={(e) => confirm("Remove this person? It stays in the audit history.") && submit(e as any, true)}>Remove</button>}
          <button type="button" className="btn ghost" onClick={onClose} disabled={s.saving}>Cancel</button>
          <button type="submit" className="btn primary" disabled={s.saving}>{s.saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Overlay>
  );
}

// ------------------------------------------------------- routes / applications
export function ContactRoutes({ mid, items, onChanged }: { mid: string; items: any[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <h4>Published routes & applications</h4>
      {items.length === 0 && <Empty>No published form, portal or inbox recorded.</Empty>}
      <ul className="timeline">
        {items.map((a) => (
          <li key={a.id}>
            <div className="row-gap wrap"><Pill tone={["supplier_application", "partnership", "self_serve_app"].includes(a.purpose) ? "info" : "neutral"}>{PURPOSE_LABEL[a.purpose]}</Pill>
              {a.label && <span>{a.label}</span>}{a.url && <a href={a.url} target="_blank" rel="noreferrer noopener">Open</a>}
              <span className="spacer" /><button className="btn ghost small" onClick={() => setEdit(a)}>Edit</button></div>
            {a.detail && <div className="pre hint">{a.detail}</div>}
            <div className="hint">{a.verification ? `${a.verification} · ` : ""}{a.checked_on ? `checked ${String(a.checked_on).slice(0, 10)}` : "date checked not recorded"}</div>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => setEdit({})}>Add route</button>
      {edit && <RouteForm mid={mid} a={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </>
  );
}

function RouteForm({ mid, a, onClose, onSaved }: { mid: string; a: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ purpose: a.purpose ?? "supplier_application", label: a.label ?? "", url: a.url ?? "", detail: a.detail ?? "", verification: a.verification ?? "", checked_on: a.checked_on ? String(a.checked_on).slice(0, 10) : "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const t = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const submit = async (e: FormEvent, remove = false) => {
    e.preventDefault();
    const body = { ...f, checked_on: f.checked_on || null, signer_name: signer };
    const ok = await s.run(() => a.id
      ? patch(`/marketplaces/${mid}/applications/${a.id}`, remove ? { remove: true, version: a.version, signer_name: signer } : { ...body, version: a.version })
      : post(`/marketplaces/${mid}/applications`, body));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={a.id ? "Edit route" : "Add route"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Purpose" required><Select value={f.purpose} onChange={t("purpose")} options={PURPOSE_LABEL} /></Field>
        <Field label="Label"><input value={f.label} onChange={t("label")} /></Field>
        <Field label="Link" wide error={s.fe("url")}><input type="url" value={f.url} onChange={t("url")} placeholder="https://" /></Field>
        <Field label="As published" wide error={s.fe("detail")} hint="The form, inbox or phone line exactly as the company publishes it."><textarea rows={2} value={f.detail} onChange={t("detail")} /></Field>
        <Field label="Verification" wide><input value={f.verification} onChange={t("verification")} /></Field>
        <Field label="Date checked"><input type="date" value={f.checked_on} onChange={t("checked_on")} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <div className="form-actions">
          {a.id && <button type="button" className="btn ghost danger" disabled={s.saving} onClick={(e) => confirm("Remove this route? It stays in the audit history.") && submit(e as any, true)}>Remove</button>}
          <button type="button" className="btn ghost" onClick={onClose} disabled={s.saving}>Cancel</button>
          <button type="submit" className="btn primary" disabled={s.saving}>{s.saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Overlay>
  );
}

// ---------------------------------------------------------------- bulk updates
const FIELD_LABEL: Record<string, string> = { category: "Category", priority: "Priority", owner: "Owner", channel_models: "Channel models", occasion_tags: "Occasions" };
const show = (field: string, v: any) =>
  v == null || v === "" ? "—" : field === "category" ? PARTNER_CATEGORY_LABEL[v] : field === "priority" ? PRIORITY_LABEL[v]
    : field === "channel_models" ? (v as string[]).map((x) => CHANNEL_MODEL_LABEL[x]).join(", ") || "—"
      : field === "occasion_tags" ? (v as string[]).map((x) => OCCASION_LABEL[x]).join(", ") || "—" : String(v);

export function BulkUpdatePartners({ rows, onClose, onSaved }: { rows: any[]; onClose: () => void; onSaved: (n: number) => void }) {
  const [field, setField] = useState("category");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<any | null>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const set = () => field === "channel_models" ? { add_channel_models: [value] } : field === "occasion_tags" ? { add_occasion_tags: [value] } : { [field]: field === "owner" ? value : value };
  const body = () => ({ ids: rows.map((r) => r.id), set: set(), signer_name: signer || "preview" });
  const options: Record<string, Record<string, string>> = { category: PARTNER_CATEGORY_LABEL, priority: PRIORITY_LABEL, channel_models: CHANNEL_MODEL_LABEL, occasion_tags: OCCASION_LABEL };
  return (
    <Overlay kind="modal" wide title={`Update ${rows.length} partner${rows.length === 1 ? "" : "s"}`} subtitle="Preview first; only the listed changes are saved." onClose={onClose}>
      <div className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Change"><Select value={field} onChange={(v) => { setField(v); setValue(""); setPreview(null); }} options={{ category: "Category", priority: "Priority", owner: "Owner", channel_models: "Add a channel model", occasion_tags: "Add an occasion" }} /></Field>
        <Field label="New value">{field === "owner"
          ? <input value={value} onChange={(e) => { setValue(e.target.value); setPreview(null); }} placeholder="Blank clears the owner" maxLength={80} />
          : <Select value={value} onChange={(v) => { setValue(v); setPreview(null); }} options={options[field]} empty="Choose…" />}</Field>
        <p className="hint wide">Stages are changed with “Change stage…”, which lists every affected record.</p>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <div className="form-actions wide">
          <button type="button" className="btn" disabled={s.saving || (field !== "owner" && !value)} onClick={() => s.run(async () => setPreview(await post("/marketplaces/bulk-update", { ...body(), dry_run: true })))}>Preview</button>
          <button type="button" className="btn primary" disabled={s.saving || !preview || !preview.changed} onClick={async () => {
            let n = 0;
            if (await s.run(async () => { n = (await post("/marketplaces/bulk-update", body())).changed; })) { rememberSigner(signer); onSaved(n); }
          }}>Save {preview ? preview.changed : ""} change{preview?.changed === 1 ? "" : "s"}</button>
        </div>
      </div>
      {preview && (
        <div className="table-wrap"><table className="table compact">
          <thead><tr><th>Partner</th><th>Stage</th><th>Change</th></tr></thead>
          <tbody>{preview.rows.map((r: any) => (
            <tr key={r.id}><td>{r.name}</td><td><StatusBadge status={r.status} /></td>
              <td>{r.diff.length ? r.diff.map((x: any) => <div key={x.field}>{FIELD_LABEL[x.field]}: {show(x.field, x.before)} → <strong>{show(x.field, x.after)}</strong></div>) : <span className="hint">No change</span>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </Overlay>
  );
}

export function BulkStagePartners({ rows, onClose, onSaved }: { rows: any[]; onClose: () => void; onSaved: (n: number) => void }) {
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [preview, setPreview] = useState<any | null>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const ids = rows.map((r) => r.id);
  const needsReason = INACTIVE.includes(to);
  const body = () => ({ ids, to_status: to, reason: needsReason ? reason || null : null, detail, signer_name: signer || "preview" });
  return (
    <Overlay kind="modal" wide title={`Change stage for ${rows.length} partner${rows.length === 1 ? "" : "s"}`} subtitle="Review the affected records before saving." onClose={onClose}>
      <div className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="New stage" required><Select value={to} onChange={(v) => { setTo(v); setPreview(null); }} options={STATUSES.map((x) => [x, stageText(x)])} empty="Choose…" /></Field>
        {needsReason && <Field label="Reason" required><Select value={reason} onChange={(v) => { setReason(v); setPreview(null); }} options={REASON_LABEL} empty="Choose…" /></Field>}
        <Field label="Detail" wide><textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <div className="form-actions wide">
          <button type="button" className="btn" disabled={s.saving || !to || (needsReason && !reason)} onClick={() => s.run(async () => setPreview(await post("/marketplaces/bulk-stage", { ...body(), dry_run: true })))}>Preview</button>
          <button type="button" className="btn primary" disabled={s.saving || !preview || !preview.changing} onClick={async () => {
            let n = 0;
            if (await s.run(async () => { n = (await post("/marketplaces/bulk-stage", { ...body(), confirm_ids: preview.rows.map((r: any) => r.id) })).changing; })) { rememberSigner(signer); onSaved(n); }
          }}>Change {preview ? preview.changing : ""} stage{preview?.changing === 1 ? "" : "s"}</button>
        </div>
      </div>
      {preview && <>
        <div className="table-wrap"><table className="table compact">
          <thead><tr><th>Partner</th><th>Current</th><th>New</th></tr></thead>
          <tbody>{preview.rows.map((r: any) => <tr key={r.id}><td>{r.name}</td><td><StatusBadge status={r.from} /></td><td>{r.unchanged ? <span className="hint">Already this stage</span> : <StatusBadge status={r.to} />}</td></tr>)}</tbody>
        </table></div>
        {preview.open_tasks.length > 0 && <div className="alert warn">These open tasks stay open — reconcile them separately: {preview.open_tasks.map((t: any) => `${t.title} (${t.partner})`).join("; ")}</div>}
      </>}
    </Overlay>
  );
}

// --------------------------------------------------------------- research import
const OUTCOME_LABEL: Record<string, string> = {
  new: "New", existing_match: "Existing match", possible_duplicate: "Possible duplicate", conflict: "Conflicting fields",
  skipped_by_decision: "Skipped by decision", invalid: "Invalid row", not_imported: "Excluded",
};
const OUTCOME_TONE: Record<string, "neutral" | "warn" | "ok" | "info" | "danger"> = {
  new: "ok", existing_match: "info", possible_duplicate: "warn", conflict: "warn", skipped_by_decision: "neutral", invalid: "danger", not_imported: "neutral",
};

export function ImportPartners({ onClose, onApplied }: { onClose: () => void; onApplied: (msg: string) => void }) {
  const [csv, setCsv] = useState("");
  const [name, setName] = useState("");
  const [decisions, setDecisions] = useState<Record<string, any>>({});
  const [p, setP] = useState<any | null>(null);
  const [filter, setFilter] = useState("");
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const [tab, setTab] = useState<"new" | "history">("new");
  const preview = (d = decisions) => s.run(async () => setP(await post("/partners/import/preview", { csv, source_name: name || "Partner research import", decisions: d })));
  const decide = (key: string, patchD: any) => {
    const next = { ...decisions, [key]: { ...(decisions[key] ?? {}), ...patchD } };
    for (const k of Object.keys(next[key])) if (next[key][k] === undefined) delete next[key][k];
    if (!Object.keys(next[key]).length) delete next[key];
    setDecisions(next); preview(next);
  };
  const file = async (f: File | undefined) => { if (!f) return; setCsv(await f.text()); setName(f.name.replace(/\.csv$/i, "")); setP(null); setDecisions({}); };
  const rows = (p?.rows ?? []).filter((r: any) => !filter || r.outcome === filter);
  return (
    <Overlay kind="modal" wide title="Import partner research" subtitle="Preview → review → apply. Nothing is written until you apply." onClose={onClose}>
      <div className="tabs small-tabs"><button className={tab === "new" ? "active" : ""} onClick={() => setTab("new")}>New import</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Past imports</button></div>
      {tab === "history" ? <ImportHistory /> : <>
        <ErrorBox error={s.error} />
        <div className="form-grid">
          <Field label="CSV file" wide hint="The file stays in your browser until you preview; it is never stored in the code repository.">
            <input type="file" accept=".csv,text/csv" onChange={(e) => file(e.target.files?.[0])} />
          </Field>
          <Field label="Import name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
          <div className="form-actions"><button type="button" className="btn" disabled={!csv || s.saving} onClick={() => preview()}>{p ? "Refresh preview" : "Preview"}</button></div>
        </div>
        {p && <>
          <div className="row-gap wrap import-summary">
            <button className={`btn ghost small ${filter === "" ? "active" : ""}`} onClick={() => setFilter("")}>All {p.summary.rows}</button>
            {Object.keys(OUTCOME_LABEL).filter((k) => p.summary[k]).map((k) => <button key={k} className={`btn ghost small ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}><Pill tone={OUTCOME_TONE[k]}>{OUTCOME_LABEL[k]} {p.summary[k]}</Pill></button>)}
            <span className="hint">By priority: {Object.entries(p.by_priority).map(([k, n]) => `${k === "skipped" ? "Skipped" : PRIORITY_LABEL[k]} ${n}`).join(" · ")}</span>
          </div>
          {p.unknown_columns.length > 0 && <p className="hint">Columns not imported: {p.unknown_columns.join(", ")}</p>}
          {p.blocking > 0 && <div className="alert warn">{p.blocking} possible duplicate{p.blocking === 1 ? "" : "s"} need a decision before applying.</div>}
          <div className="import-rows">
            {rows.map((r: any) => <ImportRowCard key={r.line} r={r} decide={(d) => decide(r.key, d)} />)}
          </div>
          <div className="form-grid">
            <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
            <div className="form-actions">
              <button type="button" className="btn primary" disabled={s.saving || p.blocking > 0} onClick={async () => {
                let msg = "";
                if (await s.run(async () => {
                  const r = await post("/partners/import/apply", { csv, source_name: name || "Partner research import", decisions, signer_name: signer });
                  msg = `Import applied: ${r.totals.created} new partners, ${r.totals.filled} empty fields filled, ${r.totals.contacts} people, ${r.totals.routes} routes and ${r.totals.requirements} requirements added. It can be reversed from Past imports.`
                    + (r.late_conflicts?.length ? ` ${r.late_conflicts.length} field(s) changed after the preview were kept and recorded as conflicts: ${r.late_conflicts.map((x: any) => `${x.company} (${x.field.replace(/_/g, " ")})`).join(", ")}.` : "");
                })) { rememberSigner(signer); onApplied(msg); }
              }}>Apply import</button>
            </div>
          </div>
        </>}
      </>}
    </Overlay>
  );
}

function ImportRowCard({ r, decide }: { r: any; decide: (d: any) => void }) {
  const [open, setOpen] = useState(r.outcome === "possible_duplicate" || r.outcome === "conflict" || r.outcome === "invalid");
  const d = r.decision ?? {};
  const v = (x: unknown) => (Array.isArray(x) ? x.join(", ") || "—" : x == null || x === "" ? "—" : String(x));
  return (
    <div className={`card import-row outcome-${r.outcome}`}>
      <div className="card-head">
        <span className="row-gap wrap"><span className="hint">Line {r.line}</span> <strong>{r.company}</strong> <Pill tone={OUTCOME_TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Pill>
          {r.match && <span className="hint">→ {r.match.name} ({r.match.how}) <StatusBadge status={r.match.status} /></span>}</span>
        <button className="btn ghost small" onClick={() => setOpen(!open)}>{open ? "Hide" : "Details"}</button>
      </div>
      {r.errors.length > 0 && <div className="alert danger small">{r.errors.join("; ")}</div>}
      <div className="hint">Priority {PRIORITY_LABEL[r.fields.priority]} · {PARTNER_CATEGORY_LABEL[r.fields.category]}{r.category_source ? ` (file: ${r.category_source})` : ""} · {r.fields.channel_models.map((c: string) => CHANNEL_MODEL_LABEL[c]).join(", ") || "no channel model"} · {r.fields.research_state ? RESEARCH_LABEL[r.fields.research_state] : "research not recorded"}</div>
      {r.reasons.map((x: string) => <div key={x} className="hint">{x}</div>)}
      {open && <>
        {r.candidates.length > 0 && <div className="decision">
          <strong>Possible matches:</strong>
          <ul>{r.candidates.map((c: any) => <li key={c.id}><label className="check"><input type="radio" name={`m-${r.line}`} checked={d.merge_into === c.id} onChange={() => decide({ merge_into: c.id, create_new: undefined, action: undefined })} /> Update {c.name} <span className="hint">({c.why})</span></label></li>)}
            <li><label className="check"><input type="radio" name={`m-${r.line}`} checked={!!d.create_new} onChange={() => decide({ create_new: true, merge_into: undefined, action: undefined })} /> Create a separate partner</label></li>
          </ul>
        </div>}
        {r.conflicts.length > 0 && <div className="decision"><strong>Conflicting fields</strong> (existing value kept unless you choose the imported one)
          <table className="table compact"><thead><tr><th>Field</th><th>Existing</th><th>Imported</th><th>Use</th></tr></thead><tbody>
            {r.conflicts.map((c: any) => <tr key={c.field}><td>{c.field.replace(/_/g, " ")}</td><td>{v(c.existing)}</td><td>{v(c.imported)}</td>
              <td><Select value={c.resolution} onChange={(x) => decide({ fields: { ...(d.fields ?? {}), [c.field]: x } })} options={{ keep: "Keep existing", import: "Use imported" }} /></td></tr>)}
          </tbody></table></div>}
        {r.fills.length > 0 && <div className="hint">Fills empty fields: {r.fills.map((f: any) => `${f.field.replace(/_/g, " ")} = ${v(f.after)}`).join(" · ")}</div>}
        {r.kept.length > 0 && <div className="hint">{r.kept.join(" · ")}</div>}
        {(r.add.contacts.length + r.add.routes.length + r.add.requirements.length > 0) && <div className="decision">
          <strong>Adds</strong> {r.add.routes.length} route{r.add.routes.length === 1 ? "" : "s"}, {r.add.requirements.length} requirement/term note{r.add.requirements.length === 1 ? "" : "s"} ({[...new Set(r.add.requirements.map((q: any) => REQ_KIND_LABEL[q.kind]))].join(", ") || "none"}), and these people:
          {r.add.contacts.length === 0 && <span className="hint"> none</span>}
          <ul>{r.add.contacts.map((c: any) => <li key={c.key}>{c.name} <span className="hint">· {c.rank} · {VERIFICATION_LABEL[c.role_verification]}</span>{" "}
            <Select value={c.role} onChange={(x) => decide({ contact_roles: { ...(d.contact_roles ?? {}), [c.key]: x } })} options={CONTACT_ROLE_LABEL} aria-label={`Role of ${c.name}`} /></li>)}</ul>
        </div>}
        {(r.already.contacts + r.already.routes + r.already.requirements) > 0 && <div className="hint">Already recorded (not added again): {r.already.contacts} people, {r.already.routes} routes, {r.already.requirements} notes.</div>}
        {r.outcome !== "invalid" && <div className="row-gap wrap decision">
          <label>Category <Select value={d.category ?? ""} onChange={(x) => decide({ category: x || undefined })} options={PARTNER_CATEGORY_LABEL} empty="As mapped from the file" /></label>
          <label className="check"><input type="checkbox" checked={d.stage === "skipped"} onChange={(e) => decide(e.target.checked ? { stage: "skipped", stage_reason: d.stage_reason ?? "" } : { stage: undefined, stage_reason: undefined })} /> Import as Skipped</label>
          {d.stage === "skipped" && <input className="grow" placeholder="Reason (required)" defaultValue={d.stage_reason ?? ""} onBlur={(e) => decide({ stage_reason: e.target.value })} />}
          <label className="check"><input type="checkbox" checked={d.action === "exclude"} onChange={(e) => decide({ action: e.target.checked ? "exclude" : undefined })} /> Don’t import this row</label>
        </div>}
        {r.create && <div className="hint">Creates a new partner at stage {stageText(r.create.stage)}; sales role Unclear (kept out of the Slack scan until confirmed).</div>}
      </>}
    </div>
  );
}

function ImportHistory() {
  const list = useLoad(() => get("/partners/import/batches"), []);
  const [pv, setPv] = useState<{ id: string; r: any } | null>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  if (list.loading && !list.data) return <Loading />;
  return (
    <>
      <ErrorBox error={list.error ?? s.error} />
      {list.data?.batches.length === 0 && <Empty>No imports yet.</Empty>}
      <ul className="timeline">
        {list.data?.batches.map((b: any) => (
          <li key={b.id}>
            <div className="row-gap wrap"><strong>{b.source_name}</strong> <Pill tone={b.status === "reversed" ? "neutral" : "ok"}>{b.status}</Pill>
              <span className="hint">{b.row_count} rows · {b.created_by} · {dateTime(b.created_at)}{b.reversed_at ? ` · reversed by ${b.reversed_by}` : ""}</span>
              <span className="spacer" />
              {b.status === "applied" && <button className="btn ghost small" onClick={() => s.run(async () => setPv({ id: b.id, r: await post(`/partners/import/batches/${b.id}/reverse`, { dry_run: true, signer_name: signer || "preview" }) }))}>Preview reversal</button>}
            </div>
            <div className="hint">{Object.entries(b.summary?.outcomes ?? {}).filter(([k]) => k !== "rows").map(([k, n]) => `${OUTCOME_LABEL[k] ?? k} ${n}`).join(" · ")}</div>
            {pv?.id === b.id && <div className="alert neutral">
              Reversal would remove {pv!.r.removed} imported rows, restore {pv!.r.restored} fields and delete {pv!.r.partners_removed} partners created by this import.
              {pv!.r.kept.length > 0 && <ul>{pv!.r.kept.map((k: any, i: number) => <li key={i}>Kept: {k.company} — {k.what}</li>)}</ul>}
              <div className="form-grid"><SignerField value={signer} onChange={setSigner} />
                <div className="form-actions"><button className="btn danger" disabled={s.saving} onClick={async () => { if (await s.run(() => post(`/partners/import/batches/${b.id}/reverse`, { signer_name: signer }))) { rememberSigner(signer); setPv(null); list.reload(); } }}>Reverse this import</button></div></div>
            </div>}
          </li>
        ))}
      </ul>
    </>
  );
}
