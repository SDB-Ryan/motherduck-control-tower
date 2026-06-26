"""Control Tower Collector

One flight per account — there is NO separate merge flight. Reads this account's
manifest **registry table** (ct_registry, authored by the build-manifest skill, not
parsed from object source), enumerates the account's deployed dives/flights to
reconcile + pull run history, reads the raw ledgers/catalog LOCALLY, and writes the
account's data-flow graph into CT_DATABASE.SCHEMA:

  ct_objects / ct_edges / ct_issues       the graph
  ct_health / ct_runlog / ct_deliveries   precomputed ops panels (so the dive never
                                          queries raw ledger tables)
  ct_vitals                               table/view row counts for charted warehouses
  ct_meta                                 this account's freshness (account, collected_at)

If this is the MAIN account (IS_MAIN), the flight ALSO folds in every other account's
shared control_tower: it DETACH/ATTACHes each INBOUND_SHARES entry fresh, reads its
ct_* over the read-only share, and unions them into this account's graph IN MEMORY
before writing — dedup by node id (this account wins a clash), cycle detection re-run
on the merged edges, node-collision + stale-account flagged. No self-loop: the main
account re-collects its own graph fresh and reads the OTHER accounts' (different)
databases — it never reads-then-writes its own tables. At N=1 there are no shares, so
it's just collect → write.

Stamped per account (control-tower.config.json): ACCOUNT, CT_DATABASE, SCHEMA,
CHARTED_DATABASES (a list → multi-warehouse), IS_MAIN, INBOUND_SHARES. The original
single `DATABASE` constant's four jobs (write target / charted warehouse / scope /
ledger catalog) are now independent.
"""

# Lineage for this object is cataloged in ct_registry (authored via the
# build-manifest skill), NOT in an in-source @manifest block. The registry is the
# single source of truth; nothing here is parsed at runtime.
# (Documentation only — the collector is cataloged in ct_registry like any object;
#  this block is no longer parsed.)

import json
import re
from datetime import datetime, timedelta, timezone

import duckdb

# ── stamped at deploy (per account, from control-tower.config.json) ──────────
ACCOUNT = "YOUR_ACCOUNT"
CT_DATABASE = "control_tower"
SCHEMA = "main"                # single schema: ct_* AND ct_registry all live here
CHARTED_DATABASES = ["YOUR_DATABASE"]
IS_MAIN = True                 # the main account folds other accounts' shares into its own graph
INBOUND_SHARES = []  # main only: see INSTALL Step 6
STALE_HOURS = 36              # a folded-in share older than this raises a stale-account issue
LEDGER = "ct_sync_ledger"     # the collector's own run ledger (in CT_DATABASE.SCHEMA)


def qid(name):
    return '"' + str(name).replace('"', '""') + '"'


def qlit(val):
    return "'" + str(val).replace("'", "''") + "'"


def fqtn(db, schema, table):
    return f"{qid(db)}.{qid(schema)}.{qid(table)}"


CT = f"{qid(CT_DATABASE)}.{qid(SCHEMA)}"  # qualified Control Tower schema (control_tower.main)


# === SCHEMA MIRROR START (keep identical to build-manifest/scripts/_manifest_schema.py) ===
# Verified by build-manifest/scripts/test_schema_parity.py — do not edit one without the other.
VALID_TYPES = {"dive", "flight"}
VALID_REF_RE = re.compile(
    r"^(flight|dive|table|share|source|delivery|database):[a-z0-9_./-]+$")
EDGE_FIELDS = ("reads_from", "writes_to", "delivers_for", "feeds")
REQUIRED_FIELDS = ("manifest_version", "object", "type", "app", "database")
LEDGER_FIELDS = ("table", "ts_column", "status_column", "ok_values")

REGISTRY_COLUMNS = (
    "object", "deployed_name", "type", "app", "database", "label", "url",
    "schedule", "stale_hours", "reads_from", "writes_to", "delivers_for",
    "feeds", "ledger_table", "ledger_ts_column", "ledger_status_column",
    "ledger_ok_values", "ledger_detail_columns", "manifest_version",
    "updated_at", "updated_by",
)

