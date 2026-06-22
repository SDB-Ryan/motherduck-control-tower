"""Control Tower Manifest Sync

Reads every deployed dive and flight in this account straight from the
MotherDuck catalog, parses each object's @manifest block, and materializes
the data-flow graph as tables the Control Tower renders:

  ct_objects  one row per graph node (code objects + derived nodes)
  ct_edges    one row per edge per view (kind = 'physical' | 'logical')
  ct_issues   everything wrong or missing (no manifest, bad JSON, drift)

Resolution rules implemented here are the ones in the skill's
references/manifest.md: physical edges from reads_from/writes_to/feeds,
logical view swaps reads_from for delivers_for, every manifest-declared
ledger table is hidden from the diagram, share->warehouse derived from
MD_LIST_DATABASE_SHARES(). The parser is the same logic as
manifest_check.py — "the lint passes" means "this flight sees it."
"""

# @manifest:begin
# {
#   "manifest_version": 1,
#   "object": "control-tower-manifest-sync",
#   "type": "flight",
#   "app": "control-tower",
#   "database": "YOUR_DATABASE",
#   "label": "Flight · daily 13:30 UTC",
#   "schedule": "30 13 * * *",
#   "url": "https://app.motherduck.com/flights",
#   "stale_hours": 36,
#   "reads_from": ["source:motherduck-catalog"],
#   "writes_to": ["table:ct_objects", "table:ct_edges", "table:ct_issues"],
#   "delivers_for": [],
#   "feeds": [],
#   "ledger": {"table": "ct_sync_ledger", "ts_column": "run_ts",
#              "status_column": "status", "ok_values": ["succeeded"]}
# }
# @manifest:end

import json
import re
from datetime import datetime, timezone

import duckdb

DATABASE = "YOUR_DATABASE"
LEDGER = "ct_sync_ledger"  # every run writes a row here, failures included

# ── manifest parser: same logic as manifest_check.py ────────────────────

MARKER_RE = re.compile(r"@manifest:begin(.*?)@manifest:end", re.DOTALL)
COMMENT_PREFIX_RE = re.compile(r"^\s*(#|//|\*)\s?")
VALID_TYPES = {"dive", "flight"}
VALID_REF_RE = re.compile(
    r"^(flight|dive|table|share|source|delivery):[a-z0-9_./-]+$")
# MD_LIST_FLIGHT_RUNS reports status as 'RUN_STATUS_SUCCEEDED' etc. — strip the
# prefix at capture so the stored value is bare ('SUCCEEDED', 'FAILED', ...).
RUN_STATUS_PREFIX_RE = re.compile(r"^RUN_STATUS_")
EDGE_FIELDS = ("reads_from", "writes_to", "delivers_for", "feeds")
REQUIRED_FIELDS = ("manifest_version", "object", "type", "app", "database")
LEDGER_FIELDS = ("table", "ts_column", "status_column", "ok_values")


def parse_manifest(source):
    """Extract and parse the manifest block. Returns (dict|None, error|None).

    (None, None) means no manifest block exists at all.
    """
    m = MARKER_RE.search(source)
    if not m:
        return None, None
    raw_lines = m.group(1).splitlines()
    stripped = "\n".join(COMMENT_PREFIX_RE.sub("", ln) for ln in raw_lines)
    stripped = stripped.replace("*/", " ").strip()
    try:
        return json.loads(stripped), None
    except json.JSONDecodeError as e:
        return None, f"manifest block found but JSON does not parse: {e}"


