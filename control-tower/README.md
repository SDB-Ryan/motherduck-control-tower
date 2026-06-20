# Control Tower

Manifest-driven ops console: the data-flow graph is rendered entirely from
`ct_objects` / `ct_edges` / `ct_issues` (built by the `control-tower-manifest-sync`
flight) — zero hardcoded nodes. Add a `@manifest` block to a dive or flight and
it joins the graph on the next sync; remove it and it drops off.

- **Database:** the database you install into (stamped in place of `YOUR_DATABASE`).
- **Reads:** `ct_objects`, `ct_edges`, `ct_issues`, `ct_sync_ledger` + every
  ledger table any manifest declares.

## Data sources

- `ct_objects`, `ct_edges`, `ct_issues`, `ct_sync_ledger` — the graph and its
  problems, from the manifest-sync flight. Flight health (dot + "last run") comes
  from the `last_run_ts` / `last_run_status` / `stale_hours` columns the sync
  fills from run history — not from a data ledger.
- Every ledger table declared in a manifest's `ledger` block — feeds the run-log
  and delivery panels (data freshness), via ONE generic UNION query built
  client-side from those declarations.
- `duckdb_tables()` + `duckdb_views()` — live row counts for the warehouse box
  (no per-table code). Views are first-class ("view"); a ref missing from both
  catalogs shows as "table not found".

## How rendering works

1. BFS from the selected app's code objects over all edges (never walking into
   another app's code objects) → the visible subgraph.
2. Filter edges by the logical/physical toggle (`ct_edges.kind`).
3. Collapse all table nodes into one warehouse super-node (members listed inside
   the box). Opposite-direction collapsed edges (a flight reads AND writes
   warehouse tables) keep the majority direction.
4. Transitive reduction (drops e.g. the flight→share shortcut when
   flight→warehouse→share already tells the story).
5. Recursive linear-with-forks walk from the roots — column-per-depth, fork
   component for fan-out. Arbitrary DAG layout is out of scope.

## Behaviors

- Per-app graphs: each app renders its own catalog→sync→warehouse flow.
- A `ct_issues` warnings strip lists objects with missing/invalid manifests.
- Delivery panel: a delivery-feeding flight that declares `ledger.detail_columns`
  gets a "recent deliveries" panel rendering exactly those columns. No
  declaration, no panel.
- Sync-freshness footer; a flight goes orange "stale" only when its manifest
  opts in via `stale_hours` and its last run is older than that — a quiet flight
  with no threshold set never false-alarms (failures still show red).