REGISTRY_DDL = """
CREATE TABLE IF NOT EXISTS {schema}.ct_registry (
  object        VARCHAR,
  deployed_name VARCHAR,
  type          VARCHAR,
  app           VARCHAR,
  database      VARCHAR,
  label         VARCHAR,
  url           VARCHAR,
  schedule      VARCHAR,
  stale_hours   INTEGER,
  reads_from    VARCHAR,
  writes_to     VARCHAR,
  delivers_for  VARCHAR,
  feeds         VARCHAR,
  ledger_table          VARCHAR,
  ledger_ts_column      VARCHAR,
  ledger_status_column  VARCHAR,
  ledger_ok_values      VARCHAR,
  ledger_detail_columns VARCHAR,
  manifest_version INTEGER,
  updated_at    TIMESTAMPTZ,
  updated_by    VARCHAR
)
"""


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
                    f"'{field}' ref {ref!r} is not 'type:name' with a valid type "
                    f"(flight/dive/table/share/source/delivery/database) and a "
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
        if isinstance(sh, bool) or not isinstance(sh, int) or sh <= 0:
            problems.append("'stale_hours' must be a positive integer (hours)")
    return problems


def row_to_manifest(r):
    """Rebuild a manifest dict from a ct_registry row (dict keyed by column name)."""
    def arr(v):
        return json.loads(v) if v else []
    m = {
        "manifest_version": r.get("manifest_version") or 1,
        "object": r.get("object"),
        "type": r.get("type"),
        "app": r.get("app"),
        "database": r.get("database"),
        "reads_from": arr(r.get("reads_from")),
        "writes_to": arr(r.get("writes_to")),
        "delivers_for": arr(r.get("delivers_for")),
        "feeds": arr(r.get("feeds")),
    }
    for opt in ("label", "url", "schedule"):
        if r.get(opt) is not None:
            m[opt] = r[opt]
    if r.get("stale_hours") is not None:
        m["stale_hours"] = r["stale_hours"]
    if r.get("ledger_table"):
        ledger = {
            "table": r.get("ledger_table"),
            "ts_column": r.get("ledger_ts_column"),
            "status_column": r.get("ledger_status_column"),
            "ok_values": arr(r.get("ledger_ok_values")),
        }
        if r.get("ledger_detail_columns"):
            ledger["detail_columns"] = arr(r.get("ledger_detail_columns"))
        m["ledger"] = ledger
    return m
# === SCHEMA MIRROR END ===


# ── catalog enumeration (run history + reconcile; NO source parsing) ─────────

RUN_STATUS_PREFIX_RE = re.compile(r"^RUN_STATUS_")


def pick_function(con, candidates):
    have = {r[0] for r in con.execute(
        "SELECT DISTINCT function_name FROM duckdb_functions()"
        " WHERE function_name LIKE 'MD\\_%' ESCAPE '\\'").fetchall()}
    for name in candidates:
        if name in have:
            return name
    raise RuntimeError(f"none of {candidates} exist in this session")


def latest_run(con, runs_fn, flight_id):
    row = con.execute(
        f'SELECT status, coalesce(ended_at, started_at, created_at) AS ts '
        f'FROM {runs_fn}(flight_id := ?::UUID) '
        f'ORDER BY run_number DESC LIMIT 1', [str(flight_id)]).fetchone()
    if not row or row[1] is None:
        return None, None
    return row[1], RUN_STATUS_PREFIX_RE.sub("", row[0] or "")


def enumerate_deployed(con):
    """Return {(type, name): {flight_id, deployed_schedule, last_run_ts,
    last_run_status}} for every deployed flight + dive in THIS account. Only used
    to reconcile against the registry and to pull live run history — never to read
    manifests (those come from ct_registry)."""
    out = {}
    flights_fn = pick_function(con, ["MD_LIST_FLIGHTS", "MD_FLIGHTS"])
    runs_fn = pick_function(con, ["MD_LIST_FLIGHT_RUNS", "MD_FLIGHT_RUNS"])
    for fid, fname, cron in con.execute(
            f"SELECT flight_id, flight_name, schedule_cron FROM {flights_fn}()"
    ).fetchall():
        last_run_ts, last_run_status = latest_run(con, runs_fn, fid)
        out[("flight", fname)] = dict(
            flight_id=fid, deployed_schedule=cron,
            last_run_ts=last_run_ts, last_run_status=last_run_status)
    for did, title in con.execute(
            'SELECT id, title FROM MD_LIST_DIVES('
            'include_org_shares=false, "offset"=0, "limit"=500)').fetchall():
        out[("dive", title)] = dict(
            flight_id=None, deployed_schedule=None,
            last_run_ts=None, last_run_status=None)
    return out


def read_registry(con):
    """Read ct_registry → list of (manifest_dict, deployed_name). Ensures the
    table exists first (a fresh deploy may run before any cataloging)."""
    con.execute(REGISTRY_DDL.format(schema=CT))
    cols = ", ".join(qid(c) for c in REGISTRY_COLUMNS)
    rows = con.execute(f"SELECT {cols} FROM {CT}.ct_registry").fetchall()
    out = []
    for r in rows:
        d = dict(zip(REGISTRY_COLUMNS, r))
        m = row_to_manifest(d)
        out.append((m, d.get("deployed_name") or m.get("object")))
    return out


