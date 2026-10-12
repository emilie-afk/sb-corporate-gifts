import { useState } from "react";
import { post, ApiError } from "../api";
import { Field, Select, SignerField, ErrorBox, Overlay, Pill, Empty, useSigner, rememberSigner } from "../components/ui";
import { ProductPicker } from "../components/ProductPicker";
import { money, productLabel } from "../format";

const FIELD_LABEL: Record<string, string> = {
  channel: "Channel", variant_id: "Shopify variant ID", sku: "Gift SKU", gift_name: "Gift name (reference only)",
  proposed_supplier_price: "Proposed supplier price", agreed_selling_price: "Agreed selling price", customer_shipping_charge: "Customer shipping charge",
  commission_pct: "Marketplace commission %", fixed_fee: "Fixed fee per unit", moq: "MOQ", fulfillment_format: "Fulfillment format", status: "Status",
  effective_from: "Effective from", effective_to: "Effective to", approved_by: "Approved by", notes: "Notes",
  retail_override: "Retail reference override", cost_override: "Internal gift cost override", override_note: "Override source / note",
};
const ACTION_LABEL: Record<string, [string, any]> = {
  create: ["New price", "info"], update_draft: ["Update draft", "warn"], new_version: ["New version", "warn"], no_change: ["No change", "neutral"],
};
const fmt = (k: string, v: unknown) => (v == null ? "—" : /cents$/.test(k) || ["Proposed supplier price", "Agreed selling price", "Customer shipping charge", "Fixed fee", "Retail reference (manual)", "Internal gift cost (manual)"].includes(k) ? money(v as number) : String(v));

