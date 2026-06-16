# Control Tower — Install (load this file into your AI assistant)

You are an AI assistant. The user has handed you this file to install **Control
Tower** into their MotherDuck account. Work through it top to bottom.

**Run Preflight first, and do not start installing until it passes.** If
something is missing, your job is to name the *exact* holdup and the fix, then
stop and wait for the user to resolve it — don't improvise around a blocker. Do
not skip verification steps, and show the user what you're about to do before any
write to their account.

## What you are installing

Control Tower is a self-updating ops console for everything running in a
MotherDuck database. Three pieces:

| Piece | What it is | What it touches |
|---|---|---|
| `control-tower-manifest-sync` | a Flight (scheduled Python job) | reads every deployed dive/flight's source from the catalog; writes 4 tables: `ct_objects`, `ct_edges`, `ct_issues`, `ct_sync_ledger` |
| `control-tower` | a Dive (the console UI) | reads those 4 tables + ledger tables declared by manifests |
| The manifest convention | a JSON block each dive/flight carries in its own source | nothing — it's comments |

How it works: every dive and flight declares what it reads, writes, and
delivers in an `@manifest` comment block. The sync flight parses all of
them nightly and materializes the data-flow graph as tables. The dive
renders the graph with zero hardcoded nodes. Objects without a manifest
appear on an issues list, not the graph.

**Safety profile:** the install creates 1 flight, 1 dive, and 4 new tables.
It never modifies the user's data tables. The only edits to the user's
existing objects happen in Step 5, one at a time, each with explicit
user approval, and each adds only a comment block.

## Source files

Shipped alongside this document:

- `control-tower-manifest-sync/flight.py` (+ `requirements.txt`)
- `control-tower/dive.tsx`

Both carry a `YOUR_DATABASE` placeholder you stamp with the target database in
Step 1.

## Preflight — can we install? (do this before anything else)

Establish three things, in order. If one fails, STOP, tell the user the named
holdup and its fix, and wait.

### Check 1 — Can you run SQL against the user's MotherDuck account?

You need ONE of these:
- **MotherDuck MCP** connected to you — test it with `SELECT 1`.
- **A MotherDuck access token + a runtime** where you can run `duckdb`
  (Python, `duckdb >= 1.5.3`) connected to `md:` with that token.

> **HOLDUP 1 — no MotherDuck access.** Neither is available. Tell the user:
> "I can't reach your MotherDuck account. Give me one of: (a) the **MotherDuck
> MCP** connected to this assistant, or (b) a **read/write access token** plus a
> way for me to run Python with `duckdb>=1.5.3`. Then start me again." Stop here.

Once connected, confirm identity **before any write**:

```sql
SELECT current_user;
```

Show the user which account this is and get a yes — this is what stops you
installing into the wrong account.

### Check 2 — Is there a read/write token for the flight to run under?

The sync runs as a Flight, which authenticates with a NAMED `read_write` token
(separate from however you happen to be connected right now). List them:

```sql
SELECT token_name, token_type FROM md_access_tokens();
```

Pick a `read_write` one with the user.

