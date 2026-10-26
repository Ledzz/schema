/*
 * Two-layer grid router (A*) for a single connection. Moves in 8 directions on a 0.25 mm grid,
 * keeps `clearance + width / 2` from copper of other nets and may change layer through a via.
 */
import type { Vec } from '../schematic/types';
import { pointInPolygon, pointShapeDistance, type CopperItem } from './geometry';
import { boardEdges, edgeDistance, insideBoard } from './outline';
import { holeGap, type DrillHole } from './jlcpcb';
import type { Board, CopperLayer, DesignRules, Keepout, Pcb } from './types';

export interface RouteEnd {
  point: Vec;
  layers: CopperLayer[];
}

export interface RouteResult {
  tracks: { layer: CopperLayer; points: Vec[] }[];
  vias: Vec[];
}

const STEP = 0.25;
const LAYERS: CopperLayer[] = ['top', 'bottom'];
const DIRS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface RouteOptions {
  net: string;
  width: number;
  rules: DesignRules;
  board: Board;
  /** All copper on the board; items whose net equals `net` are not obstacles. */
  items: CopperItem[];
  netOf: (it: CopperItem) => string | null;
  /** Extra search margin around the connection, mm. */
  margin?: number;
  /**
   * Areas to stay out of unless there is no other way, e.g. under a connector's metal shell:
   * every step inside costs extra and no via may be placed there.
   */
  avoid?: { layer: CopperLayer; outlines: Vec[][] }[];
  /** Distance to the board's edges (see edgeField); without it the board is its bounding box. */
  edges?: EdgeField;
  /** Areas tracks or vias must not enter. */
  keepouts?: Pick<Keepout, 'outline' | 'layers' | 'tracks' | 'vias'>[];
  /**
   * Drilled holes already on the board. New vias keep JLCPCB's hole spacing from all of them, of
   * any net; a layer change exactly on a via of this net reuses it instead of adding one.
   */
  holes?: DrillHole[];
}

export interface EdgeField {
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** Distance from each grid point to the nearest board edge; negative outside the board. */
  dist: Float32Array;
}

const fieldCache = new Map<string, EdgeField>();

/**
 * Distance-to-edge for every grid point of the board (outline, cutouts, mounting holes), on the
 * same absolute grid the router uses. Computed once per board shape.
 */
export function edgeField(pcb: Pick<Pcb, 'board' | 'holes'>): EdgeField {
  const key = JSON.stringify([pcb.board, (pcb.holes ?? []).map((h) => [h.x, h.y, h.diameter])]);
  const hit = fieldCache.get(key);
  if (hit) return hit;
  const edges = boardEdges(pcb);
  const b = pcb.board;
  const x0 = Math.floor(b.x / STEP) * STEP;
  const y0 = Math.floor(b.y / STEP) * STEP;
  const cols = Math.ceil((b.x + b.width - x0) / STEP) + 1;
  const rows = Math.ceil((b.y + b.height - y0) / STEP) + 1;
  const dist = new Float32Array(cols * rows);
  for (let iy = 0; iy < rows; iy++)
    for (let ix = 0; ix < cols; ix++) {
      const p: Vec = [x0 + ix * STEP, y0 + iy * STEP];
      const d = edgeDistance(p, edges);
      dist[iy * cols + ix] = insideBoard(p, edges) ? d : -d;
    }
  const field = { x0, y0, cols, rows, dist };
  if (fieldCache.size > 8) fieldCache.clear();
  fieldCache.set(key, field);
  return field;
}

function fieldAt(f: EdgeField, x: number, y: number): number {
  const ix = Math.round((x - f.x0) / STEP);
  const iy = Math.round((y - f.y0) / STEP);
  return ix < 0 || iy < 0 || ix >= f.cols || iy >= f.rows ? -1 : f.dist[iy * f.cols + ix];
}