# ── graph build (resolution rules — reused from the original) ────────────────

def find_cycles(edges):
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
    """Validate each node's declared ledger table/columns against the live catalog
    of ITS OWN database (per-db, not a single warehouse). Sets node['ledger_valid']
    and returns issue dicts for invalid ones."""
    issues = []
    # One catalog dict per charted db: {db: {table: {col: dtype}}}.
    # duckdb_columns() spans every attached database; per-catalog information_schema
    # is NOT exposed on a bare md: connection (verified live during migration).
    catalogs = {}
    for db in CHARTED_DATABASES:
        cat = {}
        for tname, cname, dtype in con.execute(
                "SELECT lower(table_name), lower(column_name), data_type "
                "FROM duckdb_columns() WHERE database_name = ?", [db]).fetchall():
            cat.setdefault(tname, {})[cname] = dtype
        catalogs[db] = cat
    for n in nodes:
        if not n.get("ledger_table"):
            continue
        db = n.get("database")
        catalog = catalogs.get(db, {})
        tbl = n["ledger_table"]
        cols = catalog.get(tbl.lower())
        problems = []
        if cols is None:
            problems.append(
                f"ledger table '{tbl}' was not found in {db} — health cannot be "
                f"evaluated")
        else:
            ts = n.get("ledger_ts_column")
            stc = n.get("ledger_status_column")
            if ts and ts.lower() not in cols:
                problems.append(f"ts_column '{ts}' not found in '{tbl}'")
            elif ts and not _is_temporal(cols[ts.lower()]):
                problems.append(
                    f"ts_column '{ts}' is {cols[ts.lower()]}, not a timestamp/date type")
            if stc and stc.lower() not in cols:
                problems.append(f"status_column '{stc}' not found in '{tbl}'")
            detail_cols = (json.loads(n["ledger_detail_columns"])
                           if n.get("ledger_detail_columns") else [])
            for dc in detail_cols:
                if isinstance(dc, str) and dc.lower() not in cols:
                    problems.append(f"detail column '{dc}' not found in '{tbl}'")
        n["ledger_valid"] = not problems
        if problems:
            issues.append(dict(
                severity="error", object_key=n["node_id"],
                kind="invalid-ledger", detail="; ".join(problems)))
    return issues


