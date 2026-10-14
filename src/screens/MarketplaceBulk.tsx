// Bulk actions inside a marketplace: propose several gifts, add several requirements.
import { useState } from "react";
import { post, ApiError } from "../api";
import { Field, Select, SignerField, ErrorBox, Overlay, Pill, useSigner, rememberSigner } from "../components/ui";
import { ProductPicker, type ProductLite } from "../components/ProductPicker";
import { FAMILY_LABEL, OFFER_LABEL, PROPOSAL_LABEL, CATEGORY_LABEL, CONFIRM_LABEL, productLabel, money } from "../format";

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e as ApiError); } setBusy(false); };
  return { busy, error, run };
}

// ---------------------------------------------------------------- products
type Gift = { id: string; name: string; variant: string | null; sku: string | null; family: string | null; selected: boolean; web_price_cents: number | null; existing_status: string | null };

export function BulkProposeProducts({ mid, onClose, onSaved }: { mid: string; onClose: () => void; onSaved: (n: number) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState<"family" | "collection" | "picked">("family");
  const [family, setFamily] = useState("live_to_give_box");
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<ProductLite[]>([]);
  const [selectedOnly, setSelectedOnly] = useState(true);
  const [defaultOffer, setDefaultOffer] = useState("individual");
  const [gifts, setGifts] = useState<Gift[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState<Record<string, boolean>>({});
  const [offer, setOffer] = useState<Record<string, string>>({});
  const [shared, setShared] = useState({ proposal_status: "proposed", offer_note: "", submitted_on: "" });
  const [signer, setSigner] = useSigner();
  const { busy, error, run } = useRun();

  const bulkOnly = (g: Gift) => g.family === "pots_plus_succulents";
  const find = () => run(async () => {
    const r = await post(`/marketplaces/${mid}/products/candidates`, {
      source, family, collection_url: url, product_ids: picked.map((p) => p.id), selected_only: selectedOnly, signer_name: signer || "check",
    });
    setGifts(r.gifts); setNote(r.note);
    setTick(Object.fromEntries(r.gifts.map((g: Gift) => [g.id, !g.existing_status])));
    setOffer(Object.fromEntries(r.gifts.map((g: Gift) => [g.id, bulkOnly(g) && defaultOffer === "individual" ? "bulk" : defaultOffer])));
    setStep(2);
  });
  const chosen = gifts.filter((g) => tick[g.id] && !g.existing_status);
  const save = () => run(async () => {
    const r = await post(`/marketplaces/${mid}/products/bulk`, {
      items: chosen.map((g) => ({ product_id: g.id, offer_type: offer[g.id] })), ...shared, submitted_on: shared.submitted_on || null, signer_name: signer,
    });
    rememberSigner(signer); onSaved(r.created);
  });
  const allOn = gifts.filter((g) => !g.existing_status).every((g) => tick[g.id]);

  return (
    <Overlay kind="modal" wide title="Propose several products" subtitle={step === 1 ? "Step 1 of 2 · Choose the gifts" : "Step 2 of 2 · Check the list and save"} onClose={onClose}>
      <ErrorBox error={error} />
      {step === 1 && (
        <div className="form-grid">
          <fieldset className="model-pick wide">
            <legend>Add gifts by</legend>
            {([["family", "Gift category", "Every gift in one category (e.g. all Live to Give boxes)."],
               ["collection", "Website collection link", "Paste a succulentsbox.com/collections/… link; its products are matched to your gifts."],
               ["picked", "Picking gifts", "Search and add gifts one by one."]] as const).map(([k, label, help]) => (
              <label key={k} className={`model-option${source === k ? " on" : ""}`}>
                <input type="radio" name="bulk-source" checked={source === k} onChange={() => setSource(k)} />
                <strong>{label}</strong><span className="hint">{help}</span>
              </label>
            ))}
          </fieldset>
          {source === "family" && <Field label="Gift category" required><Select value={family} onChange={setFamily} options={FAMILY_LABEL} /></Field>}
          {source === "collection" && (
            <Field label="Collection link" required wide hint="Only gifts already in this app (website refresh) can be matched.">
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://succulentsbox.com/collections/corporate-gifts" />
            </Field>
          )}
          {source === "picked" && (
            <div className="wide">
              <ProductPicker value={null} onChange={(p) => p && !picked.some((x) => x.id === p.id) && setPicked([...picked, p])} selectedOnly />
              {picked.length > 0 && (
                <ul className="chip-list">
                  {picked.map((p) => <li key={p.id}>{productLabel(p.name, p.variant)} <button className="btn ghost small" aria-label={`Remove ${p.name}`} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>✕</button></li>)}
                </ul>
              )}
            </div>
          )}
          {source !== "picked" && <label className="check wide"><input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} /> Selected gifts only (gifts chosen for corporate gifting in Pricing → Gifts)</label>}
          <Field label="Offer type for all" hint="Can be changed per gift in the next step. Pots with succulents always use a bulk offer.">
            <Select value={defaultOffer} onChange={setDefaultOffer} options={OFFER_LABEL} />
          </Field>
          <div className="form-actions">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || (source === "collection" && !url.trim()) || (source === "picked" && !picked.length)} onClick={find}>{busy ? "Finding gifts…" : "Next: review gifts"}</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <>
          {note && <p className="hint">{note} · {gifts.length} matched gift variant(s) in this app.</p>}
          {gifts.length === 0 ? <div className="alert warn">No matching gifts. Try without “Selected gifts only”, or refresh website products in Pricing.</div> : (
            <div className="table-wrap">
              <table className="table compact">
                <thead><tr>
                  <th><input type="checkbox" aria-label="Tick all" checked={allOn} onChange={(e) => setTick(Object.fromEntries(gifts.map((g) => [g.id, !g.existing_status && e.target.checked])))} /></th>
                  <th>Gift / variant</th><th>Category</th><th className="num">Retail</th><th>Offer type</th><th></th>
                </tr></thead>
                <tbody>
                  {gifts.map((g) => (
                    <tr key={g.id} className={g.existing_status ? "muted-row" : ""}>
                      <td><input type="checkbox" aria-label={`Propose ${productLabel(g.name, g.variant)}`} disabled={!!g.existing_status} checked={!!tick[g.id] && !g.existing_status} onChange={(e) => setTick({ ...tick, [g.id]: e.target.checked })} /></td>
                      <td><strong>{productLabel(g.name, g.variant)}</strong>{g.sku && <div className="hint">SKU {g.sku}{g.selected ? "" : " · not selected for corporate gifting"}</div>}</td>
                      <td className="small-text">{g.family ? FAMILY_LABEL[g.family] : <span className="unknown">Not set</span>}</td>
                      <td className="num">{money(g.web_price_cents)}</td>
                      <td><Select aria-label={`Offer type for ${productLabel(g.name, g.variant)}`} value={offer[g.id]} onChange={(v) => setOffer({ ...offer, [g.id]: v })}
                        options={Object.entries(OFFER_LABEL).filter(([k]) => !(bulkOnly(g) && k === "individual"))} disabled={!!g.existing_status} /></td>
                      <td>{g.existing_status ? <Pill tone="neutral">Already {PROPOSAL_LABEL[g.existing_status]?.toLowerCase()}</Pill> : bulkOnly(g) ? <Pill tone="warn">Bulk only</Pill> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="form-grid">
            <Field label="Product status for all"><Select value={shared.proposal_status} onChange={(v) => setShared({ ...shared, proposal_status: v })} options={PROPOSAL_LABEL} /></Field>
            <Field label="Submission date (optional)"><input type="date" value={shared.submitted_on} onChange={(e) => setShared({ ...shared, submitted_on: e.target.value })} /></Field>
            <Field label="Offer note for all (optional)" wide><textarea rows={2} value={shared.offer_note} onChange={(e) => setShared({ ...shared, offer_note: e.target.value })} /></Field>
            <SignerField value={signer} onChange={setSigner} />
            <div className="form-actions">
              <button className="btn ghost" disabled={busy} onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" disabled={busy || !chosen.length || !signer.trim()} onClick={save}>{busy ? "Saving…" : `Propose ${chosen.length} gift${chosen.length === 1 ? "" : "s"}`}</button>
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}

// ------------------------------------------------------------ requirements
type Req = { category: string; requirement: string; errors: string[] };
const lines = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/^\s*[-•*]\s+|^\s*\d+[.)]\s+/, "").trim()).filter(Boolean);

export function BulkRequirements({ mid, onClose, onSaved }: { mid: string; onClose: () => void; onSaved: (n: number) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [text, setText] = useState("");
  const [category, setCategory] = useState("other");
  const [rows, setRows] = useState<Req[]>([]);
  const [shared, setShared] = useState({ confirmation_state: "unverified", source_ref: "", verified_on: "" });
  const [signer, setSigner] = useSigner();
  const { busy, error, run } = useRun();
  const items = lines(text);

  const check = async (rs: Req[]) => {
    const r = await post(`/marketplaces/${mid}/requirements/bulk`, { dry_run: true, items: rs.map(({ category, requirement }) => ({ category, requirement })), signer_name: signer || "check" });
    setRows(rs.map((x, i) => ({ ...x, errors: r.rows[i]?.errors ?? [] })));
  };
  const next = () => run(async () => { await check(items.map((t) => ({ category, requirement: t, errors: [] }))); setStep(2); });
  const remove = (pred: (r: Req, i: number) => boolean) => run(async () => check(rows.filter((r, i) => !pred(r, i))));
  const save = () => run(async () => {
    try {
      const r = await post(`/marketplaces/${mid}/requirements/bulk`, {
        items: rows.map(({ category, requirement }) => ({ category, requirement })), ...shared, verified_on: shared.verified_on || null, signer_name: signer,
      });
      rememberSigner(signer); onSaved(r.created);
    } catch (e) { try { await check(rows); } catch { /* keep the original error */ } throw e; }
  });
  const bad = rows.filter((r) => r.errors.length).length;

  return (
    <Overlay kind="modal" wide title="Add several requirements" subtitle={step === 1 ? "Step 1 of 2 · Paste the requirements" : "Step 2 of 2 · Set categories and save"} onClose={onClose}>
      <ErrorBox error={error} />
      {step === 1 && (
        <div className="form-grid">
          <Field label="Requirements" required wide hint="One requirement per line (e.g. copied from the marketplace's vendor guide). Bullets and numbering are removed.">
            <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Ship within 2 business days\nBranded packing slip required\nNet 30 payment terms"} autoFocus />
          </Field>
          <Field label="Category for all" hint="Can be changed per line in the next step."><Select value={category} onChange={setCategory} options={CATEGORY_LABEL} /></Field>
          <div className="form-actions">
            <span className="hint">{items.length} requirement{items.length === 1 ? "" : "s"}</span>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !items.length || items.length > 200} onClick={next}>{busy ? "Checking…" : "Next: set categories"}</button>
          </div>
        </div>
      )}
      {step === 2 && (
        <>
          {bad > 0 && <div className="alert warn">{bad} line{bad === 1 ? "" : "s"} already recorded or repeated. <button className="btn small" disabled={busy} onClick={() => remove((r) => r.errors.length > 0)}>Remove them</button></div>}
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th>Category</th><th>Supplier requirement</th><th></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.errors.length ? "row-error" : ""}>
                    <td><Select aria-label={`Category of line ${i + 1}`} value={r.category} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, category: v } : x)))} options={CATEGORY_LABEL} /></td>
                    <td>{r.requirement}{r.errors.map((e, k) => <div key={k} className="field-error">{e}</div>)}</td>
                    <td><button className="btn ghost small" aria-label={`Remove line ${i + 1}`} disabled={busy} onClick={() => remove((_, j) => j === i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-grid">
            <Field label="Confirmation state for all" hint="Confirmed = the actual applicable supplier term, confirmed by the team."><Select value={shared.confirmation_state} onChange={(v) => setShared({ ...shared, confirmation_state: v })} options={CONFIRM_LABEL} /></Field>
            <Field label="Research verification date (optional)"><input type="date" value={shared.verified_on} onChange={(e) => setShared({ ...shared, verified_on: e.target.value })} /></Field>
            <Field label="Source URL or reference for all (optional)" wide><input value={shared.source_ref} onChange={(e) => setShared({ ...shared, source_ref: e.target.value })} /></Field>
            <SignerField value={signer} onChange={setSigner} />
            <div className="form-actions">
              <button className="btn ghost" disabled={busy} onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" disabled={busy || !rows.length || bad > 0 || !signer.trim()} onClick={save}>{busy ? "Saving…" : `Add ${rows.length} requirement${rows.length === 1 ? "" : "s"}`}</button>
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}
