import type { Box } from '../easyeda/symbol';
import { rotate, samePoint, snap } from './geometry';
import type { PortKind, Rotation, Vec } from './types';

const STUB = 10;

/** Removes duplicate and collinear interior points. */
export function simplify(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    if (out.length && samePoint(out[out.length - 1], p)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear = (a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1]);
      if (collinear) out[out.length - 1] = p;
      else out.push(p);
    } else out.push(p);
  }
  return out;
}

/**
 * Which way the next bend of a wire being drawn goes: out along the pin it starts from, then
 * turning at each corner (a horizontal segment is followed by a vertical one); with nothing to go
 * by, along the longer distance first. `flip` swaps it.
 */
export function wireVerticalFirst(draft: Vec[], to: Vec, startDir: Vec | null, flip = false): boolean {
  const last = draft[draft.length - 1];
  let vertical: boolean;
  if (draft.length >= 2) vertical = draft[draft.length - 2][1] === last[1];
  else if (startDir) vertical = startDir[0] === 0;
  else vertical = Math.abs(to[1] - last[1]) > Math.abs(to[0] - last[0]);
  return vertical !== flip;
}

/** Orthogonal elbow from a to b; horizontal-first unless `verticalFirst`. */
export function elbow(a: Vec, b: Vec, verticalFirst = false): Vec[] {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b];
  return verticalFirst ? [a, [a[0], b[1]], b] : [a, [b[0], a[1]], b];
}

const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k];

/**
 * Orthogonal route between two pins. `dir` is the pin's unit vector towards its symbol body,
 * so the wire leaves each pin in the opposite direction.
 */
export function routePins(a: { at: Vec; dir: Vec }, b: { at: Vec; dir: Vec }): Vec[] {
  const outA: Vec = [-a.dir[0], -a.dir[1]];
  const outB: Vec = [-b.dir[0], -b.dir[1]];
  const horizontalA = outA[1] === 0;
  const horizontalB = outB[1] === 0;

  // Pins facing each other on a straight line.
  if (horizontalA && horizontalB && a.at[1] === b.at[1] && (b.at[0] - a.at[0]) * outA[0] > 0 && (a.at[0] - b.at[0]) * outB[0] > 0) {
    return [a.at, b.at];
  }
  if (!horizontalA && !horizontalB && a.at[0] === b.at[0] && (b.at[1] - a.at[1]) * outA[1] > 0 && (a.at[1] - b.at[1]) * outB[1] > 0) {
    return [a.at, b.at];
  }

  const sa = add(a.at, outA, STUB);
  const sb = add(b.at, outB, STUB);
  let middle: Vec[];
  if (horizontalA && horizontalB) {
    const facing = (sb[0] - sa[0]) * outA[0] >= 0 && (sa[0] - sb[0]) * outB[0] >= 0;
    const x = facing ? snap((sa[0] + sb[0]) / 2, 10) : outA[0] > 0 ? Math.max(sa[0], sb[0]) : Math.min(sa[0], sb[0]);
    middle = [sa, [x, sa[1]], [x, sb[1]], sb];
  } else if (!horizontalA && !horizontalB) {
    const facing = (sb[1] - sa[1]) * outA[1] >= 0 && (sa[1] - sb[1]) * outB[1] >= 0;
    const y = facing ? snap((sa[1] + sb[1]) / 2, 10) : outA[1] > 0 ? Math.max(sa[1], sb[1]) : Math.min(sa[1], sb[1]);
    middle = [sa, [sa[0], y], [sb[0], y], sb];
  } else {
    middle = elbow(sa, sb, !horizontalA);
  }
  return simplify([a.at, ...middle, b.at]);
}

export interface RouteObstacles {
  /** Component bodies and flag/label boxes the wire must not cross. */
  boxes: Box[];
  /** Connection points the wire must not touch (other pins, wire ends, label anchors). */
  points: Vec[];
  /** Existing wire segments; running along them is penalised, crossing them is cheap. */
  segments: [Vec, Vec][];
}