def validate(manifest):
    """Return a list of plain-English problems (empty list = valid)."""
    problems = []
    for f in REQUIRED_FIELDS:
        if f not in manifest:
            problems.append(f"missing required field '{f}'")
    if manifest.get("manifest_version") != 1:
        problems.append(
            f"manifest_version must be 1 (got {manifest.get('manifest_version')!r})")
    if "type" in manifest and manifest["type"] not in VALID_TYPES:
        problems.append(
            f"type must be one of {sorted(VALID_TYPES)} (got {manifest['type']!r})")
    for field in EDGE_FIELDS:
        refs = manifest.get(field, [])
        if not isinstance(refs, list):
            problems.append(f"'{field}' must be a list")
            continue
        for ref in refs:
            if not isinstance(ref, str) or not VALID_REF_RE.match(ref):
                problems.append(
                    f"'{field}' ref {ref!r} is not 'type:name' with a valid "
                    f"type (flight/dive/table/share/source/delivery) and a "
                    f"lowercase name")
    ledger = manifest.get("ledger")
    if ledger is not None:
        if not isinstance(ledger, dict):
            problems.append("'ledger' must be an object")
        else:
            for f in LEDGER_FIELDS:
                if f not in ledger:
                    problems.append(f"'ledger' is missing '{f}'")
            if "ok_values" in ledger and not isinstance(ledger["ok_values"], list):
                problems.append("'ledger.ok_values' must be a list")
            if "detail_columns" in ledger and not (
                    isinstance(ledger["detail_columns"], list)
                    and all(isinstance(c, str) for c in ledger["detail_columns"])):
                problems.append("'ledger.detail_columns' must be a list of column names")
    if "stale_hours" in manifest:
        sh = manifest["stale_hours"]
        # bool is a subclass of int — reject it explicitly.
        if isinstance(sh, bool) or not isinstance(sh, int) or sh <= 0:
            problems.append("'stale_hours' must be a positive integer (hours)")
    return problems


# ── catalog enumeration ──────────────────────────────────────────────────

def pick_function(con, candidates):
    """Flight SQL function names vary by session generation — resolve live."""
    have = {r[0] for r in con.execute(
        "SELECT DISTINCT function_name FROM duckdb_functions()"
        " WHERE function_name LIKE 'MD\\_%' ESCAPE '\\'").fetchall()}
    for name in candidates:
        if name in have:
            return name
    raise RuntimeError(f"none of {candidates} exist in this session")


def latest_run(con, runs_fn, flight_id):
    """The newest run's (timestamp, bare status) for a flight, or (None, None).

    Flight health comes from the platform's RUN HISTORY, not a data ledger: a
    data ledger answers "is the data fresh?", run history answers "did the job
    actually run?". A per-record audit table (one row per item ingested) would
    make a node track the last item instead of the last run, and a quiet period
    would read as a failure — so the run/status/timestamp dot is driven from
    MD_LIST_FLIGHT_RUNS here. Runs are ordered by run_number (sequential) so we
    don't depend on the function's internal ordering; ended_at is the true
    completion, falling back to started_at/created_at for in-flight runs."""
    row = con.execute(
        f'SELECT status, coalesce(ended_at, started_at, created_at) AS ts '
        f'FROM {runs_fn}(flight_id := ?::UUID) '
        f'ORDER BY run_number DESC LIMIT 1', [str(flight_id)]).fetchone()
    if not row or row[1] is None:
        return None, None
    return row[1], RUN_STATUS_PREFIX_RE.sub("", row[0] or "")