> **HOLDUP 2 — no API/token access.** No `read_write` token exists (or the user
> can't share one). Tell the user: "Create a read/write access token in MotherDuck
> → Settings → Access Tokens, then tell me its name." Stop until they do.

Also confirm the client is new enough to see flight functions at all:

```sql
SELECT count(*) FROM duckdb_functions() WHERE function_name LIKE 'MD_%FLIGHT%';
```

Zero → the duckdb client is older than **1.5.3**; fix the env
(`pip install 'duckdb>=1.5.3'`) before continuing.

### Check 3 — Can this account actually run Flights?

Flights need a paid plan. Seeing the functions in Check 2 does NOT mean the plan
allows *creating* one — the only reliable test is trying, in Step 2.

> **HOLDUP 3 — Flights not on this plan (free tier).** When the create in Step 2
> fails with a plan error, you are NOT blocked. Offer the user two paths:
> 1. **Upgrade** to a plan with Flights, for scheduled refresh; or
> 2. **Local-sync mode** — install now and run the same `flight.py` as a local
>    script (or local cron). Control Tower works identically; the only difference
>    is the graph refreshes when the script runs, not on a MotherDuck schedule.
>
> Let the user choose — both finish the install.

### Then pick the database (and schedule)

- **Database:** Control Tower scopes to ONE database (the `ct_*` tables live
  beside that database's data). List them (`SHOW DATABASES`) and confirm which.
- **Schedule:** default `30 13 * * *` (UTC — tell the user the local time; cron is
  UTC year-round). Skip if installing local-sync.

Preflight passes when: you can run SQL on the confirmed account, you have a
`read_write` token name, and you know whether you're deploying as a Flight or in
local-sync mode. Proceed to Step 1.

## Step 1 — Stamp the config into the sources

Copy the two source folders into the user's workspace, then replace the
database name. The complete list of edit points (nothing else is
environment-specific — this was audited):

| File | Edit |
|---|---|
| `flight.py` | `DATABASE = "<their_db>"` and `"database": "<their_db>"` in the manifest block |
| `dive.tsx` | `const DB = "<their_db>"`, `const REQUIRED_DATABASES = ["<their_db>"]`, `"database": "<their_db>"` in the manifest block, and reset the manifest's `"url"` to `""` (it gets the real dive URL in Step 4) |

After stamping, verify: a grep for the previous database name across both
files must return nothing.

`REQUIRED_DATABASES` matters: dives run in single-attach mode, and a wrong
entry silently breaks every query.

## Step 2 — Deploy the sync flight

Any agent with SQL access (MCP or duckdb) can deploy the flight — no skill
needed, just a MotherDuck connection:

```sql
SET VARIABLE src = (SELECT content FROM read_text('flight.py'));
SET VARIABLE req = (SELECT content FROM read_text('requirements.txt'));
SELECT flight_id FROM MD_CREATE_FLIGHT(
  name := 'control-tower-manifest-sync',
  source_code := getvariable('src'),
  requirements_txt := getvariable('req'),
  access_token_name := '<their token label>',
  schedule_cron := '30 13 * * *');
```

Save the returned `flight_id`. Then verify the upload landed intact:

```sql
SELECT source_code = getvariable('src')
FROM MD_LIST_FLIGHT_VERSIONS("limit" := 1, flight_id := '<id>'::UUID);
```

Must be `true`. (Note: `MD_GET_FLIGHT` returns metadata only — source
comes from `MD_LIST_FLIGHT_VERSIONS`.)

**Local-sync lane (free plan, no Flights):** if MD_CREATE_FLIGHT failed
with a plan error, run the sync as a local script instead — `flight.py`
is designed to work both ways. Set the user's MotherDuck token as the
`motherduck_token` env var and run it with python (duckdb >= 1.5.3). It
writes the same four ct_* tables. Tell the user the one tradeoff: the
graph refreshes when they run the script (or a local cron runs it), not
on a MotherDuck schedule — and the sync job itself won't appear on its
own graph, since it isn't a deployed object. Re-running after every
manifest change is the habit to build. If they later upgrade plans,
deploy the same file as a flight and nothing else changes.

## Step 3 — First sync run (expect warnings; that's the design)

Trigger it and wait for completion:

```sql
SELECT * FROM MD_RUN_FLIGHT(flight_id := '<id>'::UUID);
-- poll MD_LIST_FLIGHT_RUNS(flight_id := ...) until SUCCEEDED,
-- then read MD_GET_FLIGHT_LOGS(...)
```

(If you use the optional build-dive skill, `flight_run.py --name ...` does
trigger-poll-logs in one command.)

Expected on a fresh account:

- `ct_sync_ledger` gains a `succeeded` row.
- `ct_objects` contains the sync flight itself plus derived nodes.
- **`ct_issues` contains one `missing-manifest` warning per existing dive
  and flight in the account.** This is not a problem — it's the to-do
  list. Show it to the user and tell them: "this is everything Control
  Tower found that isn't cataloged yet; we'll catalog them in Step 5."

If the run FAILED, read the logs. Known container gotchas: the container
TZ is `Etc/Unknown` (the shipped flight already pins UTC); secrets inject
as env vars prefixed with the secret's name (not used by this flight).

## Step 4 — Publish the dive

Via SQL (the build-dive skill's `dive_push.py` wraps the same call if you use it):

```sql
SET VARIABLE content = (SELECT content FROM read_text('dive.tsx'));
SELECT id FROM MD_CREATE_DIVE(
  title := 'Control Tower',
  description := 'Manifest-driven ops console.',
  content := getvariable('content'));
```

Then put the returned dive URL into the dive's own manifest (`"url":
"https://app.motherduck.com/dives/<id>"`) and push once more — the graph
node for the console should link to the console.

Open the dive with the user. They should see: a mostly-empty graph
containing just the Control Tower app (catalog → sync flight → warehouse
with the ct_* tables), and the issues strip listing their uncataloged
objects. After the next sync run the dive will also discover itself.

## Step 5 — Catalog the user's existing objects (the real install)

This is the part only you can do, and it requires judgment. For each
`missing-manifest` issue, **one object at a time**:

1. Pull the object's source (`MD_GET_DIVE(id)` for dives;
   `MD_LIST_FLIGHT_VERSIONS` for flights).
2. Read the code. Determine honestly:
   - what it **reads** (tables, shares, external sources) and **writes**
   - what it **delivers and for what** (only if it's a delivery mechanism
     for some report — most objects leave `delivers_for` empty)
   - whether it has a **ledger** (a table where each run/send writes a row)
3. Draft the manifest. Schema v1, all of it:

```json
{
  "manifest_version": 1,
  "object": "<kebab-case-name>",        // unique within the database
  "type": "dive" | "flight",
  "app": "<app-grouping>",              // ask the user how they'd group it
  "database": "<their_db>",
  "label": "Flight · daily 13:00 UTC",  // optional display hint
  "schedule": "0 13 * * *",             // flights only; must match deployed
  "url": "https://app.motherduck.com/dives/<id>",   // optional deep link
  "reads_from":  ["table:x", "share:y", "source:z"],
  "writes_to":   ["table:w"],
  "delivers_for": [],                    // the report this object delivers, if any
  "feeds": [],                           // terminal outputs (e.g. delivery:email)
  "ledger": {                            // omit if no ledger table
    "table": "...", "ts_column": "...", "status_column": "...",
    "ok_values": ["succeeded"],
    "detail_columns": ["..."]            // optional: columns a console shows per row
  }
}
```

   Node refs are `type:name`, lowercase, types:
   `flight, dive, table, share, source, delivery`. Honesty rule: declare
   what the code actually does — don't fake a physical edge to make the
   logical picture prettier. Don't declare what the catalog already knows
   (share↔database wiring, deployed schedules, row counts — the sync
   derives those).

   Format: Python files get `# @manifest:begin` / JSON in `#` comments /
   `# @manifest:end` right after the docstring; TSX files get a
   `/* @manifest:begin ... @manifest:end */` block at the top.

4. **Show the user the draft and your reasoning. Do not push without their
   confirmation** — a manifest that lies is worse than no manifest.
5. Push the updated object (comment-only change; verify the stored source
   matches), re-run the sync, and confirm: the object now renders on the
   graph and its issue is gone.

Repeat until `ct_issues` is empty or the user says "enough — leave the
rest." Partial cataloging is fine; uncataloged objects just stay on the
issues strip.

## Step 6 — Final verification

Run all of these and show the user the results:

```sql
SELECT flight_name, schedule_cron, schedule_status FROM MD_LIST_FLIGHTS();  -- ACTIVE, right cron
SELECT status, detail FROM ct_sync_ledger ORDER BY run_ts DESC LIMIT 1;     -- succeeded
SELECT count(*) FROM ct_objects;                                            -- > 0
SELECT * FROM ct_issues;                                                    -- only what the user chose to leave
```

Done means: the dive renders every cataloged app, every status dot has a
real ledger or live count behind it, and the sync runs itself on schedule
from now on. New objects join the graph by carrying a manifest — that's
the convention the user adopts going forward (put it in their project's
CLAUDE.md or team docs).

## Failure modes, in plain English

- **No MD_*FLIGHT* functions:** duckdb client < 1.5.3. Upgrade.
- **Flight deploy verifies but run fails immediately:** read the logs
  first; most failures are dependency pins missing from requirements.txt.
- **Dive renders but every query errors:** `REQUIRED_DATABASES` doesn't
  name the database (Step 1 was skipped or typo'd).
- **An object never appears on the graph:** its DEPLOYED source has no
  valid manifest — local edits don't count until pushed. Check `ct_issues`
  for the reason; `manifest_check.py` lints locally if available.
- **The whole health query breaks after cataloging an object:** its
  manifest's `ledger` block names a table/column that doesn't exist in the
  target database. Fix the manifest to match reality.
