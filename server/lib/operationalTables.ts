// Every table that holds the team's operational records, in foreign-key-safe order.
// Used by the private export/import and by the demo-data guard. Bookkeeping tables (schema_migrations,
// rate_limits, slack_scan_state with its one row per channel) are not operational data.
export const OPERATIONAL_TABLES = [
  "channels", "marketplaces", "status_history", "setup_milestones", "requirements", "communications",
  "products", "collection_references", "product_collections", "marketplace_products",
  "source_mappings", "gift_source_links", "import_runs", "cost_snapshots",
  "pricing_import_batches", "pricing_records", "monthly_revenue", "match_rules",
  "shopify_import_runs", "shopify_orders", "revenue_adjustments",
  "vendors", "corporate_actions", "supplier_resources", "sample_requests", "review_items", "slack_findings", "slack_messages",
  "corporate_task_requests",
  "audit_events",
] as const;

/** Transient per-run staging rows; not exported, but their presence still means the database is in use. */
export const TRANSIENT_TABLES = ["import_run_items"] as const;
