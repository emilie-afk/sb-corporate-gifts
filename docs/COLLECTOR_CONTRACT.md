# Corporate gifting — Shopify order ingestion contract (`sbcg-orders-v1`)

Status: **implemented in this app; NOT yet connected to the GP collector.** Connecting it needs a small,
separately reviewed change in the GP repository (proposed below). Nothing in the GP engine, its Worker
contract or its schedule was modified.

## Why a separate payload

The GP collector (`sb-gross-profit`, `automation/shopify-export`) uploads a sanitized orders CSV to the GP
Worker. That sanitization (`shared/adapters/shopifyCsv.js`, `shopifyPrivacy.js`) is designed for the GP engine:

- **Tags** are reduced to an approved list (`free sample`, `sample`, `influencer`, `prepaid`, `subscription…`).
  Corporate tags such as a partner name are removed.
- **Source** must be on an approved list of channel/app ids, otherwise the export is refused.
- **Billing company**, names, emails, addresses, phones, notes and discount codes are dropped.

So the GP upload cannot identify partner-style corporate orders, and widening it would change the GP
data contract. Instead, the collector would build a **second, minimal payload** from the same in-memory raw
export, before the raw bytes are zeroed, and send it here. No second Shopify download, browser, schedule or
Shopify app.

## Endpoint

```
POST https://<site>/api/ingest/shopify-orders
Authorization: Bearer <CORPORATE_INGEST_SECRET>
Content-Type: application/json
```

- `CORPORATE_INGEST_SECRET`: ≥ 32 random characters, set privately in Netlify (Functions scope) and stored on
  the collector PC in Windows Credential Manager (proposed target name `sb-corporate-ingest`). It is **not** the
  shared Google login. When the variable is missing the endpoint answers `503 ingest_disabled`.
- Body ≤ 6 MB (Netlify synchronous function limit). An 8-week rolling export reduces to well under that.
- Responses contain **counts only** (no order details), e.g.
  `{"ok":true,"status":"completed","import_id":"…","received":3137,"new":40,"updated":12,"unchanged":3085,"stale":0,"rejected":0,"warnings":2}`.
  `status` is `completed`, `no_change` or `duplicate`. Errors: `401 unauthorized`, `400 payload_rejected` (with
  JSON paths only — never values), `413 too_large`, `503 ingest_disabled`.

## Payload

```jsonc
{
  "format": "sbcg-orders-v1",
  "store": "succulentsbox",
  "exportedAt": "2026-10-12T07:20:00.000Z",   // when the export was generated/downloaded (snapshot time)
  "coverageFrom": "2026-08-17",                // the export's order-date filter, America/Los_Angeles
  "coverageTo": "2026-10-11",
  "fileName": null,                            // optional
  "fields": ["source", "tags", "billing_company"], // classification fields present in this export
  "orders": [{
    "id": "9000000001",              // Shopify numeric Id when exported (kept for reference)
    "name": "#910001",               // canonical key with "store"
    "createdAt": "2026-09-03 09:00:00 -0700",
    "cancelledAt": null, "financialStatus": "paid", "currency": "USD",
    "subtotal": "282.00", "shipping": "0.00", "taxes": "22.40", "duties": null, "total": "304.40",
    "discountAmount": "20.00", "refundedAmount": "0.00",
    "source": "web", "tags": ["Corporate", "bravo"], "billingCompany": "Bravo Gifting LLC",
    "lines": [{ "sku": "SYN-THANKS-S", "name": "Live to Give Thank You Box - Simple", "quantity": 10, "price": "30.00", "discount": "20.00" }]
  }]
}
```

Build it with `shared/corporateOrders.js` (dependency-free ES module):
`prepareCorporateOrdersPayload(rawRows, { headers, exportedAt, coverageFrom, coverageTo })`.

**Columns read** (everything else in the Shopify export is never touched): Name, Id, Created at, Cancelled at,
Financial Status, Currency, Subtotal, Shipping, Taxes, Duties, Total, Discount Amount, Refunded Amount, Source,
Tags, Billing Company, Lineitem name/price/quantity/sku/discount.

