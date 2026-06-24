#!/usr/bin/env python3
"""Create an account's Control Tower database + schema + empty ct_registry.

Idempotent: safe to run repeatedly. Run once per account before cataloging.

    python3 registry_init.py --env main
"""
import argparse

from _ct import add_env_arg, account_entry, connect, load_ct_config, schemas, qid
from _manifest_schema import REGISTRY_DDL


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    add_env_arg(ap)
    args = ap.parse_args()

    _, cfg = load_ct_config()
    acct = account_entry(cfg, args.env)
    ct_db = acct["ct_database"]
    schema, _canon = schemas(cfg)

    con = connect(args.env)  # md_user-verified; refuses the wrong account
    con.execute(f"CREATE DATABASE IF NOT EXISTS {qid(ct_db)}")
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {qid(ct_db)}.{qid(schema)}")
    con.execute(REGISTRY_DDL.format(schema=f"{qid(ct_db)}.{qid(schema)}"))

    # Verify the table is really there before claiming success.
    got = con.execute(
        "SELECT count(*) FROM information_schema.tables "
        "WHERE lower(table_catalog)=lower(?) AND lower(table_schema)=lower(?) "
        "AND lower(table_name)='ct_registry'", [ct_db, schema]).fetchone()[0]
    if got != 1:
        raise SystemExit(
            f"\n  ✗ ct_registry not found in {ct_db}.{schema} after init.\n")
    print(f"  ✓ {ct_db}.{schema}.ct_registry ready")


if __name__ == "__main__":
    main()
