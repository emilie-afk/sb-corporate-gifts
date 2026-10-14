# Team guide — pricing and revenue (short)

Every save asks for **Your name** — a self-reported signature. The shared Google login only controls access.

## Adding marketplaces in bulk

1. **Marketplaces → Add in bulk.** Paste the names, one per line (a spreadsheet column works; bullets and
   numbers are removed). Choose the provider type for all of them.
2. **Next: choose statuses.** Tick one status per name (default Prospect), or tick a column heading to set it for
   everyone. Change the type per name if needed. Names that already exist or are repeated are flagged —
   **Remove them** before saving.
3. Enter your name and **Add**. Each record gets the default setup milestones; add contacts and details later
   from the record. On hold / Rejected / Not qualified / Inactive need a reason, so set those afterwards.

## Pricing

1. **Pricing → Add pricing record.** Pick the channel and the gift/variant.
2. The form fills in, read-only: the **website retail price** (from the last website refresh), the **Product
   Master gift cost** (with cost basis, pack quantity and what it already includes) and the channel's defaults
   (MOQ, discount, terms). Don't retype them.
3. Choose **how this marketplace pays SB**. Only that model's fields are shown and required (and only once the
   price is agreed):
   - **Fixed supplier price** — SB receives the agreed supplier price per gift. Nothing is deducted from it; commission
     and fee fields don't apply. The marketplace's own selling price can be noted for reference.
   - **Commission-based** — marketplace selling price, what the commission is calculated on (selling price, SB
     retail price or other), commission % and/or fixed fee. Blank commission = **not specified**, never 0% (enter 0
     if there is none). The form shows what SB receives, e.g. $40.00 − 15% = $34.00.
   - **Other / custom terms** — the agreed price plus a written explanation. Nothing is calculated automatically.
   The Direct website always uses *Direct sale* (the agreed customer price).
4. Also enter customer shipping charge, status and effective dates. Everything else is under **More details**.
5. If a retail price or cost is missing or wrong, tick **Enter a manual value instead** and give the amount,
   reason, source and date. It is shown as **Manual**. Blank always means unknown — never $0.
6. **Direct website** shows a *suggested* price = retail × (1 − 20%). It is only stored if you save it as the
   agreed customer price, and it never affects marketplace prices.
7. Agreed/active prices can't be edited. Use **Revise price** for a new dated version; the old one and its
   snapshot (retail, cost, terms at the time) stay in **View price history**.
8. Refreshing website products or Product Master costs never changes an agreed price; the price view shows
   "when agreed" next to "current" so you can decide whether to renegotiate.
9. Older prices entered before pricing models show **Model not specified**; choose a model when you revise them.

**Custom pots:** sold on their own (no plants), or with succulents as a complete gift. Pots with succulents are
bulk orders only — individual recipient shipping is unavailable, so individual and separate-address formats can't
be priced or proposed.

## Pricing file import (optional — .xlsx or .csv, any layout)

1. **Pricing → Import pricing file.** Upload the marketplace's own price list or your sheet as it is. The
   **template** download is only a convenience; its commission and fee columns are optional.
2. **Where the data is:** for Excel, pick the worksheet. The header row is found automatically (title rows above
   it are fine); change it if needed.
3. **For the whole file:** choose the channel (unless the file has a channel column), the **pricing model**, the
   commission basis for commission-based files, the fulfillment format and the status (default Draft).
4. **What each column means:** suggestions are marked (e.g. "Wholesale price", "Vendor price", "Net price" →
   *Agreed supplier price (SB receives)*; "Selling price" → *Marketplace selling price*). A column called just
   "Price", "Cost" or "MSRP" is never assumed — choose its meaning or ignore it. **Apply and re-check rows.**
5. **Review rows:** each row shows the interpreted price, what SB receives and the terms, plus *New price*,
   *Update draft*, *New version*, *No change* or *Error*. Change a row's pricing model if it differs from the file.
   Gifts are matched by **Shopify variant ID** or exact **SKU** only — choose the gift for ambiguous or unmatched rows.
   A fixed supplier price with a commission in the same row is rejected (it would be deducted twice).
6. For agreed/active prices tick **Create new version**. Select rows, enter your name, **Save selected rows**.
   Re-uploading the same rows creates nothing new.
7. Plain values only (no formulas, no macros); blank = unknown. Optional retail/cost override columns are stored
   as **manual** values with the file as their source; they never change Shopify or Product Master.

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