def build_graph(registry, deployed, shares, hidden_keys=frozenset()):
    """registry: list of (manifest_dict, deployed_name).
    deployed: {(type, name): {flight_id, deployed_schedule, last_run_ts, last_run_status}}.
    shares: list of (share_name, source_db_name).
    Returns (nodes, edges, issues)."""
    issues = []
    parsed = []  # (m, deployed_name, deployed_schedule, last_run_ts, last_run_status)
    out_of_scope = []
    registry_keys = set()

    for m, deployed_name in registry:
        key = (m.get("type"), deployed_name)
        registry_keys.add(key)
        hidden_key = f"{m.get('type')}:{deployed_name}"
        if hidden_key in hidden_keys:
            continue
        problems = validate(m)
        if problems:
            issues.append(dict(severity="error", object_key=hidden_key,
                               kind="invalid-manifest", detail="; ".join(problems)))
            continue
        if m["database"] not in CHARTED_DATABASES:
            out_of_scope.append((hidden_key, m["database"]))
            continue
        d = deployed.get((m["type"], deployed_name), {})
        parsed.append((m, deployed_name, d.get("deployed_schedule"),
                       d.get("last_run_ts"), d.get("last_run_status")))

    # Reconcile registry vs what's actually deployed. Intentionally-hidden objects
    # are excluded from both checks — they produce no node and no issue.
    for t, n in sorted(deployed.keys() - registry_keys):
        if f"{t}:{n}" in hidden_keys:
            continue
        issues.append(dict(
            severity="warning", object_key=f"{t}:{n}", kind="missing-manifest",
            detail="deployed object has no ct_registry row — catalog it with the "
                   "build-manifest skill so it appears on the graph"))
    for t, n in sorted(registry_keys - set(deployed.keys())):
        if f"{t}:{n}" in hidden_keys:
            continue
        issues.append(dict(
            severity="warning", object_key=f"{t}:{n}", kind="orphan-registry",
            detail="ct_registry row has no matching deployed object — it was "
                   "deleted or renamed; remove the stale registry row"))

    if out_of_scope:
        others = sorted({db for _, db in out_of_scope if db})
        issues.append(dict(
            severity="warning", object_key="(environment)", kind="out-of-scope",
            detail=(f"{len(out_of_scope)} object(s) target databases not charted "
                    f"by this account ({', '.join(others)}); charted: "
                    f"{', '.join(CHARTED_DATABASES)}.")))

    # Manifest-declared ledger tables are ops plumbing: hidden from the diagram.
    hidden = {f"table:{m['ledger']['table']}"
              for m, *_ in parsed if m.get("ledger")}
    # Control Tower's own bookkeeping tables (ct_*) are plumbing too — never chart
    # them as nodes (they live in CT_DATABASE, not a charted warehouse anyway).
    for m, *_ in parsed:
        for ref in (m.get("reads_from", []) + m.get("writes_to", [])
                    + m.get("feeds", []) + m.get("delivers_for", [])):
            if ref.startswith("table:ct_"):
                hidden.add(ref)

    nodes = {}
    edges = set()

    def declare_node(node_id, declaring_app, declaring_db):
        if node_id in nodes:
            return
        ntype, name = node_id.split(":", 1)
        nodes[node_id] = dict(
            node_id=node_id, node_type=ntype, name=name, app=declaring_app,
            database=declaring_db, label=ntype.capitalize(), url=None,
            schedule_declared=None, schedule_deployed=None,
            source_kind="derived", has_manifest=False,
            ledger_table=None, ledger_ts_column=None,
            ledger_status_column=None, ledger_ok_values=None,
            ledger_detail_columns=None, ledger_valid=None,
            last_run_ts=None, last_run_status=None, stale_hours=None)

    for m, deployed_name, deployed_schedule, last_run_ts, last_run_status in parsed:
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
            ledger_valid=None,
            last_run_ts=last_run_ts, last_run_status=last_run_status,
            stale_hours=m.get("stale_hours"))
        if (m.get("schedule") and deployed_schedule
                and m["schedule"] != deployed_schedule):
            issues.append(dict(
                severity="warning", object_key=node_id, kind="schedule-drift",
                detail=f"manifest declares cron '{m['schedule']}' but the "
                       f"deployed schedule is '{deployed_schedule}'"))

    # A database:<db> ref resolves to that database's warehouse node, so it unifies
    # with derived warehouse nodes and the table-collapse target — letting an object
    # declare "reads/writes this whole database" (database-to-database lineage).
    def norm(r):
        return ("warehouse:" + r.split(":", 1)[1]) if r.startswith("database:") else r

    for m, *_ in parsed:
        node_id = f"{m['type']}:{m['object']}"
        reads = [norm(r) for r in m.get("reads_from", []) if r not in hidden]
        writes = [norm(r) for r in m.get("writes_to", []) if r not in hidden]
        feeds = [norm(r) for r in m.get("feeds", []) if r not in hidden]
        delivers = [norm(r) for r in m.get("delivers_for", []) if r not in hidden]
        for ref in reads + writes + feeds + delivers:
            declare_node(ref, m["app"], m["database"])
        for r in reads:
            edges.add((r, node_id, "physical"))
        for r in writes + feeds:
            edges.add((node_id, r, "physical"))
        for r in (delivers if delivers else reads):
            edges.add((r, node_id, "logical"))
        for r in writes + feeds:
            edges.add((node_id, r, "logical"))

    # Derived from the catalog: warehouse node + warehouse->share edge per share
    # sourced from a charted db.
    for share_name, source_db in shares:
        if source_db not in CHARTED_DATABASES:
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
        declare_node(f"share:{share_name}", None, source_db)
        edges.add((wh, f"share:{share_name}", "physical"))
        edges.add((wh, f"share:{share_name}", "logical"))

    for kind, members in find_cycles(edges):
        issues.append(dict(
            severity="error", object_key=members[0], kind="cycle",
            detail=(f"dependency cycle in the {kind} view: "
                    + " → ".join(members + [members[0]])
                    + " — the lineage graph cannot be drawn until this loop "
                      "is removed")))

    return list(nodes.values()), sorted(edges), issues


# ── precomputed ops panels (moved out of the dive; read raw ledgers LOCALLY) ──

def _ledger_nodes(nodes):
    return [n for n in nodes
            if n.get("ledger_table") and n.get("ledger_valid") is True]


