# Control Tower — Install (load this file into your AI assistant)

You are an AI assistant. The user handed you this file to install **Control Tower** into
their MotherDuck account(s). Work through it top to bottom. **Run Preflight first and don't
start installing until it passes.** If something's missing, name the exact holdup and its
fix, then stop and wait — don't improvise around a blocker. Show the user what you're about
to do before any write, and never claim success without verifying.

## What Control Tower is

A self-updating ops console for your MotherDuck environment — it draws the live data-flow
graph (which flights/dives read and write which databases), with health, run history, and
freshness, and flags what's broken or uncataloged.

| Piece | What it is | What it touches |
|---|---|---|
| `control-tower-collector` | a Flight (scheduled Python) — **one per account** | reads the catalog + the warehouse(s) you chart + a registry table; writes the graph tables (`ct_objects`, `ct_edges`, `ct_issues`, `ct_health`, `ct_runlog`, `ct_deliveries`, `ct_vitals`) into a `control_tower` database |
| `control-tower` | a Dive (the console UI) | reads only `control_tower.main` |
| `ct_registry` | a table | the declared lineage of your objects — authored by the skill, **not** stored in your objects' source |
| the `build-manifest` skill | how cataloging happens | reads each object's code and writes `ct_registry` rows |

**There is no separate "manifest" you edit into your code, and no separate merge flight.**
Lineage lives in `ct_registry`; the collector reads it. For multiple accounts, each account
runs its own collector and **shares** its `control_tower`; the main account's collector
reads those shares and folds them into one graph (details in Step 6).

**Safety profile:** the install creates 1 flight, 1 dive, and a `control_tower` database per
account. **It never modifies your existing objects' source** — cataloging writes a registry
*table*, never an `@manifest` comment in your dive/flight. It only reads your data (row
counts, run history, and any ledger tables you point it at).

## Core idea — the skill *evaluates your environment*

You already have dives, flights, and databases. Installing Control Tower does **not** ask
you to annotate them. Instead, the `build-manifest` skill **reads each deployed object's
code and infers its lineage** — what it reads, what it writes — and records that in
`ct_registry`. That's the install's real work (Step 3). Represent what you find: if a flight
reads `database:b`, declare it; don't fake edges and don't prune real ones. **Scope is the
user's choice** — set by *which databases they chart*, never by hand-editing the graph.

## How to run the commands (pick one before Preflight)

Same as any MotherDuck SQL/flight work. **Recommended: a local `duckdb` CLI** (>= 1.5.3 —
MotherDuck rejects newer; grab 1.5.3 from DuckDB releases if `brew` gives you a newer one)
connected with the user's token, run from the folder holding the source files so
`read_text(...)` resolves. **Fallback: the MotherDuck MCP** — but `read_text()` won't work
server-side, so pass file contents inline to `create_flight`/`save_dive`, and verify pushes
with `md5()` + `strlen()`.

## Preflight — can we install?

Establish these in order; if one fails, STOP, name the holdup + fix, and wait.

1. **SQL access** — the MCP (`SELECT 1`) or a token + `duckdb>=1.5.3`. Then confirm identity
   before any write: `SELECT current_user;` — show the user which account this is and get a yes.
2. **A `read_write` token** for the flight to run under: `SELECT token_name, token_type FROM
   md_access_tokens();` — pick one with the user. (No token? They create one in Settings →
   Access Tokens.)
3. **Flights enabled** (paid plan). If `MD_CREATE_FLIGHT` fails with a plan error later, offer:
   upgrade, **or** local-sync mode (run the same `flight.py` as a local script/cron — the graph
   refreshes when it runs).
4. **Pick scope:** which **database(s)** this account should chart (`charted_databases`), and —
   if installing across more than one account — **which account is `main`** (it hosts the dive).
   `SHOW DATABASES;` to list them. Charting is a deliberate choice: chart 3 or chart 30.

## Step 1 — Stamp the config

