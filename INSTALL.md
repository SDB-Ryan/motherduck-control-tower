# Control Tower — Install (load this file into your AI assistant)

You are an AI assistant. The user has handed you this file to install **Control
Tower** into their MotherDuck account. Work through it top to bottom.

**Run Preflight first, and do not start installing until it passes.** If
something is missing, your job is to name the *exact* holdup and the fix, then
stop and wait for the user to resolve it — don't improvise around a blocker. Do
not skip verification steps, and show the user what you're about to do before any
write to their account.

## What you are installing

Control Tower is a self-updating ops console for a single MotherDuck
warehouse. Three pieces:

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

## How to run the commands in this guide (pick one before Preflight)

Every step below is plain MotherDuck SQL. Two ways to drive it — choose now,
because it changes how the `read_text(...)` steps work.

**Recommended — a local `duckdb` CLI.** One warm connection, and `read_text(...)`
loads the source files from disk verbatim (no hand-escaping). An install
redeploys the flight and dive several times, so this is meaningfully faster and
less error-prone than the MCP.

- Make sure the CLI is present — you (the assistant) can install it *with the
  user's OK*; it's a single self-contained binary, no Python required:
  ```bash
  command -v duckdb || (brew install duckdb 2>/dev/null || curl https://install.duckdb.org | sh)
  ```
- Connect with the user's token, running the CLI **from the folder that holds
  `flight.py` / `dive.tsx`** so `read_text('flight.py')` resolves to the real file:
  ```bash
  duckdb 'md:?motherduck_token=<token>'      # or: export motherduck_token=… ; duckdb md:
  ```
  The `motherduck` extension auto-installs on first `md:` use.

  > **CLI version matters.** MotherDuck only accepts a supported DuckDB version —
  > as of this writing the newest supported is **1.5.3**, and a *newer* CLI is
  > rejected at connect with "DuckDB version … is not yet supported by
  > MotherDuck." `brew install duckdb` may give you a too-new release (it
  > installed 1.5.4 here). If the connection is refused, grab the 1.5.3 CLI
  > directly from the DuckDB GitHub releases. (This is separate from the
  > `duckdb==1.5.3` pin in `requirements.txt`, which is the *flight container's*.)

**Fallback — the MotherDuck MCP.** Zero extra setup if it's already connected to
your assistant, but two caveats this guide's SQL assumes you've handled:

- **`read_text()` will NOT work over the MCP.** The MCP runs SQL *server-side*,
  where your local files don't exist, so `read_text('flight.py')` finds nothing.
  Wherever a step uses `read_text(...)`, skip the `SET VARIABLE … read_text(…)`
  line and pass the file contents **inline** via the MCP's `create_flight` /
  `update_flight` / `save_dive` / `update_dive` tools (each takes the source as a
  string argument).
- **It's slower and escaping-prone.** Every call is a multi-second round trip and
  you hand-escape the full source (30–40 KB of TSX) as a tool argument — a real
  cause of failed pushes. For an iterative install, prefer the local CLI.

If the CLI one-liner can't run (locked-down machine, no `brew`/`curl`), use the
MCP fallback.

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

- **Database:** pick the ONE warehouse Control Tower will monitor — this choice
  is both where its `ct_*` tables are stored AND the warehouse it charts.
  Discovery is account-wide (it lists every dive and flight in the account), but
  only objects whose manifest targets **this** database are charted; objects in
  other databases are reported as **out-of-scope** rather than forced onto the
  graph. Control Tower is single-warehouse today — install one per warehouse you
  want to watch (multi-warehouse is a planned mode). List them with
  `SHOW DATABASES`.
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

(MCP path: `read_text` won't work server-side — drop the two `SET VARIABLE` lines
and pass `flight.py` / `requirements.txt` contents inline to the `create_flight`
tool instead. See *How to run the commands*.)

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
as env vars prefixed with the secret's name (not used by this flight); and
`MD_LIST_FLIGHT_RUNS` (which the flight calls to read each flight's real run
history) imports `pytz` internally — it's already in the shipped
`requirements.txt`, so a `No module named 'pytz'` error means that pin got
dropped, not that the flight is wrong.

## Step 4 — Publish the dive

Via SQL (the build-dive skill's `dive_push.py` wraps the same call if you use it):

```sql
SET VARIABLE content = (SELECT content FROM read_text('dive.tsx'));
SELECT id FROM MD_CREATE_DIVE(
  title := 'Control Tower',
  description := 'Manifest-driven ops console.',
  content := getvariable('content'));
```

(MCP path: pass `dive.tsx` contents inline to the `save_dive` tool instead of the
`read_text` line.)

**Export form matters.** The dive's entry component must be exported as
`export default <Name>` — *not* the re-export form `export { <Name> as default }`.
Both are valid ESM and a local `esbuild` accepts either, so a local check passes
while the platform push rejects the re-export form with a misleading
`default_export` error. The shipped `dive.tsx` already uses the correct form;
keep it that way if you edit the bundle's tail.

**Verify the push landed byte-for-byte** (cheap, and catches a single bad escaped
character without re-downloading):

```sql
SELECT md5(content), strlen(content) FROM MD_GET_DIVE(id := '<id>'::UUID);
```

Compare to the local file's md5 and byte count. (`strlen` gives byte length;
`octet_length` needs a `BLOB`.)

Then put the returned dive URL into the dive's own manifest (`"url":
"https://app.motherduck.com/dives/<id>"`) and push once more — the graph
node for the console should link to the console. Use the **bare-UUID** form of
the URL: `save_dive`/`update_dive` may return a cosmetic slug prefix that drifts
between calls (`…/dives/control-tower-<id>` vs `…/dives/dive-<id>`), but both
resolve by the UUID — link by it and the slug won't matter.

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
   - whether it writes a **data ledger** worth surfacing (a table with one row
     per delivery/record, for the freshness + delivery panels) — this is *not*
     where flight run health comes from; that's read automatically from run
     history (see the schema note below)
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
  "stale_hours": 36,                    // optional, flights only; see below
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

   **Run history vs. data ledger — they answer different questions.** A flight's
   health dot ("did the job run, and did it succeed?") comes from the platform's
   **run history** (`MD_LIST_FLIGHT_RUNS`), which the sync reads automatically —
   you don't declare anything for it. The optional `ledger` block points at a
   **data table** the object writes (one row per delivery/record) and answers a
   different question — "is the data fresh?" — feeding the run-log and delivery
   panels. Don't use a per-record audit table as a stand-in for run health: the
   node would track the last *record* instead of the last *run*, and a quiet
   period (no new records) would read as a failure.

   `stale_hours` is **opt-in** and flights-only: if set, a flight whose last run
   is older than that many hours shows an orange "stale" dot (use it for "this
   nightly job should have run by now"). Omit it and a quiet-but-healthy flight
   never false-alarms — failures still show red regardless.

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

Done means: the dive renders every cataloged app, every status dot has
something real behind it (flight run history, a data ledger, or a live row/view
count), and the sync runs itself on schedule from now on. New objects join the graph by carrying a manifest — that's
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
