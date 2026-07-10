# Changelog — Control Tower

## 2026-07-10 · Assistant-agnostic install
The whole repo now works from a clean clone with any AI assistant: the registry
scripts run without any private workspace (config at the repo root, token via
`MOTHERDUCK_TOKEN` or a per-account `token_env`, optional `md_user` identity
guard), `references/manifest.md` ships, dead pointers to unshipped tooling are
gone, dive UI strings say "the collector", and doc examples are generic.

## 2026-06-30 · About tab + accurate docs
About tab in the dive (what it is / how it works / where to get it, author
links); header freshness-stamp layout; docs aligned to the `ct_registry` model;
issues reference in the collector README.

## 2026-06-26 · Multi-account + layered overview
One collector per account; the main account folds other accounts' shared
`control_tower` boards into a single graph (`stale-account`, `node-collision`
guards). Overview board switched to a layered (Sugiyama) layout: per-app bands,
lane routing, crossing minimization.

## 2026-06-22 · Hardening + explicit scope
Named error panel for dependency cycles; ledger validation (`invalid-ledger`);
visible query-error banner; honest "Checked HH:MM" freshness + manual refresh;
keyboard-operable nav; charted-database scope with `out-of-scope` warnings
instead of silently mashing unknown databases onto the board; network-icon
redesign; app-scoped issues.

## 2026-06-20 · Hidden objects
Objects listed in a `ct_hidden` table are excluded from the graph and the issues
strip, and shown in a muted "Hidden" section at the bottom so the exclusion stays
visible rather than silent — for objects you intentionally don't track (e.g. a
scratch or test dive).

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