Set, in `control-tower.config.json` and stamped into `flight.py` at deploy:
`ACCOUNT` (this account's name), `CT_DATABASE` (default `control_tower`), `SCHEMA` (`main`),
`CHARTED_DATABASES` (the list from Preflight 4), `IS_MAIN` (true on the account that hosts the
dive), `INBOUND_SHARES` (empty for now — Step 6). The dive's `DB` constant = `control_tower`.

## Step 2 — Create the database + deploy the collector

1. `registry_init.py --env <acct>` (or the SQL it runs): creates `control_tower`, the `main`
   schema, and an empty `ct_registry`.
2. Deploy the collector with `MD_CREATE_FLIGHT` (name `control-tower-collector`, the
   `read_write` token, schedule e.g. `30 13 * * *` UTC). Verify the upload landed
   (`source_code = ...` from `MD_LIST_FLIGHT_VERSIONS`).

## Step 3 — Catalog your environment (the real install)

Run the **`build-manifest`** skill against this account. For each deployed object that has no
registry row, the skill:
1. pulls its source (`MD_GET_DIVE` / `MD_LIST_FLIGHT_VERSIONS`) — **read-only**,
2. **reads the code** and determines honestly what it reads/writes — tables (`table:x`),
   shares (`share:y`), sources (`source:z`), whole databases (`database:b`), terminal
   deliveries (`delivery:e`), and whether it writes a data **ledger** worth surfacing,
3. drafts a registry row, **shows you the draft + reasoning, and writes only on your OK**,
4. `registry_upsert.py` validates and writes it — **the object's source is never touched**
   (diff it afterward; it's byte-identical).

This is judgment work: it's the same as a human reading each job and saying "this reads raw,
writes analytics." Do it one object at a time until `registry_scan.py` is clean (or the user
says "enough — leave the rest"; uncataloged objects just stay on the issues strip).

## Step 4 — First run

Trigger the collector (`MD_RUN_FLIGHT`, poll `MD_LIST_FLIGHT_RUNS`, read logs). It reads the
registry + catalog + your charted warehouse(s) and writes the `control_tower.main` graph
tables. Expect health/runs/vitals to populate; uncataloged objects appear as
`missing-manifest` issues (the to-do list, not errors).

## Step 5 — Publish the dive

`MD_CREATE_DIVE` with `dive.tsx` (DB stamped = `control_tower`). Verify byte-for-byte
(`md5`, `strlen`). Open it: you should see your apps as a left-to-right graph —
sources/warehouses → flights → tables → dives — with status dots, plus a Recent Runs panel
and an issues strip. (Export the entry component as `export default <Name>`, not the
re-export form, or the platform rejects it.)

## Step 6 — Multiple accounts (optional)

Control Tower spans accounts **through read-only shares — no data is copied, only the graph**
(object/table names + structure). The flight is the same everywhere; the difference is config:

1. **On each non-main account:** do Steps 1–5 (it gets its own collector + its own
   `control_tower` + can host its own dive of just its objects), then **share its
   `control_tower`** read-only to the main account (`dive_share.py` / `CREATE SHARE`,
   `UPDATE AUTOMATIC`).
2. **On the main account:** add each inbound share to the collector's `INBOUND_SHARES`
   (`{"alias","url"}`) and redeploy. On its next run the main collector DETACH/ATTACHes each
   share fresh, reads the other accounts' `control_tower`, and **folds them into one graph**.
   It dedups by node name (the main account wins a clash and flags a `node-collision`),
   re-runs cycle detection on the merged edges, and raises `stale-account` if a share is old.

**Notes:** AUTOMATIC shares are eventually-consistent (~1 min lag), so schedule the main
collector a bit after the producers (e.g. producers `:30`, main `:45`); the `stale-account`
guard catches a producer whose collector stopped. Only graph metadata crosses, **never row
data** — the one exception is `ct_deliveries.recipient` (e.g. burst email addresses), so if a
producer bursts to sensitive recipients and the main account is more widely visible, omit or
hash that column before sharing.

## Step 7 — Verify

```sql
SELECT flight_name, schedule_cron, schedule_status FROM MD_LIST_FLIGHTS();  -- collector ACTIVE
SELECT status, detail FROM control_tower.main.ct_sync_ledger ORDER BY run_ts DESC LIMIT 1;  -- succeeded
SELECT count(*) FROM control_tower.main.ct_objects;                          -- > 0
SELECT DISTINCT source_account FROM control_tower.main.ct_objects;           -- every account you linked
SELECT * FROM control_tower.main.ct_issues;                                  -- only what you chose to leave
```

## Going forward

New object deployed? Re-run `build-manifest` — it reads the new object's code and adds its
registry row (no source edits). Want to widen/narrow what's monitored? Change
`charted_databases` and redeploy — **scope is config, never hand-edited edges.**

## Failure modes, in plain English

- **No `MD_*FLIGHT*` functions:** duckdb client < 1.5.3. Upgrade.
- **Flight verifies but the run fails:** read the logs — usually a missing pin in `requirements.txt`.
- **Dive renders but every query errors:** the dive's `DB` isn't `control_tower`, or `control_tower` isn't attached for the dive.
- **An object never appears on the graph:** it has no `ct_registry` row — run `build-manifest`. Check `ct_issues`.
- **`stale-account` on the board:** a linked account's collector hasn't run recently, or its share went stale.
- **`node-collision`:** two accounts define an object with the same name differently — rename one.
- **A linked account's objects are missing:** its share isn't attached on main, or its `control_tower` is empty (run its collector first).
