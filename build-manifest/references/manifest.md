# Object manifests

A **manifest** is the lineage declaration for a dive or flight: a small JSON
record saying what the object is, which app it belongs to, and what flows into
and out of it. Manifests are how the data-flow graph stays out of anyone's head.

Manifests live as rows in the **`ct_registry`** table, authored by this
(build-manifest) skill — the object's source is never edited. The Control Tower
collector flight reads `ct_registry` (plus the live catalog) and materializes the
graph as tables (`ct_objects`, `ct_edges`) that the Control Tower dive renders
without a single hardcoded node.

**The non-negotiable rule: a manifest reflects reality.** A manifest that lies is
worse than no manifest — the graph it produces looks authoritative and isn't.

## Who carries a manifest

Code artifacts only: dives (`dive.tsx`) and flights (`flight.py`) get a
`ct_registry` row. Tables, shares, sources, and delivery endpoints do **not** —
they exist as graph nodes because the manifests that touch them declare them.
A table nobody declares doesn't appear on the graph; that's a feature.

## Format

The canonical store is a `ct_registry` row (this skill writes it — see
`registry_upsert.py`). The same fields can also appear as a legacy in-source
`@manifest` comment block; this skill can parse one to *seed* a registry row, but
the collector no longer reads object source, so an in-source block on its own does
nothing. Prefer authoring the registry row directly.

Legacy in-source form — Python (`flight.py`):

```python
# @manifest:begin
# {
#   "manifest_version": 1,
#   "object": "my-flight",
#   ...
# }
# @manifest:end
```

TypeScript (`dive.tsx`):

```tsx
/* @manifest:begin
{
  "manifest_version": 1,
  "object": "my-dive",
  ...
}
@manifest:end */
```

Extraction rule (`parse_manifest()` in `_manifest_schema.py`): take the text
between the markers, strip a leading `#`, `//`, or `*` (plus surrounding
whitespace) from each line, `json.loads` the result.

## Schema v1

| Field | Required | Meaning |
|---|---|---|
| `manifest_version` | yes | Always `1` for this schema. |
| `object` | yes | Unique key within the database. Use the workspace slug. |
| `type` | yes | `"dive"` or `"flight"`. |
| `app` | yes | App grouping the console uses — the `apps/<app>/` unit this object ships with (data-layer build flights group under their `databases/<db>/`). |
| `database` | yes | The MotherDuck database this object lives against. |
| `label` | no | Display hint for consoles, e.g. `"Flight · daily 09:15 UTC"`. |
| `schedule` | no | Cron expression (flights only). Keep in sync with the deployed schedule. |
| `url` | no | Deep link to the object (dive URL, flights page). |
| `reads_from` | no | List of node refs this object **physically reads**. |
| `writes_to` | no | List of node refs this object **physically writes**. |
| `delivers_for` | no | Logical parent(s): the report/object this one exists to deliver. |
| `feeds` | no | Logical terminal output(s), e.g. an email distribution. |
| `ledger` | no | Where this object's run/delivery health lives (see below). |

### Node refs

Namespaced `type:name` strings. Valid types:

```
flight:   another flight                dive:     a dive
table:    a table in `database`         share:    a database share
source:   an external source            delivery: a terminal delivery channel
```

Examples: `table:report_detail`, `source:market-data`,
`delivery:email-distribution`, `dive:briefing-book-burst`.
Names: lowercase, `a-z0-9_./-`. Nodes referenced by any manifest are
materialized by the collector; a ref to something only you know about is fine —
it becomes a node.

### Physical vs logical edges

- `reads_from` / `writes_to` describe **runtime truth** — what the code
  actually queries and mutates. This is the lineage you debug with.
- `feeds` describes **terminal outputs** — where value exits the system
  (inboxes, Slack, a bucket). These are physically real AND part of the
  story, so they appear in both views.
- `delivers_for` describes **meaning only** — the report this object
  exists to serve. It is the one purely-logical field, and the only thing
  that moves between the two views.

Declare everything honestly; don't fake a physical edge to make the
logical picture work, or vice versa.

### How consoles build the two views (the resolution rules)

