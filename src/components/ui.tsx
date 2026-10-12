import { useEffect, useState, useCallback, type ReactNode } from "react";
import { ApiError } from "../api";
import { INACTIVE, STATUS_LABEL } from "../format";

// ---------------------------------------------------------------- signer
const SIGNER_KEY = "sbg.signer";
function readSigner() {
  try { return localStorage.getItem(SIGNER_KEY) ?? ""; } catch { return ""; }
}
export function rememberSigner(name: string) {
  try { localStorage.setItem(SIGNER_KEY, name.trim()); } catch { /* storage unavailable */ }
}
/** Pre-fills the last typed name for convenience; always visible and editable, never substituted silently. */
export function useSigner() {
  return useState<string>(readSigner);
}

// --------------------------------------------------------------- saving
export function useSave() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "error", String((e as Error)?.message ?? e)));
      return false;
    } finally {
      setSaving(false);
    }
  }, [saving]);
  return { saving, error, run, fe: (k: string) => error?.fields?.[k], clear: () => setError(null) };
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <strong>{error.status === 409 ? "Not saved — conflict." : "Not saved."}</strong> {error.message}
      {error.status === 409 && <div className="hint">Your input is kept below. Reload the record to see the latest version.</div>}
    </div>
  );
}

export function Success({ msg }: { msg: string | null }) {
  return msg ? <div className="alert success" role="status">{msg}</div> : null;
}

// ---------------------------------------------------------------- fields
export function Field(props: { label: string; error?: string; hint?: ReactNode; children: ReactNode; wide?: boolean; required?: boolean }) {
  return (
    <label className={`field ${props.wide ? "wide" : ""} ${props.error ? "has-error" : ""}`}>
      <span className="label">{props.label}{props.required && <span className="req" aria-hidden> *</span>}</span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
      {props.error && <span className="field-error">{props.error}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, empty, ...rest }: {
  value: string; onChange: (v: string) => void; options: Record<string, string> | [string, string][]; empty?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value">) {
  const opts = Array.isArray(options) ? options : Object.entries(options);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {empty !== undefined && <option value="">{empty}</option>}
      {opts.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  );
}

export function SignerField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label="Your name" required error={error} hint="Self-reported signature recorded with this change.">
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={80} autoComplete="off" />
    </Field>
  );
}

export function FormActions({ saving, onCancel, label = "Save", disabled }: { saving: boolean; onCancel?: () => void; label?: string; disabled?: boolean }) {
  return (
    <div className="form-actions">
      {onCancel && <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>}
      <button type="submit" className="btn primary" disabled={saving || disabled}>{saving ? "Saving…" : label}</button>
    </div>
  );
}

// ------------------------------------------------------------- containers
export function Overlay({ title, onClose, children, kind = "panel", subtitle }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; kind?: "panel" | "modal";
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className={`overlay ${kind}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={kind} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="overlay-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="subtitle">{subtitle}</div>}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}

export function Section({ title, count, children, actions, defaultOpen = true }: {
  title: string; count?: ReactNode; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? "open" : ""}`}>
      <div className="section-head">
        <button className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="chev">{open ? "▾" : "▸"}</span> {title} {count !== undefined && <span className="count">{count}</span>}
        </button>
        {open && actions}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status} ${INACTIVE.includes(status) ? "muted" : ""}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "ok" | "info" | "danger" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="loading" role="status">{what}…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Remembered per-browser display preference (filters/toggles only — never business data). */
export function usePref<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(`sbg.pref.${key}`); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(`sbg.pref.${key}`, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV] as const;
}
