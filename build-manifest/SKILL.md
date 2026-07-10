---
name: build-manifest
description: >
  Catalog MotherDuck dives and flights into Control Tower's manifest registry — WITHOUT
  editing the objects' source. Use this skill whenever the user wants to register an object's
  lineage, "add it to Control Tower", record what a dive or flight reads/writes/delivers, fix
  a missing-manifest or out-of-scope warning on the Control Tower board, see what isn't
  cataloged yet, or onboard an account into a multi-account Control Tower. This is the
  non-invasive alternative to embedding an @manifest block in an object's code: the lineage
  lives in a `ct_registry` table the collector flight reads. If the work is about what
  Control Tower knows about an object (rather than building the object itself), this skill
  drives it.
---

# Build Manifest

Catalog objects into Control Tower's **registry table** so the data-flow graph can chart
them — without ever touching the object's source. Three principles:

1. **Non-invasive.** This skill only writes `ct_registry` rows. It NEVER edits a dive's or
   flight's deployed source. (That is the whole reason it exists — so production objects
   you can't or won't edit can still be cataloged.)
2. **Never write to the wrong account.** Every operation goes through a script with an
   explicit `--env`, and `connect()` verifies the live `md_user()` against the account's
   configured identity (the `md_user` field in the config) and refuses on mismatch.
3. **The registry is the single truth, validated once.** Rows are validated with the same
   `validate()` the collector uses (`scripts/_manifest_schema.py`), so a row that would
   break the graph is rejected at write time, not discovered later on the board.

## How this fits Control Tower

Each account runs a **collector flight** that reads its `ct_registry`, enumerates that
account's deployed objects, and writes the graph tables (`ct_objects/ct_edges/ct_issues`
+ precomputed health/runlog/deliveries/vitals). There is **no separate merge flight**: on
the main account, the same collector also folds in the other accounts' shared
`control_tower` databases before writing — one board, which the **dive** renders. This
skill is the *authoring* side: it fills `ct_registry`. See
`control-tower.config.json` for the account topology.

A manifest registry row replaces the old in-source `@manifest` block. Same fields, same
validation — different home (a table, per account).

## Step 0 — ASK which account, every time

Ask the user **which Control Tower account** to work in (the `env` values in
`control-tower.config.json`). Pass it as `--env` to every script. Identity is
verified, never assumed — the same person can show different `md_user()` across accounts.

## Workflow

1. **`registry_init.py --env X`** once per account — creates the account's Control Tower
   database, schema, and empty `ct_registry`. Idempotent.
2. **`registry_scan.py --env X`** — the to-do list: which deployed objects are
   **uncataloged**, which registry rows are **orphans**, which flights have **schedule
   drift**. Use `--json` to consume it programmatically.
