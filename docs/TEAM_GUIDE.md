# Team guide — pricing and revenue (short)

Every save asks for **Your name** — a self-reported signature. The shared Google login only controls access.

## Pricing

1. **Pricing → Add pricing record.** Pick the channel and the gift/variant.
2. The form fills in, read-only: the **website retail price** (from the last website refresh), the **Product
   Master gift cost** (with cost basis, pack quantity and what it already includes) and the channel's defaults
   (MOQ, discount, terms). Don't retype them.
3. Enter only what you negotiate: proposed supplier price, agreed selling price, customer shipping charge,
   marketplace fees (commission % and/or fixed fee), status and effective dates. Everything else is under
   **More details**.
4. If a retail price or cost is missing or wrong, tick **Enter a manual value instead** and give the amount,
   reason, source and date. It is shown as **Manual**. Blank always means unknown — never $0.
5. **Direct website** shows a *suggested* price = retail × (1 − 20%). It is only stored if you save it as the
   agreed price, and it never affects marketplace prices.
6. Agreed/active prices can't be edited. Use **Revise price** for a new dated version; the old one and its
   snapshot (retail, cost, terms at the time) stay in **View price history**.
7. Refreshing website products or Product Master costs never changes an agreed price; the price view shows
   "when agreed" next to "current" so you can decide whether to renegotiate.

**Custom pots:** sold on their own (no plants), or with succulents as a complete gift. Pots with succulents are
bulk orders only — individual recipient shipping is unavailable, so individual and separate-address formats can't
be priced or proposed.

## Excel pricing import (optional)

1. **Pricing → Import pricing Excel → Download the .xlsx template.** One row per channel + gift/variant +
   fulfillment format. Identify gifts by **Shopify variant ID** (best) or exact **SKU** — the name column is for
   your reference only.
2. Type plain values (no formulas, no macros). Leave a cell blank when unknown.
3. Upload. Check the preview: *New price*, *Update draft*, *New version*, *No change* or *Error*. Choose the gift
   for any ambiguous or unmatched row. For agreed/active prices tick **Create new version** to make a new version.
4. Select the rows, enter your name, **Save selected rows**. Re-uploading the same file creates nothing new.
5. Optional retail/cost override columns are stored as **manual** values with the file as their source; they
   never change Shopify or Product Master.

## Shopify matching rules (Revenue → Shopify matching rules)

- Orders arrive from the collector (or **Upload Shopify report**) as *Unclassified* — ordinary retail by default.
- **Add rule:** channel + field (only fields present in the reports: order source, tags, billing company) +
  *exact match* or *contains* + value. Case and spaces don't matter.
- **Preview impact** shows matching orders, orders that would move, conflicts and months affected. Nothing
  changes until you enter your name and **Confirm and apply**.
- Several rules may point to the same channel. If an order matches rules for **different** channels it becomes
  a **Conflict** and is not counted for any channel until you fix the rules or assign it manually.
- **Orders & classification:** assign an order to a channel, exclude it as ordinary retail, or clear your
  decision (back to rules). A reason is required; manual decisions win over rules until cleared.

## Revenue review (monthly)

1. Check the **coverage** line and month flags: a month is complete only when Shopify reports cover every day.
2. Resolve **conflicts** first (they are excluded from every channel).
3. **Manual entries & reconciliation:** older monthly totals typed before the Shopify import show **Needs review**
   and are left out. Mark each one *Additional off-Shopify revenue* or *Already covered by Shopify* with a note.
4. Add **manual entries** only for off-Shopify sales, explicit corrections (may be negative) or **actual
   marketplace fees** from a statement — always with a reference (invoice/statement/order ID) and reason. Void
   mistakes (history is kept).
5. Read the table: From Shopify + Manual = Combined. Fees show *Fees not recorded* until an actual fee is
   entered. "Revenue after marketplace fees" is **not** gross profit.
6. Refunds on orders older than the collector's 8-week window: export a wider date range from Shopify and use
   **Upload Shopify report**.
