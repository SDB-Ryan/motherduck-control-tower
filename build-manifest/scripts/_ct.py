"""Shared helpers for the build-manifest scripts.

Two jobs:
  1. Reuse build-dive's `_md` (connections + the md_user-verified `connect(env)`
     that refuses to write to the wrong account) without duplicating it. During
     development the two skills sit side by side under ~/.claude/skills/; the OSS
     publish step vendors a copy of _md so the shipped skill is self-contained.
  2. Load `control-tower.config.json` — the account topology — and
     expose the per-account entry + the canonical/slice schema names.

--env here selects a Control Tower ACCOUNT (from control-tower.config.json).
In the private workspace the same `env` also exists in dives.config.json, which
supplies the token + identity guard; in a public install `_md` falls back to
control-tower.config.json itself (token from MOTHERDUCK_TOKEN or `token_env`,
optional `md_user` guard) — one config file, no other workspace needed.
"""

import argparse
import json
import sys
from pathlib import Path

# Bridge to build-dive's _md (sibling skill). If it's ever vendored locally,
# a sibling _md.py takes precedence because this dir is already on sys.path.
_BUILD_DIVE_SCRIPTS = Path(__file__).resolve().parents[2] / "build-dive" / "scripts"
if _BUILD_DIVE_SCRIPTS.is_dir():
    sys.path.insert(0, str(_BUILD_DIVE_SCRIPTS))

import _md  # noqa: E402
from _md import connect, get_token, pick_function, require_duckdb, find_workspace_root  # noqa: E402,F401

CT_CONFIG_RELPATH = ("workspace", "control-tower.config.json")


def load_ct_config():
    """Return (project_root, control-tower.config dict).

    Looks in the private workspace location (control-tower.config.json)
    first, then at the project root (the public-install location).
    """
    root, _ = find_workspace_root()
    for p in (root.joinpath(*CT_CONFIG_RELPATH), root / "control-tower.config.json"):
        if p.exists():
            return root, json.loads(p.read_text())
    raise SystemExit(
        "\n  ✗ control-tower.config.json not found. Control Tower's topology config "
        "is required — copy control-tower.config.example.json to "
        "control-tower.config.json (repo root) and fill it in.\n")


def account_entry(ct_cfg, env):
    """The accounts[] entry for this env, or exit with a clear message."""
    for a in ct_cfg.get("accounts", []):
        if a.get("env") == env:
            return a
    known = ", ".join(a.get("env") for a in ct_cfg.get("accounts", []))
    raise SystemExit(
        f"\n  ✗ env '{env}' is not in control-tower.config.json accounts ({known}).\n")


def schemas(ct_cfg):
    """The single Control Tower schema (default 'main'). Returned twice for the
    callers that unpack two values (there used to be a slice/canonical split)."""
    s = ct_cfg.get("schema", "main")
    return s, s


def add_env_arg(parser: argparse.ArgumentParser) -> None:
    """--env with choices drawn from control-tower.config.json accounts."""
    try:
        _, cfg = load_ct_config()
        choices = sorted(a["env"] for a in cfg.get("accounts", []))
    except Exception:
        choices = None
    parser.add_argument(
        "--env", required=True, choices=choices,
        help="Which Control Tower account (env name from control-tower.config.json).")


def qid(name: str) -> str:
    """Quote a SQL identifier."""
    return '"' + str(name).replace('"', '""') + '"'
