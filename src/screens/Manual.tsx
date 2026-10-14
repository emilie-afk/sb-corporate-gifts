// "How to use this site" — the team manual, from first contact with a corporate gift partner to monthly revenue.
import type { ReactNode } from "react";
import { Overlay } from "../components/ui";

type Step = { id: string; title: string; where: string; body: ReactNode };

const STEPS: Step[] = [
  {
    id: "basics", title: "Before you start", where: "Everywhere",
    body: (
      <ul>
        <li><strong>Your name</strong> is asked on every save. It is your signature in the history — type your own name, even though the Google login is shared.</li>
        <li><strong>Nothing is sent from this site.</strong> Emails, calls and portal submissions happen elsewhere; here you record what happened.</li>
        <li><strong>Blank means unknown</strong>, never zero or “no”. Leave a field empty rather than guessing.</li>
        <li>Agreed prices, status changes and removals are never erased — the history keeps every version and who did it.</li>
      </ul>
    ),
  },
  {
    id: "add", title: "1. Add the partner", where: "Marketplaces → Add marketplace / Add in bulk",
    body: (
      <>
        <ul>
          <li><strong>One partner:</strong> <em>Add marketplace</em> — name, provider type, starting status, contact, website, vendor portal, priority, the first action to take and a short description.</li>
          <li><strong>A list of partners:</strong> <em>Add in bulk</em> — paste the names (one per line), choose the type, then tick each one's status in the table. Names already in the site are flagged; remove them before saving.</li>
          <li><strong>Provider type:</strong> <em>Marketplace</em> = a platform that sells our gifts (Goody, Reachdesk…). <em>Potential supplier opportunity</em> = a company we could supply for its own gifting projects.</li>
        </ul>
        <p className="hint">Every new partner gets the 6-step setup checklist automatically. Add contact details later from the record (<em>Edit details</em>).</p>
      </>
    ),
  },
  {
    id: "contact", title: "2. Make contact and log every touchpoint", where: "Open the partner → Communication notes → Add communication",
    body: (
      <>
        <ol>
          <li>Contact the partner by email, phone, meeting or their vendor portal — outside this site.</li>
          <li>Straight after, add a <strong>communication note</strong>: date, method, contact name, a short summary of what was said or agreed, and a reference link (email thread, portal page) if there is one.</li>
          <li>Move the status forward: <em>Change status</em> → <strong>Reconnecting</strong> (former partner) or <strong>In discussion</strong>.</li>
          <li>Tick <strong>Contact established</strong> in the setup checklist.</li>
        </ol>
        <p className="hint">Rule of thumb: if it isn't in a communication note, the next person won't know it happened.</p>
      </>
    ),
  },
  {
    id: "requirements", title: "3. Record their requirements", where: "Partner → Requirements → Add requirement / Add several",
    body: (
      <>
        <ul>
          <li>Copy each rule from their vendor guide, application form or email: fulfillment (dispatch time, packing slip), product, customization, pricing, payment, technical.</li>
          <li><em>Add several</em>: paste one requirement per line, pick a category, adjust per line, add the source link once.</li>
          <li>Write <strong>our response</strong> to each (can we meet it, how).</li>
          <li><strong>Confirmation state:</strong> <em>Unverified</em> (from research) → <em>Awaiting clarification</em> (asked them) → <em>Confirmed</em> (they confirmed; your name is recorded).</li>
          <li>When all key requirements are confirmed, tick <strong>Requirements confirmed</strong> in the checklist.</li>
        </ul>
        <p className="hint">“Not publicly available” is a valid researched note — it is not proof that no requirement exists.</p>
      </>
    ),
  },
  {
    id: "terms", title: "4. Record the common agreement terms", where: "Partner → Common agreement terms → Edit",
    body: (
      <ul>
        <li>Terms that apply to every gift with this partner: payment terms, shipping responsibility, fees and fee basis, dispatch requirement, corporate MOQ and notes.</li>
        <li>Gift-specific exceptions go on the price record instead (step 6).</li>
        <li>Unspecified terms stay blank — entering a price does not mean the contract is fully recorded.</li>
      </ul>
    ),
  },
  {
    id: "gifts", title: "5. Choose and propose gifts", where: "Pricing → Gifts & collections, then Partner → Proposed products",
    body: (
      <>
        <ol>
          <li><strong>Prepare the gifts</strong> (once): <em>Pricing → Refresh website products</em> keeps names, variants and retail prices current. In <em>Gifts &amp; collections</em> tick <strong>Selected for use in this dashboard</strong> and set the internal family (Live to Give box, arrangement, pots…), card eligibility and fulfillment details.</li>
          <li><strong>Propose to the partner</strong>: <em>Propose product</em> for one gift, or <em>Propose several</em> to add a whole <strong>gift category</strong>, a pasted <strong>succulentsbox.com/collections/…</strong> link, or gifts picked one by one. Untick any you don't want and set the offer type per gift.</li>
          <li>Update each proposal as it moves: <strong>Proposed → Submitted</strong> (add the submission date) <strong>→ Approved</strong> (add the listing URL) or <strong>Declined / Withdrawn</strong> (add a note).</li>
          <li>Tick <strong>Products selected</strong> in the checklist.</li>
        </ol>
        <ul>
          <li><strong>Offer types:</strong> Individual gift (ships to one recipient), Bulk customized offer, Bulk offer.</li>
          <li><strong>Custom pots</strong> are available on their own, or with succulents as a complete gift. Pots with succulents are <strong>bulk orders only</strong> — individual recipient shipping is unavailable, so the site won't let you propose or price them as individual.</li>
          <li>A declined product never changes the partner's status.</li>
        </ul>
      </>
    ),
  },
  {
    id: "pricing", title: "6. Agree the price", where: "Pricing → Add pricing record / Import pricing file",
    body: (
      <>
        <ol>
          <li><em>Add pricing record</em> → channel + gift. Website retail price and Product Master cost fill in by themselves — don't retype them.</li>
          <li>Choose <strong>how the partner pays SB</strong>:
            <ul>
              <li><strong>Fixed supplier price</strong> — SB receives the agreed amount per gift; nothing is deducted.</li>
              <li><strong>Commission-based</strong> — their selling price minus commission % and/or fee. Blank commission means not specified (not 0%).</li>
              <li><strong>Other / custom terms</strong> — agreed price plus a written explanation.</li>
            </ul>
            The form shows what SB receives per gift.
          </li>
          <li>Status: <strong>Draft → Proposed</strong> (sent to the partner) <strong>→ Agreed</strong> (they accepted; enter who approved) <strong>→ Activate</strong> with the start date when it takes effect.</li>
          <li>Agreed prices can't be edited. To renegotiate use <strong>Revise price</strong> — a new dated version; the old one stays in the price history.</li>
          <li>Partner sent a price list? <em>Import pricing file</em> (.xlsx or .csv, any layout): choose the worksheet, confirm what each column means, pick the pricing model, review every row, save.</li>
          <li>Tick <strong>Pricing agreed</strong> in the checklist.</li>
        </ol>
        <p className="hint">A missing or wrong retail price or cost? Tick “Enter a manual value instead” and give the amount, reason, source and date.</p>
      </>
    ),
  },
  {
    id: "live", title: "7. Approval and going live", where: "Partner → Change status, Setup checklist",
    body: (
      <ol>
        <li>Application sent → status <strong>Application submitted</strong> (log it in communication notes).</li>
        <li>Account approved → status <strong>Approved</strong>, tick <strong>Account approved</strong>.</li>
        <li>Building listings → status <strong>Setting up listings</strong>; add listing URLs to approved proposals.</li>
        <li>Gifts visible to their customers → status <strong>Live</strong>, tick <strong>Listings live</strong>.</li>
      </ol>
    ),
  },
  {
    id: "revenue", title: "8. Track revenue", where: "Revenue",
    body: (
      <>
        <ul>
          <li><strong>Shopify orders arrive automatically</strong> every Monday from the GP collector (last 8 weeks). <em>Upload Shopify report</em> is the manual fallback, e.g. for older months.</li>
          <li>New orders are <em>Unclassified</em> (ordinary retail) until a <strong>matching rule</strong> assigns them: <em>Shopify matching rules → Add rule</em> → channel + field (order source, tag or billing company) + value → <em>Preview impact</em> → <em>Confirm and apply</em>. Set this up once per partner when their first order arrives.</li>
          <li>Single orders can be assigned or excluded by hand in <em>Orders &amp; classification</em> (reason required).</li>
          <li><strong>Manual entries</strong>: sales that never went through Shopify, corrections and the partner's actual fees from their statement — always with a reference and reason.</li>
          <li>Older monthly totals typed before the Shopify import show <strong>Needs review</strong>: mark each as <em>Additional off-Shopify revenue</em> or <em>Already covered by Shopify</em>.</li>
        </ul>
        <p className="hint">“Revenue after marketplace fees” is not gross profit. Fees show “Fees not recorded” until an actual fee is entered.</p>
      </>
    ),
  },
  {
    id: "ongoing", title: "9. Keep it up to date", where: "Routine",
    body: (
      <>
        <p><strong>After every contact:</strong> communication note + status / checklist / requirement update.</p>
        <p><strong>Weekly:</strong></p>
        <ul>
          <li>Marketplaces list: scan <em>Last communication</em> — follow up on anyone quiet for too long.</li>
          <li>Proposed products: update submitted ones that were approved or declined.</li>
          <li>Revenue: check the latest import arrived (coverage line) and resolve any <strong>conflicts</strong>.</li>
        </ul>
        <p><strong>Monthly:</strong></p>
        <ul>
          <li>Refresh website products and Product Master costs (Pricing); review agreed prices where cost or retail moved (“when agreed” vs “current”).</li>
          <li>Enter partner fee statements and off-Shopify sales; reconcile <em>Needs review</em> totals.</li>
        </ul>
      </>
    ),
  },
  {
    id: "pause", title: "10. Pausing, ending or restarting", where: "Partner → Change status / Reactivate",
    body: (
      <ul>
        <li>Choose <strong>On hold, Rejected, Not qualified</strong> or <strong>Inactive</strong> — a reason is required (fulfillment requirement, pricing or margin, product fit, application rejected, no current demand, partnership paused, other). Add the unmet requirement, what would need to change and an optional revisit date.</li>
        <li>Inactive partners are hidden from the default list; tick <em>Show inactive marketplaces</em> to see them.</li>
        <li><strong>Reactivate</strong> keeps every checklist step, price, note and revenue record — nothing is reset.</li>
        <li>To end one gift price, use <em>Expire</em> on the active price (Pricing).</li>
      </ul>
    ),
  },
];