def compute_health(con, nodes):
    """Per-object freshness — replaces the dive's healthSql. last_ts is raw so the
    dive can compute age client-side."""
    rows = []
    for n in _ledger_nodes(nodes):
        ts, st = n["ledger_ts_column"], n["ledger_status_column"]
        ok = json.loads(n.get("ledger_ok_values") or "[]")
        ok_sql = ",".join(qlit(v) for v in ok) or "''"
        q = (f"SELECT strftime(max({qid(ts)}), '%b %d %H:%M') AS last_at, "
             f"max({qid(ts)}) AS last_ts, "
             f"(any_value({qid(st)} ORDER BY {qid(ts)} DESC) IN ({ok_sql})) AS is_ok, "
             f"any_value({qid(st)} ORDER BY {qid(ts)} DESC) AS last_status "
             f"FROM {fqtn(n['database'], 'main', n['ledger_table'])}")
        try:
            r = con.execute(q).fetchone()
            rows.append(dict(node_id=n["node_id"], last_at=r[0], last_ts=r[1],
                             is_ok=r[2], last_status=r[3]))
        except Exception:
            pass  # validated but unreadable this run — skip rather than fail the run
    return rows


def compute_runlog(con, nodes, per_object=20):
    """Recent run-log rows — replaces the dive's runlogSql. Keeps up to per_object
    per object so the merged global top-10 is correct."""
    rows = []
    for n in _ledger_nodes(nodes):
        ts, st = n["ledger_ts_column"], n["ledger_status_column"]
        q = (f"SELECT {qid(ts)} AS ts, strftime({qid(ts)}, '%b %d %H:%M') AS run_at, "
             f"{qlit(n['node_id'])} AS node_id, {qlit(n['name'])} AS object_name, "
             f"{qid(st)} AS status "
             f"FROM {fqtn(n['database'], 'main', n['ledger_table'])} "
             f"ORDER BY {qid(ts)} DESC LIMIT {int(per_object)}")
        try:
            for r in con.execute(q).fetchall():
                rows.append(dict(ts=r[0], run_at=r[1], node_id=r[2],
                                 object_name=r[3], status=r[4]))
        except Exception:
            pass
    return rows


def compute_deliveries(con, nodes, edges, per_object=8):
    """Recent delivery rows — replaces the dive's deliveriesSql. A delivery flight
    is one with a valid ledger + detail_columns that feeds a delivery: node.
    Collapsed to (recipient, status, is_ok) so the dive does no dynamic SQL."""
    delivery_srcs = {src for src, dst, kind in edges
                     if dst.startswith("delivery:") and kind == "physical"}
    rows = []
    for n in _ledger_nodes(nodes):
        if n["node_id"] not in delivery_srcs:
            continue
        detail = json.loads(n.get("ledger_detail_columns") or "[]")
        st = n["ledger_status_column"]
        ts = n["ledger_ts_column"]
        recipient = next((c for c in detail if c != st), None)
        ok = json.loads(n.get("ledger_ok_values") or "[]")
        ok_sql = ",".join(qlit(v) for v in ok) or "''"
        rec_sel = f"{qid(recipient)}" if recipient else "NULL"
        q = (f"SELECT strftime({qid(ts)}, '%b %d %H:%M') AS delivered_at, "
             f"{qid(ts)} AS ts, {rec_sel} AS recipient, {qid(st)} AS status, "
             f"({qid(st)} IN ({ok_sql})) AS is_ok "
             f"FROM {fqtn(n['database'], 'main', n['ledger_table'])} "
             f"ORDER BY {qid(ts)} DESC LIMIT {int(per_object)}")
        try:
            for r in con.execute(q).fetchall():
                rows.append(dict(node_id=n["node_id"], app=n["app"],
                                 delivered_at=r[0], ts=r[1], recipient=r[2],
                                 status=r[3], is_ok=r[4]))
        except Exception:
            pass
    return rows


def compute_vitals(con):
    """Table/view row counts per charted db — replaces the dive's vitalsQ."""
    rows = []
    for db in CHARTED_DATABASES:
        try:
            res = con.execute(
                f"SELECT table_name, estimated_size AS n, 'table' AS kind "
                f"FROM duckdb_tables() WHERE database_name = {qlit(db)} "
                f"UNION ALL "
                f"SELECT view_name AS table_name, NULL AS n, 'view' AS kind "
                f"FROM duckdb_views() WHERE database_name = {qlit(db)} AND NOT internal"
            ).fetchall()
        except Exception:
            res = []
        for name, n, kind in res:
            rows.append(dict(database=db, name=name, kind=kind, n=n))
    return rows


# ── transactional write + verify (into CT_DATABASE.CT_SCHEMA) ─────────────