**Privacy rules enforced by the server** (whole payload rejected on any violation, recorded as a failed import):
exact key allowlist at payload/order/line level; tags, source, billing company and line titles must not look like
an email, URL or phone number (same patterns as the GP collector's `looksPersonal`); string length limits;
≤ 20,000 orders. The reducer drops personal-looking tags/companies before upload.

## Import semantics (same code path for the collector and the manual upload)

- **Canonical order** = store + Shopify order Name. One row per order; line-item rows are grouped; order-level
  money columns are read once (Shopify writes them on the first line row), never summed across lines.
- **Exact duplicate** (same orders + coverage, regardless of export time): recorded as `duplicate`, no writes.
- **Chronology:** an order is updated only by a report whose `exportedAt` is newer than the stored snapshot.
  Older reports never overwrite newer data (`stale`); a different order with the *same* export time is flagged
  "chronology uncertain" and not applied. Manual uploads use a declared export time and are labelled as such.
- **Missing orders** in a later report are never deleted.
- **Failures** (validation, database) leave stored orders untouched; the run is recorded with its error.
- Each run records: import id, payload SHA-256, source, coverage, export time, start/completion, received / new /
  updated / unchanged / stale / rejected counts, warnings and errors.

## Revenue treatment

| Field | Treatment |
|---|---|
| Subtotal | Line items after all discounts (line + order level). Gift sales = Subtotal − excluded lines. |
| Discount Amount | Informational; already inside Subtotal; never subtracted again. |
| Shipping | Shipping revenue (as charged). |
| Taxes, Duties | Excluded (pass-through). |
| Route protection lines (`ROUTEINS…` / "Shipping Protection by Route") | Excluded (customer-funded pass-through, as in GP). |
| Gift-card purchases (SKU `GC…`) | Excluded (not gift revenue; same SKU rule as GP). |
| Refunded Amount | Cumulative, order level. Deducted up to gift sales + shipping; any excess (tax / Route refund) is not deducted and is flagged. Attributed to the **order's month** (the export has no refund-event dates). A later report with a bigger refund updates that month. |
| Cancelled orders | Kept as records, excluded from totals (GP excludes cancelled orders too); flagged if an unrefunded amount remains. |
| Financial status `voided` | Excluded. |
| `pending` / `authorized` / `partially_paid` / `unpaid` | Counted (GP does not filter by payment status) and flagged "awaiting payment" — team decision welcome. |
| Units | Σ line quantities of gift lines = sellable gift units (a 10-pack counts as 1 unit). |
| Month | `Created at` converted to America/Los_Angeles. |

Net revenue = gift sales + shipping − refunds applied. Shopify amounts are treated as what Succulents Box earns
(confirmed by the team); no marketplace margin is subtracted. Marketplace fees are separate, manual, actual.

## Proposed GP collector change (not applied — needs review/authorization in the GP repo)

In `automation/shopify-export/src/collect.mjs`, step 5, right after `prepareShopifyExport(...)` and **before**
`file.body.fill(0)`:

```js
import { parseCsvObjects, prepareCorporateOrdersPayload } from './corporateOrders.mjs'; // copy of shared/corporateOrders.js
// …
const { headers, rows } = parseCsvObjects(file.body.toString('utf8'));
const corp = prepareCorporateOrdersPayload(rows, { headers, exportedAt, coverageFrom: win.from, coverageTo: win.to });
file.body.fill(0); file = null;
// after the GP upload succeeded or failed — independent, never blocks the GP run:
if (!corp.refused && config.corporateIngestUrl) {
  const secret = await readCredential('sb-corporate-ingest');           // Windows Credential Manager
  try { await fetch(config.corporateIngestUrl, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(corp.payload) }); }
  catch { manifest.corporate = 'upload_failed'; }                        // logged as a status code only
}
```

- Same rolling window and schedule as today (verified in the repo: `rollingWindow()` = 56 days ending on the
  reporting Sunday, plus ≤ 10 boundary-spill orders; Windows task Monday 14:05 ICT on the Free-tier path,
  15:05 on the csv_text path, with catch-up triggers). No new scheduled task.
- No raw data is written to disk; only the reduced payload is sent; the collector manifest records counts/status.
- Must stay independent: a corporate upload failure never changes the GP exit code or GP data.

## Coverage and history

The app keeps every imported order permanently, so history accumulates beyond the 8-week window. Month
coverage is computed from the union of successful report coverage ranges; a month is **partial** unless every
day is covered. A recent import does not prove complete history. **Limitation:** refunds/cancellations on
orders older than the rolling window are not seen automatically — run a wider Shopify export and use
**Revenue → Upload Shopify report** to backfill (it uses the same import logic).