def enumerate_objects(con):
    """Return (kind, identity, source, deployed_schedule, last_run_ts,
    last_run_status) for every deployed dive and flight in the account.
    identity is the human name to report issues against; deployed_schedule,
    last_run_ts and last_run_status are None for dives (dives don't run)."""
    out = []

    flights_fn = pick_function(con, ["MD_LIST_FLIGHTS", "MD_FLIGHTS"])
    versions_fn = pick_function(
        con, ["MD_LIST_FLIGHT_VERSIONS", "MD_FLIGHT_VERSIONS"])
    runs_fn = pick_function(con, ["MD_LIST_FLIGHT_RUNS", "MD_FLIGHT_RUNS"])
    for fid, fname, cron in con.execute(
            f"SELECT flight_id, flight_name, schedule_cron FROM {flights_fn}()"
    ).fetchall():
        row = con.execute(
            f'SELECT source_code FROM {versions_fn}('
            '"limit" := 1, flight_id := ?::UUID)', [str(fid)]).fetchone()
        last_run_ts, last_run_status = latest_run(con, runs_fn, fid)
        out.append(("flight", fname, (row[0] or "") if row else "", cron,
                    last_run_ts, last_run_status))

    for did, title in con.execute(
            'SELECT id, title FROM MD_LIST_DIVES('
            'include_org_shares=false, "offset"=0, "limit"=500)').fetchall():
        row = con.execute(
            "SELECT content FROM MD_GET_DIVE(id=?::UUID)", [str(did)]).fetchone()
        out.append(("dive", title, (row[0] or "") if row else "", None,
                    None, None))

    return out


# ── graph build (the resolution rules) ───────────────────────────────────

def find_cycles(edges):
    """Detect cyclic topology per view ('physical' / 'logical').

    The lineage diagram is laid out as a DAG: roots are the indegree-0 nodes,
    columns are longest-path depth. A dependency loop has no root, so the board
    renders blank — and a normal root feeding into a loop blows up the column
    relaxation instead. A control tower must NAME that mistake, never silently
    vanish. Returns a list of (kind, [member_node_ids]); one entry per distinct
    cycle (self-loops included)."""
    by_kind = {}
    for src, dst, kind in edges:
        by_kind.setdefault(kind, []).append((src, dst))
    found = []
    for kind, elist in by_kind.items():
        adj, nodes = {}, set()
        for src, dst in elist:
            nodes.add(src)
            nodes.add(dst)
            adj.setdefault(src, []).append(dst)
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {n: WHITE for n in nodes}
        reported = set()
        # Iterative DFS that keeps the active path so a back-edge to a GRAY
        # node yields the actual cycle members (not just a yes/no).
        for start in nodes:
            if color[start] != WHITE:
                continue
            stack = [(start, iter(adj.get(start, ())))]
            path = [start]
            color[start] = GRAY
            while stack:
                node, it = stack[-1]
                advanced = False
                for nxt in it:
                    if color.get(nxt) == GRAY:
                        members = path[path.index(nxt):]
                        key = frozenset(members)
                        if key not in reported:
                            reported.add(key)
                            found.append((kind, list(members)))
                        advanced = True
                        break
                    if color.get(nxt) == WHITE:
                        color[nxt] = GRAY
                        path.append(nxt)
                        stack.append((nxt, iter(adj.get(nxt, ()))))
                        advanced = True
                        break
                if not advanced:
                    color[node] = BLACK
                    stack.pop()
                    path.pop()
    return found


def _is_temporal(data_type):
    dt = (data_type or "").upper()
    return any(t in dt for t in ("TIMESTAMP", "DATE", "TIME"))


