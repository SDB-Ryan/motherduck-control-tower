# Changelog — Manifest Sync

## 2026-06-20 · Hidden objects
The sync reads a `ct_hidden` table (`object_key`, `reason`) and skips those objects
entirely — no node and no issue. `ct_hidden` is created with `CREATE TABLE IF NOT
EXISTS` and persists across runs (only `ct_objects`/`ct_edges`/`ct_issues` are
rebuilt each run), so hiding is durable.

## 2026-06-19 · Run-history health
Flight health now comes from the platform's run history instead of a data ledger:
the sync reads each flight's latest run via `MD_LIST_FLIGHT_RUNS` and writes
`last_run_ts` / `last_run_status` (with the `RUN_STATUS_` prefix stripped) into
`ct_objects`, plus an opt-in `stale_hours` manifest field. This fixes per-record
audit tables reading as job health and quiet-period false "stale". Added `pytz`
to `requirements.txt` (`MD_LIST_FLIGHT_RUNS` imports it internally in the bare
flight container). `ct_objects` gains three columns — the table is rebuilt with
`CREATE OR REPLACE` each run, so the next sync migrates it with no manual ALTER.

## 2026-06-16 · Initial public release
Catalog-driven graph sync: parses every deployed dive/flight's `@manifest`,
materializes `ct_objects`/`ct_edges`/`ct_issues`/`ct_sync_ledger` atomically per
run, derives the warehouse + share nodes from the catalog, and flags missing/
invalid manifests and schedule drift in `ct_issues`. Runs as a Flight or as a
plain local script (duckdb ≥ 1.5.3) on plans without Flights.