export function routeConnection(from: RouteEnd, to: RouteEnd, opt: RouteOptions): RouteResult | null {
  const { board, rules, width } = opt;
  const margin = opt.margin ?? 8;
  // Grid lines sit on absolute multiples of STEP, so fine-pitch pins of parts placed on round
  // coordinates fall exactly on them and tracks run straight into the pins.
  const onGrid = (v: number, round: (v: number) => number) => round(v / STEP - 1e-9) * STEP;
  const x0 = Math.max(onGrid(board.x, Math.ceil), onGrid(Math.min(from.point[0], to.point[0]) - margin, Math.floor));
  const y0 = Math.max(onGrid(board.y, Math.ceil), onGrid(Math.min(from.point[1], to.point[1]) - margin, Math.floor));
  const x1 = Math.min(board.x + board.width, Math.max(from.point[0], to.point[0]) + margin);
  const y1 = Math.min(board.y + board.height, Math.max(from.point[1], to.point[1]) + margin);
  const cols = Math.floor((x1 - x0) / STEP) + 1;
  const rows = Math.floor((y1 - y0) / STEP) + 1;
  // 16 search states per cell; keep memory around 20 MB.
  if (cols < 2 || rows < 2 || cols * rows > 150_000) return null;
  const cells = cols * rows;
  const cx = (i: number) => x0 + (i % cols) * STEP;
  const cy = (i: number) => y0 + Math.floor(i / cols) * STEP;

  // blocked[layer][cell]; viaBlocked[cell] (a via needs room on both layers).
  const blocked = [new Uint8Array(cells), new Uint8Array(cells)];
  const viaBlocked = new Uint8Array(cells);
  const trackInflate = rules.clearance + width / 2;
  const viaInflate = rules.clearance + rules.viaDiameter / 2;
  const edge = width / 2 + 0.25;
  for (let i = 0; i < cells; i++) {
    const x = cx(i);
    const y = cy(i);
    const de = opt.edges ? fieldAt(opt.edges, x, y) : Math.min(x - board.x, y - board.y, board.x + board.width - x, board.y + board.height - y);
    if (de < edge) blocked[0][i] = blocked[1][i] = 1;
    if (de < rules.viaDiameter / 2 + 0.25) viaBlocked[i] = 1;
  }
  for (const k of opt.keepouts ?? []) {
    if (k.outline.length < 3 || (!k.tracks && !k.vias)) continue;
    const area = { kind: 'poly' as const, points: k.outline };
    const reach = Math.max(width / 2, rules.viaDiameter / 2) + 0.05;
    const xs = k.outline.map((p) => p[0]);
    const ys = k.outline.map((p) => p[1]);
    const ix0 = Math.max(0, Math.floor((Math.min(...xs) - reach - x0) / STEP));
    const ix1 = Math.min(cols - 1, Math.ceil((Math.max(...xs) + reach - x0) / STEP));
    const iy0 = Math.max(0, Math.floor((Math.min(...ys) - reach - y0) / STEP));
    const iy1 = Math.min(rows - 1, Math.ceil((Math.max(...ys) + reach - y0) / STEP));
    for (let iy = iy0; iy <= iy1; iy++)
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iy * cols + ix;
        const d = pointShapeDistance([x0 + ix * STEP, y0 + iy * STEP], area);
        if (k.tracks && d < width / 2 + 0.05) for (const l of k.layers) blocked[l === 'top' ? 0 : 1][i] = 1;
        if (k.vias && d < rules.viaDiameter / 2 + 0.05) viaBlocked[i] = 1;
      }
  }
  // No vias in SMD pads of any net: solder would wick into the hole during assembly.
  const viaPadKeepout = rules.viaDiameter / 2 + 0.05;
  for (const it of opt.items) {
    if (it.type !== 'pad' || it.layers.length !== 1) continue;
    const ix0 = Math.max(0, Math.floor((it.box.x1 - viaPadKeepout - x0) / STEP));
    const ix1 = Math.min(cols - 1, Math.ceil((it.box.x2 + viaPadKeepout - x0) / STEP));
    const iy0 = Math.max(0, Math.floor((it.box.y1 - viaPadKeepout - y0) / STEP));
    const iy1 = Math.min(rows - 1, Math.ceil((it.box.y2 + viaPadKeepout - y0) / STEP));
    for (let iy = iy0; iy <= iy1; iy++)
      for (let ix = ix0; ix <= ix1; ix++) if (pointShapeDistance([x0 + ix * STEP, y0 + iy * STEP], it.shape) < viaPadKeepout) viaBlocked[iy * cols + ix] = 1;
  }
  for (const it of opt.items) {
    if (opt.netOf(it) === opt.net && opt.net) continue;
    const inflate = Math.max(trackInflate, viaInflate);
    const ix0 = Math.max(0, Math.floor((it.box.x1 - inflate - x0) / STEP));
    const ix1 = Math.min(cols - 1, Math.ceil((it.box.x2 + inflate - x0) / STEP));
    const iy0 = Math.max(0, Math.floor((it.box.y1 - inflate - y0) / STEP));
    const iy1 = Math.min(rows - 1, Math.ceil((it.box.y2 + inflate - y0) / STEP));
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iy * cols + ix;
        const d = pointShapeDistance([x0 + ix * STEP, y0 + iy * STEP], it.shape);
        if (d < trackInflate) for (const l of it.layers) blocked[l === 'top' ? 0 : 1][i] = 1;
        if (d < viaInflate) viaBlocked[i] = 1;
      }
    }
  }

  const avoided = [new Uint8Array(cells), new Uint8Array(cells)];
  for (const area of opt.avoid ?? []) {
    const l = area.layer === 'top' ? 0 : 1;
    for (const outline of area.outlines) {
      const xs = outline.map((p) => p[0]);
      const ys = outline.map((p) => p[1]);
      const ix0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / STEP));
      const ix1 = Math.min(cols - 1, Math.ceil((Math.max(...xs) - x0) / STEP));
      const iy0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / STEP));
      const iy1 = Math.min(rows - 1, Math.ceil((Math.max(...ys) - y0) / STEP));
      for (let iy = iy0; iy <= iy1; iy++)
        for (let ix = ix0; ix <= ix1; ix++) {
          if (!pointInPolygon([x0 + ix * STEP, y0 + iy * STEP], outline)) continue;
          avoided[l][iy * cols + ix] = 1;
          viaBlocked[iy * cols + ix] = 1;
        }
    }
  }

  // Hole spacing: no new via hole too close to an existing one (same-net copper is no obstacle,
  // so without this two connections can drop vias side by side). On-grid vias of this net can be
  // used as they are.
  const reuse = new Set<number>();
  for (const h of opt.holes ?? []) {
    const reach = (h.d + h.len) / 2 + rules.viaDrill / 2 + holeGap({ kind: 'via' }, h);
    const ix0 = Math.max(0, Math.floor((h.center[0] - reach - x0) / STEP));
    const ix1 = Math.min(cols - 1, Math.ceil((h.center[0] + reach - x0) / STEP));
    const iy0 = Math.max(0, Math.floor((h.center[1] - reach - y0) / STEP));
    const iy1 = Math.min(rows - 1, Math.ceil((h.center[1] + reach - y0) / STEP));
    for (let iy = iy0; iy <= iy1; iy++)
      for (let ix = ix0; ix <= ix1; ix++) if (Math.hypot(x0 + ix * STEP - h.center[0], y0 + iy * STEP - h.center[1]) < reach - 1e-9) viaBlocked[iy * cols + ix] = 1;
    if (h.kind === 'via' && h.net === opt.net) {
      const ix = Math.round((h.center[0] - x0) / STEP);
      const iy = Math.round((h.center[1] - y0) / STEP);
      const onGrid = Math.abs(x0 + ix * STEP - h.center[0]) < 1e-3 && Math.abs(y0 + iy * STEP - h.center[1]) < 1e-3;
      if (onGrid && ix >= 0 && iy >= 0 && ix < cols && iy < rows) reuse.add(iy * cols + ix);
    }
  }
  for (const c of reuse) viaBlocked[c] = 0;

  const cellOf = (p: Vec) => {
    const ix = Math.min(cols - 1, Math.max(0, Math.round((p[0] - x0) / STEP)));
    const iy = Math.min(rows - 1, Math.max(0, Math.round((p[1] - y0) / STEP)));
    return iy * cols + ix;
  };
  const start = cellOf(from.point);
  const goal = cellOf(to.point);
  const goalLayers = new Set<number>(to.layers.map((l) => (l === 'top' ? 0 : 1)));
  // Endpoints sit on their own pads, so they are always allowed.
  for (const l of [0, 1]) {
    blocked[l][start] = 0;
    blocked[l][goal] = 0;
  }

  const SQRT2 = Math.SQRT2;
  const BEND = 0.4;
  const VIA = 12;
  /** Extra cost per step inside an avoided area (a step costs 1). */
  const AVOID = 4;
  const N = cells * 2 * 8;
  const cost = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = new Heap();
  const gx = goal % cols;
  const gy = Math.floor(goal / cols);
  const h = (c: number) => {
    const dx = Math.abs((c % cols) - gx);
    const dy = Math.abs(Math.floor(c / cols) - gy);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };
  const state = (c: number, l: number, d: number) => (c * 2 + l) * 8 + d;
  for (const layer of from.layers) {
    const l = layer === 'top' ? 0 : 1;
    for (let d = 0; d < 8; d++) {
      const s = state(start, l, d);
      cost[s] = 0;
      heap.push(h(start), s);
    }
  }
  let found = -1;
  let expanded = 0;
  while (heap.size) {
    const s = heap.pop();
    const d = s % 8;
    const l = Math.floor(s / 8) % 2;
    const c = Math.floor(s / 16);
    if (c === goal && goalLayers.has(l)) {
      found = s;
      break;
    }
    if (++expanded > 600_000) break;
    const base = cost[s];
    const ix = c % cols;
    const iy = Math.floor(c / cols);
    for (let nd = 0; nd < 8; nd++) {
      if ((nd + 4) % 8 === d) continue;
      const nx = ix + DIRS[nd][0];
      const ny = iy + DIRS[nd][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nc = ny * cols + nx;
      if (blocked[l][nc]) continue;
      const diagonal = nd % 2 === 1;
      if (diagonal && (blocked[l][iy * cols + nx] || blocked[l][ny * cols + ix])) continue;
      const step = (diagonal ? SQRT2 : 1) + (nd !== d ? BEND * (Math.min(Math.abs(nd - d), 8 - Math.abs(nd - d)) / 1) : 0) + (avoided[l][nc] ? AVOID : 0);
      const ns = state(nc, l, nd);
      if (base + step < cost[ns]) {
        cost[ns] = base + step;
        prev[ns] = s;
        heap.push(cost[ns] + h(nc), ns);
      }
    }
    // Change layer through a via.
    if (!viaBlocked[c] && c !== start) {
      const nl = 1 - l;
      if (!blocked[nl][c]) {
        const ns = state(c, nl, d);
        const step = reuse.has(c) ? 1 : VIA;
        if (base + step < cost[ns]) {
          cost[ns] = base + step;
          prev[ns] = s;
          heap.push(cost[ns] + h(c), ns);
        }
      }
    }
  }
  if (found < 0) return null;

  // Walk back and split into per-layer polylines and vias.
  const path: { p: Vec; l: number; c: number }[] = [];
  for (let s = found; s >= 0; s = prev[s]) {
    const c = Math.floor(s / 16);
    path.push({ p: [Math.round(cx(c) * 1000) / 1000, Math.round(cy(c) * 1000) / 1000], l: Math.floor(s / 8) % 2, c });
  }
  path.reverse();
  const tracks: RouteResult['tracks'] = [];
  const vias: Vec[] = [];
  let current: { layer: CopperLayer; points: Vec[] } = { layer: LAYERS[path[0].l], points: [from.point] };
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (LAYERS[node.l] !== current.layer) {
      current.points.push(node.p);
      tracks.push(current);
      // An existing via of this net is used as it is.
      if (!reuse.has(node.c)) vias.push(node.p);
      current = { layer: LAYERS[node.l], points: [node.p] };
      continue;
    }
    current.points.push(node.p);
  }
  current.points.push(to.point);
  tracks.push(current);
  return { tracks: tracks.map((t) => ({ ...t, points: simplifyPath(t.points) })).filter((t) => t.points.length >= 2), vias };
}

/** Drops duplicate and collinear points. */
export function simplifyPath(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      const dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]);
      if (Math.abs(cross) < 1e-9 && dot > 0) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}
