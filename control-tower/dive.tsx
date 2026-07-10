/* Lineage for this dive is cataloged in ct_registry (authored via the
   build-manifest skill), NOT in an in-source @manifest block. */

import { useMemo, useRef, useState, useEffect, createContext, useContext } from "react";
import { useSQLQuery, useDiveState } from "@motherduck/react-sql-query";

const N = (v: unknown): number => (v != null ? Number(v) : 0);
const runFailed = (s: string | null): boolean => s === "FAILED" || s === "CANCELLED";

const SANS = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = "ui-monospace, Menlo, Consolas, monospace";
const SERIF = "Georgia, 'Times New Roman', serif";

const DB = "control_tower";                    // canonical Control Tower DB the dive reads (all ct_* tables)
const WAREHOUSE = "uncharted";  // fallback only: a table with no database collapses into a node with this label. Normally each table collapses into warehouse:<its own database>, so a board can show N warehouses.

// About tab: a "what is this / how it works / where to get it" pane. Ships in both the
// gallery dive and the OSS download. Set to false to hide it.
const ABOUT = true;
// Explainer video. Set to a YouTube video ID once recorded & uploaded; until then the
// About pane omits the video box entirely.
const VIDEO_ID = "";
const REPO_URL = "https://github.com/SDB-Ryan/motherduck-control-tower";

// Two palettes; the active one (C) is swapped per theme at render time. Every
// style reads C, so switching themes is a single reassignment.
const DARK = {
  canvasGrad: "radial-gradient(130% 90% at 50% -12%, #11151F 0%, #0B0E14 46%, #07090E 100%)",
  sidebarGrad: "linear-gradient(180deg,#0C1016,#090C12)",
  board: "#070A0F",
  nodeGrad: "linear-gradient(180deg,#161C28,#10151E)",
  panelGrad: "linear-gradient(180deg,#10151E,#0C1118)",
  inset: "rgba(255,255,255,.02)",
  rowHover: "rgba(255,255,255,.05)",
  text: "#EAEEF5", text2: "#C2CAD6", muted: "#9BA6B6", muted2: "#828C9A",
  faint: "#69727F", faint2: "#5A6373", faint3: "#566072",
  accent: "#8B93FF", accentTint: "rgba(139,147,255,.18)",
  hair: "rgba(255,255,255,.06)", hairStrong: "rgba(255,255,255,.13)",
  gridDot: "rgba(255,255,255,.04)", gridLine: "rgba(255,255,255,.04)",
  boardShadow: "inset 0 1px 0 rgba(255,255,255,.04), inset 0 50px 90px -50px rgba(0,0,0,.65)",
  cardBorder: "rgba(255,255,255,.085)",
  cardShadow: "0 8px 20px -10px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.05)",
  glassBg: "rgba(8,11,17,.62)", tooltipBg: "rgba(10,13,19,.96)", btnBg: "rgba(8,11,17,.72)",
  nodeFill: "#0E131C", iconColor: "#9db4d0", scrollThumb: "rgba(255,255,255,.09)",
};
const LIGHT = {
  canvasGrad: "radial-gradient(130% 90% at 50% -12%, #FFFFFF 0%, #F3F6FB 46%, #EAEFF6 100%)",
  sidebarGrad: "linear-gradient(180deg,#FCFDFF,#F2F5FB)",
  board: "#ECF1F8",
  nodeGrad: "linear-gradient(180deg,#FFFFFF,#F6F9FD)",
  panelGrad: "linear-gradient(180deg,#FFFFFF,#F7FAFD)",
  inset: "rgba(0,0,0,.025)",
  rowHover: "rgba(0,0,0,.045)",
  text: "#1A2230", text2: "#3C4658", muted: "#5C6878", muted2: "#6E7A8A",
  faint: "#8893A2", faint2: "#9AA5B3", faint3: "#A6B1BE",
  accent: "#5B63E0", accentTint: "rgba(91,99,224,.14)",
  hair: "rgba(0,0,0,.09)", hairStrong: "rgba(0,0,0,.16)",
  gridDot: "rgba(0,0,0,.06)", gridLine: "rgba(0,0,0,.05)",
  boardShadow: "inset 0 1px 0 rgba(255,255,255,.7), inset 0 30px 70px -52px rgba(20,30,50,.20)",
  cardBorder: "rgba(0,0,0,.10)",
  cardShadow: "0 6px 16px -10px rgba(20,30,50,.28), inset 0 1px 0 rgba(255,255,255,.85)",
  glassBg: "rgba(255,255,255,.82)", tooltipBg: "rgba(255,255,255,.98)", btnBg: "rgba(255,255,255,.88)",
  nodeFill: "#FFFFFF", iconColor: "#5C6878", scrollThumb: "rgba(0,0,0,.18)",
};
type Pal = typeof DARK;

type Status = "ok" | "fail" | "warn" | "idle";
type SM = { color: string; text: string; bg: string; glyph: string; label: string };
const DARK_SMAP: Record<Status, SM> = {
  ok: { color: "#3FB950", text: "#56D364", bg: "rgba(63,185,80,.14)", glyph: "✓", label: "Healthy" },
  warn: { color: "#D6A02A", text: "#F0B84B", bg: "rgba(214,160,42,.15)", glyph: "~", label: "Stale" },
  fail: { color: "#F8514A", text: "#FF6F66", bg: "rgba(248,81,74,.15)", glyph: "✕", label: "Failing" },
  idle: { color: "#6A7383", text: "#9BA6B6", bg: "rgba(106,115,131,.16)", glyph: "–", label: "Idle" },
};
const LIGHT_SMAP: Record<Status, SM> = {
  ok: { color: "#2DA44E", text: "#1A7F37", bg: "rgba(45,164,78,.14)", glyph: "✓", label: "Healthy" },
  warn: { color: "#BF8700", text: "#9A6700", bg: "rgba(191,135,0,.16)", glyph: "~", label: "Stale" },
  fail: { color: "#CF222E", text: "#A40E26", bg: "rgba(207,34,46,.13)", glyph: "✕", label: "Failing" },
  idle: { color: "#6E7781", text: "#57606A", bg: "rgba(110,119,129,.14)", glyph: "–", label: "Idle" },
};
// Active palette flows through context (no module-level mutation during render).
const ThemeCtx = createContext<{ C: Pal; SMAP: Record<Status, SM> }>({ C: DARK, SMAP: DARK_SMAP });
const useTheme = () => useContext(ThemeCtx);

