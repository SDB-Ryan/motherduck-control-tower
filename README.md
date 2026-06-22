# Control Tower

A self-updating ops console for a **MotherDuck warehouse** — the data-flow graph
of the dives, flights, tables, and shares feeding one database, drawn
automatically from metadata you write into the objects themselves.

![Control Tower mapping a MotherDuck account's data flow](docs/control-tower.png)

You annotate each dive and flight with a small `@manifest` comment block declaring
what it reads, writes, and delivers. A scheduled **manifest-sync** flight parses
all of them and materializes the graph as tables (`ct_objects`, `ct_edges`,
`ct_issues`). The **Control Tower** dive renders that graph — per-app lineage, a
logical/physical toggle, live row counts and run health, and a warnings strip for
anything not yet cataloged. Zero hardcoded nodes: add a manifest and an object
joins the graph on the next sync; an object with no manifest shows up on the
issues list instead.

## Scope: one warehouse (for now)

Control Tower charts a **single warehouse** — the one database you point it at.
It discovers every dive and flight in your account, but only charts the objects
that belong to that warehouse; anything targeting another database is listed as
**out-of-scope** rather than forced onto the graph. Its own `ct_*` bookkeeping
tables also live in that database (it never modifies your data tables). A
multi-warehouse console — one view across several databases, with the `ct_*`
tables moved into their own dedicated database — is a planned future mode. For
now, install one Control Tower per warehouse you want to watch.

## How it fits together

```
your dives & flights  ──(@manifest comments)──►  manifest-sync flight
                                                        │
                                          writes  ct_objects / ct_edges / ct_issues
                                                        │
                                                        ▼
                                              Control Tower dive  ──►  the graph
```

## What's here

```
control-tower/                  the dive (the console UI)
control-tower-manifest-sync/    the flight that builds the graph from manifests
INSTALL.md                      step-by-step install guide (hand it to an agent)
```

## Install

Control Tower installs into **one MotherDuck database** and charts the objects
feeding that warehouse. The whole thing is one flight, one dive, and a handful of
`ct_*` bookkeeping tables; it never touches your data tables.

**Load [`INSTALL.md`](INSTALL.md) into the AI assistant of your choice** (Claude,
ChatGPT, Claude Code — anything that can run MotherDuck SQL) and tell it to
install Control Tower. The file is written *to the assistant*: it **preflights
first** — checks it can reach your account, that there's a read/write token, and
whether your plan has Flights — and if something's missing it names the exact
holdup and how to fix it before touching anything. Once it's clear, it stamps
your database in place of `YOUR_DATABASE`, deploys the flight, runs the first
sync, publishes the dive, and helps you catalog your existing objects one at a
time.

The three things it checks for, and what to do:
- **No MotherDuck access** → connect the [MotherDuck MCP](https://motherduck.com)
  to your assistant, *or* give it a read/write token + a Python env with
  `duckdb >= 1.5.3`.
- **No read/write token** → create one in MotherDuck → Settings → Access Tokens.
- **No Flights (free plan)** → install in **local-sync mode** instead — identical
  result, the graph just refreshes when you run the sync script rather than on a
  schedule. (Or upgrade for scheduling.)

No skill or framework required — the install uses plain MotherDuck SQL. (If you
happen to use the `build-dive` skill, its scripts wrap the same calls.)

## The manifest convention

An object joins the graph by carrying a comment block. Minimal example:

```python
# @manifest:begin
# {
#   "manifest_version": 1,
#   "object": "daily-orders-load",
#   "type": "flight",
#   "app": "orders",
#   "database": "analytics",
#   "reads_from": ["source:shopify"],
#   "writes_to": ["table:orders"]
# }
# @manifest:end
```

Node refs are `type:name` (`table:`, `share:`, `source:`, `dive:`, `flight:`,
`delivery:`). Full field reference and the logical-vs-physical edge rules are in
**INSTALL.md** (Step 5).

## License

MIT — see [LICENSE](LICENSE).
