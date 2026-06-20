/* @manifest:begin
{
  "manifest_version": 1,
  "object": "control-tower",
  "type": "dive",
  "app": "control-tower",
  "database": "YOUR_DATABASE",
  "label": "Dive · ops console",
  "url": "",
  "reads_from": ["table:ct_objects", "table:ct_edges", "table:ct_issues"],
  "delivers_for": [],
  "feeds": []
}
@manifest:end */

import { useMemo, useRef } from "react";
import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

const N = (v: unknown): number => (v != null ? Number(v) : 0);
// Flight run status is stored bare (the flight strips MD's RUN_STATUS_ prefix).
const runFailed = (s: string | null): boolean => s === "FAILED" || s === "CANCELLED";
const NUM_FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const REQUIRED_DATABASES = ["YOUR_DATABASE"];
const DB = "YOUR_DATABASE";

const C = {
  ok: "#2d7a00",
  fail: "#bc1200",
  warn: "#e18727",
  idle: "#6a6a6a",
  accent: "#0777b3",
  text: "#231f20",
  muted: "#6a6a6a",
  border: "#ccc",
  sep: "#eee",
};

type Status = "ok" | "fail" | "warn" | "idle";

type CtNode = {
  node_id: string;
  node_type: string;
  name: string;
  app: string | null;
  label: string;
  url: string | null;
  schedule_deployed: string | null;
  source_kind: string;
  ledger_table: string | null;
  ledger_ts_column: string | null;
  ledger_status_column: string | null;
  ledger_ok_values: string[] | null;
  ledger_detail_columns: string[] | null;
  // Flight health from platform run history (null for dives — they don't run).
  last_run_at: string | null;
  last_run_age_s: number | null;
  last_run_status: string | null;
  stale_hours: number | null;
};

type Edge = { src: string; dst: string };

// ── tiny graph helpers (the linear-with-forks renderer's data prep) ────

/** Collapse all visible table nodes into one warehouse super-node.
    Re-targeted opposite edges (X reads AND writes the warehouse) keep the
    majority direction so the flow stays a DAG. */
function collapseTables(nodeIds: Set<string>, edges: Edge[], tableIds: Set<string>, whId: string) {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const src = tableIds.has(e.src) ? whId : e.src;
    const dst = tableIds.has(e.dst) ? whId : e.dst;
    if (src === dst) continue;
    const k = `${src} ${dst}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out: Edge[] = [];
  for (const [k, n] of counts) {
    const [src, dst] = k.split(" ");
    const rev = counts.get(`${dst} ${src}`) || 0;
    if (rev > n) continue; // the opposite direction dominates
    if (rev === n && rev > 0 && src === whId) continue; // tie: writes into the warehouse win
    out.push({ src, dst });
  }
  const outNodes = new Set([...nodeIds].filter((id) => !tableIds.has(id)));
  if (tableIds.size) outNodes.add(whId);
  return { nodes: outNodes, edges: out };
}

/** Remove edge a→b when a longer path a→…→b exists (transitive reduction),
    so "flight pushes the share it also fills the warehouse for" renders as
    one linear flow, not a shortcut arrow. */
function reduceTransitive(edges: Edge[]): Edge[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src)!.push(e.dst);
  }
  const reaches = (from: string, to: string, skip: Edge): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) || []) {
        if (cur === skip.src && nxt === skip.dst) continue;
        stack.push(nxt);
      }
    }
    return false;
  };
  return edges.filter((e) => !reaches(e.src, e.dst, e));
}

const TYPE_ORDER: Record<string, number> = {
  source: 0, warehouse: 1, share: 2, dive: 3, flight: 4, delivery: 5, table: 6,
};

function prettyName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── visual grammar (identical to v1) ───────────────────────────────────

function Dot({ status }: { status: Status }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: C[status],
        flexShrink: 0,
      }}
    />
  );
}

function NodeCard({
  kind,
  title,
  stat,
  status,
  statusLabel,
  href,
}: {
  kind: string;
  title: string;
  stat?: string;
  status: Status;
  statusLabel: string;
  href?: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${C[status]}`,
        padding: "8px 12px",
        minWidth: 148,
        background: "#fff",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: C.muted,
          fontFamily: NUM_FONT,
        }}
      >
        {kind}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, margin: "2px 0" }}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: C.accent, textDecoration: "none" }}
          >
            {title}
          </a>
        ) : (
          <span style={{ color: C.text }}>{title}</span>
        )}
      </div>
      {stat ? (
        <div
          style={{
            fontSize: 12,
            color: C.text,
            fontFamily: NUM_FONT,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {stat}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          marginTop: 4,
          fontSize: 11,
          color: C[status],
          fontFamily: NUM_FONT,
        }}
      >
        <Dot status={status} />
        {statusLabel}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div style={{ color: C.muted, fontSize: 20, padding: "0 10px", flexShrink: 0 }}>
      →
    </div>
  );
}

