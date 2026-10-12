import { useEffect, useState } from "react";
import { get, qs } from "../api";
import { FAMILY_LABEL, productLabel, money } from "../format";
import { useDebounced } from "./ui";

export type ProductLite = { id: string; name: string; variant: string | null; sku: string | null; family: string | null; selected: boolean; web_price_cents: number | null; plants_included: string; individual_recipient_fulfillment: string };

/** Search-as-you-type gift/variant selector. Shows names and variants, never only IDs. */
export function ProductPicker({ value, onChange, selectedOnly = false }: { value: ProductLite | null; onChange: (p: ProductLite | null) => void; selectedOnly?: boolean }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [onlySel, setOnlySel] = useState(selectedOnly);
  const [items, setItems] = useState<ProductLite[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    get(`/products${qs({ q: dq, selected: onlySel, limit: 30 })}`).then((r) => setItems(r.products)).catch(() => setItems([]));
  }, [dq, onlySel, open]);

  if (value && !open)
    return (
      <div className="picked">
        <div>
          <strong>{productLabel(value.name, value.variant)}</strong>
          <div className="hint">{[value.sku, value.family && FAMILY_LABEL[value.family]].filter(Boolean).join(" · ")}</div>
        </div>
        <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>Change</button>
      </div>
    );
  return (
    <div className="picker">
      <div className="picker-row">
        <input placeholder="Search gifts by name, variant or SKU" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)} autoFocus={open} />
        <label className="check"><input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> Selected gifts only</label>
      </div>
      {open && (
        <ul className="picker-list">
          {items.length === 0 && <li className="hint">No matching gifts. Add one in Pricing → Gifts.</li>}
          {items.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onChange(p); setOpen(false); }}>
                <span>{productLabel(p.name, p.variant)}</span>
                <span className="hint">{[p.sku, p.family ? FAMILY_LABEL[p.family] : null, money(p.web_price_cents, "")].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value && open && <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>Keep {productLabel(value.name, value.variant)}</button>}
    </div>
  );
}
