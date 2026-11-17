import { useEffect, useState } from "react";
import { get, post } from "./api";
import { Loading } from "./components/ui";
import { MarketplacesScreen } from "./screens/Marketplaces";
import { PricingScreen } from "./screens/Pricing";
import { RevenueScreen } from "./screens/Revenue";
import { Manual } from "./screens/Manual";

type Tab = "marketplaces" | "pricing" | "revenue";
const TABS: [Tab, string][] = [["marketplaces", "Marketplaces"], ["pricing", "Pricing"], ["revenue", "Revenue"]];

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
        {route.tab === "pricing" && <PricingScreen params={route.params} nav={nav} />}
        {route.tab === "revenue" && <RevenueScreen params={route.params} nav={nav} />}
      </main>
      {manual && <Manual onClose={() => setManual(false)} />}
    </div>
  );
}