def write_graph(con, nodes, edges, issues, health, runlog, deliveries, vitals,
                synced_at):
    con.execute("BEGIN")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_objects (
          node_id VARCHAR, node_type VARCHAR, name VARCHAR, app VARCHAR,
          database VARCHAR, label VARCHAR, url VARCHAR,
          schedule_declared VARCHAR, schedule_deployed VARCHAR,
          source_kind VARCHAR, has_manifest BOOLEAN,
          ledger_table VARCHAR, ledger_ts_column VARCHAR,
          ledger_status_column VARCHAR, ledger_ok_values VARCHAR,
          ledger_detail_columns VARCHAR, ledger_valid BOOLEAN,
          last_run_ts TIMESTAMPTZ, last_run_status VARCHAR,
          stale_hours INTEGER, source_account VARCHAR, synced_at TIMESTAMPTZ)""")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_edges (
          src_node VARCHAR, dst_node VARCHAR, kind VARCHAR,
          source_account VARCHAR, synced_at TIMESTAMPTZ)""")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_issues (
          severity VARCHAR, object_key VARCHAR, kind VARCHAR,
          detail VARCHAR, source_account VARCHAR, synced_at TIMESTAMPTZ)""")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_health (
          node_id VARCHAR, last_at VARCHAR, last_ts TIMESTAMPTZ,
          is_ok BOOLEAN, last_status VARCHAR,
          source_account VARCHAR, synced_at TIMESTAMPTZ)""")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_runlog (
          ts TIMESTAMPTZ, run_at VARCHAR, node_id VARCHAR,
          object_name VARCHAR, status VARCHAR,
          source_account VARCHAR, synced_at TIMESTAMPTZ)""")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_deliveries (
          node_id VARCHAR, app VARCHAR, delivered_at VARCHAR, ts TIMESTAMPTZ,
          recipient VARCHAR, status VARCHAR, is_ok BOOLEAN,
          source_account VARCHAR, synced_at TIMESTAMPTZ)""")
    con.execute(f"""
        CREATE OR REPLACE TABLE {CT}.ct_vitals (
          database VARCHAR, name VARCHAR, kind VARCHAR, n BIGINT,
          source_account VARCHAR, synced_at TIMESTAMPTZ)""")

    if nodes:
        con.executemany(
            f"INSERT INTO {CT}.ct_objects VALUES "
            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [[n["node_id"], n["node_type"], n["name"], n["app"], n["database"],
              n["label"], n["url"], n["schedule_declared"], n["schedule_deployed"],
              n["source_kind"], n["has_manifest"], n["ledger_table"],
              n["ledger_ts_column"], n["ledger_status_column"],
              n["ledger_ok_values"], n["ledger_detail_columns"], n["ledger_valid"],
              n["last_run_ts"], n["last_run_status"], n["stale_hours"],
              n.get("source_account", ACCOUNT), synced_at] for n in nodes])
    if edges:
        con.executemany(
            f"INSERT INTO {CT}.ct_edges VALUES (?,?,?,?,?)",
            [[s, d, k, ACCOUNT, synced_at] for s, d, k in edges])
    if issues:
        con.executemany(
            f"INSERT INTO {CT}.ct_issues VALUES (?,?,?,?,?,?)",
            [[i["severity"], i["object_key"], i["kind"], i["detail"],
              i.get("source_account", ACCOUNT), synced_at] for i in issues])
    if health:
        con.executemany(
            f"INSERT INTO {CT}.ct_health VALUES (?,?,?,?,?,?,?)",
            [[h["node_id"], h["last_at"], h["last_ts"], h["is_ok"],
              h["last_status"], h.get("source_account", ACCOUNT), synced_at] for h in health])
    if runlog:
        con.executemany(
            f"INSERT INTO {CT}.ct_runlog VALUES (?,?,?,?,?,?,?)",
            [[r["ts"], r["run_at"], r["node_id"], r["object_name"], r["status"],
              r.get("source_account", ACCOUNT), synced_at] for r in runlog])
    if deliveries:
        con.executemany(
            f"INSERT INTO {CT}.ct_deliveries VALUES (?,?,?,?,?,?,?,?,?)",
            [[d["node_id"], d["app"], d["delivered_at"], d["ts"], d["recipient"],
              d["status"], d["is_ok"], d.get("source_account", ACCOUNT), synced_at] for d in deliveries])
    if vitals:
        con.executemany(
            f"INSERT INTO {CT}.ct_vitals VALUES (?,?,?,?,?,?)",
            [[v["database"], v["name"], v["kind"], v["n"],
              v.get("source_account", ACCOUNT), synced_at] for v in vitals])
    con.execute("COMMIT")

    got = tuple(con.execute(
        f"SELECT (SELECT count(*) FROM {CT}.ct_objects),"
        f"       (SELECT count(*) FROM {CT}.ct_edges),"
        f"       (SELECT count(*) FROM {CT}.ct_issues),"
        f"       (SELECT count(*) FROM {CT}.ct_health),"
        f"       (SELECT count(*) FROM {CT}.ct_runlog),"
        f"       (SELECT count(*) FROM {CT}.ct_deliveries),"
        f"       (SELECT count(*) FROM {CT}.ct_vitals)").fetchone())
    expected = (len(nodes), len(edges), len(issues), len(health), len(runlog),
                len(deliveries), len(vitals))
    if got != expected:
        raise RuntimeError(
            f"post-write verification failed: expected {expected}, found {got}")