def check_ledger_targets(con, nodes):
    """Confirm every code object's declared ledger table/columns exist and are
    typed correctly, against the live catalog. Sets each node's 'ledger_valid'
    (True/False; left None when no ledger is declared) and returns issue dicts
    for the invalid ones.

    Why: the dive turns each ledger declaration into executable SQL — a single
    UNION ALL across all of them. qid/qlit stop injection but cannot prove the
    target exists, and one missing/renamed table or column fails the WHOLE
    union, so every ledger-backed object silently reads 'idle'. Validating here
    lets the dive drop the known-bad object and show its owner an explicit
    config error instead of a misleading green/idle board."""
    issues = []
    rows = con.execute(
        "SELECT lower(table_name), lower(column_name), data_type "
        "FROM information_schema.columns "
        "WHERE lower(table_catalog) = lower(?)", [DATABASE]).fetchall()
    catalog = {}
    for tname, cname, dtype in rows:
        catalog.setdefault(tname, {})[cname] = dtype
    for n in nodes:
        if not n.get("ledger_table"):
            continue
        tbl = n["ledger_table"]
        cols = catalog.get(tbl.lower())
        problems = []
        if cols is None:
            problems.append(
                f"ledger table '{tbl}' was not found in {DATABASE} — health "
                f"cannot be evaluated")
        else:
            ts = n.get("ledger_ts_column")
            stc = n.get("ledger_status_column")
            if ts and ts.lower() not in cols:
                problems.append(f"ts_column '{ts}' not found in '{tbl}'")
            elif ts and not _is_temporal(cols[ts.lower()]):
                problems.append(
                    f"ts_column '{ts}' is {cols[ts.lower()]}, not a "
                    f"timestamp/date type")
            if stc and stc.lower() not in cols:
                problems.append(f"status_column '{stc}' not found in '{tbl}'")
            detail_cols = (json.loads(n["ledger_detail_columns"])
                           if n.get("ledger_detail_columns") else [])
            for dc in detail_cols:
                if isinstance(dc, str) and dc.lower() not in cols:
                    problems.append(
                        f"detail column '{dc}' not found in '{tbl}'")
        n["ledger_valid"] = not problems
        if problems:
            issues.append(dict(
                severity="error", object_key=n["node_id"],
                kind="invalid-ledger", detail="; ".join(problems)))
    return issues