const QUICK: [string, string][] = [
  ["Found a new partner", "Add marketplace (Prospect)"],
  ["Emailed / called them", "Communication note → status In discussion → tick Contact established"],
  ["Got their vendor guide", "Requirements → Add several (Unverified)"],
  ["They confirmed a rule", "Edit the requirement → Confirmed"],
  ["Sent our gift list", "Propose several → status Submitted + date"],
  ["They accepted a price", "Pricing record → Agreed → Activate with start date"],
  ["They changed a price", "Revise price (new version)"],
  ["Account approved / listings up", "Status Approved → Setting up listings → Live; tick checklist"],
  ["First order came in", "Revenue → add a matching rule for the partner"],
  ["They charged fees", "Revenue → manual entry (marketplace fee, with statement reference)"],
  ["Partnership paused", "Change status → On hold + reason + revisit date"],
];

export function Manual({ onClose }: { onClose: () => void }) {
  const jump = (id: string) => document.getElementById(`manual-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const body: ReactNode = (
    <div className="manual">
      <p>From finding a corporate gift partner to tracking their revenue — the order the team works in.</p>
      <nav className="manual-toc" aria-label="Manual contents">
        {STEPS.map((s) => <button key={s.id} className="btn ghost small" onClick={() => jump(s.id)}>{s.title}</button>)}
        <button className="btn ghost small" onClick={() => jump("quick")}>Quick reference</button>
      </nav>
      {STEPS.map((s) => (
        <section key={s.id} id={`manual-${s.id}`} className="manual-step">
          <h3>{s.title}</h3>
          <div className="manual-where">Where: {s.where}</div>
          {s.body}
        </section>
      ))}
      <section id="manual-quick" className="manual-step">
        <h3>Quick reference — when this happens, do this</h3>
        <table className="table compact">
          <thead><tr><th>When…</th><th>Do this in the site</th></tr></thead>
          <tbody>{QUICK.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
  return <Overlay title="How to use this site" subtitle="Working with a corporate gift partner, start to finish" onClose={onClose}>{body}</Overlay>;
}
