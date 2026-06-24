"""Shared library for the build-dive scripts: MotherDuck connections + the dive workspace.

Nothing here is specific to any one dive or any one person's account. Everything
that varies between users lives in data, not code:

  * Which MotherDuck accounts exist, and where their tokens are, is defined in
    `dives/dives.config.json` (the "environments" map). The skill asks the user
    which environment to use, and `--env` selects one of the configured names.

  * Each dive's own facts (its remote id, environment, database, share name)
    live in `workspace/<slug>/meta.json`. The scripts read that, so a dive's UUID is
    never hardcoded anywhere.

This is what makes the skill shareable: a different user writes their own
config and grows their own `workspace/` folder; the skill code doesn't change.
"""
import argparse
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

import duckdb


def content_hash(text: str) -> str:
    """Fingerprint of a dive's code, recorded in meta.json on every push/pull.

    Lets dive_pull detect local edits that were never published before it
    overwrites them.
    """
    return hashlib.sha256(text.encode()).hexdigest()[:16]

CONFIG_RELPATH = ("workspace", "dives.config.json")


# ── Workspace discovery ────────────────────────────────────────────

def find_workspace_root() -> tuple[Path, Path]:
    """Return (project_root, config_path) by locating dives/dives.config.json upward."""
    seen = set()
    for start in (Path.cwd().resolve(), Path(__file__).resolve()):
        for d in [start] + list(start.parents):
            if d in seen:
                continue
            seen.add(d)
            cand = d.joinpath(*CONFIG_RELPATH)
            if cand.exists():
                return d, cand
    raise FileNotFoundError(
        "Could not find dives/dives.config.json. Create the workspace first "
        "(see dive_new.py) or run from inside a project that has one."
    )


def load_config() -> tuple[Path, dict]:
    """Return (project_root, config dict)."""
    root, cfg_path = find_workspace_root()
    return root, json.loads(cfg_path.read_text())


def dives_dir() -> Path:
    """The workspace root that holds databases/ and apps/ (formerly dives/)."""
    root, _ = load_config()
    return root / "workspace"


def dive_dir(name: str) -> Path:
    return dives_dir() / name


# ── Per-dive metadata + changelog ──────────────────────────────────

def load_meta(name: str) -> dict:
    p = dive_dir(name) / "meta.json"
    if not p.exists():
        raise FileNotFoundError(
            f"No dive named '{name}' in the workspace ({p} missing). "
            f"Create it with dive_new.py or import it with dive_pull.py --id."
        )
    return json.loads(p.read_text())


def save_meta(name: str, meta: dict) -> None:
    (dive_dir(name) / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")


def add_changelog(name: str, version, note: str) -> None:
    """Prepend a dated entry to the dive's CHANGELOG.md (newest first)."""
    p = dive_dir(name) / "CHANGELOG.md"
    title = load_meta(name).get("title", name)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"## {stamp} · v{version}\n{note}\n"
    if p.exists():
        existing = p.read_text()
    else:
        existing = f"# Changelog — {title}\n\n"
    if "\n\n" in existing:
        head, rest = existing.split("\n\n", 1)
        p.write_text(f"{head}\n\n{entry}\n{rest}")
    else:
        p.write_text(f"{existing}\n{entry}")


# ── Environments + connections ─────────────────────────────────────

def _environments() -> dict:
    _, cfg = load_config()
    return cfg.get("environments", {})


def add_env_arg(parser: argparse.ArgumentParser) -> None:
    """Add the required --env flag, with choices drawn from dives.config.json."""
    try:
        choices = sorted(_environments().keys())
    except Exception:
        choices = None
    parser.add_argument(
        "--env",
        required=True,
        choices=choices,
        help="Which MotherDuck account to use (defined in dives/dives.config.json).",
    )


def get_token(env: str) -> str:
    """Return the access token for the chosen environment.

    Looks up the environment's token variable name in dives.config.json, then
    reads that variable from the process environment first, falling back to the
    configured env_file (e.g. .dive-preview/.env). The env_file is gitignored.
    """
    root, cfg = load_config()
    envs = cfg.get("environments", {})
    if env not in envs:
        raise ValueError(f"Unknown env '{env}'. Configured: {sorted(envs)}")
    var = envs[env]["token_env"]

    if os.environ.get(var):
        return os.environ[var].strip()

    env_file = root / cfg.get("env_file", ".env")
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == var:
                return v.strip()
    raise ValueError(
        f"Token variable '{var}' for env '{env}' not found in the process "
        f"environment or {env_file}."
    )


def connect(env: str) -> duckdb.DuckDBPyConnection:
    """Open a connection to the chosen MotherDuck account and confirm which one it is.

    If dives.config.json declares an expected `md_user` for this environment, the
    live `md_user()` must match it or we refuse — the token may have opened a
    different account than `--env` named. (The username alone doesn't identify the
    account; the configured per-env value is the source of truth for the mapping.)
    """
    con = duckdb.connect(f"md:?motherduck_token={get_token(env)}")
    who = con.execute("SELECT md_user()").fetchone()[0]
    expected = _environments().get(env, {}).get("md_user")
    if expected and who != expected:
        raise SystemExit(
            f"\n  ✗ Account mismatch: --env {env} expects md_user '{expected}' "
            f"but the token connected as '{who}'. Refusing to proceed.\n")
    print(f"  [{env}] connected to MotherDuck as: {who}"
          + (" ✓ verified" if expected else ""))
    return con


def pick_function(con, candidates) -> str:
    """Return the first MD_* function name that exists in this session.

    Flight function names vary by client generation (e.g. some sessions
    expose MD_LIST_FLIGHT_RUNS, others MD_FLIGHT_RUNS). Resolve at runtime
    instead of guessing.
    """
    names = {
        r[0]
        for r in con.execute(
            "SELECT function_name FROM duckdb_functions() "
            "WHERE function_name ILIKE 'MD\\_%' ESCAPE '\\'"
        ).fetchall()
    }
    for c in candidates:
        if c in names:
            return c
    raise SystemExit(
        f"\n  ✗ None of {candidates} exist in this session. Your duckdb client "
        f"may be too old for flight functions (need >= 1.5.3).\n")


def require_duckdb(minimum: str = "1.5.3") -> None:
    """Fail with a helpful message when the duckdb client is too old.

    Flight SQL functions (MD_CREATE_FLIGHT, MD_RUN_FLIGHT, ...) simply do
    not exist on clients older than 1.5.3 — the error you'd get otherwise
    is a confusing "Table Function ... does not exist".
    """
    have = tuple(int(p) for p in duckdb.__version__.split(".")[:3])
    need = tuple(int(p) for p in minimum.split(".")[:3])
    if have < need:
        raise SystemExit(
            f"\n  ✗ Flight operations need duckdb >= {minimum}; you have "
            f"{duckdb.__version__}.\n"
            f"    Older clients can't see any MD_FLIGHT* functions at all.\n"
            f"    Fix:  pip install --upgrade 'duckdb>={minimum}'\n"
            f"    (use a virtualenv if your system Python is externally managed)\n")
