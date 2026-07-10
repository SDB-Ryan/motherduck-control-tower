# Control Tower Collector

Control Tower's backend — **one flight per account, no separate merge flight.** It reads
this account's manifest **registry table** (`ct_registry`, authored by the `build-manifest`
skill — *not* parsed from object source), enumerates the account's deployed dives/flights to
reconcile + pull run history, reads the charted warehouse(s) and any ledger tables locally,
and writes the data-flow graph into `control_tower.main`.

- **Environment:** main
- **CT database / schema:** `control_tower.main` (the dive reads this)
- **Charted warehouse(s):** `YOUR_DATABASE`
- **Own ledger:** `ct_sync_ledger`
- **Schedule:** daily `30 13 * * *` UTC

> Stamped constants (per account, edited at the top of `flight.py` at deploy): `ACCOUNT`,
> `CT_DATABASE`, `SCHEMA`, `CHARTED_DATABASES`, `IS_MAIN`, `INBOUND_SHARES`.

## What it writes (all into `control_tower.main`, rebuilt atomically per run + count-verified)

| Table | Contents |
|---|---|
| `ct_objects` | one row per graph node — code objects (dives/flights) + derived nodes (tables, shares, sources, deliveries, warehouses/databases); carries `source_account` |
| `ct_edges` | one row per edge per view (`kind` = `physical` \| `logical`) |
| `ct_issues` | problems: missing-manifest, orphan-registry, invalid-manifest, invalid-ledger, schedule-drift, out-of-scope, cycle, `node-collision`, `stale-account` (see [Issues reference](#issues-reference)) |
| `ct_health` / `ct_runlog` / `ct_deliveries` | precomputed ops panels (the dive never queries raw ledger tables) |
| `ct_vitals` | table/view row counts for charted warehouse(s) |
| `ct_meta` | this account's freshness (`account`, `collected_at`) — drives `stale-account` |
| `ct_sync_ledger` | the flight's own run health |

`ct_registry` and `ct_hidden` are **not** rebuilt here — `build-manifest` writes the registry, and `ct_hidden` is maintained directly (one row per intentionally-untracked object: `object_key`, `reason`); the collector only reads them.

## Issues reference

Everything the collector can write to `ct_issues`, with what triggers it and how to clear it.
`stale-account` and `node-collision` only occur in the multi-account fold.

| Issue | Severity | Triggers when | Fix |
|---|---|---|---|
| `invalid-manifest` | error | A `ct_registry` row is malformed — missing or invalid required fields | Re-catalog the object with `build-manifest` (it validates on write) |
| `invalid-ledger` | error | An object's declared ledger table/timestamp/status/detail column doesn't exist in the catalog | Fix the ledger fields in the registry to match the real table |
| `cycle` | error | Dependencies form a loop (physical or logical), so the graph can't be laid out — checked per app and on the merged cross-account graph | Break the loop in the declared `reads_from`/`writes_to` |
| `missing-manifest` | warning | A deployed dive/flight has no `ct_registry` row (uncataloged) | Catalog it with `build-manifest` |
| `orphan-registry` | warning | A `ct_registry` row whose object isn't deployed (deleted or renamed) | Remove the stale registry row |
| `out-of-scope` | warning | Objects target a database not in `CHARTED_DATABASES` — one rollup issue counting them and naming the databases | Add the database to `charted_databases`, or leave it out deliberately |
| `schedule-drift` | warning | A flight's deployed cron differs from the cron declared in its registry row | Align the registry schedule with the deployed one (or vice versa) |
| `stale-account` | warning | *(main only)* a folded-in account's shared board is older than `STALE_HOURS` (36h), or its share is attached but unreadable | Check that account's collector is running and its share is valid |
| `node-collision` | warning | *(main only)* the same node id is defined differently in two folded accounts (this account wins the clash) | Rename one object so ids are unique across accounts |

## Resolution rules

- Physical edges: `reads_from → object → writes_to + feeds`. Logical: same, except
  `delivers_for` replaces incoming reads.
- `database:<db>` refs resolve to that database's `warehouse:<db>` node — **database-to-database
  lineage** (so a flight can say "reads `raw`, writes `analytics`" without listing tables).
- Hidden from the graph (plumbing): any table named in a `ledger` block, and any `table:ct_*`.
- Derived from the catalog, never declared: `warehouse:<db>` + `warehouse → share` edges
  (`MD_LIST_DATABASE_SHARES`); deployed crons (`MD_LIST_FLIGHTS`) for drift; run history
  (`MD_LIST_FLIGHT_RUNS`) for flight health.
- Multi-warehouse: `CHARTED_DATABASES` is a list; objects targeting an un-charted database are
  reported `out-of-scope`, not drawn.

## Multi-account fold (main account only)

If `IS_MAIN` and `INBOUND_SHARES` is non-empty, after building its own graph the collector
DETACH/ATTACHes each inbound share fresh, reads the other accounts' `control_tower` over the
read-only share, and unions them **in memory** (`fold_in_shares`): dedup by node id (this
account wins a clash → `node-collision`), cycle detection re-run on the merged edges,
`stale-account` raised for an old share, each row's `source_account` preserved. Best-effort —
a missing/stale/unreadable share is flagged, never fatal. No self-loop: the main account
re-collects its own graph fresh and only *reads* the other accounts' (different) databases.

## Notes

- An object missing from the graph means it has no `ct_registry` row — run `build-manifest`
  (it reads the object's code and writes the row; it never edits the object's source). Check
  `ct_issues`.
- `MD_GET_FLIGHT` returns metadata only; flight source comes from `MD_LIST_FLIGHT_VERSIONS`.
- Manual run: trigger it with `MD_RUN_FLIGHT` (SQL). Local dry-run: run `flight.py`
  directly with the `motherduck_token` env var set (duckdb 1.5.3).
