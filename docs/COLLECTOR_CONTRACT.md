# Corporate order reporting

The app reports corporate gifting revenue from Shopify order exports. A signed-in team member can upload an export directly, or the team's order collector can send one automatically.

Before anything leaves the computer, the export is reduced to the few order and line-item fields needed to recognise corporate orders and total their revenue. Customer names, contact details, addresses and notes are never read. The server validates each report and records every import. Repeated or older reports never overwrite newer data. Orders that later disappear from a report are kept.

Monthly totals show whether each month is fully covered by the reports received so far, so a recent import is never mistaken for complete history.

Field definitions, credentials and revenue rules are kept in the team's private operator guide.
