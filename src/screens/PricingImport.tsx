import { useState } from "react";
import { post, ApiError } from "../api";
import { Field, Select, SignerField, ErrorBox, Overlay, Pill, Empty, useSigner, rememberSigner } from "../components/ui";
import { ProductPicker } from "../components/ProductPicker";
import { money, productLabel, FORMAT_LABEL } from "../format";
import { MODEL_LABEL, BASIS_LABEL, MARKETPLACE_MODELS } from "../../shared/pricingModel";

const ACTION_LABEL: Record<string, [string, any]> = {
  create: ["New price", "info"], update_draft: ["Update draft", "warn"], new_version: ["New version", "warn"], no_change: ["No change", "neutral"],
};
const MONEY_FIELDS = ["Agreed supplier price", "Marketplace selling price", "Agreed price", "Proposed supplier price", "Customer shipping charge", "Fixed fee", "SB retail price (manual)", "Internal gift cost (manual)"];
const fmt = (k: string, v: unknown) => {
  if (v == null) return "blank";
  if (MONEY_FIELDS.includes(k)) return money(v as number);
  if (k === "Pricing model") return MODEL_LABEL[v as keyof typeof MODEL_LABEL] ?? String(v);
  if (k === "Commission basis") return BASIS_LABEL[v as string] ?? String(v);
  if (k === "Commission %") return `${v}%`;
  return String(v);
};
const STATUS_OPTS: [string, string][] = [["draft", "Draft"], ["proposed", "Proposed"], ["agreed", "Agreed"], ["active", "Active"]];

