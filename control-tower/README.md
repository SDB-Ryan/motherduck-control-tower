# Control Tower — the dive

The console UI: a **read-only** MotherDuck dive that renders the data-flow graph and ops
panels entirely from the `ct_*` tables in `control_tower.main` (built by the collector
flight) — zero hardcoded nodes. See the [main README](../README.md) for what Control Tower
is and [INSTALL.md](../INSTALL.md) to install it.

## Data sources (all read-only)

- `ct_objects`, `ct_edges`, `ct_issues` — the graph and its problems.
- `ct_health`, `ct_runlog`, `ct_deliveries` — precomputed ops panels (the dive never queries
  raw ledger tables).
- `ct_vitals` — live row counts for the charted warehouse(s).
- `ct_meta` / `ct_sync_ledger` — freshness (last sync, last collector run).
- `ct_hidden` — objects intentionally excluded from the graph.

## How rendering works

1. Per app, BFS from the app's code objects over `ct_edges` → the visible subgraph (never
   walking into another app's code objects).
2. Filter edges by the logical/physical toggle (`ct_edges.kind`).
3. Collapse each app's table nodes into their warehouse node — one per charted database, so a
   board can show several warehouses; members are listed inside the box. Opposite-direction
   collapsed edges (a flight that reads *and* writes warehouse tables) keep the majority
   direction.
4. Transitive reduction drops redundant shortcuts (e.g. flight→share when
   flight→warehouse→share already tells the story).
5. Layered left-to-right layout from the roots; a dependency cycle is reported as an issue,
   not drawn.

Freshness (last sync + last load) and a refresh control sit in the content header. The
Overview merges every app into one environment-wide graph; per-app views add the
logical/physical toggle.
