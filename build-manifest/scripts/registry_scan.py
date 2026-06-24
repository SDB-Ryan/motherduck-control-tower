#!/usr/bin/env python3
"""Diff what's deployed in an account against what's in its ct_registry.

Read-only. Prints the cataloging to-do list — the same reconcile the collector
does, so "scan is clean" means "the collector will chart everything":

  uncataloged : deployed object with no registry row  (collector → missing-manifest)
  orphan      : registry row whose object isn't deployed (collector → orphan-registry)
  drift       : flight whose deployed cron != the registry's declared schedule
  type-mismatch: deployed type != registry type for the same name

    python3 registry_scan.py --env main          # human report
    python3 registry_scan.py --env main --json    # machine-readable (for the skill)
"""
import argparse
import json

from _ct import (add_env_arg, account_entry, connect, load_ct_config, schemas,
                 pick_function, qid)


def deployed_objects(con):
    """[(type, name, schedule_or_None)] for every deployed flight + dive."""
    out = []
    flights_fn = pick_function(con, ["MD_LIST_FLIGHTS", "MD_FLIGHTS"])
    for _fid, fname, cron in con.execute(
            f"SELECT flight_id, flight_name, schedule_cron FROM {flights_fn}()"
    ).fetchall():
        out.append(("flight", fname, cron))
    for _did, title in con.execute(
            'SELECT id, title FROM MD_LIST_DIVES('
            'include_org_shares=false, "offset"=0, "limit"=500)').fetchall():
        out.append(("dive", title, None))
    return out


def registry_rows(con, ct_db, schema):
    """[(object, deployed_name, type, database, schedule)] or [] if no table yet."""
    try:
        return con.execute(
            f"SELECT object, deployed_name, type, database, schedule "
            f"FROM {qid(ct_db)}.{qid(schema)}.ct_registry").fetchall()
    except Exception:
        raise SystemExit(
            f"\n  ✗ {ct_db}.{schema}.ct_registry not found — run "
            f"registry_init.py --env <env> first.\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    add_env_arg(ap)
    ap.add_argument("--json", action="store_true", help="emit JSON for the skill")
    args = ap.parse_args()

    _, cfg = load_ct_config()
    acct = account_entry(cfg, args.env)
    ct_db = acct["ct_database"]
    charted = set(acct.get("charted_databases", []))
    schema, _canon = schemas(cfg)

    con = connect(args.env)
    deployed = deployed_objects(con)
    reg = registry_rows(con, ct_db, schema)

    # match key = (type, deployed_name-or-object)
    reg_by_key = {}
    for obj, dep_name, typ, db, sched in reg:
        reg_by_key[(typ, dep_name or obj)] = dict(
            object=obj, deployed_name=dep_name or obj, type=typ,
            database=db, schedule=sched)
    dep_by_key = {(t, n): dict(type=t, name=n, schedule=s) for t, n, s in deployed}
    # also index deployed by name alone, to spot type mismatches
    dep_names = {}
    for t, n, s in deployed:
        dep_names.setdefault(n, set()).add(t)

    uncataloged, orphan, drift, type_mismatch = [], [], [], []

    for (t, n), d in dep_by_key.items():
        if (t, n) not in reg_by_key:
            # is it the same name deployed under a different type than registry?
            if any((rt, rn) for (rt, rn) in reg_by_key if rn == n and rt != t):
                type_mismatch.append(dict(name=n, deployed_type=t))
            else:
                uncataloged.append(dict(type=t, name=n))

    for (t, n), r in reg_by_key.items():
        if (t, n) not in dep_by_key:
            orphan.append(dict(type=t, object=r["object"], deployed_name=n,
                               database=r["database"]))
        else:
            dep = dep_by_key[(t, n)]
            if (t == "flight" and r.get("schedule")
                    and r["schedule"] != dep.get("schedule")):
                drift.append(dict(object=r["object"], declared=r["schedule"],
                                  deployed=dep.get("schedule")))

    result = dict(env=args.env, ct_database=ct_db,
                  charted_databases=sorted(charted),
                  uncataloged=uncataloged, orphan=orphan, drift=drift,
                  type_mismatch=type_mismatch)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    def section(title, items, fmt):
        print(f"\n  {title} ({len(items)})")
        for it in items:
            print("    - " + fmt(it))

    print(f"\nControl Tower registry scan — env={args.env}, ct_db={ct_db}")
    print(f"charted databases: {', '.join(sorted(charted)) or '(none set)'}")
    section("UNCATALOGED (need a registry row)", uncataloged,
            lambda i: f"{i['type']}: {i['name']}")
    section("ORPHAN (registry row, object not deployed)", orphan,
            lambda i: f"{i['type']}: {i['object']} (deployed_name={i['deployed_name']})")
    section("SCHEDULE DRIFT", drift,
            lambda i: f"{i['object']}: declared {i['declared']} vs deployed {i['deployed']}")
    section("TYPE MISMATCH", type_mismatch,
            lambda i: f"{i['name']}: deployed as {i['deployed_type']}")
    total = len(uncataloged) + len(orphan) + len(drift) + len(type_mismatch)
    print(f"\n  {'✓ registry is in sync' if total == 0 else f'{total} item(s) to resolve'}")


if __name__ == "__main__":
    main()
