#!/usr/bin/env python3
"""Guard against the collector's inlined schema drifting from _manifest_schema.py.

The collector flight (deployed source — can't import local files) carries an
inlined copy of validate() / row_to_manifest() / the field constants between
'SCHEMA MIRROR START' and 'SCHEMA MIRROR END'. This test loads both and asserts
identical constants AND identical behavior on a battery of manifests, so the two
can never silently disagree (Key Risk #4 in the plan).

    python3 test_schema_parity.py        # exits non-zero on any mismatch
"""
import glob
import importlib.util
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _manifest_schema as M          # noqa: E402
from _ct import find_workspace_root   # noqa: E402


def load_collector():
    try:
        root, _ = find_workspace_root()
    except FileNotFoundError:
        root = None
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    roots = [str(r) for r in (root, repo) if r]
    patterns = [os.path.join(r, sub, "**", "flight.py")
                for r in roots for sub in ("workspace", "")]
    for pattern in patterns:
        for p in glob.glob(pattern, recursive=True):
            if "SCHEMA MIRROR START" in open(p).read():
                spec = importlib.util.spec_from_file_location("collector_flight", p)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                return mod, p
    raise SystemExit("no collector flight with a SCHEMA MIRROR found "
                     "(searched workspace/ and the repo tree)")


CASES = [
    # valid
    {"manifest_version": 1, "object": "a", "type": "flight", "app": "x",
     "database": "d", "reads_from": ["table:t"], "writes_to": ["table:u"]},
    {"manifest_version": 1, "object": "b", "type": "dive", "app": "x",
     "database": "d", "delivers_for": ["dive:c"], "feeds": ["delivery:email"],
     "ledger": {"table": "lg", "ts_column": "ts", "status_column": "s",
                "ok_values": ["ok"], "detail_columns": ["email"]}},
    # broken in various ways
    {"object": "c"},
    {"manifest_version": 2, "object": "d", "type": "widget", "app": "x",
     "database": "d", "reads_from": ["bogus"]},
    {"manifest_version": 1, "object": "e", "type": "flight", "app": "x",
     "database": "d", "reads_from": "not-a-list"},
    {"manifest_version": 1, "object": "f", "type": "flight", "app": "x",
     "database": "d", "stale_hours": True},
    {"manifest_version": 1, "object": "g", "type": "flight", "app": "x",
     "database": "d", "ledger": {"table": "lg"}},
]


def main():
    C, path = load_collector()

    assert tuple(M.REQUIRED_FIELDS) == tuple(C.REQUIRED_FIELDS), "REQUIRED_FIELDS"
    assert tuple(M.EDGE_FIELDS) == tuple(C.EDGE_FIELDS), "EDGE_FIELDS"
    assert tuple(M.LEDGER_FIELDS) == tuple(C.LEDGER_FIELDS), "LEDGER_FIELDS"
    assert set(M.VALID_TYPES) == set(C.VALID_TYPES), "VALID_TYPES"
    assert M.VALID_REF_RE.pattern == C.VALID_REF_RE.pattern, "VALID_REF_RE"
    assert tuple(M.REGISTRY_COLUMNS) == tuple(C.REGISTRY_COLUMNS), "REGISTRY_COLUMNS"

    for m in CASES:
        assert M.validate(m) == C.validate(m), f"validate disagreement on {m}"

    # row_to_manifest parity (build a full registry-row dict for each valid case)
    for m in CASES:
        if M.validate(m):
            continue
        row = {c: None for c in M.REGISTRY_COLUMNS}
        row.update(M.manifest_to_row(m))
        assert M.row_to_manifest(row) == C.row_to_manifest(row), f"row_to_manifest on {m}"

    print(f"  ✓ schema parity OK — collector mirror matches _manifest_schema.py")
    print(f"    ({path})")


if __name__ == "__main__":
    main()