# ── bookkeeping ────────────────────────────────────────────────────────

def ensure(con):
    con.execute(f"CREATE DATABASE IF NOT EXISTS {qid(CT_DATABASE)}")
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {CT}")
    con.execute(REGISTRY_DDL.format(schema=CT))
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {CT}.{LEDGER} "
        "(run_ts TIMESTAMPTZ, status VARCHAR, detail VARCHAR, error VARCHAR)")
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {CT}.ct_hidden "
        "(object_key VARCHAR, reason VARCHAR, hidden_at TIMESTAMPTZ)")
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {CT}.ct_meta "
        "(account VARCHAR, collected_at TIMESTAMPTZ)")


def write_meta(con, collected_at):
    con.execute(f"DELETE FROM {CT}.ct_meta WHERE account = ?", [ACCOUNT])
    con.execute(f"INSERT INTO {CT}.ct_meta VALUES (?, ?)",
                [ACCOUNT, collected_at])


def write_ledger(con, status, detail="", error=""):
    con.execute(f"INSERT INTO {CT}.{LEDGER} VALUES (?, ?, ?, ?)",
                [datetime.now(timezone.utc), status, detail, error])


# ── fold in other accounts' shares (main account only — replaces the merge flight) ──

_OBJ_COLS = ("node_id", "node_type", "name", "app", "database", "label", "url",
             "schedule_declared", "schedule_deployed", "source_kind", "has_manifest",
             "ledger_table", "ledger_ts_column", "ledger_status_column",
             "ledger_ok_values", "ledger_detail_columns", "ledger_valid",
             "last_run_ts", "last_run_status", "stale_hours", "source_account")


def fold_in_shares(con, nodes, edges, issues, health, runlog, deliveries, vitals,
                   cutoff):
    """MAIN account only: DETACH/ATTACH each inbound share fresh, read its ct_* over
    the read-only share, and union into our own in-memory graph. Best-effort — a
    missing/stale/unreadable share raises a stale-account issue but never fails the run.
    Re-attach is mandatory each run (a cached attachment serves stale rows — verified
    in the spike). Own data wins on a node clash; cross-account cycles are recomputed
    on the merged edges."""
    node_ids = {n["node_id"] for n in nodes}
    edge_set = set(edges)
    health_ids = {h["node_id"] for h in health}
    vital_keys = {(v["database"], v["name"]) for v in vitals}
    own_code = {n["node_id"]: (n.get("database"), n.get("app"), n.get("ledger_table"))
                for n in nodes if n.get("source_kind") == "code"}

    def read(alias, table, cols):
        sql = (f"SELECT {', '.join(qid(c) for c in cols)} "
               f"FROM {qid(alias)}.{qid(SCHEMA)}.{qid(table)}")
        return [dict(zip(cols, r)) for r in con.execute(sql).fetchall()]

    def stale(detail):
        issues.append(dict(severity="warning", object_key="(environment)",
                           kind="stale-account", source_account=ACCOUNT, detail=detail))

    for s in INBOUND_SHARES:
        alias = s["alias"]
        try:
            con.execute(f"DETACH {alias}")
        except Exception:
            pass
        try:
            con.execute(f"ATTACH '{s['url']}' AS {alias}")
        except Exception as e:
            stale(f"inbound share '{alias}' could not be attached ({e}); that "
                  "account is missing from the graph")
            continue
        try:
            sobjs = read(alias, "ct_objects", _OBJ_COLS)
            sedges = read(alias, "ct_edges", ("src_node", "dst_node", "kind"))
            sissues = read(alias, "ct_issues",
                           ("severity", "object_key", "kind", "detail", "source_account"))
            shealth = read(alias, "ct_health",
                           ("node_id", "last_at", "last_ts", "is_ok", "last_status", "source_account"))
            srun = read(alias, "ct_runlog",
                        ("ts", "run_at", "node_id", "object_name", "status", "source_account"))
            sdel = read(alias, "ct_deliveries",
                        ("node_id", "app", "delivered_at", "ts", "recipient", "status", "is_ok", "source_account"))
            svit = read(alias, "ct_vitals",
                        ("database", "name", "kind", "n", "source_account"))
            smeta = read(alias, "ct_meta", ("account", "collected_at"))
        except Exception as e:
            stale(f"inbound share '{alias}' attached but unreadable ({e})")
            continue

        for o in sobjs:
            nid = o["node_id"]
            if nid in own_code and o.get("source_kind") == "code":
                if (o.get("database"), o.get("app"), o.get("ledger_table")) != own_code[nid]:
                    issues.append(dict(
                        severity="warning", object_key=nid, kind="node-collision",
                        source_account=ACCOUNT,
                        detail=f"object id '{nid}' is defined differently in "
                               f"'{o.get('source_account')}' and '{ACCOUNT}'; kept "
                               f"'{ACCOUNT}'s — rename one to disambiguate"))
                continue  # this account wins
            if nid not in node_ids:
                node_ids.add(nid)
                nodes.append(o)
        for e in sedges:
            t = (e["src_node"], e["dst_node"], e["kind"])
            if t not in edge_set:
                edge_set.add(t)
                edges.append(t)
        for i in sissues:
            if i.get("kind") != "cycle":   # cycles recomputed on merged edges below
                issues.append(i)
        for h in shealth:
            if h["node_id"] not in health_ids:
                health_ids.add(h["node_id"])
                health.append(h)
        runlog.extend(srun)
        deliveries.extend(sdel)
        for v in svit:
            key = (v["database"], v["name"])
            if key not in vital_keys:
                vital_keys.add(key)
                vitals.append(v)
        if smeta and smeta[0].get("collected_at") and smeta[0]["collected_at"] < cutoff:
            stale(f"account '{smeta[0]['account']}' last collected "
                  f"{smeta[0]['collected_at']:%Y-%m-%d %H:%M} UTC, older than "
                  f"{STALE_HOURS}h — its part of the graph may be out of date")

    # Cross-account cycles only exist after the union — recompute on the merged edges.
    issues = [i for i in issues if i.get("kind") != "cycle"]
    for kind, members in find_cycles(edges):
        issues.append(dict(
            severity="error", object_key=members[0], kind="cycle",
            source_account=ACCOUNT,
            detail=(f"dependency cycle in the {kind} view: "
                    + " → ".join(members + [members[0]])
                    + " — the lineage graph cannot be drawn until this loop is removed")))

    # Bound the merged run-log (the dive only shows the top 10).
    runlog.sort(key=lambda r: r.get("ts") or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True)
    del runlog[500:]
    return nodes, edges, issues, health, runlog, deliveries, vitals