3. **For each uncataloged object, one at a time** (this is the judgment only you can do):
   - Pull its source: `MD_GET_DIVE(id := …)` for dives, `MD_LIST_FLIGHT_VERSIONS("limit"
     := 1, flight_id := …)` for flights (read-only).
   - Read the code and determine honestly:
     - what it **reads** (`reads_from`: `table:`, `share:`, `source:` refs)
     - what it **writes** (`writes_to`: `table:`, `share:` refs)
     - what it **delivers and for what** (`delivers_for`: the `dive:` it serves — usually
       empty)
     - terminal outputs (`feeds`: e.g. `delivery:email-distribution`)
     - whether it writes a **data ledger** worth surfacing (the `ledger` block: table,
       ts_column, status_column, ok_values, optional detail_columns)
   - Draft a manifest object (schema below). Set `deployed_name` to the object as the
     catalog reports it (a dive's **title**; for a flight it defaults to `object`).
4. **Show the user the draft and your reasoning. Do not write without confirmation** — a
   manifest that lies is worse than none.
5. **`registry_upsert.py --env X --file draft.json`** — validates, writes transactionally,
   verifies. Accepts one object or a list.
6. **Confirm it rendered:** trigger the collector — `MD_RUN_FLIGHT` via SQL (or
   build-dive's `flight_run.py` where that workspace exists) — and check the object now
   appears and its `missing-manifest` issue cleared — **and that its source is unchanged**
   (diff the deployed source; it must be byte-identical).

## Manifest schema (v1)

The row you draft for `registry_upsert.py` is a manifest object plus optional
`deployed_name`:

```json
{
  "manifest_version": 1,
  "object": "burst-notify",                 // kebab; unique within (database)
  "deployed_name": "burst-notify",          // catalog title/name; omit to default to object
  "type": "flight",                          // 'flight' | 'dive'
  "app": "briefing-book",
  "database": "YOUR_DATABASE",    // must be in this account's charted_databases
  "label": "Flight · daily 09:15 UTC",       // optional
  "schedule": "15 9 * * *",                  // flights; keep == deployed cron
  "stale_hours": 36,                          // optional, flights only
  "url": "https://app.motherduck.com/flights",
  "reads_from":  ["table:report_detail", "share:upstream", "source:market-data"],
  "writes_to":   ["table:burst_notify_ledger"],
  "delivers_for": ["dive:briefing-book-burst"],
  "feeds":       ["delivery:email-distribution"],
  "ledger": {
    "table": "burst_notify_ledger", "ts_column": "sent_ts",
    "status_column": "status", "ok_values": ["sent"],
    "detail_columns": ["email", "status"]
  }
}
```

Ref types: `flight, dive, table, share, source, delivery, database`; names lowercase
`[a-z0-9_./-]`. Use `database:<db>` to declare that an object reads or writes a whole
database (database-to-database lineage) — it resolves to that database's node, so the
collector draws the warehouse-to-warehouse flow without you enumerating tables.

**Honesty rule — represent what you find, both directions:** declare what the code actually
does. Don't fake an edge to make the picture prettier, and **don't prune a real one**
because it looks noisy or environment-specific. If a flight reads `database:b`, show it —
even your own Control Tower collector reads the warehouse(s) it charts, and that edge is
real for everyone. **Scope is the user's choice, not yours to hand-edit:** what Control
Tower covers is set by the account's `charted_databases` (chart 3 or chart 45 — their
call), never by deleting edges from the graph. Don't declare what the catalog already knows
(share↔database wiring, deployed schedules, row counts — the collector derives those). Full
reference: `references/manifest.md`.

## Scripts

| Script | What it does (plain English) |
|---|---|
| `scripts/registry_init.py` | Creates an account's Control Tower DB + slice schema + empty `ct_registry`. Idempotent. |
| `scripts/registry_scan.py` | Read-only diff of deployed objects vs the registry: uncataloged / orphan / drift. `--json` for the skill. |
| `scripts/registry_upsert.py` | Validates and upserts registry rows (one or a list), transactional + verified. Never edits object source. |
| `scripts/registry_pull.py` | Dumps the registry to JSON (manifest shape) for review or version control. |
| `scripts/_manifest_schema.py` | The shared schema: `validate()` + manifest↔row conversion + the `ct_registry` DDL. Mirrored inline by the collector. |
| `scripts/_ct.py` | Loads `control-tower.config.json` and reuses build-dive's `_md.connect` (md_user-verified). |

```bash
S=build-manifest/scripts
python3 $S/registry_init.py   --env main
python3 $S/registry_scan.py   --env main
python3 $S/registry_upsert.py --env main --file draft.json
python3 $S/registry_pull.py   --env main --out registry.main.json
```

## Notes

- Migrating an existing single-account Control Tower? Its objects already carry in-source
  `@manifest` blocks. `parse_manifest()` in `_manifest_schema.py` reads them; feed the
  parsed dicts (with `deployed_name` set) to `registry_upsert.py` to move them into the
  registry, then the collector reads the registry instead of the source.
- Triggering the collector needs nothing special: `MD_RUN_FLIGHT` via SQL (in the private
  workspace, build-dive's `flight_run.py` wraps the same call). During OSS publish,
  `_md.py` is vendored into this skill so it ships self-contained.