The collector derives both graphs from the same manifests with three
deterministic rules:

1. **Physical view:** for every object, draw `reads_from → object`,
   `object → writes_to`, and `object → feeds`.
2. **Logical view:** identical, **except** an object that declares
   `delivers_for` has its incoming `reads_from` edges replaced by
   `delivers_for → object`. Objects with no `delivers_for` keep their
   physical shape in both views.
3. **Ledger hiding:** the table named in an object's own `ledger` block is
   ops plumbing, not data flow — it is hidden from the diagram in both
   views (consoles read it for status, not topology).

Worked through the burst flight: physically it hangs off the tables it
reads; logically it hangs off the report it delivers; in both views it
terminates at the email distribution; in neither view does its ledger
table clutter the flow.

### Conventions for common edges

- A pipeline flight that pushes a share declares it:
  `writes_to: ["share:<name>", ...]` — the push is a real write, and it
  tells consoles who keeps the share fresh.
- A dive declares what it actually attaches: cross-org dives read the
  share (`reads_from: ["share:<name>"]`); in-org dives may read tables
  directly. Match your `REQUIRED_DATABASES` reality.

### Declared vs derived (what you never write down)

Manifests declare what only the code's author knows. The collector derives
what the platform already knows — never duplicate it:

- **Share ↔ warehouse:** `MD_LIST_DATABASE_SHARES()` maps every share to
  its source database. The collector auto-creates the share node and the
  `warehouse → share` edge. No manifest declares it.
- **Table vitals:** row counts and freshness come from live queries, not
  manifests.
- **Deployed schedules:** `MD_LIST_FLIGHTS()` reports the real cron. The
  manifest's `schedule` is a declaration; the collector flags drift between
  the two.

Rule of thumb: if the catalog can answer it, the manifest shouldn't.

### The `ledger` block

Lets a console compute this object's health generically, with no
per-object code:

```json
"ledger": {
  "table": "burst_notify_ledger",
  "ts_column": "sent_ts",
  "status_column": "status",
  "ok_values": ["sent"]
}
```

Contract: the table has a timestamp column and a status column; a recent
row whose status is in `ok_values` means healthy. Flights that follow the
build-dive ledger pattern (every run writes a row, including failures)
satisfy it automatically.

Optional: `detail_columns` — a list of additional ledger columns a console
should show per row (beyond the timestamp). Use it when the ledger rows
ARE the product (a delivery flight's recipient/size/routing columns) and a
generic ts+status log would lose the story:

```json
"ledger": {
  "table": "burst_notify_ledger",
  "ts_column": "sent_ts",
  "status_column": "status",
  "ok_values": ["sent"],
  "detail_columns": ["md_username", "email", "status", "pdf_kb", "test_mode"]
}
```

Consoles render the declared columns verbatim (cast to text), coloring the
`status_column` by `ok_values`. No `detail_columns` = the object only
appears in generic run logs.

## Worked example (a burst flight)

```json
{
  "manifest_version": 1,
  "object": "burst-notify",
  "type": "flight",
  "app": "briefing-book",
  "database": "YOUR_DATABASE",
  "label": "Flight · daily 09:15 UTC",
  "schedule": "15 9 * * *",
  "url": "https://app.motherduck.com/flights",
  "reads_from": ["table:report_detail", "table:report_summary",
                 "table:report_tickers",
                 "table:burst_users", "table:burst_config",
                 "table:report_refresh_ledger"],
  "writes_to": ["table:burst_notify_ledger"],
  "delivers_for": ["dive:briefing-book-burst"],
  "feeds": ["delivery:email-distribution"],
  "ledger": {"table": "burst_notify_ledger", "ts_column": "sent_ts",
             "status_column": "status", "ok_values": ["sent"]}
}
```

## Tooling

- `registry_scan.py` — diff what's deployed against `ct_registry`
  (uncataloged / orphan / schedule-drift / type-mismatch).
- `registry_upsert.py` — write/validate `ct_registry` rows. Rows are validated
  on write against this schema (`_manifest_schema.py`); an invalid manifest is
  rejected, not silently stored.
- `registry_init.py` / `registry_pull.py` — create the table / pull existing rows.
