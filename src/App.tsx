import { useEffect, useState } from "react";
import { get, post } from "./api";
import { Loading } from "./components/ui";
import { MarketplacesScreen } from "./screens/Marketplaces";
import { PricingScreen } from "./screens/Pricing";
import { RevenueScreen } from "./screens/Revenue";
import { SupplierResourcesScreen } from "./screens/SupplierResources";
import { Manual } from "./screens/Manual";

type Tab = "marketplaces" | "resources" | "pricing" | "revenue";
const TABS: [Tab, string][] = [["marketplaces", "Partners"], ["resources", "Partner Resources"], ["pricing", "Pricing"], ["revenue", "Revenue"]];

export type Nav = (tab: Tab, params?: Record<string, string>) => void;

function readUrl() {
  const u = new URLSearchParams(location.search);
  const tab = (u.get("tab") as Tab) || "marketplaces";
  u.delete("tab");
  return { tab: TABS.some(([t]) => t === tab) ? tab : "marketplaces", params: Object.fromEntries(u) as Record<string, string> };
}

const AUTH_ERRORS: Record<string, string> = {
  not_authorized: "That Google account is not approved for this site.",
  expired: "The sign-in attempt expired. Try again.",
  state: "Sign-in could not be verified. Try again.",
  cancelled: "Sign-in was cancelled.",
};

export function App() {
  const [session, setSession] = useState<{ authenticated: boolean; email?: string } | null>(null);
  const [route, setRoute] = useState(readUrl);
  const [manual, setManual] = useState(() => new URLSearchParams(location.search).get("help") === "1");

  useEffect(() => {
    get("/auth/session").then(setSession).catch(() => setSession({ authenticated: false }));
    const onUnauth = () => setSession({ authenticated: false });
    const onPop = () => setRoute(readUrl());
    window.addEventListener("sbg:unauthorized", onUnauth);
    window.addEventListener("popstate", onPop);
    return () => { window.removeEventListener("sbg:unauthorized", onUnauth); window.removeEventListener("popstate", onPop); };
  }, []);

  const nav: Nav = (tab, params = {}) => {
    const u = new URLSearchParams({ tab, ...params });
    history.pushState(null, "", `?${u}`);
    setRoute({ tab, params });
  };

  if (!session) return <Loading what="Checking sign-in" />;
  if (!session.authenticated) {
    const err = new URLSearchParams(location.search).get("auth_error");
    return (
      <div className="login">
        <div className="login-card">
          <img className="login-logo" src="data:image/png;base64,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" alt="Succulents Box" width={120} height={14} />
          <h1>SB Corporate Gifting</h1>
          <p>Private team workspace. Sign in with the approved Google account.</p>
          {err && <div className="alert error">{AUTH_ERRORS[err] ?? "Sign-in failed. Try again."}</div>}
          <a className="btn primary" href="/api/auth/login">Sign in with Google</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">SB Corporate Gifting</div>
        <nav className="tabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={route.tab === t} className={route.tab === t ? "active" : ""} onClick={() => nav(t)}>{label}</button>
          ))}
        </nav>
        <div className="account">
          <button className="btn ghost small" onClick={() => setManual(true)}>How to use</button>
          <span className="who" title="Signed-in Google login">{session.email}</span>
          <button className="btn ghost small" onClick={async () => { await post("/auth/logout").catch(() => {}); setSession({ authenticated: false }); }}>Sign out</button>
        </div>
      </header>
      <main>
        {route.tab === "marketplaces" && <MarketplacesScreen params={route.params} nav={nav} />}
        {route.tab === "resources" && <SupplierResourcesScreen params={route.params} nav={nav} />}
        {route.tab === "pricing" && <PricingScreen params={route.params} nav={nav} />}
        {route.tab === "revenue" && <RevenueScreen params={route.params} nav={nav} />}
      </main>
      {manual && <Manual onClose={() => setManual(false)} />}
    </div>
  );
}