def main():
    con = duckdb.connect("md:")
    con.execute("SET TimeZone='UTC'")
    ensure(con)
    try:
        deployed = enumerate_deployed(con)
        registry = read_registry(con)
        print(f"account {ACCOUNT}: {len(deployed)} deployed object(s), "
              f"{len(registry)} registry row(s)")

        shares = con.execute(
            "SELECT name, source_db_name FROM MD_LIST_DATABASE_SHARES()"
        ).fetchall()

        hidden_keys = {r[0] for r in con.execute(
            f"SELECT object_key FROM {CT}.ct_hidden").fetchall()}
        if hidden_keys:
            print(f"hiding {len(hidden_keys)} object(s): "
                  + ", ".join(sorted(hidden_keys)))

        nodes, edges, issues = build_graph(registry, deployed, shares, hidden_keys)
        issues += check_ledger_targets(con, nodes)
        health = compute_health(con, nodes)
        runlog = compute_runlog(con, nodes)
        deliveries = compute_deliveries(con, nodes, edges)
        vitals = compute_vitals(con)

        synced_at = datetime.now(timezone.utc)
        if IS_MAIN and INBOUND_SHARES:
            nodes, edges, issues, health, runlog, deliveries, vitals = fold_in_shares(
                con, nodes, edges, issues, health, runlog, deliveries, vitals,
                synced_at - timedelta(hours=STALE_HOURS))
            print(f"folded in {len(INBOUND_SHARES)} inbound share(s)")
        write_graph(con, nodes, edges, issues, health, runlog, deliveries,
                    vitals, synced_at)
        write_meta(con, synced_at)

        detail = (f"{len(nodes)} nodes, {len(edges)} edges, {len(issues)} issues, "
                  f"{len(health)} health, {len(runlog)} runlog, "
                  f"{len(deliveries)} deliveries, {len(vitals)} vitals "
                  f"from {len(registry)} registry rows")
        write_ledger(con, "succeeded", detail)
        print(f"ct_sync_ledger: succeeded — {detail}")
    except Exception as e:
        try:
            con.execute("ROLLBACK")
        except Exception:
            pass
        write_ledger(con, "failed", "", f"{type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
