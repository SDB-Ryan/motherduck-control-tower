# Changelog — Manifest Sync

## 2026-06-16 · Initial public release
Catalog-driven graph sync: parses every deployed dive/flight's `@manifest`,
materializes `ct_objects`/`ct_edges`/`ct_issues`/`ct_sync_ledger` atomically per
run, derives the warehouse + share nodes from the catalog, and flags missing/
invalid manifests and schedule drift in `ct_issues`. Runs as a Flight or as a
plain local script (duckdb ≥ 1.5.3) on plans without Flights.
