# Control Tower

Manifest-driven ops console: the data-flow graph is rendered entirely from
`ct_objects` / `ct_edges` / `ct_issues` (built by the `manifest-sync`
flight) — zero hardcoded nodes. This replaced the hardcoded v1 on
2026-06-10 after Ryan confirmed it renders the identical picture (v1
lives in git history at `control-tower/control-tower/` pre-rename).

- **Environment:** main
- **Database:** YOUR_DATABASE
- **Share:** (none yet — local preview only, unpublished)

## Data sources

- `ct_objects`, `ct_edges`, `ct_issues`, `ct_sync_ledger` — the graph and
  its problems, from manifest-sync.
- Every ledger table declared in a manifest's `ledger` block — health is
  ONE generic UNION query built client-side from those declarations.
- `duckdb_tables()` — live row counts for the warehouse box (no per-table
  code, and a declared-but-missing table shows as "table not found").

## How rendering works

1. BFS from the selected app's code objects over all edges (never walking
   into another app's code objects) → the visible subgraph.
2. Filter edges by the logical/physical toggle (`ct_edges.kind`).
3. Collapse all table nodes into one warehouse super-node (members listed
   inside the box). Opposite-direction collapsed edges (a flight reads AND
   writes warehouse tables) keep the majority direction.
4. Transitive reduction (drops e.g. the flight→share shortcut when
   flight→warehouse→share already tells the story).
5. Recursive linear-with-forks walk from the roots — column-per-depth,
   Fork component for fan-out. Arbitrary DAG layout is out of scope.

## Differences vs the retired v1 (deliberate)

- Table freshness ("thru Mar 2026") is gone — the period column is
  table-specific knowledge no manifest declares. Row counts remain.
- "Recent deliveries" is back (2026-06-10, same day) but manifest-driven:
  a delivery-feeding flight declares `ledger.detail_columns` and the panel
  renders exactly those columns. No declaration, no panel.
- New: ct_issues warnings strip, per-app graphs (control-tower app shows
  its own catalog→sync→warehouse flow), sync-freshness footer, "stale"
  warn state when a scheduled flight's latest ok run is >36h old.