function Fork({ ys }: { ys: number[] }) {
  return (
    <svg
      width="46"
      viewBox="0 0 46 100"
      preserveAspectRatio="none"
      style={{ flexShrink: 0, alignSelf: "stretch", minHeight: 60 }}
    >
      <path
        d="M2,50 L14,50"
        stroke={C.muted}
        strokeWidth={1.5}
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
      {ys.map((y) => (
        <g key={y}>
          <path
            d={`M14,50 C26,50 24,${y} 38,${y}`}
            stroke={C.muted}
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={`M34,${y - 2.5} L40,${y} L34,${y + 2.5}`}
            stroke={C.muted}
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}

function WarehouseCard({
  title,
  tables,
  status,
}: {
  title: string;
  tables: { name: string; rows: number | null; kind?: string }[];
  status: Status;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${C[status]}`,
        background: "#fff",
        padding: "8px 12px",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: C.muted,
          fontFamily: NUM_FONT,
        }}
      >
        Warehouse
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, margin: "2px 0 6px" }}>
        <a
          href="https://app.motherduck.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: C.accent, textDecoration: "none" }}
        >
          {title}
        </a>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {tables.map((t) => (
          <div
            key={t.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "#f8f8f8",
              padding: "3px 8px",
              fontSize: 11,
              fontFamily: NUM_FONT,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <Dot status={t.kind === "view" ? "ok" : t.rows === null ? "warn" : t.rows > 0 ? "ok" : "warn"} />
            <span style={{ color: C.text, fontWeight: 600 }}>{t.name}</span>
            <span style={{ color: C.muted }}>
              {t.kind === "view"
                ? "view"
                : t.rows === null
                ? "table not found"
                : `${t.rows.toLocaleString()} rows`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Skeleton({ w, h }: { w: number; h: number }) {
  return <div className="bg-gray-200 animate-pulse" style={{ width: w, height: h }} />;
}

// ── the dive ────────────────────────────────────────────────────────────

export default function ControlTowerV2() {
  const [selectedApp, setSelectedApp] = useDiveState("app", "");
  const [view, setView] = useDiveState<"logical" | "physical">("view", "logical");

  const objectsQ = useSQLQuery(`
    SELECT node_id, node_type, name, app, label, url,
           schedule_deployed, source_kind, ledger_table, ledger_ts_column,
           ledger_status_column, ledger_ok_values, ledger_detail_columns,
           strftime(last_run_ts, '%b %d %H:%M') AS last_run_at,
           epoch(now() - last_run_ts) AS last_run_age_s,
           last_run_status, stale_hours
    FROM "${DB}"."main"."ct_objects" ORDER BY node_id
  `);
  const edgesQ = useSQLQuery(`
    SELECT src_node, dst_node, kind FROM "${DB}"."main"."ct_edges"
  `);
  const issuesQ = useSQLQuery(`
    SELECT severity, object_key, kind, detail FROM "${DB}"."main"."ct_issues"
    ORDER BY severity, object_key
  `);
  // Objects intentionally excluded from the graph + issues (see ct_hidden).
  const hiddenQ = useSQLQuery(`
    SELECT object_key, reason FROM "${DB}"."main"."ct_hidden"
    ORDER BY object_key
  `);
  const syncQ = useSQLQuery(`
    SELECT strftime(max(run_ts), '%b %d %H:%M') AS synced_at,
           any_value(status ORDER BY run_ts DESC) AS status,
           any_value(detail ORDER BY run_ts DESC) AS detail
    FROM "${DB}"."main"."ct_sync_ledger"
  `);
  // Live table vitals straight from the catalog — no per-table code. Views are
  // first-class: a manifest can legitimately reference a view via a table: ref,
  // so we UNION duckdb_views() in (kind='view', no row count) rather than let
  // it read as a missing table.
  const vitalsQ = useSQLQuery(`
    SELECT table_name, estimated_size AS n, 'table' AS kind
    FROM duckdb_tables() WHERE database_name = '${DB}'
    UNION ALL
    SELECT view_name AS table_name, NULL AS n, 'view' AS kind
    FROM duckdb_views() WHERE database_name = '${DB}' AND NOT internal
  `);

  // Anchor raw results so downstream useMemos short-circuit.
  const nodesRef = useRef<CtNode[]>([]);
  const nodes: CtNode[] = useMemo(() => {
    const raw = Array.isArray(objectsQ.data) ? objectsQ.data : [];
    if (!raw.length) return nodesRef.current;
    nodesRef.current = raw.map((r: any) => ({
      node_id: String(r.node_id),
      node_type: String(r.node_type),
      name: String(r.name),
      app: r.app == null ? null : String(r.app),
      label: String(r.label || ""),
      url: r.url == null ? null : String(r.url),
      schedule_deployed: r.schedule_deployed == null ? null : String(r.schedule_deployed),
      source_kind: String(r.source_kind),
      ledger_table: r.ledger_table == null ? null : String(r.ledger_table),
      ledger_ts_column: r.ledger_ts_column == null ? null : String(r.ledger_ts_column),
      ledger_status_column: r.ledger_status_column == null ? null : String(r.ledger_status_column),
      ledger_ok_values: r.ledger_ok_values == null ? null : JSON.parse(String(r.ledger_ok_values)),
      ledger_detail_columns: r.ledger_detail_columns == null ? null : JSON.parse(String(r.ledger_detail_columns)),
      last_run_at: r.last_run_at == null ? null : String(r.last_run_at),
      last_run_age_s: r.last_run_age_s == null ? null : N(r.last_run_age_s),
      last_run_status: r.last_run_status == null ? null : String(r.last_run_status),
      stale_hours: r.stale_hours == null ? null : N(r.stale_hours),
    }));
    return nodesRef.current;
  }, [objectsQ.data]);

  const allEdges = useMemo(() => {
    const raw = Array.isArray(edgesQ.data) ? edgesQ.data : [];
    return raw.map((r: any) => ({
      src: String(r.src_node),
      dst: String(r.dst_node),
      kind: String(r.kind),
    }));
  }, [edgesQ.data]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.node_id, n])), [nodes]);
  const apps = useMemo(
    () => [...new Set(nodes.map((n) => n.app).filter(Boolean))].sort() as string[],
    [nodes]);
  // Never assume an app name exists: fall back to the first app on the graph.
  const activeApp = apps.includes(selectedApp) ? selectedApp : (apps[0] || "");

  // Health for every node with a ledger block — ONE generic query, built
  // from the manifests' ledger declarations, no per-object code.
  const healthSql = useMemo(() => {
    const parts = nodes
      .filter((n) => n.ledger_table && n.ledger_ts_column && n.ledger_status_column)
      .map((n) => {
        const ok = (n.ledger_ok_values || [])
          .map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",") || "''";
        return `SELECT '${n.node_id}' AS node_id,
          strftime(max("${n.ledger_ts_column}"), '%b %d %H:%M') AS last_at,
          epoch(now() - max("${n.ledger_ts_column}")) AS age_s,
          (any_value("${n.ledger_status_column}" ORDER BY "${n.ledger_ts_column}" DESC) IN (${ok})) AS is_ok,
          any_value("${n.ledger_status_column}" ORDER BY "${n.ledger_ts_column}" DESC) AS last_status
        FROM "${DB}"."main"."${n.ledger_table}"`;
      });
    return parts.length ? parts.join("\nUNION ALL\n") : "";
  }, [nodes]);
  const healthQ = useSQLQuery(healthSql || "SELECT 1", { enabled: !!healthSql });

  // Unified run log: every ledger, one UNION, newest first.
  const runlogSql = useMemo(() => {
    const parts = nodes
      .filter((n) => n.ledger_table && n.ledger_ts_column && n.ledger_status_column)
      .map((n) => `SELECT "${n.ledger_ts_column}" AS ts,
          strftime("${n.ledger_ts_column}", '%b %d %H:%M') AS run_at,
          '${n.name}' AS object_name,
          "${n.ledger_status_column}" AS status
        FROM "${DB}"."main"."${n.ledger_table}"`);
    return parts.length
      ? `SELECT run_at, object_name, status FROM (${parts.join(" UNION ALL ")}) ORDER BY ts DESC LIMIT 12`
      : "";
  }, [nodes]);
  const runlogQ = useSQLQuery(runlogSql || "SELECT 1", { enabled: !!runlogSql });

  // Recent deliveries: any flight in the selected app that feeds a delivery
  // node AND declares ledger.detail_columns gets its ledger rows shown with
  // exactly the columns its manifest asks for (cast to text, no per-object
  // code). First such flight wins; apps without one get no panel.
  const deliveryFlight = useMemo(() => {
    return nodes.find((n) =>
      n.app === activeApp && n.node_type === "flight" &&
      n.ledger_table && n.ledger_ts_column &&
      (n.ledger_detail_columns || []).length > 0 &&
      allEdges.some((e) => e.src === n.node_id && e.dst.startsWith("delivery:"))
    ) || null;
  }, [nodes, allEdges, activeApp]);

  const deliveriesSql = useMemo(() => {
    if (!deliveryFlight) return "";
    const cols = (deliveryFlight.ledger_detail_columns || [])
      .map((c) => `"${c}"::VARCHAR AS "${c}"`).join(", ");
    return `SELECT strftime("${deliveryFlight.ledger_ts_column}", '%b %d %H:%M') AS "__at", ${cols}
      FROM "${DB}"."main"."${deliveryFlight.ledger_table}"
      ORDER BY "${deliveryFlight.ledger_ts_column}" DESC LIMIT 8`;
  }, [deliveryFlight]);
  const deliveriesQ = useSQLQuery(deliveriesSql || "SELECT 1", { enabled: !!deliveriesSql });

  const health = useMemo(() => {
    const m = new Map<string, { last_at: string; age_s: number; is_ok: boolean; last_status: string }>();
    for (const r of Array.isArray(healthQ.data) ? (healthQ.data as any[]) : []) {
      if (r.node_id == null) continue;
      m.set(String(r.node_id), {
        last_at: String(r.last_at || ""),
        age_s: N(r.age_s),
        is_ok: Boolean(r.is_ok),
        last_status: String(r.last_status || ""),
      });
    }
    return m;
  }, [healthQ.data]);

  const vitals = useMemo(() => {
    const m = new Map<string, { n: number | null; kind: string }>();
    for (const r of Array.isArray(vitalsQ.data) ? (vitalsQ.data as any[]) : []) {
      m.set(String(r.table_name), {
        n: r.n == null ? null : N(r.n),
        kind: String(r.kind || "table"),
      });
    }
    return m;
  }, [vitalsQ.data]);

  // Status per node: own ledger first, then inherit along the flow.
  const statusOf = useMemo(() => {
    const m = new Map<string, Status>();
    for (const n of nodes) {
      if (n.node_type === "flight") {
        // Job health from platform RUN HISTORY, not a data ledger. Staleness is
        // opt-in: with no stale_hours a quiet flight never false-alarms.
        const stale = n.stale_hours != null && n.last_run_age_s != null &&
          n.last_run_age_s > n.stale_hours * 3600;
        if (!n.last_run_at) m.set(n.node_id, "idle");          // never run
        else if (runFailed(n.last_run_status)) m.set(n.node_id, "fail");
        else if (stale) m.set(n.node_id, "warn");
        else m.set(n.node_id, "ok");
      } else if (n.ledger_table) {
        // Non-flight with a data ledger: freshness comes from the ledger.
        const h = health.get(n.node_id);
        if (!h || !h.last_at) m.set(n.node_id, "idle");
        else if (!h.is_ok) m.set(n.node_id, "fail");
        else m.set(n.node_id, "ok");
      } else if (n.node_type === "dive") {
        m.set(n.node_id, n.source_kind === "code" ? "ok" : "idle");
      } else if (n.node_type === "table") {
        // In neither catalog → missing (warn); a view is healthy as-is; a
        // table is healthy iff it has rows.
        const v = vitals.get(n.name);
        if (!v) m.set(n.node_id, "warn");
        else if (v.kind === "view") m.set(n.node_id, "ok");
        else m.set(n.node_id, (v.n || 0) > 0 ? "ok" : "warn");
      }
    }
    // Derived endpoints inherit from the manifest-carrying node beside them:
    // shares/deliveries from their writer/feeder, sources from their reader.
    for (const n of nodes) {
      if (m.has(n.node_id)) continue;
      const writers = allEdges
        .filter((e) => e.dst === n.node_id && m.has(e.src))
        .map((e) => m.get(e.src)!);
      const readers = allEdges
        .filter((e) => e.src === n.node_id && m.has(e.dst))
        .map((e) => m.get(e.dst)!);
      const pool = writers.length ? writers : readers;
      const worst = (["fail", "warn", "idle", "ok"] as Status[])
        .find((s) => pool.includes(s));
      m.set(n.node_id, pool.length ? (worst as Status) : "idle");
    }
    return m;
  }, [nodes, health, vitals, allEdges]);

  // ── per-app, per-view graph: BFS to the app's subgraph, filter by view,
  //    collapse tables into the warehouse, reduce, then walk from the roots.
  const graph = useMemo(() => {
    if (!nodes.length) return null;
    const appCode = nodes.filter((n) => n.app === activeApp && n.source_kind === "code");
    if (!appCode.length) return null;

    // Undirected reachability from this app's code objects (all edge kinds).
    const visible = new Set(appCode.map((n) => n.node_id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of allEdges) {
        const srcN = byId.get(e.src);
        const dstN = byId.get(e.dst);
        // Don't walk INTO another app's code objects.
        const blocked = (x?: CtNode) =>
          x && x.source_kind === "code" && x.app !== activeApp;
        if (visible.has(e.src) && !visible.has(e.dst) && !blocked(dstN)) {
          visible.add(e.dst); grew = true;
        }
        if (visible.has(e.dst) && !visible.has(e.src) && !blocked(srcN)) {
          visible.add(e.src); grew = true;
        }
      }
    }

    const viewEdges = allEdges.filter(
      (e) => e.kind === view && visible.has(e.src) && visible.has(e.dst));

    const tableIds = new Set(
      [...visible].filter((id) => byId.get(id)?.node_type === "table"));
    const whId = `warehouse:${DB}`;
    const collapsed = collapseTables(visible, viewEdges, tableIds, whId);
    const edges = reduceTransitive(collapsed.edges);

    const indeg = new Map<string, number>();
    for (const id of collapsed.nodes) indeg.set(id, 0);
    for (const e of edges) indeg.set(e.dst, (indeg.get(e.dst) || 0) + 1);
    const roots = [...collapsed.nodes]
      .filter((id) => (indeg.get(id) || 0) === 0)
      .sort((a, b) =>
        (TYPE_ORDER[a.split(":")[0]] ?? 9) - (TYPE_ORDER[b.split(":")[0]] ?? 9) ||
        a.localeCompare(b));

    const childrenOf = (id: string) =>
      edges.filter((e) => e.src === id).map((e) => e.dst)
        .sort((a, b) =>
          (TYPE_ORDER[a.split(":")[0]] ?? 9) - (TYPE_ORDER[b.split(":")[0]] ?? 9) ||
          a.localeCompare(b));

    const memberTables = [...tableIds].map((id) => byId.get(id)!.name).sort();
    return { roots, childrenOf, memberTables, whId };
  }, [nodes, allEdges, byId, activeApp, view]);

  const issues = Array.isArray(issuesQ.data) ? (issuesQ.data as any[]) : [];
  const hidden = Array.isArray(hiddenQ.data) ? (hiddenQ.data as any[]) : [];
  const syncRow = Array.isArray(syncQ.data) ? (syncQ.data as any[])[0] : undefined;

  const appStatus = (app: string): Status => {
    const sts = nodes
      .filter((n) => n.app === app && n.source_kind === "code")
      .map((n) => statusOf.get(n.node_id) || "idle");
    return (["fail", "warn", "idle", "ok"] as Status[]).find((s) => sts.includes(s)) || "idle";
  };

  // ── node renderer (kind/title/stat all manifest- or catalog-driven) ──
  function renderNode(id: string) {
    if (graph && id === graph.whId) {
      const tables = graph.memberTables.map((name) => {
        const v = vitals.get(name);
        return { name, rows: v ? v.n : null, kind: v ? v.kind : undefined };
      });
      // A view is healthy without a row count; a table needs rows.
      const st: Status =
        tables.every((t) => t.kind === "view" || (t.rows || 0) > 0) ? "ok" : "warn";
      return <WarehouseCard title={DB} tables={tables} status={st} />;
    }
    const n = byId.get(id);
    const st = statusOf.get(id) || "idle";
    if (!n) return <NodeCard kind="?" title={id} status="idle" statusLabel="unknown" />;
    if (n.node_type === "dive") {
      return (
        <NodeCard kind={n.label || "Dive"} title={prettyName(n.name)}
          href={n.url || undefined} status={st}
          statusLabel={n.source_kind === "code" ? "published" : "not deployed"} />
      );
    }
    if (n.node_type === "flight") {
      // Stat + label come from platform run history (see statusOf).
      const ran = !!n.last_run_at;
      const runStatus = (n.last_run_status || "").toLowerCase();
      return (
        <NodeCard kind={n.label || "Flight"} title={n.name}
          href={n.url || undefined}
          stat={ran ? `${n.last_run_at} · ${runStatus}` : undefined}
          status={st}
          statusLabel={!ran ? "never run" : st === "warn" ? "stale" : runStatus} />
      );
    }
    if (n.node_type === "share") {
      return (
        <NodeCard kind="Share" title={n.name} status={st}
          statusLabel={st === "ok" ? "auto-updating" : st === "idle" ? "no writer yet" : "writer unhealthy"} />
      );
    }
    if (n.node_type === "source") {
      return (
        <NodeCard kind="Source" title={prettyName(n.name)}
          href={n.url || undefined} status={st}
          statusLabel={st === "ok" ? "responding" : "no data"} />
      );
    }
    if (n.node_type === "delivery") {
      return (
        <NodeCard kind="Delivery" title={prettyName(n.name)}
          href={n.url || undefined} status={st}
          statusLabel={st === "ok" ? "delivering" : st === "fail" ? "delivery failures" : "no deliveries yet"} />
      );
    }
    return <NodeCard kind={n.node_type} title={n.name} status={st} statusLabel={st} />;
  }

  // Recursive linear-with-forks chain walk (column-per-depth via nesting).
  function renderChain(id: string, rendered: Set<string>): JSX.Element {
    rendered.add(id);
    const kids = (graph ? graph.childrenOf(id) : []).filter((k) => !rendered.has(k));
    return (
      <div style={{ display: "flex", alignItems: "center" }}>
        {renderNode(id)}
        {kids.length === 1 ? (
          <>
            <Arrow />
            {renderChain(kids[0], rendered)}
          </>
        ) : kids.length > 1 ? (
          <>
            <Fork ys={kids.map((_, i) => ((i + 0.5) / kids.length) * 100)} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {kids.map((k) => (
                <div key={k}>{renderChain(k, rendered)}</div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#f8f8f8",
        color: C.text,
        fontFamily: "Georgia, 'Times New Roman', serif",
        padding: 24,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Control Tower</h1>
      <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 20px" }}>
        Every app, its data flow, and where it hurts — drawn from the manifests, not from code.
      </p>

      {/* Issues strip */}
      {issues.length ? (
        <div style={{ marginBottom: 16 }}>
          {issues.map((i, k) => (
            <div
              key={k}
              style={{
                borderLeft: `3px solid ${String(i.severity) === "error" ? C.fail : C.warn}`,
                background: "#fff",
                padding: "6px 12px",
                marginBottom: 4,
                fontSize: 12,
                fontFamily: NUM_FONT,
                color: String(i.severity) === "error" ? C.fail : C.warn,
              }}
            >
              <strong>{String(i.object_key)}</strong> · {String(i.kind)} — {String(i.detail)}
            </div>
          ))}
        </div>
      ) : null}

      {/* Apps */}
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: C.muted,
          fontFamily: NUM_FONT,
          marginBottom: 8,
        }}
      >
        Apps
      </div>
      {objectsQ.isLoading ? <Skeleton w={760} h={44} /> : null}
      {apps.map((app) => {
        const st = appStatus(app);
        const code = nodes.filter((n) => n.app === app && n.source_kind === "code");
        const flights = code.filter((n) => n.node_type === "flight").length;
        const dives = code.filter((n) => n.node_type === "dive").length;
        const tbls = nodes.filter((n) => n.app === app && n.node_type === "table").length;
        const newest = code
          .map((n) => (n.node_type === "flight" ? n.last_run_at : health.get(n.node_id)?.last_at) || "")
          .filter(Boolean).sort().slice(-1)[0];
        return (
          <button
            key={app}
            onClick={() => setSelectedApp(app)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              background: activeApp === app ? "#fff" : "transparent",
              border: `1px solid ${activeApp === app ? C.border : "transparent"}`,
              borderLeft: `3px solid ${C[st]}`,
              padding: "10px 14px",
              cursor: "pointer",
              fontFamily: "inherit",
              marginBottom: 8,
            }}
          >
            <Dot status={st} />
            <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
              {prettyName(app)}
            </span>
            <span style={{ fontSize: 12, color: C.muted }}>
              {flights} flight{flights === 1 ? "" : "s"} · {tbls} table{tbls === 1 ? "" : "s"} · {dives} dive{dives === 1 ? "" : "s"}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 12,
                color: C.muted,
                fontFamily: NUM_FONT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {newest ? `last run ${newest}` : "no runs yet"}
            </span>
          </button>
        );
      })}

      {/* Data flow header + logical/physical toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "8px 0 8px" }}>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: C.muted,
            fontFamily: NUM_FONT,
            minWidth: 150,
          }}
        >
          {view === "logical" ? "Logical data flow" : "Physical data flow"}
        </div>
        <div style={{ display: "flex", border: `1px solid ${C.border}` }}>
          {(["logical", "physical"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                border: "none",
                cursor: "pointer",
                padding: "3px 10px",
                fontSize: 11,
                fontFamily: NUM_FONT,
                background: view === v ? C.accent : "#fff",
                color: view === v ? "#fff" : C.muted,
              }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {objectsQ.isLoading || edgesQ.isLoading ? (
        <Skeleton w={760} h={96} />
      ) : !graph ? (
        <p style={{ fontSize: 13, color: C.muted }}>
          No objects in this app yet — run manifest-sync after deploying something.
        </p>
      ) : (
        <div style={{ display: "flex", alignItems: "center", overflowX: "auto", paddingBottom: 4 }}>
          {(() => {
            const rendered = new Set<string>();
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {graph.roots.map((r) =>
                  rendered.has(r) ? null : <div key={r}>{renderChain(r, rendered)}</div>)}
              </div>
            );
          })()}
        </div>
      )}

      {/* Unified run log across every ledger the manifests declare */}
      <div
        style={{
          display: "flex",
          gap: 24,
          alignItems: "flex-start",
          flexWrap: "wrap",
          marginTop: 24,
        }}
      >
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderTop: `3px solid ${C.ok}`,
            background: "#fff",
            padding: "10px 14px 12px",
          }}
        >
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: C.muted,
              fontFamily: NUM_FONT,
              marginBottom: 6,
            }}
          >
            Recent runs · all ledgers
          </div>
          {runlogQ.isLoading ? (
            <Skeleton w={460} h={80} />
          ) : (
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: 12,
                fontFamily: NUM_FONT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <thead>
                <tr style={{ color: C.muted, textAlign: "left" }}>
                  <th style={{ padding: "4px 16px 4px 0", fontWeight: 400 }}>at</th>
                  <th style={{ padding: "4px 16px 4px 0", fontWeight: 400 }}>object</th>
                  <th style={{ padding: "4px 0", fontWeight: 400 }}>status</th>
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(runlogQ.data) ? (runlogQ.data as any[]) : [])
                  .filter((r) => r.run_at != null)
                  .map((r, i) => {
                    const okSet = nodes.find((n) => n.name === String(r.object_name))?.ledger_ok_values || [];
                    const ok = okSet.includes(String(r.status));
                    return (
                      <tr key={i} style={{ borderTop: `1px solid ${C.sep}` }}>
                        <td style={{ padding: "5px 16px 5px 0", color: C.text }}>{String(r.run_at)}</td>
                        <td style={{ padding: "5px 16px 5px 0", color: C.text, fontWeight: 600 }}>
                          {String(r.object_name)}
                        </td>
                        <td style={{ padding: "5px 0", color: ok ? C.ok : C.fail }}>
                          {String(r.status)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent deliveries — columns declared by the flight's manifest */}
        {deliveryFlight ? (
          <div
            style={{
              border: `1px solid ${C.border}`,
              borderTop: `3px solid ${C[statusOf.get(deliveryFlight.node_id) || "idle"]}`,
              background: "#fff",
              padding: "10px 14px 12px",
            }}
          >
            <div
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: C.muted,
                fontFamily: NUM_FONT,
                marginBottom: 6,
              }}
            >
              Recent deliveries · {deliveryFlight.name}
            </div>
            {deliveriesQ.isLoading ? (
              <Skeleton w={460} h={80} />
            ) : !Array.isArray(deliveriesQ.data) || deliveriesQ.data.length === 0 ? (
              <p style={{ fontSize: 13, color: C.muted }}>No deliveries yet.</p>
            ) : (
              <table
                style={{
                  borderCollapse: "collapse",
                  fontSize: 12,
                  fontFamily: NUM_FONT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <thead>
                  <tr style={{ color: C.muted, textAlign: "left" }}>
                    <th style={{ padding: "4px 16px 4px 0", fontWeight: 400 }}>at</th>
                    {(deliveryFlight.ledger_detail_columns || []).map((c) => (
                      <th key={c} style={{ padding: "4px 16px 4px 0", fontWeight: 400 }}>
                        {c.replace(/_/g, " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(deliveriesQ.data as any[]).map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.sep}` }}>
                      <td style={{ padding: "5px 16px 5px 0", color: C.text }}>
                        {String(r.__at)}
                      </td>
                      {(deliveryFlight.ledger_detail_columns || []).map((c) => {
                        const v = r[c] == null ? "—" : String(r[c]);
                        const isStatus = c === deliveryFlight.ledger_status_column;
                        const ok = (deliveryFlight.ledger_ok_values || []).includes(v);
                        return (
                          <td
                            key={c}
                            style={{
                              padding: "5px 16px 5px 0",
                              color: isStatus ? (ok ? C.ok : C.fail) : C.text,
                            }}
                          >
                            {v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>

      {/* Hidden objects — intentionally excluded from the graph + issues */}
      {hidden.length ? (
        <div style={{ marginTop: 20 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: C.muted,
              fontFamily: NUM_FONT,
              marginBottom: 6,
            }}
          >
            Hidden ({hidden.length})
          </div>
          {hidden.map((h, k) => (
            <div
              key={k}
              style={{ fontSize: 12, fontFamily: NUM_FONT, color: C.muted, padding: "2px 0" }}
            >
              <strong style={{ color: C.text }}>{String(h.object_key)}</strong>
              {h.reason ? ` — ${String(h.reason)}` : ""}
            </div>
          ))}
        </div>
      ) : null}

      {/* Sync footer */}
      <p style={{ fontSize: 11, color: C.muted, fontFamily: NUM_FONT, marginTop: 16 }}>
        {syncRow && syncRow.synced_at
          ? `graph synced ${String(syncRow.synced_at)} UTC · ${String(syncRow.detail || "")}`
          : "manifest-sync has not run yet"}
      </p>
    </div>
  );
}