def build_graph(objects, shares, hidden_keys=frozenset()):
    """objects: list of (kind, identity, source, deployed_schedule,
    last_run_ts, last_run_status).
    shares: list of (share_name, source_db_name) from the catalog.
    hidden_keys: object keys ('kind:identity') to exclude entirely — no node
    and no issue (e.g. account marker dives). See ct_hidden / sync-hidden.py.
    Returns (nodes, edges, issues)."""
    issues = []
    parsed = []  # (manifest, deployed_schedule, last_run_ts, last_run_status)
    out_of_scope = []  # (object_key, declared_database) targeting another warehouse

    for kind, identity, source, deployed_schedule, last_run_ts, \
            last_run_status in objects:
        # Intentionally hidden objects produce no node and no issue.
        if f"{kind}:{identity}" in hidden_keys:
            continue
        manifest, parse_err = parse_manifest(source)
        if parse_err:
            issues.append(dict(severity="error", object_key=f"{kind}:{identity}",
                               kind="invalid-manifest", detail=parse_err))
            continue
        if manifest is None:
            issues.append(dict(
                severity="warning", object_key=f"{kind}:{identity}",
                kind="missing-manifest",
                detail="deployed source has no @manifest block — object "
                       "will not appear on the graph"))
            continue
        problems = validate(manifest)
        if problems:
            issues.append(dict(severity="error", object_key=f"{kind}:{identity}",
                               kind="invalid-manifest", detail="; ".join(problems)))
            continue
        if manifest["type"] != kind:
            issues.append(dict(
                severity="error", object_key=f"{kind}:{identity}",
                kind="invalid-manifest",
                detail=f"manifest says type '{manifest['type']}' but the "
                       f"deployed object is a {kind}"))
            continue
        # Single-warehouse scope. The catalog listing is account-wide, but
        # Control Tower charts ONE warehouse (DATABASE). An object declaring a
        # different database is discovered but NOT charted — otherwise its
        # tables would collapse into this warehouse's box and misrepresent the
        # environment. Recorded as out-of-scope so the omission is visible, not
        # silent. (Multi-warehouse is a planned future mode.)
        if manifest.get("database") != DATABASE:
            out_of_scope.append((f"{kind}:{identity}", manifest.get("database")))
            continue
        parsed.append((manifest, deployed_schedule, last_run_ts,
                       last_run_status))

    if out_of_scope:
        others = sorted({db for _, db in out_of_scope if db})
        issues.append(dict(
            severity="warning", object_key="(environment)", kind="out-of-scope",
            detail=(f"{len(out_of_scope)} object(s) target other databases "
                    f"({', '.join(others)}) and are not charted — Control Tower "
                    f"monitors a single warehouse ('{DATABASE}'). Multi-warehouse "
                    f"support is planned.")))

    # Every manifest-declared ledger table is ops plumbing: hidden from the
    # diagram in both views, never materialized as a node.
    hidden = {f"table:{m['ledger']['table']}"
              for m, *_ in parsed if m.get("ledger")}

    nodes = {}     # node_id -> dict
    edges = set()  # (src, dst, kind)

    def declare_node(node_id, declaring_app):
        if node_id in nodes:
            return
        ntype, name = node_id.split(":", 1)
        nodes[node_id] = dict(
            node_id=node_id, node_type=ntype, name=name, app=declaring_app,
            database=DATABASE, label=ntype.capitalize(), url=None,
            schedule_declared=None, schedule_deployed=None,
            source_kind="derived", has_manifest=False,
            ledger_table=None, ledger_ts_column=None,
            ledger_status_column=None, ledger_ok_values=None,
            ledger_detail_columns=None, ledger_valid=None,
            last_run_ts=None, last_run_status=None, stale_hours=None)

    for m, deployed_schedule, last_run_ts, last_run_status in parsed:
        node_id = f"{m['type']}:{m['object']}"
        ledger = m.get("ledger") or {}
        nodes[node_id] = dict(
            node_id=node_id, node_type=m["type"], name=m["object"],
            app=m["app"], database=m["database"],
            label=m.get("label") or m["type"].capitalize(),
            url=m.get("url") or None,
            schedule_declared=m.get("schedule"),
            schedule_deployed=deployed_schedule,
            source_kind="code", has_manifest=True,
            ledger_table=ledger.get("table"),
            ledger_ts_column=ledger.get("ts_column"),
            ledger_status_column=ledger.get("status_column"),
            ledger_ok_values=json.dumps(ledger["ok_values"]) if ledger else None,
            ledger_detail_columns=(json.dumps(ledger["detail_columns"])
                                   if ledger.get("detail_columns") else None),
            # Validated against the live catalog later (check_ledger_targets);
            # None here means "not yet checked / no ledger declared".
            ledger_valid=None,
            # Flight health from run history (None for dives, which don't run);
            # stale_hours is opt-in per object (None ⇒ no staleness alarm).
            last_run_ts=last_run_ts, last_run_status=last_run_status,
            stale_hours=m.get("stale_hours"))
        if (m.get("schedule") and deployed_schedule
                and m["schedule"] != deployed_schedule):
            issues.append(dict(
                severity="warning", object_key=node_id, kind="schedule-drift",
                detail=f"manifest declares cron '{m['schedule']}' but the "
                       f"deployed schedule is '{deployed_schedule}'"))

    for m, *_ in parsed:
        node_id = f"{m['type']}:{m['object']}"
        reads = [r for r in m.get("reads_from", []) if r not in hidden]
        writes = [r for r in m.get("writes_to", []) if r not in hidden]
        feeds = [r for r in m.get("feeds", []) if r not in hidden]
        delivers = [r for r in m.get("delivers_for", []) if r not in hidden]

        for ref in reads + writes + feeds + delivers:
            declare_node(ref, m["app"])

        # Rule 1 — physical: reads -> object -> writes + feeds.
        for r in reads:
            edges.add((r, node_id, "physical"))
        for r in writes + feeds:
            edges.add((node_id, r, "physical"))
        # Rule 2 — logical: identical, except delivers_for (when declared)
        # replaces the incoming reads_from edges.
        for r in (delivers if delivers else reads):
            edges.add((r, node_id, "logical"))
        for r in writes + feeds:
            edges.add((node_id, r, "logical"))

    # Derived from the catalog (never declared): the warehouse node and the
    # warehouse -> share edge for every share sourced from this database.
    for share_name, source_db in shares:
        if source_db != DATABASE:
            continue
        wh = f"warehouse:{source_db}"
        if wh not in nodes:
            nodes[wh] = dict(
                node_id=wh, node_type="warehouse", name=source_db,
                app=None, database=source_db, label="Warehouse",
                url="https://app.motherduck.com",
                schedule_declared=None, schedule_deployed=None,
                source_kind="derived", has_manifest=False,
                ledger_table=None, ledger_ts_column=None,
                ledger_status_column=None, ledger_ok_values=None,
                ledger_detail_columns=None, ledger_valid=None,
                last_run_ts=None, last_run_status=None, stale_hours=None)
        declare_node(f"share:{share_name}", None)
        edges.add((wh, f"share:{share_name}", "physical"))
        edges.add((wh, f"share:{share_name}", "logical"))

    # Topology must be acyclic per view — report loops as errors so the dive
    # can draw a named error panel instead of a blank or runaway board.
    for kind, members in find_cycles(edges):
        issues.append(dict(
            severity="error", object_key=members[0], kind="cycle",
            detail=(f"dependency cycle in the {kind} view: "
                    + " → ".join(members + [members[0]])
                    + " — the lineage graph cannot be drawn until this loop "
                      "is removed")))

    return list(nodes.values()), sorted(edges), issues


