# Manifest Sync

Control Tower's backend. Reads every deployed dive and flight in the account
straight from the MotherDuck catalog, parses each object's `@manifest` block, and
materializes the data-flow graph as tables.

- **Database:** the database you install into (stamped in place of `YOUR_DATABASE`).
- **Ledger:** `ct_sync_ledger`
- **Schedule:** daily `30 13 * * *` UTC (a sensible default; change to suit).

## What it writes

| Table | Grain | Contents |
|---|---|---|
| `ct_objects` | one row per graph node | code objects (dives/flights with manifests) + derived nodes (tables, shares, sources, deliveries, the warehouse) with label, url, app, ledger pointers, declared + deployed schedules, and per-flight run history (`last_run_ts`, `last_run_status`, opt-in `stale_hours`) |
| `ct_edges` | one row per edge per view | `kind` = `physical` or `logical`; the dive's view toggle is just a filter on this column |
| `ct_issues` | one row per problem | missing manifests (warning), invalid manifests (error), schedule drift between manifest and deployed cron (warning) |
| `ct_sync_ledger` | one row per run | the flight's own health, failures included |

All three graph tables are rebuilt atomically in one transaction per run, then
verified by reading the counts back.

## Resolution rules

- Physical edges: `reads_from → object → writes_to + feeds`.
- Logical edges: identical, except an object declaring `delivers_for` has its
  incoming reads replaced by `delivers_for → object`.
- Any table named in some manifest's `ledger` block is ops plumbing: hidden from
  both views, never materialized as a node.
- Derived from the catalog, never declared: the `warehouse:<db>` node and the
  `warehouse → share` edge (via `MD_LIST_DATABASE_SHARES()`); deployed crons (via
  `MD_LIST_FLIGHTS()`) for drift detection.
- Flight health is read from **run history** (`MD_LIST_FLIGHT_RUNS`), not a data
  ledger: each flight's latest run timestamp + status land in `ct_objects`
  (`last_run_ts` / `last_run_status`, the `RUN_STATUS_` prefix stripped). A data
  ledger answers "is the data fresh"; run history answers "did the job run". A
  manifest's optional `stale_hours` (flights only) sets the staleness threshold;
  omit it and a quiet-but-healthy flight never shows stale.

## Notes

- An object missing from the graph almost always means its DEPLOYED source lacks
  a manifest — push the object again and check `ct_issues` first. (Local edits
  don't count until the source is pushed.)
- `MD_GET_FLIGHT` returns metadata only; flight source code comes from
  `MD_LIST_FLIGHT_VERSIONS("limit" := 1, flight_id := ...)`.
- Local dry-run: run `flight.py` with `motherduck_token` set (duckdb ≥ 1.5.3) —
  it writes the same `ct_*` tables, so it works even on plans without Flights.
