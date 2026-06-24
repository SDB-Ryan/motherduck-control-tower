# Control Tower Collector

Control Tower's backend — **one flight per account, no separate merge flight.** It reads
this account's manifest **registry table** (`ct_registry`, authored by the `build-manifest`
skill — *not* parsed from object source), enumerates the account's deployed dives/flights to
reconcile + pull run history, reads the charted warehouse(s) and any ledger tables locally,
and writes the data-flow graph into `control_tower.main`.

- **Environment:** main (the `main` account)
- **CT database / schema:** `control_tower.main` (the dive reads this)
- **Charted warehouse(s):** `YOUR_DATABASE`
- **Own ledger:** `ct_sync_ledger`
- **Schedule:** daily `30 13 * * *` UTC

> The deployed flight is still named `control-tower-manifest-sync` (historical); its role is
> the collector. Stamped constants (per account): `ACCOUNT`, `CT_DATABASE`, `SCHEMA`,
> `CHARTED_DATABASES`, `IS_MAIN`, `INBOUND_SHARES`.

## What it writes (all into `control_tower.main`, rebuilt atomically per run + count-verified)

| Table | Contents |
|---|---|
| `ct_objects` | one row per graph node — code objects (dives/flights) + derived nodes (tables, shares, sources, deliveries, warehouses/databases); carries `source_account` |
| `ct_edges` | one row per edge per view (`kind` = `physical` \| `logical`) |
| `ct_issues` | problems: missing-manifest, invalid-manifest, invalid-ledger, schedule-drift, out-of-scope, cycle, `node-collision`, `stale-account` |
| `ct_health` / `ct_runlog` / `ct_deliveries` | precomputed ops panels (the dive never queries raw ledger tables) |
| `ct_vitals` | table/view row counts for charted warehouse(s) |
| `ct_meta` | this account's freshness (`account`, `collected_at`) — drives `stale-account` |
| `ct_sync_ledger` | the flight's own run health |

`ct_registry` and `ct_hidden` are **not** rebuilt here — the skill / `sync-hidden.py` own them; the collector reads them.

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
- Manual run: `flight_run.py --name databases/YOUR_DATABASE/control-tower-manifest-sync`
  (needs the duckdb>=1.5.3 venv). Local dry-run: run `flight.py` with `motherduck_token` set.