export function PricingImport({ channels, onClose }: { channels: any[]; onClose: () => void }) {
  const [signer, setSigner] = useSigner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [headerRow, setHeaderRow] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [rowModels, setRowModels] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<any | null>(null);
  const [dirty, setDirty] = useState(false);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e as ApiError); } setBusy(false); };
  const accept = (p: any) => {
    setPreview(p);
    setMapping(p.mapping ?? {});
    setSettings(Object.fromEntries(Object.entries(p.settings ?? {}).map(([k, v]) => [k, (v as string) ?? ""])));
    setHeaderRow(String(p.header_row ?? 1));
    setRowModels(p.row_models ?? {});
    setSelected(new Set(p.rows.filter((r: any) => r.valid && r.action !== "no_change").map((r: any) => r.ref)));
    setVersions(new Set());
    setDirty(false);
  };
  const upload = (file: File) => run(async () => {
    if (!signer.trim()) throw new ApiError(400, "signer", "Enter your name first.");
    const b64 = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] ?? ""); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
    setResult(null); setResolutions({});
    accept(await post("/pricing-import/preview", { filename: file.name, file_base64: b64, signer_name: signer }));
    rememberSigner(signer);
  });
  const nullable = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v || null]));
  const recheck = (extra: Record<string, unknown> = {}) => run(async () => accept(await post(`/pricing-import/${preview.batch_id}/preview`, {
    mapping, settings: nullable(settings), resolutions, row_models: rowModels, signer_name: signer, ...extra,
  })));
  const confirm = () => run(async () => {
    const r = await post(`/pricing-import/${preview.batch_id}/confirm`, { selected: [...selected], confirm_versions: [...versions], version: preview.version, signer_name: signer });
    rememberSigner(signer);
    setResult(r); setPreview(null);
  });
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, k: string, on: boolean) => { const n = new Set(set); on ? n.add(k) : n.delete(k); setter(n); };

  // header → field (the mapping is stored field → header)
  const fieldOf: Record<string, string> = Object.fromEntries(Object.entries(mapping).map(([k, h]) => [h, k]));
  const setColumn = (header: string, field: string) => {
    const next = Object.fromEntries(Object.entries(mapping).filter(([k, h]) => h !== header && k !== field));
    if (field) next[field] = header;
    setMapping(next); setDirty(true);
  };
  const setSetting = (k: string, v: string) => { setSettings({ ...settings, [k]: v }); setDirty(true); };
  const groups = preview ? [...new Set<string>(preview.fields.map((f: any) => f.group))] : [];
  const fileModel = settings.pricing_model;

  return (
    <Overlay kind="modal" wide title="Import pricing file" subtitle="Optional. .xlsx or .csv in any column layout — you confirm what each column means. Nothing is saved until you confirm." onClose={onClose}>
      <ErrorBox error={error} />
      {!preview && !result && (
        <div className="form-grid">
          <p className="wide">Upload a marketplace price list or your own sheet (.xlsx or .csv). You will choose the worksheet, confirm the column meanings and the pricing model, then review every row before saving.</p>
          <p className="hint wide">Convenience only: <a href="/api/pricing-import/template">download the .xlsx template</a> (commission and fee columns are optional). Blank cells mean unspecified — never zero. Plain values only: formulas and macro-enabled files are rejected. Gifts are matched by Shopify variant ID or exact SKU, never by name. The file itself is not stored.</p>
          <SignerField value={signer} onChange={setSigner} />
          <Field label="Pricing file (.xlsx or .csv)" required>
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </Field>
          {busy && <p className="hint wide">Reading the file…</p>}
        </div>
      )}

      {preview && (
        <>
          <p><strong>{preview.filename}</strong> <span className="hint">· {preview.file_kind === "csv" ? "CSV" : "Excel"}</span>
            {preview.previously_imported && <span className="warn-text"> · this exact file was already imported (unchanged rows show “No change”)</span>}</p>

          <h3 className="subhead">1. Where the data is</h3>
          <div className="import-settings">
            {preview.file_kind === "xlsx" && (
              <Field label="Worksheet">
                <Select value={preview.sheet} onChange={(v) => recheck({ sheet: v, mapping: undefined })}
                  options={preview.sheets.map((s: any) => [s.name, `${s.name} (${s.rows} rows)`])} disabled={busy} />
              </Field>
            )}
            <Field label="Header row" hint="Detected automatically; change it if titles sit above the column names.">
              <input inputMode="numeric" value={headerRow} onChange={(e) => setHeaderRow(e.target.value)}
                onBlur={() => { const n = Number(headerRow); if (Number.isInteger(n) && n >= 1 && n !== preview.header_row) recheck({ header_row: n, mapping: undefined }); }} />
            </Field>
          </div>
          {preview.sheet_error && <div className="alert error">{preview.sheet_error}{preview.sheets.length > 1 && " Choose another worksheet."}</div>}

          {!preview.sheet_error && (
            <>
              <h3 className="subhead">2. For the whole file</h3>
              <div className="import-settings">
                <Field label="Channel" required={!mapping.channel} hint={mapping.channel ? `A “${mapping.channel}” column is used; this applies to rows where it is blank.` : undefined}>
                  <Select value={settings.channel_id ?? ""} onChange={(v) => setSetting("channel_id", v)} empty={mapping.channel ? "From the column" : "Choose…"} options={channels.map((c) => [c.id, c.name])} />
                </Field>
                <Field label="Pricing model" required={!mapping.pricing_model} hint="What the prices in this file mean. Rows can be changed individually below.">
                  <Select value={fileModel ?? ""} onChange={(v) => setSetting("pricing_model", v)} empty={mapping.pricing_model ? "From the column" : "Choose…"}
                    options={[...MARKETPLACE_MODELS.map((k) => [k, MODEL_LABEL[k]] as [string, string]), ["direct", MODEL_LABEL.direct]]} />
                </Field>
                {(fileModel === "commission" || mapping.commission_basis) && (
                  <Field label="Commission calculated on" hint="Used for commission-based rows without a basis column value.">
                    <Select value={settings.commission_basis ?? ""} onChange={(v) => setSetting("commission_basis", v)} empty="Not specified" options={Object.entries(BASIS_LABEL)} />
                  </Field>
                )}
                <Field label="Fulfillment format" required={!mapping.fulfillment_format}>
                  <Select value={settings.fulfillment_format ?? ""} onChange={(v) => setSetting("fulfillment_format", v)} empty={mapping.fulfillment_format ? "From the column" : "Choose…"} options={FORMAT_LABEL} />
                </Field>
                <Field label="Status" required={!mapping.status}>
                  <Select value={settings.status ?? ""} onChange={(v) => setSetting("status", v)} empty={mapping.status ? "From the column" : "Choose…"} options={STATUS_OPTS} />
                </Field>
              </div>

              <h3 className="subhead">3. What each column means</h3>
              <p className="hint">Suggestions are marked. A column called just “Price” is never assumed to be what SB earns — choose whether it is the supplier price SB receives, the marketplace selling price or SB's retail price, or ignore it.</p>
              <div className="table-wrap">
                <table className="table compact map-table">
                  <thead><tr><th>Column in the file</th><th>Example values</th><th>Means</th></tr></thead>
                  <tbody>
                    {preview.headers.map((h: string) => {
                      const cur = fieldOf[h] ?? "";
                      const sug = Object.entries(preview.suggested ?? {}).find(([, x]) => x === h)?.[0];
                      return (
                        <tr key={h}>
                          <td><strong>{h}</strong></td>
                          <td className="map-sample" title={(preview.samples?.[h] ?? []).join(" · ")}>{(preview.samples?.[h] ?? []).join(" · ") || "—"}</td>
                          <td>
                            <select aria-label={`Meaning of ${h}`} value={cur} onChange={(e) => setColumn(h, e.target.value)}>
                              <option value="">— Ignore this column —</option>
                              {groups.map((g) => (
                                <optgroup key={g} label={g}>
                                  {preview.fields.filter((f: any) => f.group === g).map((f: any) => (
                                    <option key={f.key} value={f.key}>{f.label}{mapping[f.key] && mapping[f.key] !== h ? ` (now: ${mapping[f.key]})` : ""}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            {sug && sug === cur && <span className="pill-suggested">suggested</span>}
                            {cur && <div className="hint">{preview.fields.find((f: any) => f.key === cur)?.help}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {preview.notes?.length > 0 && <div className="alert warn"><ul className="notes-list">{preview.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></div>}
              {preview.missing?.length > 0 && <div className="alert warn">Still needed: {preview.missing.join("; ")}.</div>}
              <div className="form-actions">
                <button className="btn" disabled={busy} onClick={() => recheck()}>{dirty ? "Apply and re-check rows" : "Re-check rows"}</button>
                {dirty && <span className="warn-text small-text">Changes not applied yet.</span>}
              </div>
            </>
          )}

          {preview.rows.length > 0 && (
            <>
              <h3 className="subhead">4. Review rows</h3>
              <ul className="stats">
                <li><strong>{preview.summary.valid}</strong> valid</li><li><strong>{preview.summary.errors}</strong> with errors</li>
                <li>{preview.summary.create} new · {preview.summary.update_draft} draft updates · {preview.summary.new_version} new versions · {preview.summary.no_change} no change</li>
              </ul>
              <div className="table-wrap">
                <table className="table compact import-table">
                  <thead><tr><th>Save</th><th>Row</th><th>Channel / gift</th><th>Pricing model</th><th>Interpreted price &amp; terms</th><th>Result</th><th>Details</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r: any) => (
                      <tr key={r.ref} className={r.valid ? "" : "row-error"}>
                        <td>{r.valid && r.action !== "no_change" && <input type="checkbox" aria-label={`Save ${r.ref}`} checked={selected.has(r.ref)} onChange={(e) => toggle(selected, setSelected, r.ref, e.target.checked)} />}</td>
                        <td>{r.row}</td>
                        <td>{r.channel?.name ?? <span className="unknown">?</span>}<div>{r.product ? productLabel(r.product.name, r.product.variant) : <span className="unknown">Gift not matched</span>}</div>
                          {r.product?.sku && <div className="hint">SKU {r.product.sku} · matched by {r.match === "variant_id" ? "variant ID" : r.match === "sku" ? "SKU" : "your choice"}</div>}
                          {!r.product && (r.candidates?.length > 0 ? (
                            <Select value={resolutions[r.ref] ?? ""} empty="Choose the gift…" options={r.candidates.map((c: any) => [c.id, `${productLabel(c.name, c.variant)} (${c.sku ?? "no SKU"})`])}
                              onChange={(v) => { const n = { ...resolutions, [r.ref]: v }; setResolutions(n); if (v) recheck({ resolutions: n }); }} />
                          ) : r.errors.some((x: string) => /No gift with/.test(x)) ? (
                            <ProductPicker value={null} onChange={(p) => { if (p) { const n = { ...resolutions, [r.ref]: p.id }; setResolutions(n); recheck({ resolutions: n }); } }} />
                          ) : null)}
                        </td>
                        <td>
                          <select aria-label={`Pricing model for ${r.ref}`} value={rowModels[r.ref] ?? ""} onChange={(e) => { const n = { ...rowModels, [r.ref]: e.target.value }; setRowModels(n); recheck({ row_models: n }); }}>
                            <option value="">{r.model && r.model_source !== "row" ? `${MODEL_LABEL[r.model as keyof typeof MODEL_LABEL]} (${r.model_source === "column" ? "from column" : "file"})` : "File default"}</option>
                            {[...MARKETPLACE_MODELS, "direct" as const].map((k) => <option key={k} value={k}>{MODEL_LABEL[k]}</option>)}
                          </select>
                        </td>
                        <td className="interp">
                          {r.interpretation ? (
                            <>
                              <div>{r.interpretation.headlineLabel}: <strong>{money(r.input?.agreed_price_cents ?? r.interpretation.headlineCents, "blank")}</strong></div>
                              <div>SB receives: {r.interpretation.sbReceivesCents != null ? <strong>{money(r.interpretation.sbReceivesCents)}</strong> : <span className="unknown">not calculated</span>}</div>
                              <div className="hint">{r.interpretation.explanation}</div>
                              {r.interpretation.notes.map((n: string, i: number) => <div key={i} className="hint">{n}</div>)}
                              <div className="hint">{FORMAT_LABEL[r.input?.fulfillment_format] ?? ""}{r.input?.moq ? ` · MOQ ${r.input.moq}` : ""}{r.input?.status ? ` · ${r.input.status}` : ""}</div>
                            </>
                          ) : <span className="hint">—</span>}
                        </td>
                        <td>{r.valid && r.action ? <Pill tone={ACTION_LABEL[r.action][1]}>{ACTION_LABEL[r.action][0]}</Pill> : <Pill tone="danger">Error</Pill>}
                          {r.action === "new_version" && r.valid && (
                            <label className="check small"><input type="checkbox" checked={versions.has(r.ref)} onChange={(e) => { toggle(versions, setVersions, r.ref, e.target.checked); if (e.target.checked) toggle(selected, setSelected, r.ref, true); }} /> Create new version</label>
                          )}</td>
                        <td className="small-text">
                          {r.errors.map((x: string, i: number) => <div key={i} className="field-error">{x}</div>)}
                          {r.warnings.map((x: string, i: number) => <div key={i} className="warn-text">{x}</div>)}
                          {r.changes.map((c: any, i: number) => <div key={i}>{c.field}: {fmt(c.field, c.from)} → <strong>{fmt(c.field, c.to)}</strong></div>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {preview.rows.length === 0 && !preview.sheet_error && preview.missing?.length === 0 && <Empty>No data rows found below the header row.</Empty>}
          <div className="form-grid">
            <SignerField value={signer} onChange={setSigner} />
            <div className="form-actions">
              <button className="btn ghost" disabled={busy} onClick={() => run(async () => { await post(`/pricing-import/${preview.batch_id}/discard`, { signer_name: signer }); setPreview(null); })}>Discard</button>
              <button className="btn primary" disabled={busy || dirty || !selected.size || !signer.trim()} onClick={confirm}>{busy ? "Saving…" : `Save ${selected.size} selected row(s)`}</button>
            </div>
            {dirty && <p className="hint wide">Apply your column/file changes before saving.</p>}
          </div>
        </>
      )}

      {result && (
        <div className="alert success">
          <strong>Import saved.</strong>{" "}
          {Object.entries(result.summary.results ?? {}).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ") || "Nothing selected."}
          <div className="form-actions"><button className="btn small" onClick={onClose}>Close</button></div>
        </div>
      )}
    </Overlay>
  );
}
