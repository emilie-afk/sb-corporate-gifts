import { useState, type FormEvent } from "react";
import { get, post, patch, qs } from "../api";
import {
  Field, Select, SignerField, FormActions, ErrorBox, Overlay, Section, Pill, Loading, Empty,
  useLoad, useSave, useSigner, rememberSigner, useDebounced,
} from "../components/ui";
import { FAMILY_LABEL, TRI_LABEL, AVAIL_LABEL, money, dateTime, productLabel } from "../format";

const PAGE = 50;

export function GiftsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"gifts" | "collections">("gifts");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [selected, setSelected] = useState(true);
  const [family, setFamily] = useState("");
  const [collection, setCollection] = useState("");
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<any | null>(null);
  const list = useLoad(() => get(`/products${qs({ q: dq, selected, family, collection_id: collection, limit: PAGE, offset })}`), [dq, selected, family, collection, offset]);
  const cols = useLoad(() => get("/collections"), []);

  return (
    <Overlay title="Gifts & collections" subtitle="Website products are imported; team-confirmed fields are never overwritten by refreshes." onClose={onClose}>
      <div className="seg">
        <button className={tab === "gifts" ? "active" : ""} onClick={() => setTab("gifts")}>Gifts</button>
        <button className={tab === "collections" ? "active" : ""} onClick={() => setTab("collections")}>Collection references</button>
      </div>
      {tab === "gifts" && (
        <>
          <div className="filters">
            <input type="search" placeholder="Search name, variant, SKU" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
            <Select value={family} onChange={(v) => { setFamily(v); setOffset(0); }} options={FAMILY_LABEL} empty="All families" />
            <Select value={collection} onChange={(v) => { setCollection(v); setOffset(0); }} options={(cols.data?.collections ?? []).map((c: any) => [c.id, c.name])} empty="Any collection" />
            <label className="check"><input type="checkbox" checked={selected} onChange={(e) => { setSelected(e.target.checked); setOffset(0); }} /> Selected for this dashboard only</label>
            <button className="btn small" onClick={() => setEdit({})}>Add gift</button>
          </div>
          <ErrorBox error={list.error} />
          {list.loading && !list.data && <Loading />}
          {list.data && (
            <>
              <div className="table-wrap">
                <table className="table dense">
                  <thead><tr><th>Gift / variant</th><th>Family</th><th>Availability</th><th>Card</th><th>Plants</th><th>Individual</th><th className="num">Retail</th><th className="num">Cost</th><th></th></tr></thead>
                  <tbody>
                    {list.data.products.length === 0 && <tr><td colSpan={9}><Empty>No gifts. {selected ? "Untick “Selected only” to see the whole imported catalog." : "Run Refresh website products or add a gift."}</Empty></td></tr>}
                    {list.data.products.map((p: any) => (
                      <tr key={p.id}>
                        <td data-label="Gift"><strong>{productLabel(p.name, p.variant)}</strong>
                          <div className="hint">{[p.sku, p.source === "manual" ? "manual" : null, p.selected ? "selected" : null].filter(Boolean).join(" · ")}{p.not_seen_since && <> · <span className="warn-text">not on website since {dateTime(p.not_seen_since)}</span></>}</div></td>
                        <td data-label="Family">{p.family ? FAMILY_LABEL[p.family] : <span className="unknown">Not set</span>}</td>
                        <td data-label="Availability">{p.availability ? AVAIL_LABEL[p.availability] : <span className="unknown">Not set</span>}</td>
                        <td data-label="Card">{TRI_LABEL[p.card_eligible]}</td>
                        <td data-label="Plants">{p.plants_included === "no" ? <strong>Not included</strong> : TRI_LABEL[p.plants_included]}</td>
                        <td data-label="Individual">{TRI_LABEL[p.individual_recipient_fulfillment]}</td>
                        <td className="num" data-label="Retail">{money(p.web_price_cents)}</td>
                        <td className="num" data-label="Cost">{money(p.current_cost_cents)}</td>
                        <td><button className="btn small" onClick={() => setEdit(p)}>Edit</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <button className="btn ghost small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Prev</button>
                <span className="hint">{list.data.total ? `${offset + 1}–${Math.min(offset + PAGE, list.data.total)} of ${list.data.total}` : "0"}</span>
                <button className="btn ghost small" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next →</button>
              </div>
            </>
          )}
        </>
      )}
      {tab === "collections" && <Collections data={cols.data} reload={() => { cols.reload(); list.reload(); }} />}
      {edit && <GiftForm p={edit} collections={cols.data?.collections ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </Overlay>
  );
}

function GiftForm({ p, collections, onClose, onSaved }: { p: any; collections: any[]; onClose: () => void; onSaved: () => void }) {
  const isManual = !p.id || p.source === "manual";
  const [f, setF] = useState({
    name: p.name ?? "", variant: p.variant ?? "", sku: p.sku ?? "", product_url: p.product_url ?? "",
    selected: p.id ? !!p.selected : true, vendor: p.vendor ?? "", family: p.family ?? "", contents_summary: p.contents_summary ?? "",
    availability: p.availability ?? "", card_eligible: p.card_eligible ?? "unknown", customization_note: p.customization_note ?? "",
    plants_included: p.plants_included ?? "unknown", individual_recipient_fulfillment: p.individual_recipient_fulfillment ?? "unknown",
    fulfillment_note: p.fulfillment_note ?? "", cost_source_note: p.cost_source_note ?? "",
  });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const set = (k: keyof typeof f) => (v: any) => setF({ ...f, [k]: v?.target ? (v.target.type === "checkbox" ? v.target.checked : v.target.value) : v });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: any = { ...f, family: f.family || null, availability: f.availability || null, signer_name: signer };
    if (!isManual) for (const k of ["name", "variant", "sku", "product_url"]) delete body[k];
    const ok = await s.run(() => (p.id ? patch(`/products/${p.id}`, { ...body, version: p.version }) : post("/products", body)));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  const famWarn = f.family === "custom_pots" ? "Custom pots are pots only — plants not included." : f.family === "pots_plus_succulents" ? "Bulk only, multiple shipments. Cannot be fulfilled to individual recipients by SB." : f.family === "watering_can" ? "Confirm customization, MOQ, card eligibility and fulfillment per offer — don't infer from the title." : f.family === "live_to_give_box" ? "Live to Give label applies only to the gifts you mark here — never automatically." : null;
  return (
    <Overlay kind="modal" title={p.id ? productLabel(p.name, p.variant) : "Add gift"} subtitle={p.id && !isManual ? "Imported from the website. Name, URL, image and retail refresh from the site." : undefined} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        {isManual ? (
          <>
            <Field label="Name" required error={s.fe("name")}><input value={f.name} onChange={set("name")} /></Field>
            <Field label="Variant"><input value={f.variant} onChange={set("variant")} /></Field>
            <Field label="SKU / identifier"><input value={f.sku} onChange={set("sku")} /></Field>
            <Field label="Product URL" error={s.fe("product_url")}><input type="url" value={f.product_url} onChange={set("product_url")} /></Field>
          </>
        ) : (
          <div className="wide hint">
            {p.product_url && <a href={p.product_url} target="_blank" rel="noreferrer noopener">View on website</a>} · SKU {p.sku ?? "—"} · Retail {money(p.web_price_cents)} · Website availability: {p.web_availability}
            {p.website_vendor && <> · Website vendor label: {p.website_vendor} (not a cost mapping)</>}
          </div>
        )}
        <label className="check wide"><input type="checkbox" checked={f.selected} onChange={set("selected")} /> Selected for use in this dashboard</label>
        <Field label="Internal family" hint={famWarn}><Select value={f.family} onChange={set("family")} options={FAMILY_LABEL} empty="Not set" /></Field>
        <Field label="Availability (team flag)" hint="No stock counting."><Select value={f.availability} onChange={set("availability")} options={AVAIL_LABEL} empty="Not set" /></Field>
        <Field label="Vendor (Product Master)"><input value={f.vendor} onChange={set("vendor")} /></Field>
        <Field label="Handwritten card eligible"><Select value={f.card_eligible} onChange={set("card_eligible")} options={TRI_LABEL} /></Field>
        <Field label="Plants included" error={s.fe("plants_included")}><Select value={f.plants_included} onChange={set("plants_included")} options={TRI_LABEL} /></Field>
        <Field label="Individual recipient fulfillment" error={s.fe("individual_recipient_fulfillment")}><Select value={f.individual_recipient_fulfillment} onChange={set("individual_recipient_fulfillment")} options={TRI_LABEL} /></Field>
        <Field label="Contents summary" wide><textarea rows={2} value={f.contents_summary} onChange={set("contents_summary")} /></Field>
        <Field label="Customization note" wide><textarea rows={2} value={f.customization_note} onChange={set("customization_note")} /></Field>
        <Field label="Fulfillment note" wide><textarea rows={2} value={f.fulfillment_note} onChange={set("fulfillment_note")} /></Field>
        <Field label="Cost-source note" wide><input value={f.cost_source_note} onChange={set("cost_source_note")} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
      {p.id && <GiftCollections p={p} collections={collections} />}
      {p.id && <SourceLinks productId={p.id} />}
    </Overlay>
  );
}

function GiftCollections({ p, collections }: { p: any; collections: any[] }) {
  const [current, setCurrent] = useState<any[]>(p.collections ?? []);
  const [pick, setPick] = useState("");
  const [signer] = useSigner();
  const s = useSave();
  const toggle = async (id: string, remove: boolean) => {
    const ok = await s.run(() => post(`/products/${p.id}/collections`, { collection_id: id, remove, signer_name: signer }));
    if (ok) setCurrent(remove ? current.filter((c) => c.id !== id) : [...current, collections.find((c) => c.id === id)]);
  };
  return (
    <Section title="Collection references" count={current.length} defaultOpen={false}>
      <ErrorBox error={s.error} />
      <div className="row-gap wrap">
        {current.map((c) => <span key={c.id} className="pill neutral">{c.name} <button className="link" onClick={() => toggle(c.id, true)} aria-label={`Unlink ${c.name}`}>✕</button></span>)}
      </div>
      <div className="row-gap">
        <Select value={pick} onChange={setPick} options={collections.filter((c) => !current.some((x) => x.id === c.id)).map((c) => [c.id, c.name])} empty="Add to collection…" />
        <button className="btn small" disabled={!pick || s.saving || !signer.trim()} onClick={() => { toggle(pick, false); setPick(""); }}>Link</button>
        {!signer.trim() && <span className="hint">Enter your name in the form above first.</span>}
      </div>
    </Section>
  );
}

// ------------------------------------------------- Product Master source rows
function SourceLinks({ productId }: { productId: string }) {
  const links = useLoad(() => get(`/products/${productId}/source-links`), [productId]);
  const detail = useLoad(() => get(`/products/${productId}`), [productId]);
  const [adding, setAdding] = useState(false);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const remove = async (l: any) => {
    if (!confirm("Remove this source row mapping? Past cost snapshots are kept.")) return;
    if (await s.run(() => patch(`/products/${productId}/source-links/${l.id}`, { remove: true, version: l.version, signer_name: signer }))) links.reload();
  };
  const setQty = async (l: any, v: string) => {
    const n = v === "" ? null : Number(v);
    if (await s.run(() => patch(`/products/${productId}/source-links/${l.id}`, { quantity_per_gift: n, version: l.version, signer_name: signer }))) links.reload();
  };
  return (
    <Section title="Product Master cost mapping" count={links.data?.links.length}>
      <p className="hint">Map this gift explicitly to unique vendor row(s). Composite gifts need one row per distinct component, or a confirmed complete-gift cost row.</p>
      <ErrorBox error={s.error || links.error} />
      {links.data?.links.length === 0 && <Empty>Not mapped — this gift is reported as unmapped on cost refresh.</Empty>}
      <ul className="timeline small">
        {links.data?.links.map((l: any) => (
          <li key={l.id}>
            <strong>{l.mapping_label}</strong> ({l.vendor} · {l.tab_name}) {l.component_label && <Pill>{l.component_label}</Pill>}
            <div>Match: {Object.entries(l.match_values).map(([k, v]) => `${k} = ${v}`).join(", ")} · Basis: {l.cost_basis === "per_piece" ? "per piece" : "complete pack/gift"}</div>
            {l.cost_basis === "per_piece" && (
              <div className="row-gap">Quantity per gift:
                <input className="narrow" defaultValue={l.quantity_per_gift ?? ""} placeholder="from sheet / unknown" onBlur={(e) => e.target.value !== String(l.quantity_per_gift ?? "") && setQty(l, e.target.value)} />
              </div>
            )}
            <button className="btn ghost small danger" onClick={() => remove(l)}>Remove</button>
          </li>
        ))}
      </ul>
      <SignerField value={signer} onChange={setSigner} />
      <button className="btn small" onClick={() => setAdding(true)} disabled={!signer.trim()}>Map a source row</button>
      {adding && <LinkForm productId={productId} existing={links.data?.links.length ?? 0} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); links.reload(); }} />}
      {detail.data?.costSnapshots?.length > 0 && (
        <>
          <div className="subhead">Cost snapshots</div>
          <table className="table compact">
            <thead><tr><th>Date</th><th className="num">Gift cost</th><th>Detail</th><th>Confirmed by</th></tr></thead>
            <tbody>
              {detail.data.costSnapshots.map((c: any) => (
                <tr key={c.id}><td>{dateTime(c.created_at)}</td><td className="num">{money(c.gift_cost_cents)}</td>
                  <td className="small-text">{c.detail.map((x: any) => `${x.component_label ? x.component_label + ": " : ""}${x.source_cost} ${x.basis === "per_piece" ? `× ${x.quantity}` : "(pack)"} [${x.vendor}/${x.tab} row ${x.row_locator}, map v${x.mapping_version}]`).join("; ")}</td>
                  <td>{c.confirmed_by}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}

function LinkForm({ productId, existing, onClose, onSaved }: { productId: string; existing: number; onClose: () => void; onSaved: () => void }) {
  const sources = useLoad(() => get("/sources"), []);
  const [mapId, setMapId] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<any | null>(null);
  const [chosen, setChosen] = useState<any | null>(null);
  const [qty, setQty] = useState("");
  const [component, setComponent] = useState("");
  const [signer, setSigner] = useSigner();
  const look = useSave();
  const s = useSave();
  const mapping = sources.data?.sources.find((x: any) => x.id === mapId);
  const lookup = async () => { await look.run(async () => setRows(await post(`/sources/${mapId}/lookup`, { query }))); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const match_values = Object.fromEntries(mapping.match_columns.map((k: string) => [k, String(chosen.cells[k] ?? "")]));
    const ok = await s.run(() => post(`/products/${productId}/source-links`, { source_mapping_id: mapId, match_values, quantity_per_gift: qty ? Number(qty) : null, component_label: component || null, signer_name: signer }));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title="Map Product Master row" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error || look.error} />
        <Field label="Vendor tab mapping" required wide>
          <Select value={mapId} onChange={(v) => { setMapId(v); setRows(null); setChosen(null); }} options={(sources.data?.sources ?? []).map((m: any) => [m.id, `${m.vendor} — ${m.label}`])} empty={sources.data?.sources.length ? "Choose…" : "No mappings yet — add one in Cost source settings"} />
        </Field>
        {mapping && (
          <>
            <Field label={`Search ${mapping.match_columns.join(" / ")}`} wide>
              <div className="row-gap"><input value={query} onChange={(e) => setQuery(e.target.value)} /><button type="button" className="btn small" onClick={lookup} disabled={look.saving}>{look.saving ? "Reading sheet…" : "Find rows"}</button></div>
            </Field>
            {rows?.missing_headers?.length > 0 && <div className="alert error wide">Missing columns in the tab: {rows.missing_headers.join(", ")}</div>}
            {rows && (
              <div className="wide table-wrap">
                <table className="table compact">
                  <thead><tr><th></th><th>Row</th>{Object.keys(rows.rows[0]?.cells ?? {}).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                  <tbody>
                    {rows.rows.length === 0 && <tr><td colSpan={9}>No rows found.</td></tr>}
                    {rows.rows.map((r: any) => (
                      <tr key={r.rowNumber} className={chosen?.rowNumber === r.rowNumber ? "current-row" : ""}>
                        <td><input type="radio" name="row" checked={chosen?.rowNumber === r.rowNumber} onChange={() => setChosen(r)} /></td>
                        <td>{r.rowNumber}</td>{Object.values(r.cells).map((v: any, i) => <td key={i}>{String(v ?? "")}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint">The match is saved by identifier values, not row number. Ambiguous identifiers are reported on refresh and never used.</p>
              </div>
            )}
            {mapping.cost_basis === "per_piece" && (
              <Field label="Quantity per gift" hint={mapping.quantity_column ? `Leave blank to use the "${mapping.quantity_column}" column.` : "Required — the sheet has no quantity column. Don't infer from the product name."}>
                <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
            )}
            {mapping.cost_basis === "per_pack" && <p className="hint wide">This tab's cost is for the complete pack/gift — it is used directly, never multiplied.</p>}
            <Field label={existing > 0 ? "Component label (required for an extra component)" : "Component label (composite gifts only)"}><input value={component} onChange={(e) => setComponent(e.target.value)} /></Field>
          </>
        )}
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} disabled={!chosen} />
      </form>
    </Overlay>
  );
}

// -------------------------------------------------------------- collections
function Collections({ data, reload }: { data: any; reload: () => void }) {
  const [edit, setEdit] = useState<any | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const refresh = async (c: any) => {
    setMsg(null);
    const ok = await s.run(async () => {
      const r = await post(`/collections/${c.id}/refresh-membership`, { signer_name: signer });
      setMsg(`${c.name}: ${r.products_on_site} website products, ${r.links_added} new links added. ${r.note}`);
    });
    if (ok) reload();
  };
  if (!data) return <Loading />;
  return (
    <>
      <p className="hint">A collection is a grouping/reference, not a sellable gift or cost record. Select individual gifts and variants inside it.</p>
      <ErrorBox error={s.error} />
      {msg && <div className="alert success">{msg}</div>}
      {data.collections.length === 0 && <Empty>No collection references.</Empty>}
      <ul className="timeline">
        {data.collections.map((c: any) => (
          <li key={c.id}>
            <strong>{c.name}</strong> <span className="hint">{c.product_count} linked variants</span>
            {c.url && <div><a href={c.url} target="_blank" rel="noreferrer noopener">{c.url}</a></div>}
            {c.note && <div className="hint">{c.note}</div>}
            <div className="row-gap">
              <button className="btn ghost small" onClick={() => setEdit(c)}>Edit</button>
              {c.url?.includes("succulentsbox.com/collections/") && <button className="btn ghost small" disabled={s.saving || !signer.trim()} onClick={() => refresh(c)}>Import membership from website</button>}
            </div>
          </li>
        ))}
      </ul>
      <SignerField value={signer} onChange={setSigner} />
      <button className="btn small" onClick={() => setEdit({})}>Add collection reference</button>
      {edit && <CollectionForm c={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function CollectionForm({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: c.name ?? "", url: c.url ?? "", note: c.note ?? "" });
  const [signer, setSigner] = useSigner();
  const s = useSave();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await s.run(() => (c.id ? patch(`/collections/${c.id}`, { ...f, version: c.version, signer_name: signer }) : post("/collections", { ...f, signer_name: signer })));
    if (ok) { rememberSigner(signer); onSaved(); }
  };
  return (
    <Overlay kind="modal" title={c.id ? "Edit collection reference" : "Add collection reference"} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <ErrorBox error={s.error} />
        <Field label="Name" required error={s.fe("name")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Collection URL" error={s.fe("url")}><input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
        <Field label="Note" wide><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <SignerField value={signer} onChange={setSigner} error={s.fe("signer_name")} />
        <FormActions saving={s.saving} onCancel={onClose} />
      </form>
    </Overlay>
  );
}
