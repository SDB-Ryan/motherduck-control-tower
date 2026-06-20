# Changelog — Control Tower

## 2026-06-20 · Hidden objects
Objects listed in a `ct_hidden` table are excluded from the graph and the issues
strip, and shown in a muted "Hidden" section at the bottom so the exclusion stays
visible rather than silent — for objects you intentionally don't track (e.g. an
account marker dive).

## 2026-06-19 · Run-history health + views
Flight status dot and "last run" now read from run history (`last_run_ts` /
`last_run_status` in `ct_objects`) rather than a data ledger; staleness is opt-in
per flight via `stale_hours` (no threshold ⇒ no false "stale"), replacing the
hardcoded 36h window. The warehouse card recognizes views as first-class (via
`duckdb_views()`) instead of rendering them "table not found". Data ledgers still
drive the run-log and delivery panels.

## 2026-06-16 · Initial public release
Manifest-driven ops console: the data-flow graph renders entirely from
`ct_objects`/`ct_edges`/`ct_issues` (no hardcoded nodes), with per-app graphs, a
logical/physical edge toggle, a `ct_issues` warnings strip, manifest-declared
delivery panels, and a sync-freshness footer.