export function PricingImport({ onClose }: { channels: any[]; onClose: () => void }) {
  const [signer, setSigner] = useSigner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<any | null>(null);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e as ApiError); } setBusy(false); };
  const accept = (p: any) => {
    setPreview(p);
    setMapping(p.mapping ?? {});
    setSelected(new Set(p.rows.filter((r: any) => r.valid && r.action !== "no_change").map((r: any) => r.ref)));
    setVersions(new Set());
  };
  const upload = (file: File) => run(async () => {
    if (!signer.trim()) throw new ApiError(400, "signer", "Enter your name first.");
    const b64 = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] ?? ""); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
    setResult(null); setResolutions({});
    accept(await post("/pricing-import/preview", { filename: file.name, file_base64: b64, signer_name: signer }));
    rememberSigner(signer);
  });
  const repreview = (nextResolutions = resolutions) => run(async () => accept(await post(`/pricing-import/${preview.batch_id}/preview`, { mapping, resolutions: nextResolutions, signer_name: signer })));
  const confirm = () => run(async () => {
    const r = await post(`/pricing-import/${preview.batch_id}/confirm`, { selected: [...selected], confirm_versions: [...versions], version: preview.version, signer_name: signer });
    rememberSigner(signer);
    setResult(r); setPreview(null);
  });
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, k: string, on: boolean) => { const n = new Set(set); on ? n.add(k) : n.delete(k); setter(n); };

  return (
    <Overlay kind="modal" title="Import pricing Excel" subtitle="Optional. Manual entry and Product Master stay available. Nothing is saved until you confirm." onClose={onClose}>
      <ErrorBox error={error} />
      {!preview && !result && (
        <div className="form-grid">
          <p className="wide">1. <a href="/api/pricing-import/template">Download the .xlsx template</a> (channel list, allowed values and instructions included). 2. Fill one row per channel + gift/variant + fulfillment format. 3. Upload it here.</p>
          <p className="hint wide">Blank cells mean unspecified (never zero). Plain values only — formulas and macro-enabled files are rejected. Gifts are matched by Shopify variant ID or exact SKU, never by name. The file itself is not stored; only the parsed rows and the file name, date and your name are kept.</p>
          <SignerField value={signer} onChange={setSigner} />
          <Field label="Pricing workbook (.xlsx)" required>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </Field>
          {busy && <p className="hint wide">Reading the workbook…</p>}
        </div>
      )}

      {preview && (
        <>
          <p><strong>{preview.filename}</strong> {preview.sheet && <span className="hint">· sheet “{preview.sheet}”</span>}
            {preview.previously_imported && <span className="warn-text"> · this exact file was already imported (unchanged rows will show “No change”)</span>}</p>
          {(preview.missing?.length > 0 || Object.keys(mapping).length < Object.keys(FIELD_LABEL).length) && (
            <details open={preview.missing?.length > 0} className="mapping">
              <summary>Column mapping {preview.missing?.length > 0 && <span className="warn-text">— map: {preview.missing.join(", ")}</span>}</summary>
              <div className="form-grid">
                {Object.entries(FIELD_LABEL).map(([k, label]) => (
                  <Field key={k} label={label}>
                    <Select value={mapping[k] ?? ""} onChange={(v) => setMapping({ ...mapping, [k]: v })} options={(preview.headers ?? []).map((h: string) => [h, h])} empty="— not in this file —" />
                  </Field>
                ))}
                <div className="form-actions"><button className="btn small" disabled={busy} onClick={() => repreview()}>Apply mapping and re-check</button></div>
              </div>
            </details>
          )}
          {preview.rows.length > 0 && (
            <>
              <ul className="stats">
                <li><strong>{preview.summary.valid}</strong> valid</li><li><strong>{preview.summary.errors}</strong> with errors</li>
                <li>{preview.summary.create} new · {preview.summary.update_draft} draft updates · {preview.summary.new_version} new versions · {preview.summary.no_change} no change</li>
              </ul>
              <div className="table-wrap">
                <table className="table compact import-table">
                  <thead><tr><th>Save</th><th>Row</th><th>Channel / gift</th><th>Result</th><th>Details</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r: any) => (
                      <tr key={r.ref} className={r.valid ? "" : "row-error"}>
                        <td>{r.valid && r.action !== "no_change" && <input type="checkbox" aria-label={`Save ${r.ref}`} checked={selected.has(r.ref)} onChange={(e) => toggle(selected, setSelected, r.ref, e.target.checked)} />}</td>
                        <td>{r.row}</td>
                        <td>{r.channel?.name ?? <span className="unknown">?</span>}<div>{r.product ? productLabel(r.product.name, r.product.variant) : <span className="unknown">Gift not matched</span>}</div>
                          {r.product?.sku && <div className="hint">SKU {r.product.sku} · matched by {r.match === "variant_id" ? "variant ID" : r.match === "sku" ? "SKU" : "your choice"}</div>}</td>
                        <td>{r.valid && r.action ? <Pill tone={ACTION_LABEL[r.action][1]}>{ACTION_LABEL[r.action][0]}</Pill> : <Pill tone="danger">Error</Pill>}
                          {r.action === "new_version" && r.valid && (
                            <label className="check small"><input type="checkbox" checked={versions.has(r.ref)} onChange={(e) => { toggle(versions, setVersions, r.ref, e.target.checked); if (e.target.checked) toggle(selected, setSelected, r.ref, true); }} /> Create new version</label>
                          )}</td>
                        <td className="small-text">
                          {r.errors.map((x: string, i: number) => <div key={i} className="field-error">{x}</div>)}
                          {r.warnings.map((x: string, i: number) => <div key={i} className="warn-text">{x}</div>)}
                          {r.changes.map((c: any, i: number) => <div key={i}>{c.field}: {fmt(c.field, c.from)} → <strong>{fmt(c.field, c.to)}</strong></div>)}
                          {!r.product && (r.candidates?.length > 0 ? (
                            <Select value={resolutions[r.ref] ?? ""} empty="Choose the gift…" options={r.candidates.map((c: any) => [c.id, `${productLabel(c.name, c.variant)} (${c.sku ?? "no SKU"})`])}
                              onChange={(v) => { const n = { ...resolutions, [r.ref]: v }; setResolutions(n); if (v) repreview(n); }} />
                          ) : r.errors.some((x: string) => /No gift with SKU/.test(x)) ? (
                            <ProductPicker value={null} onChange={(p) => { if (p) { const n = { ...resolutions, [r.ref]: p.id }; setResolutions(n); repreview(n); } }} />
                          ) : null)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {preview.rows.length === 0 && preview.missing?.length === 0 && <Empty>No data rows found.</Empty>}
          <div className="form-grid">
            <SignerField value={signer} onChange={setSigner} />
            <div className="form-actions">
              <button className="btn ghost" disabled={busy} onClick={() => run(async () => { await post(`/pricing-import/${preview.batch_id}/discard`, { signer_name: signer }); setPreview(null); })}>Discard</button>
              <button className="btn primary" disabled={busy || !selected.size || !signer.trim()} onClick={confirm}>{busy ? "Saving…" : `Save ${selected.size} selected row(s)`}</button>
            </div>
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
