"""Shared manifest schema — the single source of truth for what a valid manifest
is, plus the conversion between a manifest dict and a ct_registry row.

Used by the build-manifest skill scripts (registry_scan / registry_upsert) and
mirrored INLINE in the collector flight (deployed flight containers can't import
local files). A test (test_schema_parity.py) diffs the inlined copy against this
module so the two never silently drift — see Key Risk #4 in the plan.

The parse_manifest / validate logic here is byte-for-byte the same contract as
the original control-tower flight.py and build-dive's manifest_check.py, so an
object cataloged via the registry validates identically to one declared in source.
"""

import json
import re

# ── manifest contract (identical to flight.py / manifest_check.py) ──────────

MARKER_RE = re.compile(r"@manifest:begin(.*?)@manifest:end", re.DOTALL)
COMMENT_PREFIX_RE = re.compile(r"^\s*(#|//|\*)\s?")
VALID_TYPES = {"dive", "flight"}
VALID_REF_RE = re.compile(
    r"^(flight|dive|table|share|source|delivery|database):[a-z0-9_./-]+$")
EDGE_FIELDS = ("reads_from", "writes_to", "delivers_for", "feeds")
REQUIRED_FIELDS = ("manifest_version", "object", "type", "app", "database")
LEDGER_FIELDS = ("table", "ts_column", "status_column", "ok_values")


def parse_manifest(source):
    """Extract and parse a manifest block from object source. Returns
    (dict|None, error|None). (None, None) means no manifest block at all.

    Used for MIGRATION (reading existing in-source manifests into the registry)
    and by the skill when it wants to seed a draft from any block an object
    already carries."""
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
        # bool is a subclass of int — reject it explicitly.
        if isinstance(sh, bool) or not isinstance(sh, int) or sh <= 0:
            problems.append("'stale_hours' must be a positive integer (hours)")
    return problems


# ── ct_registry table: schema + manifest<->row conversion ──────────────────
# One row per cataloged object. Replaces source-embedded manifests. List fields
# (reads_from, etc.) and ledger.ok_values/detail_columns are stored as JSON text.

# `deployed_name` links a registry row to the live object as the catalog reports
# it (a dive's TITLE, a flight's NAME) — needed because a dive's manifest `object`
# is a kebab slug while MD_LIST_DIVES returns its title. It is registry linkage,
# NOT a manifest field: manifest_to_row never sets it; the writer supplies it
# (defaulting to `object`, which is correct for flights). The collector matches
# deployed objects to registry rows on it and uses it to pull run history.
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

# Natural key: an object is unique within (database, object). Upsert deletes by
# this key before insert; the collector dedupes registry rows on it too.
REGISTRY_KEY = ("database", "object")


def manifest_to_row(m):
    """Flatten a validated manifest dict into ct_registry column values
    (excluding updated_at / updated_by, which the writer stamps). List fields
    become JSON text."""
    ledger = m.get("ledger") or {}
    return {
        "object": m.get("object"),
        "type": m.get("type"),
        "app": m.get("app"),
        "database": m.get("database"),
        "label": m.get("label"),
        "url": m.get("url"),
        "schedule": m.get("schedule"),
        "stale_hours": m.get("stale_hours"),
        "reads_from": json.dumps(m.get("reads_from", [])),
        "writes_to": json.dumps(m.get("writes_to", [])),
        "delivers_for": json.dumps(m.get("delivers_for", [])),
        "feeds": json.dumps(m.get("feeds", [])),
        "ledger_table": ledger.get("table"),
        "ledger_ts_column": ledger.get("ts_column"),
        "ledger_status_column": ledger.get("status_column"),
        "ledger_ok_values": (json.dumps(ledger["ok_values"])
                             if ledger.get("ok_values") is not None else None),
        "ledger_detail_columns": (json.dumps(ledger["detail_columns"])
                                 if ledger.get("detail_columns") is not None else None),
        "manifest_version": m.get("manifest_version", 1),
    }


def row_to_manifest(r):
    """Rebuild a manifest dict from a ct_registry row (a dict keyed by column
    name). Inverse of manifest_to_row. The collector feeds the result straight
    into the existing build_graph / validate logic."""
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