# ── transactional write + verify ─────────────────────────────────────────

def write_graph(con, nodes, edges, issues, synced_at):
    con.execute("BEGIN")
    con.execute("""
        CREATE OR REPLACE TABLE ct_objects (
          node_id VARCHAR, node_type VARCHAR, name VARCHAR, app VARCHAR,
          database VARCHAR, label VARCHAR, url VARCHAR,
          schedule_declared VARCHAR, schedule_deployed VARCHAR,
          source_kind VARCHAR, has_manifest BOOLEAN,
          ledger_table VARCHAR, ledger_ts_column VARCHAR,
          ledger_status_column VARCHAR, ledger_ok_values VARCHAR,
          ledger_detail_columns VARCHAR, ledger_valid BOOLEAN,
          last_run_ts TIMESTAMPTZ, last_run_status VARCHAR,
          stale_hours INTEGER,
          synced_at TIMESTAMPTZ)""")
    con.execute("""
        CREATE OR REPLACE TABLE ct_edges (
          src_node VARCHAR, dst_node VARCHAR, kind VARCHAR,
          synced_at TIMESTAMPTZ)""")
    con.execute("""
        CREATE OR REPLACE TABLE ct_issues (
          severity VARCHAR, object_key VARCHAR, kind VARCHAR,
          detail VARCHAR, synced_at TIMESTAMPTZ)""")
    # A fresh account can legitimately produce an empty graph (no manifests
    # yet) — executemany rejects empty parameter lists, so guard each one.
    if nodes:
        con.executemany(
            "INSERT INTO ct_objects VALUES "
            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [[n["node_id"], n["node_type"], n["name"], n["app"], n["database"],
              n["label"], n["url"], n["schedule_declared"], n["schedule_deployed"],
              n["source_kind"], n["has_manifest"], n["ledger_table"],
              n["ledger_ts_column"], n["ledger_status_column"],
              n["ledger_ok_values"], n["ledger_detail_columns"], n["ledger_valid"],
              n["last_run_ts"], n["last_run_status"], n["stale_hours"], synced_at]
             for n in nodes])
    if edges:
        con.executemany(
            "INSERT INTO ct_edges VALUES (?,?,?,?)",
            [[s, d, k, synced_at] for s, d, k in edges])
    if issues:
        con.executemany(
            "INSERT INTO ct_issues VALUES (?,?,?,?,?)",
            [[i["severity"], i["object_key"], i["kind"], i["detail"],
              synced_at] for i in issues])
    con.execute("COMMIT")

    # Verify the writes landed exactly (per skill data-safety rules).
    got = tuple(con.execute(
        "SELECT (SELECT count(*) FROM ct_objects),"
        "       (SELECT count(*) FROM ct_edges),"
        "       (SELECT count(*) FROM ct_issues)").fetchone())
    expected = (len(nodes), len(edges), len(issues))
    if got != expected:
        raise RuntimeError(
            f"post-write verification failed: expected {expected} rows "
            f"(objects, edges, issues), found {got}")


