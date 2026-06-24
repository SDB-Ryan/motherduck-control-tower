#!/usr/bin/env python3
"""Dump an account's ct_registry to JSON (manifest shape) for review or to
version-control the catalog. Round-trips with registry_upsert.py.

    python3 registry_pull.py --env main               # to stdout
    python3 registry_pull.py --env main --out reg.json
"""
import argparse
import json

from _ct import (add_env_arg, account_entry, connect, load_ct_config, schemas,
                 qid)
from _manifest_schema import REGISTRY_COLUMNS, row_to_manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    add_env_arg(ap)
    ap.add_argument("--out", help="write to this file instead of stdout")
    args = ap.parse_args()

    _, cfg = load_ct_config()
    acct = account_entry(cfg, args.env)
    ct_db = acct["ct_database"]
    schema, _canon = schemas(cfg)
    tbl = f"{qid(ct_db)}.{qid(schema)}.ct_registry"

    con = connect(args.env)
    cols = ", ".join(qid(c) for c in REGISTRY_COLUMNS)
    rows = con.execute(f"SELECT {cols} FROM {tbl} ORDER BY database, object").fetchall()

    out = []
    for r in rows:
        d = dict(zip(REGISTRY_COLUMNS, r))
        m = row_to_manifest(d)
        if d.get("deployed_name") and d["deployed_name"] != m["object"]:
            m["deployed_name"] = d["deployed_name"]
        out.append(m)

    text = json.dumps(out, indent=2, default=str)
    if args.out:
        open(args.out, "w").write(text + "\n")
        print(f"  ✓ wrote {len(out)} row(s) to {args.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
