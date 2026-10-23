import { useState, type FormEvent } from "react";
import { get, post, patch } from "../api";
import { ApiError } from "../api";
import { Field, Select, SignerField, FormActions, ErrorBox, Overlay, Pill, Loading, Empty, useLoad, useSave, useSigner, rememberSigner } from "../components/ui";
import { money, dateTime, productLabel } from "../format";

// --------------------------------------------------------- website refresh
export function WebsiteRefresh({ onClose }: { onClose: () => void }) {
  const [signer, setSigner] = useSigner();
  const [run, setRun] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [apply, setApply] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<any | null>(null);
  const runs = useLoad(() => get("/imports?kind=shopify"), []);

  const start = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      let r = (await post("/imports/shopify", { signer_name: signer })).run;
      rememberSigner(signer);
      setRun(r);
      for (let i = 0; i < 120 && r.status === "fetching"; i++) {
        r = (await post(`/imports/shopify/${r.id}/next`, { signer_name: signer })).run;
        setRun(r);
      }
      if (r.status === "previewed") setApply(new Set(r.preview.selected_price_changes.map((x: any) => x.product_id)));
    } catch (e) { setError(e as ApiError); }
    setBusy(false);
  };
  const confirmRun = async () => {
    setBusy(true); setError(null);
    try { setResult(await post(`/imports/shopify/${run.id}/confirm`, { signer_name: signer, apply_price_for: [...apply] })); setRun(null); runs.reload(); }
    catch (e) { setError(e as ApiError); }
    setBusy(false);
  };
  const discard = async () => { await post(`/imports/${run.id}/discard`, { signer_name: signer }).catch(() => {}); setRun(null); };
  const pv = run?.preview;
  const lastOk = runs.data?.runs.find((r: any) => ["confirmed", "no_change"].includes(r.status));
  return (
    <Overlay kind="modal" title="Refresh website products" subtitle="Reads the public succulentsbox.com catalog. Never changes Shopify." onClose={onClose}>
      <ErrorBox error={error} />
      <p className="hint">Last successful refresh: {lastOk ? `${dateTime(lastOk.confirmed_at)} by ${lastOk.confirmed_by}` : "never"}.
        Updates title, URL, image and current retail reference. Team annotations, mappings, proposals and agreed prices are preserved. New items are not added to proposals.</p>
      {!run && !result && (
        <div className="form-grid">
          <SignerField value={signer} onChange={setSigner} />
          <div className="form-actions"><button className="btn primary" onClick={start} disabled={busy || !signer.trim()}>{busy ? "Starting…" : "Fetch and preview"}</button></div>
        </div>
      )}
      {run?.status === "fetching" && <Loading what={`Fetching page ${run.next_page} (${run.pages_fetched} done)`} />}
      {run?.status === "failed" && (
        <div className="alert error">Refresh failed{run.errors?.[0] ? ` on page ${run.errors[0].page}: ${run.errors[0].message}` : ""}. Nothing was changed; previous data is kept.
          <div className="form-actions"><button className="btn small" onClick={start} disabled={busy}>Try again</button></div></div>
      )}
      {run?.status === "previewed" && pv && (
        <>
          <ul className="stats">
            <li><strong>{pv.variants_fetched}</strong> variants fetched ({run.pages_fetched} pages, complete)</li>
            <li><strong>{pv.new_count}</strong> new (added unselected)</li>
            <li><strong>{pv.changed_count}</strong> changed · {pv.unchanged_count} unchanged</li>
            <li><strong>{pv.unselected_price_changes}</strong> retail changes on unselected items (applied)</li>
            <li><strong>{pv.not_seen_count}</strong> no longer on website (flagged, never deleted)</li>
          </ul>
          {pv.selected_price_changes.length > 0 && (
            <>
              <div className="subhead">Retail changes for selected gifts — choose which to apply</div>
              <table className="table compact">
                <thead><tr><th></th><th>Gift</th><th className="num">Current</th><th className="num">Website now</th></tr></thead>
                <tbody>
                  {pv.selected_price_changes.map((c: any) => (
                    <tr key={c.product_id}>
                      <td><input type="checkbox" checked={apply.has(c.product_id)} onChange={(e) => { const n = new Set(apply); e.target.checked ? n.add(c.product_id) : n.delete(c.product_id); setApply(n); }} /></td>
                      <td>{productLabel(c.name, c.variant)}</td><td className="num">{money(c.old_cents)}</td><td className="num">{money(c.new_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">Retail is a reference only — agreed prices are not changed.</p>
            </>
          )}
          {pv.not_seen_sample.length > 0 && <details><summary>Not seen on website ({pv.not_seen_count})</summary><ul>{pv.not_seen_sample.map((x: any) => <li key={x.id}>{productLabel(x.name, x.variant)}</li>)}</ul></details>}
          <div className="form-actions">
            <button className="btn ghost" onClick={discard} disabled={busy}>Discard</button>
            <button className="btn primary" onClick={confirmRun} disabled={busy}>{busy ? "Applying…" : "Confirm and apply"}</button>
          </div>
        </>
      )}
      {result && <div className="alert success">{result.status === "no_change" ? "No changes — nothing was updated." : `Applied: ${result.summary.inserted} new, ${result.summary.updated} updated, ${result.summary.flagged_not_seen} flagged as not seen.`}</div>}
    </Overlay>
  );
}

// ------------------------------------------------------------ cost refresh
export function CostRefresh({ onClose }: { onClose: () => void }) {
  const [signer, setSigner] = useSigner();
  const [run, setRun] = useState<any | null>(null);
  const [approve, setApprove] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<any | null>(null);
  const s = useSave();
  const runs = useLoad(() => get("/imports?kind=product_master"), []);
  const preview = async () => {
    setResult(null);
    await s.run(async () => {
      const r = (await post("/imports/product-master", { signer_name: signer })).run;
      rememberSigner(signer);
      setRun(r);
      setApprove(new Set(r.preview.items.filter((i: any) => i.status === "changed").map((i: any) => i.product_id)));
    });
  };
  const confirmRun = async () => {
    await s.run(async () => { setResult(await post(`/imports/product-master/${run.id}/confirm`, { signer_name: signer, product_ids: [...approve] })); setRun(null); runs.reload(); });
  };
  const lastOk = runs.data?.runs.find((r: any) => ["confirmed", "no_change"].includes(r.status));
  const items = run?.preview.items ?? [];
  return (
    <Overlay kind="modal" title="Refresh Product Master costs" subtitle="Read-only. Agreed prices and past snapshots are never changed." onClose={onClose}>
      <ErrorBox error={s.error} />
      <p className="hint">Last successful refresh: {lastOk ? `${dateTime(lastOk.confirmed_at)} by ${lastOk.confirmed_by}` : "never"}.</p>
      {!run && (
        <div className="form-grid">
          <SignerField value={signer} onChange={setSigner} />
          <div className="form-actions"><button className="btn primary" onClick={preview} disabled={s.saving || !signer.trim()}>{s.saving ? "Reading sheets…" : "Read and preview"}</button></div>
        </div>
      )}
      {run && (
        <>
          {run.errors.length > 0 && <div className="alert error">{run.errors.map((e: any, i: number) => <div key={i}><strong>{e.mapping}:</strong> {e.message}</div>)}<div className="hint">Affected gifts keep their last successful cost.</div></div>}
          <ul className="stats">
            <li><strong>{run.summary.changed}</strong> changed</li><li><strong>{run.summary.unchanged}</strong> unchanged</li>
            <li><strong>{run.summary.errors}</strong> errors (not saved)</li><li><strong>{run.summary.unmapped_selected}</strong> selected gifts unmapped</li>
          </ul>
          {items.length === 0 && <Empty>No mapped gifts yet. Map gifts to vendor rows from Gifts → Edit.</Empty>}
          {items.length > 0 && (
            <div className="table-wrap">
              <table className="table compact">
                <thead><tr><th></th><th>Gift</th><th className="num">Old cost</th><th className="num">New cost</th><th>Calculation</th><th>Status</th></tr></thead>
                <tbody>
                  {items.map((i: any) => (
                    <tr key={i.product_id}>
                      <td>{i.status === "changed" && <input type="checkbox" checked={approve.has(i.product_id)} onChange={(e) => { const n = new Set(approve); e.target.checked ? n.add(i.product_id) : n.delete(i.product_id); setApprove(n); }} />}</td>
                      <td>{productLabel(i.name, i.variant)}</td>
                      <td className="num">{money(i.old_cents)}</td><td className="num">{money(i.new_cents)}</td>
                      <td className="small-text">{i.components.map((c: any, k: number) => <div key={k}>{c.component_label ? `${c.component_label}: ` : ""}{c.error ? <span className="warn-text">{c.error}</span> : c.basis === "per_piece" ? `${c.source_cost} × ${c.quantity} = ${c.component_cost}` : `${c.source_cost} (complete pack)`} <span className="hint">{c.vendor}/{c.tab}{c.row_locator ? ` row ${c.row_locator}` : ""}</span></div>)}</td>
                      <td><Pill tone={i.status === "error" ? "danger" : i.status === "changed" ? "warn" : "neutral"}>{i.status}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {run.preview.unmapped.length > 0 && <details><summary>Selected gifts without a mapping ({run.preview.unmapped.length})</summary><ul>{run.preview.unmapped.map((u: any) => <li key={u.id}>{productLabel(u.name, u.variant)}</li>)}</ul></details>}
          <div className="form-actions">
            <button className="btn ghost" onClick={() => setRun(null)} disabled={s.saving}>Cancel</button>
            <button className="btn primary" onClick={confirmRun} disabled={s.saving}>{s.saving ? "Saving…" : approve.size ? `Save ${approve.size} cost change(s)` : "Confirm (no changes)"}</button>
          </div>
        </>
      )}
      {result && <div className="alert success">{result.status === "no_change" ? "No changes saved." : `Saved ${result.saved} dated cost snapshot(s).`}</div>}
    </Overlay>
  );
}

// ------------------------------------------------------- source mappings
export function SourcesPanel({ onClose }: { onClose: () => void }) {
  const list = useLoad(() => get("/sources"), []);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <Overlay title="Cost source settings" subtitle="Product Master vendor tabs (read-only). Configure each tab once." onClose={onClose}>
      <p className="hint">Product Master is the proposed source of truth for vendor costs. Marketplace agreements are stored here separately. Different vendor tabs can have different layouts — nothing is assumed.</p>
      <ErrorBox error={list.error} />
      {list.data?.sources.length === 0 && <Empty>No vendor tabs configured yet.</Empty>}
      <ul className="timeline">
        {list.data?.sources.map((m: any) => (
          <li key={m.id} className={m.active ? "" : "muted-row"}>
            <strong>{m.vendor} — {m.label}</strong> <span className="hint">mapping v{m.mapping_version} · {m.link_count} gifts mapped{m.active ? "" : " · inactive"}</span>
            <div className="small-text">Tab “{m.tab_name}” from row {m.header_row} · match {m.match_columns.join(" + ")} · cost “{m.cost_column}” ({m.cost_basis === "per_piece" ? "per piece" : "complete pack/gift"}){m.quantity_column ? ` · qty “${m.quantity_column}”` : ""}</div>
            {m.cost_inclusions_note && <div className="hint">Includes: {m.cost_inclusions_note}</div>}
            <button className="btn ghost small" onClick={() => setEdit(m)}>Edit</button>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => setEdit({})}>Add vendor tab</button>
      {edit && <SourceForm m={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </Overlay>
  );
}

function SourceForm({ m, onClose, onSaved }: { m: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    label: m.label ?? "", spreadsheet: "", vendor: m.vendor ?? "", tab_name: m.tab_name ?? "", tab_gid: m.tab_gid ?? "",
    header_row: String(m.header_row ?? 1), last_column: m.last_column ?? "ZZ", match_columns: (m.match_columns ?? []).join(", "),
    cost_column: m.cost_column ?? "", cost_basis: m.cost_basis ?? "", quantity_column: m.quantity_column ?? "", retail_column: m.retail_column ?? "",
    cost_inclusions_note: m.cost_inclusions_note ?? "", active: m.active ?? true,
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const [test, setTest] = useState<any | null>(null);
  const t = useSave();
  const set = (k: keyof typeof f) => (v: any) => setF({ ...f, [k]: v?.target ? (v.target.type === "checkbox" ? v.target.checked : v.target.value) : v });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { spreadsheet, ...rest } = f;
    // Editing: a blank link keeps the saved sheet location (it is never sent to the browser unless revealed).
    const body = { ...rest, ...(spreadsheet.trim() || !m.id ? { spreadsheet } : {}), header_row: Number(f.header_row), match_columns: f.match_columns.split(",").map((x: string) => x.trim()).filter(Boolean), signer_name: signer };
    const ok = await s.run(() => (m.id ? patch(`/sources/${m.id}`, { ...body, version: m.version }) : post("/sources", body)));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={m.id ? "Edit vendor tab mapping" : "Add vendor tab mapping"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Label" required error={s.fe("label")}><input value={f.label} onChange={set("label")} /></Field>
        <Field label="Vendor" required error={s.fe("vendor")}><input value={f.vendor} onChange={set("vendor")} /></Field>
        <Field label={m.id ? "New link to the vendor tab (leave blank to keep)" : "Link to the vendor tab"} required={!m.id} wide error={s.fe("spreadsheet")}
          hint={m.id
            ? <>Saved sheet: {m.spreadsheet_ref ?? "—"}. <button type="button" className="btn ghost small" onClick={async () => { const r = await get(`/sources/${m.id}/location`); setF((x) => ({ ...x, spreadsheet: r.link })); }}>Show saved link</button> (visible to signed-in team members; recorded in the audit log)</>
            : "Open the vendor tab in Google Sheets and copy the browser link — it includes the tab’s gid."}>
          <input value={f.spreadsheet} onChange={set("spreadsheet")} autoComplete="off" />
        </Field>
        <Field label="Tab name" required error={s.fe("tab_name")}><input value={f.tab_name} onChange={set("tab_name")} /></Field>
        <Field label="Tab gid" error={s.fe("tab_gid")} hint="Filled from the link automatically if blank (the number after gid=)."><input inputMode="numeric" value={f.tab_gid} onChange={set("tab_gid")} /></Field>
        <Field label="Header row" required error={s.fe("header_row")}><input inputMode="numeric" value={f.header_row} onChange={set("header_row")} /></Field>
        <Field label="Last column" hint="e.g. Z or AF" error={s.fe("last_column")}><input value={f.last_column} onChange={set("last_column")} /></Field>
        <Field label="Product matching column(s)" required wide hint="Header names as shown in the sheet, comma-separated (e.g. SKU). Line breaks/extra spaces in headers are ignored. Row matching is exact — no similar-name matching." error={s.fe("match_columns")}><input value={f.match_columns} onChange={set("match_columns")} /></Field>
        <Field label="Cost column" required error={s.fe("cost_column")}><input value={f.cost_column} onChange={set("cost_column")} /></Field>
        <Field label="Cost basis" required error={s.fe("cost_basis")}><Select value={f.cost_basis} onChange={set("cost_basis")} options={{ per_piece: "Per piece", per_pack: "Per complete pack / gift" }} empty="Choose…" /></Field>
        <Field label="Pack quantity column (optional)" hint="Otherwise the quantity per gift is entered per gift."><input value={f.quantity_column} onChange={set("quantity_column")} /></Field>
        <Field label="Retail / base price column (optional)" hint="Only if actually present."><input value={f.retail_column} onChange={set("retail_column")} /></Field>
        <Field label="Cost inclusions note" wide hint="What the source amount already includes (card, handling, packaging…)."><input value={f.cost_inclusions_note} onChange={set("cost_inclusions_note")} /></Field>
        {m.id && <label className="check wide"><input type="checkbox" checked={f.active} onChange={set("active")} /> Active</label>}
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
      {m.id && (
        <div>
          <button className="btn ghost small" disabled={t.saving} onClick={() => t.run(async () => setTest(await post(`/sources/${m.id}/lookup`, { query: "" })))}>{t.saving ? "Reading…" : "Test read (saved settings)"}</button>
          <ErrorBox error={t.error} />
          {test && <div className={`alert ${test.missing_headers.length ? "error" : "success"}`}>Headers: {test.headers.join(" | ") || "none"}{test.missing_headers.length > 0 && <div>Missing: {test.missing_headers.join(", ")}</div>}</div>}
        </div>
      )}
    </Overlay>
  );
}
