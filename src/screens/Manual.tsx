// "How to use this site" — the team manual, from first contact with a corporate gift partner to monthly revenue.
import type { ReactNode } from "react";
import { Overlay } from "../components/ui";
import { SB_CAPABILITY, PRODUCT_CONSTRAINTS, NOT_PROMISED } from "../format";

type Step = { id: string; title: string; where: string; body: ReactNode };

const STEPS: Step[] = [
  {
    id: "basics", title: "Before you start", where: "Everywhere",
    body: (
      <ul>
        <li><strong>Your name</strong> is asked on every save. It is your signature in the history — type your own name, even though the Google login is shared.</li>
        <li><strong>Nothing is sent from this site.</strong> Emails, calls and portal submissions happen elsewhere; here you record what happened.</li>
        <li><strong>Blank means unknown</strong>, never zero or “no”. Leave a field empty rather than guessing.</li>
        <li>Agreed prices, stage changes and removals are never erased — the history keeps every version and who did it.</li>
        <li><strong>Partners</strong> are companies that buy, sell, promote or distribute our gifts (marketplaces, gifting platforms, recognition programs, agencies, direct corporate buyers…). <strong>Product vendors</strong> supply products we sell; they are not partners.</li>
      </ul>
    ),
  },
  {
    id: "partners", title: "Partners: views, priority and stage", where: "Partners",
    body: (
      <>
        <ul>
          <li><strong>Saved views:</strong> <em>Follow-ups</em> (due or overdue next actions, without skipped or closed partners) · <em>Priority A</em> (default) · <em>Priority B</em> · <em>Active partners</em> (onboarding or live, any priority) · <em>Later</em> (priority C) · <em>Skipped / closed</em> · <em>All partners</em>. Counts follow the filters you set.</li>
          <li>Priority A and B views are grouped by <strong>primary category</strong>; due and overdue work comes first.</li>
          <li>Filter by category, channel model, stage, owner and contact readiness. Search finds names, other names and contact names.</li>
          <li><strong>Priority</strong> (A, B, C, Not assessed) and <strong>stage</strong> are independent: an active partner stays active whatever a research file says. A missing public form is not a reason for priority C.</li>
          <li><strong>Stages:</strong> Prospect → Contacted (incl. Reconnecting) → Discussing (incl. Preparing application) → Application submitted → Onboarding (Approved, Setting up listings) → Active. Closed: On hold, Declined (incl. Not qualified), Skipped, Inactive — each needs a reason.</li>
          <li><strong>Channel model</strong> (catalog/dropship, wholesale, direct purchasing, referral, employee discount, vendor directory, integration) says how we would work with them; it is separate from the pricing model on each price.</li>
          <li><strong>Contact research</strong> (“Contact needed”, “Responsible person not identified”…) is separate from relationship progress.</li>
          <li>Tick partners in the list to <em>Update category / priority / owner</em> or <em>Change stage</em>. Both show every affected record before saving.</li>
        </ul>
      </>
    ),
  },
  {
    id: "add", title: "1. Add the partner", where: "Partners → Add partner / Add in bulk / Import research",
    body: (
      <>
        <ul>
          <li><strong>One partner:</strong> <em>Add partner</em> — name, category, priority, channel models, starting stage, owner, website, opportunity summary and next action.</li>
          <li><strong>A list of partners:</strong> <em>Add in bulk</em> — paste the names (one per line), choose the type, then tick each one's stage in the table. Names already in the site are flagged; remove them before saving.</li>
          <li><strong>A research file:</strong> <em>Import research</em> — choose the CSV, then <em>Preview</em>. Each row is shown as New, Existing match, Possible duplicate, Conflicting fields, Skipped by decision or Invalid. Decide every possible duplicate (update a record, create a separate partner, or don't import), choose which conflicting values to use (existing values are kept by default), tick <em>Import as Skipped</em> with a reason where you decided not to pursue, check contact roles, then <em>Apply import</em>.</li>
          <li>Imports only add research and fill empty fields. Stages, owners, negotiated terms, prices, products, revenue, resources and tasks are never changed. Importing the same file again adds nothing. <em>Past imports</em> shows each import and can reverse it (preview first).</li>
          <li>Matching uses the record, its name and its verified other names. A similar name, a shared website or a former name is only a hint, and a shared parent company never merges records (e.g. brands of one group stay separate).</li>
          <li><strong>Provider type:</strong> <em>Marketplace</em> = a platform that sells our gifts (Demo Market Delta, Demo Market Alpha…). <em>Potential supplier opportunity</em> = a company we could supply for its own gifting projects.</li>
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
          <li>Move the stage forward: <em>Change stage</em> → <strong>Contacted</strong>, <strong>Reconnecting</strong> (former partner) or <strong>Discussing</strong>. Update the next action and its due date.</li>
          <li>Tick <strong>Contact established</strong> in the setup checklist.</li>
        </ol>
        <p className="hint">Rule of thumb: if it isn't in a communication note, the next person won't know it happened.</p>
      </>
    ),
  },
  {
    id: "people", title: "3. People, forms and applications", where: "Partner → Contacts & applications",
    body: (
      <ul>
        <li>Each person is a separate row with their <strong>role in this opportunity</strong>: Supplier sourcing / buyer, Relevant partnerships, Routing contact, Customer sales, Support, Press, Advertising only, Historical contact or Executive fallback.</li>
        <li>Record title, public business email/phone only, profile and source links, the date checked, whether the current role is verified, and the limits of what we know (“sourcing authority unconfirmed”, “hotel-partnership focus”).</li>
        <li>Historical, former and advertising-only contacts are never shown as the best contact. Customer-sales, support and press lines are routes, not buyers.</li>
        <li>Published forms, portals and inboxes go under <em>Published routes &amp; applications</em> with their purpose.</li>
      </ul>
    ),
  },
  {
    id: "requirements", title: "4. Record requirements and terms", where: "Partner → Requirements & terms → Add requirement or term / Add several",
    body: (
      <>
        <ul>
          <li>Keep the <strong>kind</strong> apart: published requirements, negotiated terms, expected ordering patterns (assumptions), unresolved questions, and SB capabilities &amp; gaps.</li>
          <li>Copy each rule from their vendor guide, application form or email: fulfillment (dispatch time, packing slip), product, customization, pricing, payment, technical. Add where it applies and whether SB meets it (meets / needs confirmation / cannot meet / not applicable).</li>
          <li>Unknown fees stay unknown — never record them as 0%.</li>
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
    id: "capability", title: "SB capability and product constraints", where: "Partner → Requirements & terms; Products & pricing",
    body: (
      <>
        <p><strong>{SB_CAPABILITY}</strong></p>
        <p>No MOQ exception or purchasing commitment is a prerequisite. Bulk pricing is a separate matter from what SB can fulfill.</p>
        <ul>{PRODUCT_CONSTRAINTS.map(([k, v]) => <li key={k}><strong>{k}:</strong> {v}</li>)}</ul>
        <p className="hint">{NOT_PROMISED} Products are never proposed automatically, and prices or terms are never assumed.</p>
      </>
    ),
  },
  {
    id: "terms", title: "5. Record the common agreement terms", where: "Partner → Requirements & terms → Common agreement terms → Edit",
    body: (
      <ul>
        <li>Terms that apply to every gift with this partner: payment terms, shipping responsibility, fees and fee basis, dispatch requirement, corporate MOQ and notes.</li>
        <li>Gift-specific exceptions go on the price record instead (step 7).</li>
        <li>Unspecified terms stay blank — entering a price does not mean the contract is fully recorded.</li>
      </ul>
    ),
  },
  {
    id: "gifts", title: "6. Choose and propose gifts", where: "Pricing → Gifts & collections, then Partner → Proposed products",
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
          <li>A declined product never changes the partner's stage.</li>
        </ul>
      </>
    ),
  },
  {
    id: "pricing", title: "7. Agree the price", where: "Pricing → Add pricing record / Import pricing file",
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
    id: "live", title: "8. Approval and going live", where: "Partner → Change stage, Setup checklist",
    body: (
      <ol>
        <li>Application sent → stage <strong>Application submitted</strong> (log it in communication notes).</li>
        <li>Account approved → stage <strong>Onboarding · Approved</strong>, tick <strong>Account approved</strong>.</li>
        <li>Building listings → stage <strong>Onboarding · Setting up listings</strong>; add listing URLs to approved proposals.</li>
        <li>Gifts visible to their customers → stage <strong>Active</strong>, tick <strong>Listings live</strong>.</li>
      </ol>
    ),
  },
  {
    id: "revenue", title: "9. Track revenue", where: "Revenue",
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
    id: "ongoing", title: "10. Keep it up to date", where: "Routine",
    body: (
      <>
        <p><strong>After every contact:</strong> communication note + stage / next action / checklist / requirement update.</p>
        <p><strong>Weekly:</strong></p>
        <ul>
          <li>Partners → <em>Follow-ups</em>: work through overdue and due next actions; give every A and B partner a next action and due date.</li>
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
    id: "pause", title: "11. Pausing, skipping, ending or restarting", where: "Partner → Change stage / Reactivate",
    body: (
      <ul>
        <li>Choose <strong>On hold, Declined, Not qualified, Skipped</strong> or <strong>Inactive</strong> — a reason is required (fulfillment requirement, insurance / compliance requirement, pricing or margin, product fit, application rejected, no current demand, partnership paused, other) with a short explanation, e.g. “Requires $X general liability insurance; not pursuing”.</li>
        <li><strong>Skipped</strong> = we decided not to pursue. The record and its history stay; it moves to <em>Skipped / closed</em> and is left out of Priority views, follow-ups and task suggestions. Other partners in the same category are not affected.</li>
        <li>Open tasks for a closed partner are listed on its record for you to reconcile — they are never marked done automatically.</li>
        <li><strong>Reactivate</strong> keeps every checklist step, price, note and revenue record — nothing is reset.</li>
        <li>To end one gift price, use <em>Expire</em> on the active price (Pricing).</li>
      </ul>
    ),
  },
];

const QUICK: [string, string][] = [
  ["Found a new partner", "Add partner (Prospect), set category, priority and next action"],
  ["Emailed / called them", "Communication note → stage Contacted or Discussing → tick Contact established"],
  ["Got a research file", "Import research → Preview → decide duplicates and conflicts → Apply"],
  ["Got their vendor guide", "Requirements → Add several (Unverified)"],
  ["They confirmed a rule", "Edit the requirement → Confirmed"],
  ["Sent our gift list", "Propose several → status Submitted + date"],
  ["They accepted a price", "Pricing record → Agreed → Activate with start date"],
  ["They changed a price", "Revise price (new version)"],
  ["Account approved / listings up", "Stage Approved → Setting up listings → Active; tick checklist"],
  ["First order came in", "Revenue → add a matching rule for the partner"],
  ["They charged fees", "Revenue → manual entry (marketplace fee, with statement reference)"],
  ["Partnership paused", "Change stage → On hold + reason + revisit date"],
  ["Decided not to pursue", "Change stage → Skipped + reason; reconcile its open tasks"],
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