const STEP = 5;
const DIRS: Vec[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

class MinHeap<T> {
  private items: { k: number; v: T }[] = [];
  get size() {
    return this.items.length;
  }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Grid A* router between two pins that avoids component bodies, other connection points and
 * running along existing wires. Returns null when no route is found inside the search window,
 * which reaches `margin` units beyond the two pins.
 */
export function autoRoute(a: { at: Vec; dir: Vec }, b: { at: Vec; dir: Vec }, obstacles: RouteObstacles, stub = STUB, margin = 80): Vec[] | null {
  const outA: Vec = [-a.dir[0], -a.dir[1]];
  const outB: Vec = [-b.dir[0], -b.dir[1]];
  const sa = add(a.at, outA, stub);
  const sb = add(b.at, outB, stub);
  const x0 = snap(Math.min(sa[0], sb[0]) - margin, STEP);
  const y0 = snap(Math.min(sa[1], sb[1]) - margin, STEP);
  const cols = Math.round((snap(Math.max(sa[0], sb[0]) + margin, STEP) - x0) / STEP) + 1;
  const rows = Math.round((snap(Math.max(sa[1], sb[1]) + margin, STEP) - y0) / STEP) + 1;
  if (cols * rows > 160_000) return null;

  const blocked = new Uint8Array(cols * rows);
  const cell = (x: number, y: number) => Math.round((y - y0) / STEP) * cols + Math.round((x - x0) / STEP);
  for (const box of obstacles.boxes) {
    for (let y = Math.max(y0, snap(box.y1 - 4, STEP)); y <= Math.min(y0 + (rows - 1) * STEP, box.y2 + 4); y += STEP) {
      for (let x = Math.max(x0, snap(box.x1 - 4, STEP)); x <= Math.min(x0 + (cols - 1) * STEP, box.x2 + 4); x += STEP) {
        if (x > box.x1 - 4 && x < box.x2 + 4 && y > box.y1 - 4 && y < box.y2 + 4) blocked[cell(x, y)] = 1;
      }
    }
  }
  for (const p of obstacles.points) {
    if (p[0] % STEP || p[1] % STEP) continue;
    if (p[0] >= x0 && p[1] >= y0 && p[0] <= x0 + (cols - 1) * STEP && p[1] <= y0 + (rows - 1) * STEP) blocked[cell(p[0], p[1])] = 1;
  }
  // Running along an existing wire: mark horizontal/vertical occupancy per cell.
  const alongH = new Uint8Array(cols * rows);
  const alongV = new Uint8Array(cols * rows);
  for (const [p, q] of obstacles.segments) {
    if (p[1] === q[1]) {
      for (let x = Math.min(p[0], q[0]); x <= Math.max(p[0], q[0]); x += STEP)
        if (x >= x0 && x <= x0 + (cols - 1) * STEP && p[1] >= y0 && p[1] <= y0 + (rows - 1) * STEP) alongH[cell(x, p[1])] = 1;
    } else if (p[0] === q[0]) {
      for (let y = Math.min(p[1], q[1]); y <= Math.max(p[1], q[1]); y += STEP)
        if (y >= y0 && y <= y0 + (rows - 1) * STEP && p[0] >= x0 && p[0] <= x0 + (cols - 1) * STEP) alongV[cell(p[0], y)] = 1;
    }
  }
  for (const s of [sa, sb]) {
    if (s[0] < x0 || s[1] < y0 || blocked[cell(s[0], s[1])]) return null;
  }

  const startDir = DIRS.findIndex((d) => d[0] === outA[0] && d[1] === outA[1]);
  const endDir = DIRS.findIndex((d) => d[0] === -outB[0] && d[1] === -outB[1]);
  const BEND = 3;
  const OVERLAP = 25;
  const cost = new Float64Array(cols * rows * 4).fill(Infinity);
  const prev = new Int32Array(cols * rows * 4).fill(-1);
  const heap = new MinHeap<number>();
  const startCell = cell(sa[0], sa[1]);
  const goalCell = cell(sb[0], sb[1]);
  const h = (c: number) => Math.abs((c % cols) - (goalCell % cols)) + Math.abs(Math.floor(c / cols) - Math.floor(goalCell / cols));
  const s0 = startCell * 4 + Math.max(0, startDir);
  cost[s0] = 0;
  heap.push(h(startCell), s0);
  let found = -1;
  while (heap.size) {
    const state = heap.pop()!;
    const c = state >> 2;
    const d = state & 3;
    if (c === goalCell) {
      found = state;
      break;
    }
    const cx = c % cols;
    const cy = Math.floor(c / cols);
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue; // no U-turns
      const nx = cx + DIRS[nd][0];
      const ny = cy + DIRS[nd][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nc = ny * cols + nx;
      if (blocked[nc] && nc !== goalCell) continue;
      let step = 1 + (nd !== d ? BEND : 0);
      if ((nd % 2 === 0 ? alongH : alongV)[nc]) step += OVERLAP;
      if (nc === goalCell && endDir >= 0 && nd !== endDir) step += BEND;
      const ns = nc * 4 + nd;
      const nCost = cost[state] + step;
      if (nCost < cost[ns]) {
        cost[ns] = nCost;
        prev[ns] = state;
        heap.push(nCost + h(nc), ns);
      }
    }
  }
  if (found < 0) return null;
  const path: Vec[] = [];
  for (let s = found; s >= 0; s = prev[s]) {
    const c = s >> 2;
    path.push([x0 + (c % cols) * STEP, y0 + Math.floor(c / cols) * STEP]);
  }
  path.reverse();
  return simplify([a.at, ...path, b.at]);
}

/** Default outward direction of each port graphic before rotation. */
const PORT_OUT: Record<PortKind, Vec> = {
  label: [1, 0],
  power: [0, -1],
  ground: [0, 1],
  noconnect: [1, 0],
  hier: [1, 0],
};

/** Rotation that points a port graphic along `out`. */
export function portRotationFor(kind: PortKind, out: Vec): Rotation {
  for (const r of [0, 90, 180, 270] as Rotation[]) {
    const v = rotate(PORT_OUT[kind], r);
    if (Math.round(v[0]) === Math.round(out[0]) && Math.round(v[1]) === Math.round(out[1])) return r;
  }
  return 0;
}
