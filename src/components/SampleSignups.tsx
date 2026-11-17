import { useEffect, useState } from "react";
import { get } from "../api";

/** All-time corporate sample box signups (count only; the signups themselves stay in Google Sheets). */
export function SampleSignups() {
  const [state, setState] = useState<{ count: number } | "loading" | "unavailable">("loading");
  useEffect(() => {
    let active = true;
    get<{ count: number }>("/sample-signups")
      .then((r) => { if (active) setState(Number.isInteger(r?.count) && r.count >= 0 ? { count: r.count } : "unavailable"); })
      .catch(() => { if (active) setState("unavailable"); });
    return () => { active = false; };
  }, []);
  return (
    <span className="hint sample-signups" aria-label="Sample box signups" aria-live="polite">
      Sample box signups:{" "}
      {state === "loading" ? "…" : state === "unavailable" ? "Signup count unavailable" : <><strong>{state.count.toLocaleString("en-US")}</strong> all-time</>}
    </span>
  );
}
