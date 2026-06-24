#!/usr/bin/env python3
"""Validate and upsert one or more registry rows into an account's ct_registry.

Input is a JSON file (or stdin) holding a single manifest object or a list of
them. Each object is a manifest dict (manifest_version/object/type/app/database/
reads_from/writes_to/.../ledger) plus an optional "deployed_name" linking it to
the live object as the catalog reports it (a dive's title; defaults to `object`,
which is right for flights).

Every row is validated with the SAME validate() the collector uses, so a row
that would break the graph is rejected here. Writes are transactional and
verified. NEVER edits the cataloged object's source — that's the whole point.

    python3 registry_upsert.py --env main --file draft.json
    cat draft.json | python3 registry_upsert.py --env main --file -
"""
import argparse
import json
import sys
from datetime import datetime, timezone

from _ct import (add_env_arg, account_entry, connect, load_ct_config, schemas,
                 qid)
from _manifest_schema import (validate, manifest_to_row, REGISTRY_COLUMNS,
                              REGISTRY_KEY)


def load_input(path):
    raw = sys.stdin.read() if path == "-" else open(path).read()
    data = json.loads(raw)
    return data if isinstance(data, list) else [data]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    add_env_arg(ap)
    ap.add_argument("--file", required=True,
                    help="JSON file with one manifest or a list ('-' for stdin)")
    args = ap.parse_args()

    _, cfg = load_ct_config()
    acct = account_entry(cfg, args.env)
    ct_db = acct["ct_database"]
    charted = set(acct.get("charted_databases", []))
    schema, _canon = schemas(cfg)
    tbl = f"{qid(ct_db)}.{qid(schema)}.ct_registry"

    manifests = load_input(args.file)

    # Validate everything BEFORE writing anything.
    errors = []
    for i, m in enumerate(manifests):
        probs = validate(m)
        if probs:
            errors.append(f"row {i} ({m.get('object', '?')}): " + "; ".join(probs))
        if charted and m.get("database") not in charted:
            print(f"  ! row {i} ({m.get('object')}) targets '{m.get('database')}' "
                  f"which is not in charted_databases {sorted(charted)} — it will "
                  f"be flagged out-of-scope by the collector.")
    if errors:
        raise SystemExit("\n  ✗ refusing to write — invalid rows:\n    "
                         + "\n    ".join(errors) + "\n")

    con = connect(args.env)
    who = con.execute("SELECT md_user()").fetchone()[0]
    now = datetime.now(timezone.utc)

    rows = []
    for m in manifests:
        row = manifest_to_row(m)
        row["deployed_name"] = m.get("deployed_name") or m["object"]
        row["updated_at"] = now
        row["updated_by"] = who
        rows.append(row)

    placeholders = ", ".join(["?"] * len(REGISTRY_COLUMNS))
    col_list = ", ".join(qid(c) for c in REGISTRY_COLUMNS)
    kcols = REGISTRY_KEY  # (database, object)

    con.execute("BEGIN")
    try:
        for row in rows:
            con.execute(
                f"DELETE FROM {tbl} WHERE "
                + " AND ".join(f"{qid(k)} = ?" for k in kcols),
                [row[k] for k in kcols])
            con.execute(
                f"INSERT INTO {tbl} ({col_list}) VALUES ({placeholders})",
                [row[c] for c in REGISTRY_COLUMNS])
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise

    # Verify each row is present exactly once.
    for row in rows:
        n = con.execute(
            f"SELECT count(*) FROM {tbl} WHERE "
            + " AND ".join(f"{qid(k)} = ?" for k in kcols),
            [row[k] for k in kcols]).fetchone()[0]
        if n != 1:
            raise SystemExit(
                f"\n  ✗ verification failed: {row['type']}:{row['object']} "
                f"present {n} times after upsert (expected 1).\n")
    print(f"  ✓ upserted {len(rows)} registry row(s) into {ct_db}.{schema}"
          + " — " + ", ".join(f"{r['type']}:{r['object']}" for r in rows))


if __name__ == "__main__":
    main()
