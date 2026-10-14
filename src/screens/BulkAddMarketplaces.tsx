import { useState } from "react";
import { post, ApiError } from "../api";
import { Field, Select, SignerField, ErrorBox, Overlay, Pill, useSigner, rememberSigner } from "../components/ui";
import { STATUS_LABEL, STATUSES, INACTIVE, PROVIDER_LABEL } from "../format";

/** Working statuses only: an inactive status needs a reason and is set later from the record. */
const WORKING = STATUSES.filter((s) => !INACTIVE.includes(s));
type Row = { name: string; provider_type: string; status: string; errors: string[] };

/** Lines (or the first column of rows pasted from a spreadsheet) → names; blank lines dropped. */
const splitNames = (text: string) =>
  text.split(/\r?\n/).map((l) => l.split("\t")[0].replace(/^\s*[-•*\d.)]+\s+/, "").replace(/\s+/g, " ").trim()).filter(Boolean);

export function BulkAddMarketplaces({ onClose, onSaved }: { onClose: () => void; onSaved: (count: number) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [text, setText] = useState("");
  const [ptype, setPtype] = useState("marketplace");
  const [rows, setRows] = useState<Row[]>([]);
  const [signer, setSigner] = useSigner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const names = splitNames(text);
  const items = (rs: Row[]) => rs.map(({ name, provider_type, status }) => ({ name, provider_type, status }));
  const check = async (rs: Row[]) => {
    const r = await post("/marketplaces/bulk", { dry_run: true, items: items(rs), signer_name: signer || "check" });
    setRows(rs.map((x, i) => ({ ...x, errors: r.rows[i]?.errors ?? [] })));
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e as ApiError); } setBusy(false); };

  const next = () => run(async () => {
    const keep = new Map(rows.map((r) => [r.name.toLowerCase(), r]));   // going back and forth keeps choices
    const rs = names.map((n) => keep.get(n.toLowerCase()) ?? { name: n, provider_type: ptype, status: "prospect", errors: [] });
    await check(rs);
    setStep(2);
  });
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setAll = (status: string) => setRows(rows.map((r) => ({ ...r, status })));
  const remove = (pred: (r: Row, i: number) => boolean) => run(async () => check(rows.filter((r, i) => !pred(r, i))));
  const save = () => run(async () => {
    try {
      const r = await post("/marketplaces/bulk", { items: items(rows), signer_name: signer });
      rememberSigner(signer);
      onSaved(r.created.length);
    } catch (e) {
      try { await check(rows); } catch { /* keep the original error */ }   // show which names need fixing
      throw e;
    }
  });
  const bad = rows.filter((r) => r.errors.length).length;

  return (
    <Overlay kind="modal" wide title="Add marketplaces in bulk" subtitle={step === 1 ? "Step 1 of 2 · List the names" : "Step 2 of 2 · Tick each one's status"} onClose={onClose}>
      <ErrorBox error={error} />
      {step === 1 && (
        <div className="form-grid">
          <Field label="Names" required wide hint="One per line. You can paste a column from a spreadsheet; bullets and numbering are removed.">
            <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Giftsenda\nSendoso\nBlueboard"} autoFocus />
          </Field>
          <Field label="Provider type for all" hint="Can be changed per name in the next step.">
            <Select value={ptype} onChange={setPtype} options={PROVIDER_LABEL} />
          </Field>
          <div className="form-actions">
            <span className="hint">{names.length} name{names.length === 1 ? "" : "s"}</span>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !names.length || names.length > 200} onClick={next}>{busy ? "Checking…" : "Next: choose statuses"}</button>
          </div>
          {names.length > 200 && <p className="field-error wide">Up to 200 names at a time.</p>}
        </div>
      )}

      {step === 2 && (
        <>
          <p className="hint">Tick one status per name (default Prospect). Tick a column heading to set that status for everyone. Inactive statuses (On hold, Rejected …) need a reason, so set them afterwards from the record.</p>
          {bad > 0 && (
            <div className="alert warn">
              {bad} name{bad === 1 ? "" : "s"} can't be added (already exists or repeated).{" "}
              <button className="btn small" disabled={busy} onClick={() => remove((r) => r.errors.length > 0)}>Remove them</button>
            </div>
          )}
          <div className="table-wrap">
            <table className="table compact bulk-status">
              <thead>
                <tr>
                  <th>Name</th><th>Type</th>
                  {WORKING.map((s) => (
                    <th key={s} className="status-col">
                      <label className="col-check" title={`Set all to ${STATUS_LABEL[s]}`}>
                        <span>{STATUS_LABEL[s]}</span>
                        <input type="checkbox" aria-label={`All ${STATUS_LABEL[s]}`} checked={rows.length > 0 && rows.every((r) => r.status === s)} onChange={() => setAll(s)} />
                      </label>
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.errors.length ? "row-error" : ""}>
                    <td><strong>{r.name}</strong>{r.errors.map((e, k) => <div key={k} className="field-error">{e}</div>)}</td>
                    <td><Select aria-label={`Type of ${r.name}`} value={r.provider_type} onChange={(v) => setRow(i, { provider_type: v })} options={PROVIDER_LABEL} /></td>
                    {WORKING.map((s) => (
                      <td key={s} className="status-col">
                        <input type="checkbox" aria-label={`${r.name}: ${STATUS_LABEL[s]}`} checked={r.status === s} onChange={() => setRow(i, { status: s })} />
                      </td>
                    ))}
                    <td><button className="btn ghost small" aria-label={`Remove ${r.name}`} disabled={busy} onClick={() => remove((_, j) => j === i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="stats">
            {WORKING.filter((s) => rows.some((r) => r.status === s)).map((s) => <li key={s}><Pill tone="neutral">{STATUS_LABEL[s]}</Pill> {rows.filter((r) => r.status === s).length}</li>)}
          </ul>
          <div className="form-grid">
            <SignerField value={signer} onChange={setSigner} />
            <div className="form-actions">
              <button className="btn ghost" disabled={busy} onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" disabled={busy || !rows.length || bad > 0 || !signer.trim()} onClick={save}>{busy ? "Saving…" : `Add ${rows.length} marketplace${rows.length === 1 ? "" : "s"}`}</button>
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}