function fmt(n: number): string {
  // Thresholds sit at the rounding boundary so e.g. 999,950 reads "1M", not "1000K".
  if (n >= 999500) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Quote a SQL identifier / string literal from manifest-sourced values.
const qid = (s: string) => '"' + String(s).replace(/"/g, '""') + '"';
const qlit = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";
// Clock label (HH:MM, local) + coarse relative age, for the freshness footer.
const clockHM = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const agoLabel = (sec: number) => sec < 60 ? "just now" : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 3600)}h ago`;

const PITCH = 162, CX0 = 92, NODE_W = 150, ROW = 120;
// ROWGAP keeps a normal 76px node at the old 120px pitch while letting tall warehouse
// cards claim proportional room; DUMMY_LANE is the thin lane a routed long edge threads;
// FAN is the max vertical spread of fan-in/out anchors (< circle R=24, so it's valid for
// both the circle Overview and the rectangular board).
const ROWGAP = ROW - 76, DUMMY_LANE = 34, FAN = 16, BAND_GAP = 34;
function edgePathStr(ax: number, ay: number, bx: number, by: number): string {
  const c = Math.max(34, (bx - ax) * 0.5);
  return `M ${ax} ${ay} C ${ax + c} ${ay}, ${bx - c} ${by}, ${bx} ${by}`;
}
// Smooth left→right curve through waypoints. 2 points = the same horizontal-tangent
// S-curve as edgePathStr; ≥3 points = one cubic per gap (Catmull-Rom-ish) with control
// points biased horizontally so the line flows L→R and threads each lane without
// overshooting into card corners.
function splinePath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return edgePathStr(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const dx = p2.x - p1.x, t = 0.16;
    const c1x = p1.x + dx * 0.5, c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - dx * 0.5, c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
function edgeStat(a: Status, b: Status): Status {
  const s = [a, b];
  if (s.indexOf("fail") >= 0) return "fail";
  if (s.indexOf("idle") >= 0) return "idle";
  if (s.indexOf("warn") >= 0) return "warn";
  return "ok";
}
function edgeStyle(st: Status, motion: boolean) {
  switch (st) {
    case "ok": return { stroke: "rgba(86,211,100,.5)", dash: "6 7", anim: motion ? "ctdash 1.1s linear infinite" : "none", op: 0.9, w: 1.7 };
    case "warn": return { stroke: "rgba(214,160,42,.5)", dash: "0", anim: "none", op: 0.9, w: 1.6 };
    case "fail": return { stroke: "rgba(248,81,74,.55)", dash: "3 5", anim: "none", op: 0.95, w: 1.8 };
    default: return { stroke: "rgba(255,255,255,.11)", dash: "0", anim: "none", op: 1, w: 1.4 };
  }
}

type GraphT = { roots: string[]; childrenOf: (id: string) => string[]; warehouses: Map<string, string[]>; cyclic: boolean; nodeIds: string[] };
type Pos = { cx: number; cy: number; left: number; top: number; w: number; h: number; col: number };
// A drawn edge: keeps src/dst identity (hover highlighting keys off them), and carries its
// resolved geometry — sy/dy = the fanned anchor Y where it leaves src / enters dst, way =
// the per-column lane waypoints a multi-column edge routes through (empty for short edges).
type RoutedEdge = { src: string; dst: string; sy: number; dy: number; way: { x: number; y: number }[] };
type LayoutT = { pos: Map<string, Pos>; edges: RoutedEdge[]; boardW: number; boardH: number; maxCol: number; degraded: boolean };

// Pure structural layout — assigns (x,y) + dynamic board height. Works for any
// graph (a single app, or the whole environment merged). Presentation only.
function computeLayout(graph: GraphT | null): LayoutT | null {
  if (!graph) return null;
  const allNodes = new Set<string>(); const order: string[] = [];
  const visit = (id: string) => { if (allNodes.has(id)) return; allNodes.add(id); order.push(id); for (const c of graph.childrenOf(id)) visit(c); };
  graph.roots.forEach(visit);
  const edges: { src: string; dst: string }[] = [];
  for (const id of allNodes) for (const c of graph.childrenOf(id)) if (allNodes.has(c)) edges.push({ src: id, dst: c });
  const col = new Map<string, number>(); allNodes.forEach((id) => col.set(id, 0));
  let ch = true, g = 0;
  while (ch && g++ < 4000) { ch = false; for (const e of edges) { const v = Math.max(col.get(e.dst)!, col.get(e.src)! + 1); if (v !== col.get(e.dst)) { col.set(e.dst, v); ch = true; } } }
  // Longest-path relaxation converges in a DAG; if it's still changing at the
  // cap, the visible graph has a cycle and the column assignment is meaningless.
  const degraded = ch;
  const orderIdx = new Map(order.map((id, i) => [id, i]));
  const heightOf = (id: string) => graph.warehouses.has(id) ? Math.max(76, 52 + graph.warehouses.get(id)!.length * 26) : 76;

  // Degraded (cyclic): columns are meaningless, so just center each column by DFS
  // order — the caller renders an error panel over this, never the graph itself.
  if (degraded) {
    const byCol = new Map<number, string[]>();
    for (const id of allNodes) { const c = col.get(id)!; if (!byCol.has(c)) byCol.set(c, []); byCol.get(c)!.push(id); }
    for (const arr of byCol.values()) arr.sort((a, b) => orderIdx.get(a)! - orderIdx.get(b)!);
    let mc = 0, ml = 1;
    for (const [c, arr] of byCol) { if (c > mc) mc = c; if (arr.length > ml) ml = arr.length; }
    const bH = Math.max(440, ml * ROW + 56);
    const pos = new Map<string, Pos>();
    for (const [c, arr] of byCol) { const k = arr.length; arr.forEach((id, idx) => { const cy = bH / 2 + (idx - (k - 1) / 2) * ROW; const cx = CX0 + c * PITCH; const h = heightOf(id); pos.set(id, { cx, cy, left: cx - NODE_W / 2, top: cy - h / 2, w: NODE_W, h, col: c }); }); }
    const re: RoutedEdge[] = edges.map((e) => ({ src: e.src, dst: e.dst, sy: pos.get(e.src)!.cy, dy: pos.get(e.dst)!.cy, way: [] }));
    return { pos, edges: re, boardW: Math.max(620, CX0 + mc * PITCH + NODE_W / 2 + 28), boardH: bH, maxCol: mc, degraded };
  }

  // ── Sugiyama-style layered layout (DAG) ──────────────────────────────────
  // Reserved-prefix dummy ids; real ids are "<type>:<name>" so "~dummy " can't collide.
  const DUM = "~dummy ";
  type ChainE = { src: string; dst: string; chain: string[] };
  const typeRank = (id: string) => id.startsWith(DUM) ? 9 : (TYPE_ORDER[id.split(":")[0]] ?? 8);
  const cmpId = (a: string, b: string) => (typeRank(a) - typeRank(b)) || a.localeCompare(b);

  // Weakly-connected components = apps that actually share data. Each becomes a vertical
  // band so one app's edges stay local instead of detouring across the whole board; a node
  // shared by several apps (e.g. one warehouse feeding many) correctly merges them into one
  // band — soft grouping by real connectivity, never forced lanes.
  const root = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (root.get(r) !== r) r = root.get(r)!; while (root.get(x) !== r) { const n = root.get(x)!; root.set(x, r); x = n; } return r; };
  for (const id of allNodes) root.set(id, id);
  for (const e of edges) { const ra = find(e.src), rb = find(e.dst); if (ra !== rb) root.set(ra, rb); }
  const compMin = new Map<string, number>();
  for (const id of allNodes) { const r = find(id), o = orderIdx.get(id)!; if (!compMin.has(r) || o < compMin.get(r)!) compMin.set(r, o); }
  const compRank = new Map([...compMin.entries()].sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0])).map(([r], i) => [r, i] as [string, number]));
  const crank = new Map<string, number>();
  for (const id of allNodes) crank.set(id, compRank.get(find(id))!);

  // Per-column layers of real + dummy nodes; a long edge becomes a real→dummy→…→real
  // unit-span path so ordering + routing treat it like any other edge.
  const layers = new Map<number, string[]>();
  const addLayer = (c: number, id: string) => { if (!layers.has(c)) layers.set(c, []); layers.get(c)!.push(id); };
  for (const id of allNodes) addLayer(col.get(id)!, id);
  const down = new Map<string, string[]>(), up = new Map<string, string[]>();
  const link = (a: string, b: string) => { (down.get(a) || down.set(a, []).get(a)!).push(b); (up.get(b) || up.set(b, []).get(b)!).push(a); };
  const dcol = new Map<string, number>();
  const chains: ChainE[] = [];
  for (const e of edges) {
    const cs = col.get(e.src)!, cd = col.get(e.dst)!;
    if (cd - cs <= 1) { link(e.src, e.dst); chains.push({ src: e.src, dst: e.dst, chain: [] }); continue; }
    const chain: string[] = []; let prev = e.src;
    for (let c = cs + 1; c < cd; c++) { const d = `${DUM}${e.src}|${e.dst}|${c}`; addLayer(c, d); dcol.set(d, c); crank.set(d, crank.get(e.src)!); chain.push(d); link(prev, d); prev = d; }
    link(prev, e.dst); chains.push({ src: e.src, dst: e.dst, chain });
  }
  let maxCol = 0; for (const c of layers.keys()) if (c > maxCol) maxCol = c;

  // Initial within-layer order: real by DFS order, dummy by its endpoints' average.
  const initKey = new Map<string, number>();
  for (const id of allNodes) initKey.set(id, orderIdx.get(id)!);
  for (const { src, dst, chain } of chains) { const avg = ((orderIdx.get(src) ?? 0) + (orderIdx.get(dst) ?? 0)) / 2; for (const d of chain) initKey.set(d, avg); }
  for (const arr of layers.values()) arr.sort((a, b) => (crank.get(a)! - crank.get(b)!) || (initKey.get(a)! - initKey.get(b)!) || cmpId(a, b));

  // Median crossing-minimization: 4 down+up sweeps. Deterministic — a no-neighbor
  // node keeps its current index; ties break by index then id (no random/time).
  const medianOf = (id: string, neigh: Map<string, string[]>, pm: Map<string, number>) => {
    const ns = (neigh.get(id) || []).map((n) => pm.get(n)!).filter((i) => i !== undefined).sort((x, y) => x - y);
    if (!ns.length) return -1; const m = ns.length; return (ns[(m - 1) >> 1] + ns[m >> 1]) / 2;
  };
  const sweep = (c: number, adj: number, neigh: Map<string, string[]>) => {
    const arr = layers.get(c); if (!arr) return;
    const pm = new Map((layers.get(adj) || []).map((id, i) => [id, i] as [string, number]));
    const cur = new Map(arr.map((id, i) => [id, i] as [string, number]));
    const med = new Map(arr.map((id) => { const m = medianOf(id, neigh, pm); return [id, m < 0 ? cur.get(id)! : m] as [string, number]; }));
    arr.sort((a, b) => (crank.get(a)! - crank.get(b)!) || (med.get(a)! - med.get(b)!) || (cur.get(a)! - cur.get(b)!) || cmpId(a, b));
  };
  for (let it = 0; it < 4; it++) {
    for (let c = 1; c <= maxCol; c++) sweep(c, c - 1, up);
    for (let c = maxCol - 1; c >= 0; c--) sweep(c, c + 1, down);
  }

  // Height-aware stacking inside per-component bands: each slot (a node, or a thin dummy
  // lane) claims its own height; a component's band is fixed across all columns so its
  // edges stay within the band. Also fixes tall-warehouse overlap.
  const slotH = (id: string) => id.startsWith(DUM) ? DUMMY_LANE : heightOf(id) + ROWGAP;
  const bandH = new Map<number, number>();
  for (const [, arr] of layers) {
    const per = new Map<number, number>();
    for (const id of arr) { const r = crank.get(id)!; per.set(r, (per.get(r) || 0) + slotH(id)); }
    for (const [r, h] of per) if (h > (bandH.get(r) || 0)) bandH.set(r, h);
  }
  const ranks = [...bandH.keys()].sort((a, b) => a - b);
  let totalH = 0; ranks.forEach((r, i) => { totalH += bandH.get(r)! + (i ? BAND_GAP : 0); });
  const boardH = Math.max(440, totalH + 56);
  const bandTop = new Map<number, number>(); let cursor = (boardH - totalH) / 2;
  for (const r of ranks) { bandTop.set(r, cursor); cursor += bandH.get(r)! + BAND_GAP; }
  const yOf = new Map<string, number>(); const pos = new Map<string, Pos>();
  for (const [c, arr] of layers) {
    const cx = CX0 + c * PITCH;
    let i = 0;
    while (i < arr.length) {
      const r = crank.get(arr[i])!; let j = i, slice = 0;
      while (j < arr.length && crank.get(arr[j])! === r) { slice += slotH(arr[j]); j++; }
      let running = bandTop.get(r)! + bandH.get(r)! / 2 - slice / 2;
      for (let k = i; k < j; k++) { const id = arr[k], sh = slotH(id), cy = running + sh / 2; running += sh; yOf.set(id, cy); if (!id.startsWith(DUM)) { const h = heightOf(id); pos.set(id, { cx, cy, left: cx - NODE_W / 2, top: cy - h / 2, w: NODE_W, h, col: c }); } }
      i = j;
    }
  }

  // Fan-in/out anchors: spread a node's edges across distinct points (±FAN) on its
  // face, ordered by where each is heading, so a 1→many fan / many→1 merge reads as
  // separated strands instead of one overlapping bundle.
  const firstY = (ec: ChainE) => yOf.get(ec.chain.length ? ec.chain[0] : ec.dst)!;
  const lastY = (ec: ChainE) => yOf.get(ec.chain.length ? ec.chain[ec.chain.length - 1] : ec.src)!;
  const outOf = new Map<string, ChainE[]>(), inOf = new Map<string, ChainE[]>();
  for (const ec of chains) { (outOf.get(ec.src) || outOf.set(ec.src, []).get(ec.src)!).push(ec); (inOf.get(ec.dst) || inOf.set(ec.dst, []).get(ec.dst)!).push(ec); }
  const syOf = new Map<ChainE, number>(), dyOf = new Map<ChainE, number>();
  const fan = (node: string, list: ChainE[], keyY: (e: ChainE) => number, otherId: (e: ChainE) => string, into: Map<ChainE, number>) => {
    list.sort((p, q) => (keyY(p) - keyY(q)) || cmpId(otherId(p), otherId(q)));
    const k = list.length, cy = yOf.get(node)!, step = k > 1 ? (2 * FAN) / (k - 1) : 0;
    list.forEach((ec, i) => { const off = (i - (k - 1) / 2) * step; into.set(ec, Math.max(cy - FAN, Math.min(cy + FAN, cy + off))); });
  };
  for (const [node, list] of outOf) fan(node, list, firstY, (e) => e.dst, syOf);
  for (const [node, list] of inOf) fan(node, list, lastY, (e) => e.src, dyOf);

  const routed: RoutedEdge[] = chains.map((ec) => ({
    src: ec.src, dst: ec.dst,
    sy: syOf.get(ec) ?? yOf.get(ec.src)!, dy: dyOf.get(ec) ?? yOf.get(ec.dst)!,
    way: ec.chain.map((d) => ({ x: CX0 + dcol.get(d)! * PITCH, y: yOf.get(d)! })),
  }));
  const boardW = Math.max(620, CX0 + maxCol * PITCH + NODE_W / 2 + 28);
  return { pos, edges: routed, boardW, boardH, maxCol, degraded };
}

const prefersReduced = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
const MOTION = !prefersReduced;

type CtNode = {
  node_id: string; node_type: string; name: string; app: string | null; database: string; label: string; url: string | null;
  schedule_deployed: string | null; source_kind: string; ledger_table: string | null; ledger_ts_column: string | null;
  ledger_status_column: string | null; ledger_ok_values: string[] | null; ledger_detail_columns: string[] | null;
  ledger_valid: boolean | null;
  last_run_at: string | null; last_run_age_s: number | null; last_run_status: string | null; stale_hours: number | null;
};
type Edge = { src: string; dst: string };

function collapseTables(nodeIds: Set<string>, edges: Edge[], tableIds: Set<string>, whOf: (id: string) => string) {
  const counts = new Map<string, number>();
  const whs = new Set<string>();
  const map = (id: string) => { if (tableIds.has(id)) { const w = whOf(id); whs.add(w); return w; } return id; };
  for (const e of edges) {
    const src = map(e.src);
    const dst = map(e.dst);
    if (src === dst) continue;
    const k = `${src} ${dst}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out: Edge[] = [];
  for (const [k, n] of counts) {
    const [src, dst] = k.split(" ");
    const rev = counts.get(`${dst} ${src}`) || 0;
    if (rev > n) continue;
    if (rev === n && rev > 0 && whs.has(src)) continue;
    out.push({ src, dst });
  }
  const outNodes = new Set([...nodeIds].filter((id) => !tableIds.has(id)));
  for (const w of whs) outNodes.add(w);
  return { nodes: outNodes, edges: out };
}
function reduceTransitive(edges: Edge[]): Edge[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) { if (!adj.has(e.src)) adj.set(e.src, []); adj.get(e.src)!.push(e.dst); }
  const reaches = (from: string, to: string, skip: Edge): boolean => {
    const stack = [from]; const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) || []) { if (cur === skip.src && nxt === skip.dst) continue; stack.push(nxt); }
    }
    return false;
  };
  return edges.filter((e) => !reaches(e.src, e.dst, e));
}
const TYPE_ORDER: Record<string, number> = { source: 0, warehouse: 1, share: 2, dive: 3, flight: 4, delivery: 5, table: 6 };
function prettyName(name: string): string { return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

function Chip({ status, size = 16, fs = 10 }: { status: Status; size?: number; fs?: number }) {
  const { SMAP } = useTheme();
  const sm = (s: Status): SM => SMAP[s] || SMAP.idle;
  const m = sm(status);
  return <span style={{ width: size, height: size, borderRadius: 5, background: m.bg, color: m.text, fontFamily: MONO, fontSize: fs, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, lineHeight: 1 }}>{m.glyph}</span>;
}
function ApertureMark({ size = 26 }: { size?: number }) {
  const { C } = useTheme();
  const a = C.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <circle cx="13" cy="13" r="10" stroke={a} strokeOpacity="0.5" strokeWidth="1.3" />
      <circle cx="13" cy="13" r="5.5" stroke={C.text} strokeWidth="1.3" />
      <circle cx="13" cy="13" r="1.7" fill={a} />
      {[0, 90, 180, 270].map((d) => { const r = (d * Math.PI) / 180; return <line key={d} x1={13 + Math.cos(r) * 7.5} y1={13 + Math.sin(r) * 7.5} x2={13 + Math.cos(r) * 9.5} y2={13 + Math.sin(r) * 9.5} stroke={a} strokeOpacity="0.5" strokeWidth="1.3" strokeLinecap="round" />; })}
    </svg>
  );
}
function NetIcon({ color, size = 15 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <line x1="4.5" y1="4" x2="11" y2="5.5" stroke={color} strokeWidth="1.2" />
      <line x1="4.5" y1="4" x2="7" y2="12" stroke={color} strokeWidth="1.2" />
      <line x1="11" y1="5.5" x2="7" y2="12" stroke={color} strokeWidth="1.2" />
      <circle cx="4.5" cy="4" r="2" fill={color} />
      <circle cx="11" cy="5.5" r="2" fill={color} />
      <circle cx="7" cy="12" r="2" fill={color} />
    </svg>
  );
}
function EyeOff({ color, size = 15 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path d="M2 8 C3.6 5.2, 5.7 3.8, 8 3.8 C10.3 3.8, 12.4 5.2, 14 8 C12.4 10.8, 10.3 12.2, 8 12.2 C5.7 12.2, 3.6 10.8, 2 8 Z" stroke={color} strokeWidth="1.2" fill="none" />
      <circle cx="8" cy="8" r="2" stroke={color} strokeWidth="1.2" fill="none" />
      <path d="M3 13 L13 3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// Hand-drawn type glyphs for the network circles.
function NodeIcon({ type, name }: { type: string; name?: string }) {
  const { C } = useTheme();
  const c = C.iconColor;
  const common = { stroke: c, strokeWidth: 1.4, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  // database cylinder, reused by the warehouse node and database-backed sources.
  const cylinder = <g {...common}><ellipse cx="8" cy="4" rx="4.5" ry="1.7" /><path d="M3.5 4 V12 a4.5 1.7 0 0 0 9 0 V4" /><path d="M3.5 8 a4.5 1.7 0 0 0 9 0" /></g>;
  if (type === "source") {
    // Sources carry no declared subtype — infer database-ish vs API/feed from the
    // name so a catalog/warehouse source reads as a database, not a download.
    const isDb = /catalog|database|warehouse|postgres|mysql|snowflake|bigquery|duckdb|sqlite|redshift|motherduck|\bdb\b|\bsql\b/i.test(name || "");
    if (isDb) return cylinder;
    return <g {...common}><path d="M4 10 a3 3 0 0 1 .4 -5.9 a3.2 3.2 0 0 1 6 -.4 a2.6 2.6 0 0 1 .6 5.1" /><path d="M8 8.4 V13 M6 11 L8 13 L10 11" /></g>;
  }
  if (type === "flight") return <path d="M9 2 L4 9 H7.5 L7 14 L12 7 H8.5 Z" stroke={c} strokeWidth={1.4} fill="none" strokeLinejoin="round" />;
  if (type === "warehouse") return cylinder;
  // share: a dataset published outward — broadcast arcs from a single origin
  // (reads as "shared to consumers", not a generic network of bubbles).
  if (type === "share") return <g {...common}><circle cx="4.6" cy="11.4" r="1.4" fill={c} stroke="none" /><path d="M4.6 7.7 A3.7 3.7 0 0 1 8.3 11.4" /><path d="M4.6 4.2 A7.2 7.2 0 0 1 11.8 11.4" /></g>;
  if (type === "dive") return <g {...common}><rect x="3" y="3" width="4.4" height="4.4" rx="1" /><rect x="8.6" y="3" width="4.4" height="4.4" rx="1" /><rect x="3" y="8.6" width="4.4" height="4.4" rx="1" /><rect x="8.6" y="8.6" width="4.4" height="4.4" rx="1" /></g>;
  if (type === "delivery") return <path d="M14 2 L2 7 L7 9 L9 14 Z M7 9 L14 2" stroke={c} strokeWidth={1.4} fill="none" strokeLinejoin="round" />;
  return <circle cx="8" cy="8" r="4" {...common} />;
}

// Interactive network view (Overview): circles + swoopy edges, left→right flow,
// hover tooltip, scroll-zoom + drag-pan. Self-contained (no libraries).
type NodeInfo = { type: string; typeLabel: string; title: string; meta: string };
function NetworkView({ lay, statusFn, infoFn }: { lay: LayoutT; statusFn: (id: string) => Status; infoFn: (id: string) => NodeInfo }) {
  const { C, SMAP } = useTheme();
  const sm = (s: Status): SM => SMAP[s] || SMAP.idle;
  const [vt, setVt] = useState({ s: 1, x: 24, y: 16 });
  const [hover, setHover] = useState<string | null>(null);
  const [grab, setGrab] = useState(false);
  const dragRef = useRef<{ x0: number; y0: number; vx: number; vy: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const VH = 560, R = 24;

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setVt((v) => {
        const s = Math.max(0.35, Math.min(2.6, v.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const k = s / v.s;
        return { s, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Fit to width — used on mount, on graph change, and by the reset button.
  const fit = () => {
    const el = wrapRef.current; if (!el) return;
    const w = el.clientWidth;
    const s = Math.max(0.35, Math.min(1.15, (w - 56) / lay.boardW));
    setVt({ s, x: (w - lay.boardW * s) / 2, y: Math.max(16, (VH - lay.boardH * s) / 2) });
  };
  useEffect(() => { fit(); }, [lay]);

  const zoom = (f: number) => setVt((v) => ({ ...v, s: Math.max(0.35, Math.min(2.6, v.s * f)) }));
  const onDown = (e: any) => { dragRef.current = { x0: e.clientX, y0: e.clientY, vx: vt.x, vy: vt.y }; setGrab(true); };
  const onMove = (e: any) => { const d = dragRef.current; if (!d) return; setVt((v) => ({ ...v, x: d.vx + (e.clientX - d.x0), y: d.vy + (e.clientY - d.y0) })); };
  const onUp = () => { dragRef.current = null; setGrab(false); };

  const conn = hover ? (() => { const s = new Set([hover]); for (const e of lay.edges) { if (e.src === hover) s.add(e.dst); if (e.dst === hover) s.add(e.src); } return s; })() : null;
  const hPos = hover ? lay.pos.get(hover) : null;
  const hInfo = hover ? infoFn(hover) : null;

  return (
    <div ref={wrapRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
      style={{ position: "relative", height: VH, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.hair}`, background: C.board, backgroundImage: `radial-gradient(${C.gridDot} 1px, transparent 1px)`, backgroundSize: "24px 24px", boxShadow: C.boardShadow, cursor: grab ? "grabbing" : "grab", userSelect: "none" }}>
      <svg width="100%" height={VH} style={{ position: "absolute", inset: 0 }}>
        <defs><filter id="ctnetglow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.5" /></filter></defs>
        <g transform={`translate(${vt.x} ${vt.y}) scale(${vt.s})`}>
          {lay.edges.map((e, i) => {
            const a = lay.pos.get(e.src)!, b = lay.pos.get(e.dst)!;
            const sx = a.cx + Math.sqrt(Math.max(0, R * R - (e.sy - a.cy) ** 2));
            const ex = b.cx - Math.sqrt(Math.max(0, R * R - (e.dy - b.cy) ** 2));
            const d = splinePath([{ x: sx, y: e.sy }, ...e.way, { x: ex, y: e.dy }]);
            const sty = edgeStyle(edgeStat(statusFn(e.src), statusFn(e.dst)), MOTION);
            let op = sty.op, w = sty.w;
            if (hover) { const hot = e.src === hover || e.dst === hover; op = hot ? Math.min(1, sty.op + 0.35) : sty.op * 0.18; if (hot) w = sty.w + 1; }
            return <path key={i} d={d} fill="none" stroke={sty.stroke} strokeWidth={w} strokeDasharray={sty.dash} strokeLinecap="round" opacity={op} style={{ animation: sty.anim }} />;
          })}
          {[...lay.pos.keys()].map((id) => {
            const p = lay.pos.get(id)!; const st = statusFn(id); const m = sm(st); const info = infoFn(id);
            const op = conn ? (conn.has(id) ? 1 : 0.28) : 1;
            const isH = hover === id;
            return (
              <g key={id} transform={`translate(${p.cx} ${p.cy})`} opacity={op} style={{ cursor: "pointer" }} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}>
                <circle r={R + 6} fill={m.color} opacity={st === "idle" ? 0.08 : 0.18} filter="url(#ctnetglow)" />
                <circle r={R} fill={C.nodeFill} stroke={m.color} strokeWidth={isH ? 3.2 : 2.2} />
                <g transform="translate(-8 -8)"><NodeIcon type={info.type} name={id} /></g>
                <circle cx={R * 0.62} cy={-R * 0.62} r={4.5} fill={m.color} stroke={C.nodeFill} strokeWidth={1.6} />
              </g>
            );
          })}
        </g>
      </svg>

      {hInfo && hPos ? (
        <div style={{ position: "absolute", left: hPos.cx * vt.s + vt.x, top: hPos.cy * vt.s + vt.y - R * vt.s - 12, transform: "translate(-50%,-100%)", pointerEvents: "none", background: C.tooltipBg, border: `1px solid ${C.hairStrong}`, borderRadius: 10, padding: "9px 12px", minWidth: 150, boxShadow: "0 12px 32px rgba(0,0,0,.4)", zIndex: 5 }}>
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: ".13em", color: C.faint }}>{hInfo.typeLabel}</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, margin: "2px 0 5px" }}>{hInfo.title}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Chip status={statusFn(hover!)} size={14} fs={9} /><span style={{ fontFamily: MONO, fontSize: 11, color: C.muted2 }}>{hInfo.meta || sm(statusFn(hover!)).label}</span></div>
        </div>
      ) : null}

      <div style={{ position: "absolute", left: 14, bottom: 14, display: "flex", gap: 6 }}>
        {([["+", 1.2], ["−", 1 / 1.2]] as [string, number][]).map(([lab, f]) => (
          <button key={lab} onClick={() => zoom(f)} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.hair}`, background: C.btnBg, color: C.muted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>{lab}</button>
        ))}
        <button onClick={fit} title="Reset view" style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.hair}`, background: C.btnBg, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 6 V3 H6 M10 3 H13 V6 M13 10 V13 H10 M6 13 H3 V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div style={{ position: "absolute", right: 16, top: 14, fontFamily: MONO, fontSize: 10, color: C.faint }}>scroll to zoom · drag to pan · hover a node</div>
    </div>
  );
}

function ThemeIcon({ theme }: { theme: "light" | "dark" }) {
  if (theme === "dark") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => { const r = (d * Math.PI) / 180; return <line key={d} x1={8 + Math.cos(r) * 5} y1={8 + Math.sin(r) * 5} x2={8 + Math.cos(r) * 6.8} y2={8 + Math.sin(r) * 6.8} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />; })}
      </svg>
    );
  }
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M13 9.7 A5.6 5.6 0 1 1 6.3 3 A4.4 4.4 0 0 0 13 9.7 Z" fill="currentColor" /></svg>;
}

function styleCss(C: Pal) {
  return `
*{box-sizing:border-box;}
@keyframes ctdash { to { stroke-dashoffset:-13; } }
@keyframes ctsync { 0%,100%{opacity:.4;transform:scale(1);} 50%{opacity:1;transform:scale(1.35);} }
@keyframes ctbreathe { 0%,100%{box-shadow:0 8px 20px -10px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.05), 0 0 0 0 rgba(248,81,74,0);} 50%{box-shadow:0 8px 22px -8px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.05), 0 0 0 4px rgba(248,81,74,.11);} }
@keyframes ctfresh { from{background:${C.accentTint};} to{background:transparent;} }
.ct-node { transition: opacity .25s ease, border-color .15s ease; }
.ct-app { transition: background .12s ease; }
.ct-app:hover { background: ${C.rowHover} !important; }
.ct-link { color: inherit; text-decoration: none; }
.ct-shell { display:flex; min-height:100vh; }
.ct-side { width:272px; flex:none; position:sticky; top:0; height:100vh; overflow-y:auto; }
::-webkit-scrollbar{width:10px;height:10px;} ::-webkit-scrollbar-thumb{background:${C.scrollThumb};border-radius:8px;} ::-webkit-scrollbar-track{background:transparent;}
button:focus-visible, a:focus-visible, [tabindex]:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
@media (max-width: 960px){ .ct-shell{ flex-direction:column; } .ct-side{ position:static; height:auto; width:auto; border-right:none !important; border-bottom:1px solid ${C.hair}; } }
@media (prefers-reduced-motion: reduce){ * { animation:none !important; } }
`;
}
function StyleBlock() { const { C } = useTheme(); return <style>{styleCss(C)}</style>; }

// Shown in place of a lineage board when the graph can't be drawn (a dependency
// cycle). A control tower must NAME the broken topology, never render blank.
function GraphErrorPanel({ title, intro, details, nodeIds, nameOf, maxW }: { title: string; intro: string; details: string[]; nodeIds: string[]; nameOf: (id: string) => string; maxW: number }) {
  const { C, SMAP } = useTheme();
  return (
    <div style={{ maxWidth: maxW, margin: "0 auto", borderRadius: 16, border: `1px solid ${C.hairStrong}`, borderLeft: `3px solid ${SMAP.fail.color}`, background: C.board, boxShadow: C.boardShadow, padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Chip status="fail" size={18} fs={11} />
        <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{title}</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 13, color: C.muted2, lineHeight: 1.5 }}>{intro}</div>
      {details.length ? (
        // Authoritative loop description(s) from ct_issues (computed on the raw
        // edges, before table-collapse), so real cycles are named exactly.
        <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 6 }}>
          {details.map((d, i) => (
            <div key={i} style={{ fontFamily: MONO, fontSize: 11.5, color: C.text2, background: C.inset, border: `1px solid ${C.hair}`, borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>{d}</div>
          ))}
        </div>
      ) : nodeIds.length ? (
        <div style={{ marginTop: 13, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {nodeIds.map((id) => (
            <span key={id} style={{ fontFamily: MONO, fontSize: 11, color: C.text2, border: `1px solid ${C.hair}`, borderRadius: 6, padding: "3px 8px" }}>{nameOf(id)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ControlTower() {
  const [selectedApp, setSelectedApp] = useDiveState("app", "");
  const [view, setView] = useDiveState<"logical" | "physical">("view", "logical");
  const [pane, setPane] = useDiveState<"overview" | "graph" | "hidden" | "about">("pane", "overview");
  const [themePref, setThemePref] = useDiveState<"light" | "dark" | "">("theme", "");
  const [hover, setHover] = useState<string | null>(null);
  // Honest freshness: a dive loads a snapshot and doesn't auto-poll, so stamp
  // when the data last loaded and tick a local clock once a minute — that lets
  // "stale" thresholds actually cross while the tab stays open, instead of the
  // status freezing at load time and looking live when it isn't.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNowMs(Date.now()), 60000); return () => clearInterval(id); }, []);

  const objectsQ = useSQLQuery(`
    SELECT node_id, node_type, name, app, database, label, url,
           schedule_deployed, source_kind, ledger_table, ledger_ts_column,
           ledger_status_column, ledger_ok_values, ledger_detail_columns, ledger_valid,
           strftime(last_run_ts, '%b %d %H:%M') AS last_run_at,
           epoch(now() - last_run_ts) AS last_run_age_s,
           last_run_status, stale_hours
    FROM "${DB}"."main"."ct_objects" ORDER BY node_id
  `);
  const edgesQ = useSQLQuery(`SELECT src_node, dst_node, kind FROM "${DB}"."main"."ct_edges"`);
  const issuesQ = useSQLQuery(`SELECT severity, object_key, kind, detail FROM "${DB}"."main"."ct_issues" ORDER BY severity, object_key`);
  const hiddenQ = useSQLQuery(`SELECT object_key, reason FROM "${DB}"."main"."ct_hidden" ORDER BY object_key`);
  const syncQ = useSQLQuery(`
    SELECT strftime(max(run_ts), '%b %d %H:%M') AS synced_at,
           any_value(status ORDER BY run_ts DESC) AS status,
           any_value(detail ORDER BY run_ts DESC) AS detail
    FROM "${DB}"."main"."ct_sync_ledger"
  `);
  // Precomputed by the collector (it reads each warehouse's catalog locally and
  // merges the result here); the dive no longer introspects raw catalogs.
  const vitalsQ = useSQLQuery(`SELECT name AS table_name, n, kind FROM "${DB}"."main"."ct_vitals"`);

  // Stamp the load time when objects actually arrive (covers manual refetch),
  // and measure client-side seconds elapsed since — folded into staleness below.
  useEffect(() => { if (Array.isArray(objectsQ.data) && objectsQ.data.length) setLoadedAt(Date.now()); }, [objectsQ.data]);
  const elapsedSec = Math.max(0, Math.floor((nowMs - loadedAt) / 1000));

  const nodesRef = useRef<CtNode[]>([]);
  const nodes: CtNode[] = useMemo(() => {
    const raw = Array.isArray(objectsQ.data) ? objectsQ.data : [];
    if (!raw.length) return nodesRef.current;
    nodesRef.current = raw.map((r: any) => ({
      node_id: String(r.node_id), node_type: String(r.node_type), name: String(r.name),
      app: r.app == null ? null : String(r.app), database: String(r.database || ""), label: String(r.label || ""), url: r.url == null ? null : String(r.url),
      schedule_deployed: r.schedule_deployed == null ? null : String(r.schedule_deployed), source_kind: String(r.source_kind),
      ledger_table: r.ledger_table == null ? null : String(r.ledger_table), ledger_ts_column: r.ledger_ts_column == null ? null : String(r.ledger_ts_column),
      ledger_status_column: r.ledger_status_column == null ? null : String(r.ledger_status_column),
      ledger_ok_values: r.ledger_ok_values == null ? null : JSON.parse(String(r.ledger_ok_values)),
      ledger_detail_columns: r.ledger_detail_columns == null ? null : JSON.parse(String(r.ledger_detail_columns)),
      ledger_valid: r.ledger_valid == null ? null : Boolean(r.ledger_valid),
      last_run_at: r.last_run_at == null ? null : String(r.last_run_at), last_run_age_s: r.last_run_age_s == null ? null : N(r.last_run_age_s),
      last_run_status: r.last_run_status == null ? null : String(r.last_run_status), stale_hours: r.stale_hours == null ? null : N(r.stale_hours),
    }));
    return nodesRef.current;
  }, [objectsQ.data]);

  const allEdges = useMemo(() => {
    const raw = Array.isArray(edgesQ.data) ? edgesQ.data : [];
    return raw.map((r: any) => ({ src: String(r.src_node), dst: String(r.dst_node), kind: String(r.kind) }));
  }, [edgesQ.data]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.node_id, n])), [nodes]);
  const apps = useMemo(() => [...new Set(nodes.map((n) => n.app).filter(Boolean))].sort() as string[], [nodes]);
  const activeApp = apps.includes(selectedApp) ? selectedApp : (apps[0] || "");

  // Health, run-log and deliveries are PRECOMPUTED by the collector (it reads the
  // raw ledger tables locally, inside each warehouse's own account) and merged
  // into the canonical DB. The dive reads fixed columns — no dynamic SQL, and it
  // never reaches into producer tables that may live in another account.
  const healthQ = useSQLQuery(`SELECT node_id, last_at, last_ts, is_ok, last_status FROM "${DB}"."main"."ct_health"`);
  const runlogQ = useSQLQuery(`SELECT run_at, node_id, object_name, status FROM "${DB}"."main"."ct_runlog" ORDER BY ts DESC LIMIT 10`);
  const deliveriesQ = useSQLQuery(`SELECT node_id, app, delivered_at, ts, recipient, status, is_ok FROM "${DB}"."main"."ct_deliveries" ORDER BY ts DESC`);

  const health = useMemo(() => {
    const m = new Map<string, { last_at: string; is_ok: boolean; last_status: string }>();
    for (const r of Array.isArray(healthQ.data) ? (healthQ.data as any[]) : []) {
      if (r.node_id == null) continue;
      m.set(String(r.node_id), { last_at: String(r.last_at || ""), is_ok: Boolean(r.is_ok), last_status: String(r.last_status || "") });
    }
    return m;
  }, [healthQ.data]);

  const vitals = useMemo(() => {
    const m = new Map<string, { n: number | null; kind: string }>();
    for (const r of Array.isArray(vitalsQ.data) ? (vitalsQ.data as any[]) : []) m.set(String(r.table_name), { n: r.n == null ? null : N(r.n), kind: String(r.kind || "table") });
    return m;
  }, [vitalsQ.data]);

  // Deliveries: precomputed rows (recipient/status/is_ok), filtered to the active
  // app client-side. hasDeliveryFlight is topology-only (a flight feeding a
  // delivery node), so the "no delivery flight" vs "no deliveries yet" distinction
  // survives the move off dynamic SQL.
  const deliveries = useMemo(() => {
    const raw = Array.isArray(deliveriesQ.data) ? (deliveriesQ.data as any[]) : [];
    return raw.map((r) => ({
      node_id: String(r.node_id), app: r.app == null ? "" : String(r.app),
      delivered_at: String(r.delivered_at || ""),
      recipient: r.recipient == null ? null : String(r.recipient),
      status: r.status == null ? null : String(r.status), is_ok: Boolean(r.is_ok),
    }));
  }, [deliveriesQ.data]);
  const hasDeliveryFlight = useMemo(() => nodes.some((n) =>
    n.app === activeApp && n.node_type === "flight" &&
    allEdges.some((e) => e.src === n.node_id && e.dst.startsWith("delivery:"))),
    [nodes, allEdges, activeApp]);
  const appDeliveries = useMemo(() => deliveries.filter((d) => d.app === activeApp).slice(0, 8), [deliveries, activeApp]);

  // Optional DB-set default theme: read ct_config.key='theme' IF that table
  // exists (gated on the catalog, so nothing errors when it's absent).
  const hasConfig = vitals.has("ct_config");
  const cfgQ = useSQLQuery(`SELECT value FROM "${DB}"."main"."ct_config" WHERE key = 'theme' LIMIT 1`, { enabled: hasConfig });

  // Manual refresh: re-run every query and re-stamp the clock. (Dives don't
  // auto-poll, so this is the supported way to pull a fresh snapshot.)
  const allQueries = [objectsQ, edgesQ, issuesQ, hiddenQ, syncQ, vitalsQ, healthQ, runlogQ, deliveriesQ, cfgQ];
  const refreshAll = () => { allQueries.forEach((q) => { try { q.refetch(); } catch { /* not connected */ } }); setNowMs(Date.now()); };
  // Surface failed queries instead of silently rendering empty/idle. A failed
  // health/runs query is "could not measure", which must not read as "fine".
  const queryErrors = ([
    ["objects", objectsQ], ["edges", edgesQ], ["issues", issuesQ], ["hidden", hiddenQ],
    ["sync", syncQ], ["catalog", vitalsQ], ["health", healthQ], ["runs", runlogQ], ["deliveries", deliveriesQ],
  ] as [string, typeof objectsQ][]).filter(([, q]) => q.isError).map(([k, q]) => ({ k, msg: String(q.error?.message || "query failed") }));

  const statusOf = useMemo(() => {
    const m = new Map<string, Status>();
    for (const n of nodes) {
      if (n.node_type === "flight") {
        // Add client-elapsed seconds so a flight crosses its stale threshold
        // while the tab is open, not only at load.
        const age = n.last_run_age_s != null ? n.last_run_age_s + elapsedSec : null;
        const stale = n.stale_hours != null && age != null && age > n.stale_hours * 3600;
        if (!n.last_run_at) m.set(n.node_id, "idle");
        else if (runFailed(n.last_run_status)) m.set(n.node_id, "fail");
        else if (stale) m.set(n.node_id, "warn");
        else m.set(n.node_id, "ok");
      } else if (n.ledger_table) {
        // Health unmeasurable (flight flagged the ledger invalid) ⇒ fail, never
        // a green/idle that hides a broken contract. The issue strip names why.
        if (n.ledger_valid === false) m.set(n.node_id, "fail");
        else {
          const h = health.get(n.node_id);
          if (!h || !h.last_at) m.set(n.node_id, "idle");
          else if (!h.is_ok) m.set(n.node_id, "fail");
          else m.set(n.node_id, "ok");
        }
      } else if (n.node_type === "dive") {
        m.set(n.node_id, n.source_kind === "code" ? "ok" : "idle");
      } else if (n.node_type === "table") {
        const v = vitals.get(n.name);
        if (!v) m.set(n.node_id, "warn");
        else if (v.kind === "view") m.set(n.node_id, "ok");
        else m.set(n.node_id, (v.n || 0) > 0 ? "ok" : "warn");
      }
    }
    for (const n of nodes) {
      if (m.has(n.node_id)) continue;
      const writers = allEdges.filter((e) => e.dst === n.node_id && m.has(e.src)).map((e) => m.get(e.src)!);
      const readers = allEdges.filter((e) => e.src === n.node_id && m.has(e.dst)).map((e) => m.get(e.dst)!);
      const pool = writers.length ? writers : readers;
      const worst = (["fail", "warn", "idle", "ok"] as Status[]).find((s) => pool.includes(s));
      m.set(n.node_id, pool.length ? (worst as Status) : "idle");
    }
    return m;
  }, [nodes, health, vitals, allEdges, elapsedSec]);

  // Build a graph from a seed set of code objects. blockCrossApp=true keeps a
  // single-app view focused; false merges the whole environment (apps share the
  // warehouse, so they connect through it).
  function buildGraph(seed: CtNode[], blockCrossApp: string | null): GraphT | null {
    if (!seed.length) return null;
    const visible = new Set(seed.map((n) => n.node_id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of allEdges) {
        const blocked = (x?: CtNode) => blockCrossApp != null && x && x.source_kind === "code" && x.app !== blockCrossApp;
        if (visible.has(e.src) && !visible.has(e.dst) && !blocked(byId.get(e.dst))) { visible.add(e.dst); grew = true; }
        if (visible.has(e.dst) && !visible.has(e.src) && !blocked(byId.get(e.src))) { visible.add(e.src); grew = true; }
      }
    }
    const viewEdges = allEdges.filter((e) => e.kind === view && visible.has(e.src) && visible.has(e.dst));
    const tableIds = new Set([...visible].filter((id) => byId.get(id)?.node_type === "table"));
    // Each table collapses into ITS OWN warehouse (by the table's database), so a
    // board can show N warehouses, not one. whOf maps a table node to its warehouse.
    const whOf = (id: string) => `warehouse:${byId.get(id)?.database || WAREHOUSE}`;
    const collapsed = collapseTables(visible, viewEdges, tableIds, whOf);
    const edges = reduceTransitive(collapsed.edges);
    const indeg = new Map<string, number>();
    for (const id of collapsed.nodes) indeg.set(id, 0);
    for (const e of edges) indeg.set(e.dst, (indeg.get(e.dst) || 0) + 1);
    const roots = [...collapsed.nodes].filter((id) => (indeg.get(id) || 0) === 0)
      .sort((a, b) => (TYPE_ORDER[a.split(":")[0]] ?? 9) - (TYPE_ORDER[b.split(":")[0]] ?? 9) || a.localeCompare(b));
    const childrenOf = (id: string) => edges.filter((e) => e.src === id).map((e) => e.dst)
      .sort((a, b) => (TYPE_ORDER[a.split(":")[0]] ?? 9) - (TYPE_ORDER[b.split(":")[0]] ?? 9) || a.localeCompare(b));
    // Member tables grouped per warehouse (for the warehouse cards + status).
    const warehouses = new Map<string, string[]>();
    for (const id of tableIds) {
      const w = whOf(id);
      if (!warehouses.has(w)) warehouses.set(w, []);
      warehouses.get(w)!.push(byId.get(id)!.name);
    }
    for (const arr of warehouses.values()) arr.sort();
    const nodeIds = [...collapsed.nodes];
    // No root while nodes remain ⇒ a pure cycle: nothing to lay out from.
    const cyclic = nodeIds.length > 0 && roots.length === 0;
    return { roots, childrenOf, warehouses, cyclic, nodeIds };
  }

  const graph = useMemo(() => buildGraph(nodes.filter((n) => n.app === activeApp && n.source_kind === "code"), activeApp), [nodes, allEdges, byId, activeApp, view]);
  const fullGraph = useMemo(() => buildGraph(nodes.filter((n) => n.source_kind === "code"), null), [nodes, allEdges, byId, view]);
  const layout = useMemo(() => computeLayout(graph), [graph]);
  const fullLayout = useMemo(() => computeLayout(fullGraph), [fullGraph]);

  const issues = Array.isArray(issuesQ.data) ? (issuesQ.data as any[]) : [];
  const hidden = Array.isArray(hiddenQ.data) ? (hiddenQ.data as any[]) : [];
  const syncRow = Array.isArray(syncQ.data) ? (syncQ.data as any[])[0] : undefined;

  // An issue's owning app, from its object_key's node (null ⇒ environment-level,
  // e.g. out-of-scope — shown only on the Overview, not on every app).
  const issueApp = (i: any): string | null => byId.get(String(i.object_key))?.app ?? null;
  const cycleIssues = issues.filter((i) => String(i.kind) === "cycle");

  const appStatus = (app: string): Status => {
    const sts = nodes.filter((n) => n.app === app && n.source_kind === "code").map((n) => statusOf.get(n.node_id) || "idle");
    const base = (["fail", "warn", "idle", "ok"] as Status[]).find((s) => sts.includes(s)) || "idle";
    // An error-level issue for this app (e.g. a dependency cycle) is a failure,
    // even when every individual object's own status looks fine.
    const hasErr = issues.some((i) => String(i.severity) === "error" && issueApp(i) === app);
    return hasErr ? "fail" : base;
  };

  const whStatusFor = (mt: string[]): Status => mt.every((name) => { const v = vitals.get(name); return (v && v.kind === "view") || (v ? (v.n || 0) > 0 : false); }) ? "ok" : "warn";
  const statusForNode = (id: string, g: GraphT): Status => g.warehouses.has(id) ? whStatusFor(g.warehouses.get(id)!) : (statusOf.get(id) || "idle");
  const nameOf = (id: string) => { const n = byId.get(id); return n ? prettyName(n.name) : id; };

  // OVERALL (whole environment) — counts the boxes on the merged board, by state.
  // Fixed; does not change with the selected app.
  const overall = useMemo(() => {
    let ok = 0, warn = 0, fail = 0, idle = 0;
    if (fullLayout && fullGraph) {
      for (const id of fullLayout.pos.keys()) {
        const s = fullGraph.warehouses.has(id) ? whStatusFor(fullGraph.warehouses.get(id)!) : (statusOf.get(id) || "idle");
        if (s === "fail") fail++; else if (s === "warn") warn++; else if (s === "ok") ok++; else idle++;
      }
    }
    return { ok, warn, fail, idle, total: ok + warn + fail + idle };
  }, [fullLayout, fullGraph, statusOf, vitals]);

  function nodeView(id: string) {
    const n = byId.get(id); const st = statusOf.get(id) || "idle";
    if (!n) return { type: "?", typeLabel: "?", title: id, href: undefined as string | undefined, meta: "", st };
    if (n.node_type === "dive") return { type: "dive", typeLabel: "DIVE", title: prettyName(n.name), href: n.url || undefined, meta: n.source_kind === "code" ? "published" : "not deployed", st };
    if (n.node_type === "flight") {
      const ran = !!n.last_run_at; const rs = (n.last_run_status || "").toLowerCase();
      return { type: "flight", typeLabel: "FLIGHT", title: n.name, href: n.url || undefined, meta: !ran ? "never run" : st === "warn" ? "stale" : `${n.last_run_at} · ${rs}`, st };
    }
    if (n.node_type === "share") return { type: "share", typeLabel: "SHARE", title: n.name, href: undefined, meta: st === "ok" ? "auto-sync" : st === "idle" ? "no writer" : "unhealthy", st };
    if (n.node_type === "source") return { type: "source", typeLabel: "SOURCE", title: prettyName(n.name), href: n.url || undefined, meta: st === "ok" ? "live feed" : "no data", st };
    if (n.node_type === "delivery") return { type: "delivery", typeLabel: "DELIVERY", title: prettyName(n.name), href: n.url || undefined, meta: st === "ok" ? "delivering" : st === "fail" ? "failures" : "no deliveries", st };
    return { type: n.node_type, typeLabel: n.node_type.toUpperCase(), title: n.name, href: undefined, meta: "", st };
  }

  function renderNodeCardG(id: string, g: GraphT, lay: LayoutT, conn: Set<string> | null) {
    const p = lay.pos.get(id); if (!p) return null;
    const op = conn ? (conn.has(id) ? 1 : 0.3) : 1;
    const isWh = g.warehouses.has(id);
    const st: Status = statusForNode(id, g);
    const failAnim = st === "fail" && MOTION ? "ctbreathe 2.4s ease-in-out infinite" : "none";
    const base: any = {
      position: "absolute", left: p.left, top: p.top, width: NODE_W, minHeight: p.h, boxSizing: "border-box",
      padding: "9px 11px", borderRadius: 12, background: C.nodeGrad, border: `1px solid ${C.cardBorder}`,
      boxShadow: C.cardShadow, opacity: op, animation: failAnim, display: "block",
    };
    if (isWh) {
      const whName = byId.get(id)?.name || id.replace(/^warehouse:/, "");
      const tables = (g.warehouses.get(id) || []).map((name) => { const v = vitals.get(name); return { name, rows: v ? v.n : null, kind: v ? v.kind : undefined }; });
      return (
        <a key={id} className="ct-node ct-link" href="https://app.motherduck.com" target="_blank" rel="noopener noreferrer" onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} style={base}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: ".13em", color: C.faint }}>WAREHOUSE</span>
            <Chip status={st} />
          </div>
          <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{whName}</div>
          <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 5 }}>
            {tables.map((t) => {
              const ts: Status = t.kind === "view" ? "ok" : t.rows === null ? "warn" : t.rows > 0 ? "ok" : "warn";
              return (
                <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Chip status={ts} size={13} fs={8} />
                  <span style={{ fontSize: 11.5, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{t.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted2 }}>{t.kind === "view" ? "view" : t.rows === null ? "—" : fmt(t.rows as number)}</span>
                </div>
              );
            })}
          </div>
        </a>
      );
    }
    const v = nodeView(id);
    const Wrap: any = v.href ? "a" : "div";
    const wp = v.href ? { href: v.href, target: "_blank", rel: "noopener noreferrer" } : {};
    return (
      <Wrap key={id} className="ct-node ct-link" {...wp} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} style={base}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: ".13em", color: C.faint }}>{v.typeLabel}</span>
          <Chip status={st} />
        </div>
        <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.title}</div>
        {v.meta ? <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 11, color: C.muted2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.meta}</div> : null}
      </Wrap>
    );
  }

  // The shared lineage board renderer (used by both the per-app and the
  // whole-environment views).
  function renderBoard(g: GraphT, lay: LayoutT) {
    let conn: Set<string> | null = null;
    if (hover) { conn = new Set([hover]); for (const e of lay.edges) { if (e.src === hover) conn.add(e.dst); if (e.dst === hover) conn.add(e.src); } }
    return (
      <div style={{ overflowX: "auto" }}>
        <div style={{ position: "relative", width: lay.boardW, height: lay.boardH, margin: "0 auto", borderRadius: 16, overflow: "hidden", background: C.board, backgroundImage: `radial-gradient(${C.gridDot} 1px, transparent 1px)`, backgroundSize: "24px 24px", border: `1px solid ${C.hair}`, boxShadow: C.boardShadow }}>
          <svg width={lay.boardW} height={lay.boardH} viewBox={`0 0 ${lay.boardW} ${lay.boardH}`} style={{ position: "absolute", inset: 0 }}>
            {Array.from({ length: lay.maxCol }, (_, s) => CX0 + (s + 0.5) * PITCH).map((x, i) => (
              <line key={i} x1={x} y1={26} x2={x} y2={lay.boardH - 26} stroke={C.gridLine} strokeWidth={1} />
            ))}
            {lay.edges.map((e, i) => {
              const a = lay.pos.get(e.src)!, b = lay.pos.get(e.dst)!;
              const d = splinePath([{ x: a.left + a.w, y: e.sy }, ...e.way, { x: b.left, y: e.dy }]);
              const sty = edgeStyle(edgeStat(statusForNode(e.src, g), statusForNode(e.dst, g)), MOTION);
              let op = sty.op, w = sty.w;
              if (hover) { const hot = e.src === hover || e.dst === hover; op = hot ? Math.min(1, sty.op + 0.35) : sty.op * 0.2; if (hot) w = sty.w + 0.9; }
              return <path key={i} d={d} fill="none" stroke={sty.stroke} strokeWidth={w} strokeDasharray={sty.dash} strokeLinecap="round" opacity={op} style={{ animation: sty.anim }} />;
            })}
          </svg>
          {[...lay.pos.keys()].map((id) => renderNodeCardG(id, g, lay, conn))}
          <div style={{ position: "absolute", top: 14, right: 16, background: C.glassBg, border: `1px solid ${C.hair}`, borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
            {([["Flowing", edgeStyle("ok", false)], ["Stale", edgeStyle("warn", false)], ["Failing", edgeStyle("fail", false)], ["Idle", edgeStyle("idle", false)]] as [string, any][]).map(([lab, s]) => (
              <div key={lab} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={s.stroke} strokeWidth="2" strokeDasharray={s.dash} strokeLinecap="round" /></svg>
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{lab}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Active theme: viewer toggle wins; else the DB default; else dark. Swap the
  // active palette before any JSX is built so every component reads it.
  const dbRow = Array.isArray(cfgQ.data) ? (cfgQ.data as any[])[0] : null;
  const dbTheme = dbRow ? String(dbRow.value || "").toLowerCase() : "";
  const theme: "light" | "dark" = themePref ? themePref : (dbTheme === "light" || dbTheme === "dark" ? dbTheme : "dark");
  const C = theme === "light" ? LIGHT : DARK;
  const SMAP = theme === "light" ? LIGHT_SMAP : DARK_SMAP;
  const sm = (s: Status): SM => SMAP[s] || SMAP.idle;

  const code = nodes.filter((n) => n.app === activeApp && n.source_kind === "code");
  const curCounts = `${plural(code.filter((n) => n.node_type === "flight").length, "flight")} · ${plural(nodes.filter((n) => n.app === activeApp && n.node_type === "table").length, "table")} · ${plural(code.filter((n) => n.node_type === "dive").length, "dive")}`;
  const rollup = sm(appStatus(activeApp));
  // Environment status reflects error-level issues (e.g. a cycle), not only the
  // per-node statuses, so the badge can't read "ok" while the graph is broken.
  const envStatus: Status = (overall.fail || issues.some((i) => String(i.severity) === "error")) ? "fail" : overall.warn ? "warn" : "ok";
  const appCycle = cycleIssues.filter((i) => issueApp(i) === activeApp);
  // Issues strip, shared by Overview and per-app. Cycle issues are surfaced by
  // the error panel instead, so callers exclude them from the list passed here.
  const issuesStrip = (list: any[], maxW: number) => list.length ? (
    <div style={{ maxWidth: maxW, margin: "18px auto 0" }}>
      {list.map((i, k) => {
        const st: Status = String(i.severity) === "error" ? "fail" : "warn"; const m = sm(st);
        return (
          <div key={k} style={{ display: "flex", gap: 9, alignItems: "center", background: C.panelGrad, border: `1px solid ${C.hair}`, borderLeft: `2px solid ${m.color}`, borderRadius: 10, padding: "9px 13px", marginBottom: 6, fontFamily: MONO, fontSize: 12 }}>
            <Chip status={st} size={15} fs={9} />
            <span style={{ color: m.text, fontWeight: 600 }}>{String(i.object_key)}</span>
            <span style={{ color: C.muted2 }}>· {String(i.kind)} — {String(i.detail)}</span>
          </div>
        );
      })}
    </div>
  ) : null;
  const segStyle = (on: boolean): any => ({ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: SANS, background: on ? C.accentTint : "transparent", color: on ? C.accent : C.muted });
  // Nav rows are real <button>s (keyboard-operable); these props reset the
  // native button look so the inline styling carries through unchanged.
  const navRow = (active: boolean): any => ({ display: "flex", gap: 9, alignItems: "center", cursor: "pointer", borderRadius: 10, padding: 9, background: active ? C.rowHover : "transparent", marginBottom: 2, border: "none", width: "100%", textAlign: "left", font: "inherit", color: "inherit" });

  // Freshness stamp for the content header (data views only): when the graph was
  // last synced + when this view loaded, with a refresh button.
  const freshStamp = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: MONO, fontSize: 11, color: C.muted }} title="When the collector last rebuilt the graph">
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.accent, animation: MOTION ? "ctsync 2.4s ease-in-out infinite" : "none" }} />
          {syncRow && syncRow.synced_at ? `Synced ${String(syncRow.synced_at)} UTC` : "Not synced"}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.faint }} title="When this view last loaded a snapshot">Checked {clockHM(loadedAt)} · {agoLabel(elapsedSec)}</span>
      </div>
      <button type="button" onClick={refreshAll} title="Refresh data" aria-label="Refresh data"
        style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.hair}`, background: C.btnBg, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8 a5.5 5.5 0 1 1 -1.6 -3.9 M12.5 1.5 V4.5 H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );

  // Recent-runs table (used in both overview and per-app).
  const RunsPanel = (
    <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "15px 17px" }}>
      <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 10 }}>RECENT RUNS</div>
      {(Array.isArray(runlogQ.data) ? (runlogQ.data as any[]) : []).filter((r) => r.run_at != null).map((r, i) => {
        // Resolve by stable node_id, not display name (names aren't unique).
        const okSet = byId.get(String(r.node_id))?.ledger_ok_values || [];
        const ok = okSet.includes(String(r.status));
        return (
          <div key={`${String(r.node_id)}:${String(r.run_at)}:${String(r.status)}`} style={{ display: "grid", gridTemplateColumns: "78px 1fr 26px", alignItems: "center", gap: 8, padding: "8px 6px", borderTop: i ? `1px solid ${C.hair}` : "none", animation: i === 0 && MOTION ? "ctfresh 1.8s ease-out 1" : "none" }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted2 }}>{String(r.run_at)}</span>
            <span style={{ fontSize: 12.5, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(r.object_name)}</span>
            <span style={{ justifySelf: "end" }}><Chip status={ok ? "ok" : "fail"} size={15} fs={9} /></span>
          </div>
        );
      })}
    </div>
  );

  return (
    <ThemeCtx.Provider value={{ C, SMAP }}>
    <div style={{ background: C.canvasGrad, color: C.text, fontFamily: SANS, minHeight: "100vh", fontSize: 14 }}>
      <StyleBlock />
      <div className="ct-shell">
        {/* SIDEBAR */}
        <aside className="ct-side" style={{ background: C.sidebarGrad, borderRight: `1px solid ${C.hair}`, padding: "22px 18px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <ApertureMark />
              <span style={{ fontFamily: SERIF, fontSize: 17, color: C.text }}>Control Tower</span>
            </div>
            <button onClick={() => setThemePref(theme === "light" ? "dark" : "light")} title="Toggle light / dark" aria-label="Toggle theme"
              style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.hair}`, background: C.inset, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <ThemeIcon theme={theme} />
            </button>
          </div>

          {/* Objective overall summary (whole environment, fixed) */}
          <div>
            <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2 }}>SYSTEM STATUS</div>
            <div style={{ marginTop: 8, fontSize: 13, color: C.muted2 }}>
              <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: C.text }}>{overall.total}</span> object{overall.total === 1 ? "" : "s"} · {apps.length} app{apps.length === 1 ? "" : "s"}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {([["ok", overall.ok], ["warn", overall.warn], ["fail", overall.fail], ["idle", overall.idle]] as [Status, number][]).map(([s, n]) => {
              const m = sm(s);
              return (
                <div key={s} style={{ padding: "9px 11px", border: `1px solid ${C.hair}`, borderRadius: 10, background: C.inset }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Chip status={s} size={14} fs={9} />
                    <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".06em", color: C.faint, textTransform: "uppercase" }}>{m.label}</span>
                  </div>
                  <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 18, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{n}</div>
                </div>
              );
            })}
          </div>

          {/* Nav */}
          <div>
            <button type="button" className="ct-app" aria-current={pane === "overview" ? "page" : undefined} onClick={() => { setPane("overview"); setHover(null); }} style={navRow(pane === "overview")}>
              <span style={{ width: 2, borderRadius: 2, background: C.accent, opacity: pane === "overview" ? 1 : 0, flexShrink: 0, alignSelf: "stretch" }} />
              <NetIcon color={pane === "overview" ? C.text : C.muted} />
              <span style={{ fontSize: 13, fontWeight: 600, color: pane === "overview" ? C.text : C.text2 }}>Overview</span>
            </button>

            <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, margin: "12px 0 8px" }}>APPS</div>
            {apps.map((app) => {
              const st = appStatus(app);
              const ac = nodes.filter((n) => n.app === app && n.source_kind === "code");
              const counts = `${plural(ac.filter((n) => n.node_type === "flight").length, "flight")} · ${plural(nodes.filter((n) => n.app === app && n.node_type === "table").length, "table")} · ${plural(ac.filter((n) => n.node_type === "dive").length, "dive")}`;
              const sel = app === activeApp && pane === "graph";
              return (
                <button type="button" key={app} className="ct-app" aria-current={sel ? "page" : undefined} onClick={() => { setSelectedApp(app); setPane("graph"); setHover(null); }} style={{ ...navRow(sel), alignItems: "flex-start" }}>
                  <span style={{ width: 2, borderRadius: 2, background: sm(st).color, opacity: sel ? 1 : 0, flexShrink: 0, alignSelf: "stretch" }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: sel ? C.text : C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{prettyName(app)}</span>
                      <Chip status={st} size={15} fs={9} />
                    </span>
                    <span style={{ display: "block", fontFamily: MONO, fontSize: 10.5, color: C.faint, marginTop: 3 }}>{counts}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {(hidden.length || ABOUT) ? (
            <div style={{ marginTop: "auto" }}>
              {hidden.length ? (
                <button type="button" className="ct-app" aria-current={pane === "hidden" ? "page" : undefined} onClick={() => { setPane("hidden"); setHover(null); }} style={navRow(pane === "hidden")}>
                  <span style={{ width: 2, borderRadius: 2, background: C.accent, opacity: pane === "hidden" ? 1 : 0, flexShrink: 0, alignSelf: "stretch" }} />
                  <EyeOff color={pane === "hidden" ? C.text : C.muted} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: pane === "hidden" ? C.text : C.text2 }}>Hidden objects</span>
                  <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 11, color: C.faint }}>{hidden.length}</span>
                </button>
              ) : null}
              {ABOUT ? (
                <button type="button" className="ct-app" aria-current={pane === "about" ? "page" : undefined} onClick={() => { setPane("about"); setHover(null); }} style={{ ...navRow(pane === "about"), marginTop: hidden.length ? 4 : 0 }}>
                  <span style={{ width: 2, borderRadius: 2, background: C.accent, opacity: pane === "about" ? 1 : 0, flexShrink: 0, alignSelf: "stretch" }} />
                  <ApertureMark size={15} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: pane === "about" ? C.text : C.text2 }}>About</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </aside>

        {/* MAIN */}
        <main style={{ flex: 1, height: "100vh", overflowY: "auto", padding: "24px 28px 32px", minWidth: 0 }}>
          {queryErrors.length ? (
            <div style={{ maxWidth: 1180, margin: "0 auto 18px", display: "flex", alignItems: "flex-start", gap: 10, background: sm("fail").bg, border: `1px solid ${C.hairStrong}`, borderLeft: `3px solid ${sm("fail").color}`, borderRadius: 12, padding: "12px 15px" }}>
              <Chip status="fail" size={16} fs={10} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Some data couldn’t be loaded — the status below may be incomplete</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted2, marginTop: 4, lineHeight: 1.5, overflowWrap: "anywhere" }}>{queryErrors.map((e) => `${e.k}: ${e.msg}`).join("  ·  ")}</div>
              </div>
              <button type="button" onClick={refreshAll} style={{ marginLeft: "auto", flexShrink: 0, padding: "5px 11px", borderRadius: 7, border: `1px solid ${C.hair}`, background: C.btnBg, color: C.muted, cursor: "pointer", fontFamily: SANS, fontSize: 12, fontWeight: 600 }}>Retry</button>
            </div>
          ) : null}
          {pane === "overview" ? (
            <>
              <div style={{ maxWidth: 1180, margin: "0 auto 18px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22, fontWeight: 600, color: C.text }}>Overview</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px 4px 7px", borderRadius: 999, background: sm(envStatus).bg }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: sm(envStatus).text }}>{sm(envStatus).glyph}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: sm(envStatus).text }}>{sm(envStatus).label}</span>
                    </span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted2, marginTop: 5 }}>Full environment · {plural(overall.total, "object")} across {plural(apps.length, "app")}{fullGraph && fullGraph.warehouses.size ? ` · ${plural(fullGraph.warehouses.size, "warehouse")}` : ""}</div>
                </div>
                {freshStamp}
              </div>
              {!fullGraph || !fullLayout ? (
                <div style={{ maxWidth: 1180, margin: "0 auto", borderRadius: 16, border: `1px solid ${C.hair}`, background: C.board, padding: 28 }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted2 }}>{objectsQ.isLoading ? "Loading…" : "Nothing deployed yet."}</span>
                </div>
              ) : fullGraph.cyclic || fullLayout.degraded || cycleIssues.length ? (
                <GraphErrorPanel maxW={1180} title="Environment graph can’t be drawn — dependency cycle"
                  intro="The environment contains a dependency loop, so the merged graph can’t be laid out. Fix the cycle in the cataloged lineage and re-run the collector."
                  details={cycleIssues.map((i) => String(i.detail))}
                  nodeIds={fullGraph.nodeIds} nameOf={nameOf} />
              ) : (
                <NetworkView
                  lay={fullLayout}
                  statusFn={(id) => statusForNode(id, fullGraph)}
                  infoFn={(id) =>
                    fullGraph.warehouses.has(id)
                      ? { type: "warehouse", typeLabel: "WAREHOUSE", title: byId.get(id)?.name || id.replace(/^warehouse:/, ""), meta: plural(fullGraph.warehouses.get(id)!.length, "table") }
                      : (() => { const v = nodeView(id); return { type: v.type, typeLabel: v.typeLabel, title: v.title, meta: v.meta }; })()
                  }
                />
              )}
              {issuesStrip(issues.filter((i) => String(i.kind) !== "cycle"), 1180)}
              <div style={{ maxWidth: 1180, margin: "20px auto 0" }}>{RunsPanel}</div>
            </>
          ) : pane === "hidden" ? (
            <>
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 22, fontWeight: 600, color: C.text }}>Hidden objects</div>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted2, marginTop: 4 }}>Intentionally excluded from the lineage graph.</div>
              </div>
              <div style={{ maxWidth: 1140, margin: "0 auto", background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "6px 17px" }}>
                {hidden.map((h, k) => {
                  const key = String(h.object_key); const parts = key.split(":"); const type = parts.length > 1 ? parts[0] : ""; const name = parts.length > 1 ? parts.slice(1).join(":") : key;
                  return (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 6px", borderTop: k ? `1px solid ${C.hair}` : "none" }}>
                      <EyeOff color={C.muted} size={16} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.text, minWidth: 170 }}>{name}</span>
                      {type ? <span style={{ fontFamily: MONO, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: C.faint, border: `1px solid ${C.hair}`, borderRadius: 5, padding: "2px 6px" }}>{type}</span> : null}
                      <span style={{ fontSize: 12.5, color: C.muted, flex: 1 }}>{h.reason ? String(h.reason) : ""}</span>
                      <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.faint }}>EXCLUDED</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : pane === "about" ? (
            <div style={{ maxWidth: 860, margin: "0 auto" }}>
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <ApertureMark size={22} />
                  <span style={{ fontSize: 22, fontWeight: 600, color: C.text }}>About Control Tower</span>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted2, marginTop: 5 }}>What this is, how it works, and where to get it.</div>
              </div>

              {/* Explainer video (16:9) — renders only when VIDEO_ID is set. Until then the
                  About tab shows no video box; paste the recorded video's ID to slot it back in. */}
              {VIDEO_ID ? (
                <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 14, overflow: "hidden", border: `1px solid ${C.hair}`, background: C.board, boxShadow: C.cardShadow, marginBottom: 18 }}>
                  <iframe
                    src={`https://www.youtube.com/embed/${VIDEO_ID}`}
                    title="Control Tower — how it works"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              ) : null}

              <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "16px 19px", marginBottom: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 9 }}>WHAT IT IS</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.65, color: C.text2 }}>
                  Control Tower is the map and the monitor for your MotherDuck pipelines. It draws the
                  data-flow graph across your warehouses — every dive, flight, table, and share, and how
                  data moves between them — and tracks the health of the jobs keeping it running: what ran,
                  what&apos;s stale, what failed, what isn&apos;t cataloged yet. You keep a small lineage
                  catalog; it draws and watches the rest. It&apos;s read-only — it never touches your data.
                </div>
              </div>

              <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "16px 19px", marginBottom: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 12 }}>HOW IT WORKS</div>
                {([
                  ["Catalog", "You register each dive and flight in a ct_registry table with the build-manifest skill — what it reads, writes, and delivers. No edits to the object's source."],
                  ["Collect", "A scheduled collector flight (one per account) reads the registry plus the live catalog and materializes the graph and ops panels as ct_* tables: run health, row counts, recent runs, deliveries, warnings."],
                  ["Render", "This dive reads those tables and draws it: per-app lineage, a logical/physical toggle, live status on every node, and a warnings strip for cycles, bad ledgers, or anything not yet cataloged."],
                ] as [string, string][]).map(([t, d], i) => (
                  <div key={t} style={{ display: "flex", gap: 13, padding: "10px 0", borderTop: i ? `1px solid ${C.hair}` : "none" }}>
                    <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: C.accentTint, color: C.accent, fontFamily: MONO, fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t}</div>
                      <div style={{ fontSize: 13.5, lineHeight: 1.6, color: C.muted, marginTop: 2 }}>{d}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "16px 19px", marginBottom: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 9 }}>SCOPE — MANY WAREHOUSES, MANY ACCOUNTS</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.65, color: C.text2 }}>
                  Control Tower isn&apos;t limited to one database. A single board charts every warehouse you
                  put in scope, and a main account folds in other accounts&apos; boards over read-only shares —
                  so you can watch your whole MotherDuck footprint, across accounts, in one graph. Anything
                  pointing at a warehouse you haven&apos;t charted isn&apos;t silently dropped or forced onto
                  the map — you get a warning counting how many objects fall outside your charted databases,
                  and which databases those are.
                </div>
              </div>

              <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "16px 19px", marginBottom: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 9 }}>WHAT IT FLAGS</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.65, color: C.text2 }}>
                  Every sync checks for the gaps that quietly break a pipeline — uncataloged or malformed
                  objects, registry rows whose object is gone, dependency cycles, broken ledger contracts,
                  schedule drift, out-of-scope databases, and (across accounts) stale or colliding boards —
                  and lists each on the warnings strip. The full reference is in the collector&apos;s README.
                </div>
              </div>

              <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "16px 19px" }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 9 }}>WHERE TO GET IT</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.65, color: C.text2 }}>
                  Control Tower is free and open source (MIT). To install it on your own MotherDuck
                  account, hand its <span style={{ fontFamily: MONO, fontSize: 13 }}>INSTALL.md</span> to the
                  AI assistant of your choice — it preflights your access, deploys the collector flight,
                  runs the first sync, and publishes the dive.
                </div>
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 13, padding: "9px 14px", borderRadius: 9, border: `1px solid ${C.hairStrong}`, background: C.btnBg, color: C.text, textDecoration: "none", fontSize: 13, fontWeight: 600 }}>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                  View on GitHub
                </a>
              </div>

              <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "16px 19px", marginTop: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 10 }}>MADE BY</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.65, color: C.text2, marginBottom: 13 }}>
                  Control Tower is built by <span style={{ color: C.text, fontWeight: 600 }}>Ryan Dolley</span>. More of my work:
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {([
                    ["Website", "https://ryandolley.com"],
                    ["Substack", "https://superdatablog.substack.com"],
                    ["YouTube", "https://youtube.com/c/superdatabrothers"],
                    ["LinkedIn", "https://linkedin.com/in/ryandolley"],
                  ] as [string, string][]).map(([label, href]) => (
                    <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 9, border: `1px solid ${C.hairStrong}`, background: C.btnBg, color: C.text, textDecoration: "none", fontSize: 13, fontWeight: 600 }}>
                      {label}
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M5 11 L11 5 M6.5 5 H11 V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, maxWidth: 1140, margin: "0 auto 18px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22, fontWeight: 600, color: C.text }}>{prettyName(activeApp) || "—"}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px 4px 7px", borderRadius: 999, background: rollup.bg }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: rollup.text }}>{rollup.glyph}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: rollup.text }}>{rollup.label}</span>
                    </span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted2, marginTop: 5 }}>{curCounts}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {freshStamp}
                  <div style={{ display: "flex", gap: 3, padding: 3, background: C.inset, border: `1px solid ${C.hair}`, borderRadius: 10 }}>
                    <button onClick={() => setView("logical")} style={segStyle(view === "logical")}>Logical</button>
                    <button onClick={() => setView("physical")} style={segStyle(view === "physical")}>Physical</button>
                  </div>
                </div>
              </div>

              {!graph || !layout ? (
                <div style={{ maxWidth: 1140, margin: "0 auto", borderRadius: 16, border: `1px solid ${C.hair}`, background: C.board, padding: 28 }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted2 }}>{objectsQ.isLoading ? "Loading…" : "No objects in this app yet — run the collector flight after deploying."}</span>
                </div>
              ) : graph.cyclic || layout.degraded || appCycle.length ? (
                <GraphErrorPanel maxW={1140} title="Lineage can’t be drawn — dependency cycle"
                  intro="This app’s lineage contains a dependency loop, so the board can’t be laid out. Fix the cycle in the cataloged lineage and re-run the collector."
                  details={appCycle.map((i) => String(i.detail))}
                  nodeIds={graph.nodeIds} nameOf={nameOf} />
              ) : renderBoard(graph, layout)}

              <div style={{ display: "grid", gridTemplateColumns: "1.18fr 1fr", gap: 18, maxWidth: 1140, margin: "20px auto 0" }}>
                {RunsPanel}
                <div style={{ background: C.panelGrad, border: `1px solid ${C.hair}`, borderRadius: 14, padding: "15px 17px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".16em", color: C.faint2, marginBottom: 10 }}>RECENT DELIVERIES</div>
                  {!hasDeliveryFlight ? (
                    <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted2, padding: "8px 6px" }}>No delivery flight in this app.</div>
                  ) : appDeliveries.length === 0 ? (
                    <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted2, padding: "8px 6px" }}>No deliveries yet.</div>
                  ) : appDeliveries.map((r, i) => (
                    <div key={`${r.node_id}:${r.delivered_at}:${i}`} style={{ display: "grid", gridTemplateColumns: "70px 1fr 26px", alignItems: "center", gap: 8, padding: "8px 6px", borderTop: i ? `1px solid ${C.hair}` : "none" }}>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted2 }}>{r.delivered_at}</span>
                      <span style={{ fontSize: 12.5, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.recipient ?? "—"}</span>
                      <span style={{ justifySelf: "end" }}><Chip status={r.status ? (r.is_ok ? "ok" : "fail") : "idle"} size={15} fs={9} /></span>
                    </div>
                  ))}
                </div>
              </div>

              {issuesStrip(issues.filter((i) => issueApp(i) === activeApp && String(i.kind) !== "cycle"), 1140)}
            </>
          )}
        </main>
      </div>
    </div>
    </ThemeCtx.Provider>
  );
}