# ── ledger plumbing (template pattern) ───────────────────────────────────

def ensure_ledger(con):
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {LEDGER} ("
        " run_ts TIMESTAMPTZ, status VARCHAR, detail VARCHAR, error VARCHAR)")


def ensure_hidden(con):
    # Objects intentionally excluded from the graph + issues (e.g. account
    # marker dives). Populated out-of-band (sync-hidden.py); persists across
    # runs — the flight only CREATE-OR-REPLACEs ct_objects/edges/issues.
    con.execute(
        "CREATE TABLE IF NOT EXISTS ct_hidden ("
        " object_key VARCHAR, reason VARCHAR, hidden_at TIMESTAMPTZ)")


def write_ledger(con, status, detail="", error=""):
    con.execute(f"INSERT INTO {LEDGER} VALUES (?, ?, ?, ?)",
                [datetime.now(timezone.utc), status, detail, error])


def main():
    con = duckdb.connect(f"md:{DATABASE}")
    # The flight container's TZ resolves to 'Etc/Unknown', which breaks
    # TIMESTAMPTZ fetches — pin the session before touching timestamps.
    con.execute("SET TimeZone='UTC'")
    ensure_ledger(con)
    ensure_hidden(con)
    try:
        objects = enumerate_objects(con)
        print(f"enumerated {len(objects)} deployed objects:")
        for kind, identity, source, sched, last_ts, last_status in objects:
            print(f"  {kind:7s} {identity}  ({len(source)} chars"
                  + (f", cron {sched}" if sched else "")
                  + (f", last run {last_status}" if last_status else "") + ")")

        shares = con.execute(
            "SELECT name, source_db_name FROM MD_LIST_DATABASE_SHARES()"
        ).fetchall()

        hidden_keys = {r[0] for r in con.execute(
            "SELECT object_key FROM ct_hidden").fetchall()}
        if hidden_keys:
            print(f"hiding {len(hidden_keys)} object(s): "
                  + ", ".join(sorted(hidden_keys)))
        nodes, edges, issues = build_graph(objects, shares, hidden_keys)
        # Validate every declared ledger against the live catalog (sets
        # ledger_valid on each node; adds an issue per invalid contract).
        issues += check_ledger_targets(con, nodes)
        synced_at = datetime.now(timezone.utc)
        write_graph(con, nodes, edges, issues, synced_at)

        print(f"\ngraph: {len(nodes)} nodes, {len(edges)} edges, "
              f"{len(issues)} issues")
        for n in sorted(nodes, key=lambda n: n["node_id"]):
            print(f"  node {n['node_id']:45s} app={n['app']} "
                  f"[{n['source_kind']}]")
        for s, d, k in edges:
            print(f"  edge [{k:8s}] {s} -> {d}")
        for i in issues:
            print(f"  issue [{i['severity']}] {i['object_key']}: "
                  f"{i['kind']} — {i['detail']}")

        detail = (f"{len(nodes)} nodes, {len(edges)} edges, "
                  f"{len(issues)} issues from {len(objects)} objects")
        write_ledger(con, "succeeded", detail)
        print(f"\nct_sync_ledger: succeeded — {detail}")
    except Exception as e:
        # Self-report the crash: the ledger must never look healthy (or
        # empty) while the flight is broken. Roll back any open transaction
        # first so the ledger write itself can land.
        try:
            con.execute("ROLLBACK")
        except Exception:
            pass
        write_ledger(con, "failed", "", f"{type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
