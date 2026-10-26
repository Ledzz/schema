/*
 * Push-and-shove: dragging a track segment sideways while its neighbours keep their directions,
 * and pushing other nets' tracks out of the way of moving copper (a segment being dragged or a
 * route being drawn), recursively, so they keep the clearance. Pads, vias and the board edge
 * don't move: a push that would run into them fails, and the caller keeps the last good state.
 */
import type { Vec } from '../schematic/types';
import { shapeDistance, type CopperItem, type CopperShape } from './geometry';
import { boardEdges, shapeEdgeDistance, type BoardEdges } from './outline';
import type { CopperLayer, Pcb, Track } from './types';

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec, b: Vec) => a[0] * b[1] - a[1] * b[0];
const len = (a: Vec) => Math.hypot(a[0], a[1]);
const unit = (a: Vec): Vec => mul(a, 1 / (len(a) || 1));
const round = (p: Vec): Vec => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000];

/** Where the line through `p` along `d` meets the line through `q` along `e` (null if parallel). */
function intersect(p: Vec, d: Vec, q: Vec, e: Vec): Vec | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  return add(p, mul(d, cross(sub(q, p), e) / den));
}

/**
 * Moves segment `i` (points[i] → points[i + 1]) sideways by `offset` mm along its left normal
 * (y down: left of the direction of travel). Neighbouring segments keep their direction, so 45°
 * and 90° corners stay; where the segment meets a track end, a 45° jog keeps that end in place.
 * Returns null when the move would fold a neighbouring segment back on itself.
 */
export function dragSegment(points: Vec[], i: number, offset: number): Vec[] | null {
  if (i < 0 || i >= points.length - 1 || Math.abs(offset) < 1e-9) return i >= 0 && i < points.length - 1 ? points : null;
  const a = points[i];
  const b = points[i + 1];
  const u = unit(sub(b, a));
  const n: Vec = [u[1], -u[0]];
  const shift = mul(n, offset);
  const a2 = add(a, shift);
  const segLen = len(sub(b, a));
  const out = points.slice();
  const jog = Math.abs(offset);

  // Start side.
  let head: Vec[];
  if (i === 0) {
    // A fixed end: leave it and join the moved line at 45°.
    if (jog * 2 >= segLen) return null;
    head = [a, add(a2, mul(u, jog))];
  } else {
    const p = points[i - 1];
    const v = sub(a, p);
    const corner = intersect(p, v, a2, u);
    if (!corner || dot(sub(corner, p), v) <= 1e-6) return null;
    head = [corner];
  }
  // End side.
  let tail: Vec[];
  const b2 = add(b, shift);
  if (i + 1 === points.length - 1) {
    if (jog * 2 >= segLen) return null;
    tail = [add(b2, mul(u, -jog)), b];
  } else {
    const q = points[i + 2];
    const w = sub(b, q);
    const corner = intersect(q, w, b2, u);
    if (!corner || dot(sub(corner, q), w) <= 1e-6) return null;
    tail = [corner];
  }
  // The moved segment must not turn round.
  if (dot(sub(tail[0], head[head.length - 1]), u) <= 1e-6) return null;
  out.splice(i, 2, ...head, ...tail);
  return out.map(round);
}

/** Copper that is moving: a segment being dragged or the route being drawn. */
export interface Mover {
  layer: CopperLayer;
  net: string | null;
  shape: CopperShape;
}

export interface ShoveOptions {
  pcb: Pcb;
  /** Fixed copper: pads and vias (tracks in this list are ignored, they can be pushed). */
  items: CopperItem[];
  /** Net of a fixed item or track, as the board's connectivity sees it. */
  netOf: (it: CopperItem) => string | null;
  trackNet: (t: Track) => string | null;
  /** Tracks that must not be pushed (the one being dragged). */
  skip?: ReadonlySet<string>;
  /** Most pushes before giving up (default 60). */
  limit?: number;
}

export interface ShoveResult {
  ok: boolean;
  /** Pushed tracks, by id, with their new points. */
  moved: Map<string, Vec[]>;
  /** Why it failed, for the status line. */
  reason?: string;
}

const segmentShape = (pts: Vec[], j: number, width: number): CopperShape => ({ kind: 'capsule', a: pts[j], b: pts[j + 1], r: width / 2 });
const EPS = 0.005;

/**
 * Pushes tracks of other nets away from the movers until everything keeps the design clearance.
 * A pushed segment becomes a mover itself, so pushes ripple outwards. Fails when a pushed track
 * would have to cross a pad, a via or the board edge, or when it needs too many pushes.
 */
export function shove(movers: Mover[], opt: ShoveOptions): ShoveResult {
  const { pcb } = opt;
  const clearance = pcb.rules.clearance;
  const edges: BoardEdges = boardEdges(pcb);
  const fixed = opt.items.filter((it) => it.type !== 'track');
  const tracks = new Map(pcb.tracks.filter((t) => !opt.skip?.has(t.id)).map((t) => [t.id, t]));
  const moved = new Map<string, Vec[]>();
  const pointsOf = (t: Track) => moved.get(t.id) ?? t.points;
  const queue: Mover[] = [...movers];
  let pushes = 0;
  const limit = opt.limit ?? 60;

  while (queue.length) {
    const m = queue.shift()!;
    for (const t of tracks.values()) {
      if (t.layer !== m.layer) continue;
      const net = opt.trackNet(t);
      if (net !== null && net === m.net) continue;
      // Push one offending segment at a time and look at the track again.
      for (let guard = 0; guard < 8; guard++) {
        const pts = pointsOf(t);
        let hit = -1;
        let gap = Infinity;
        for (let j = 0; j < pts.length - 1; j++) {
          const d = shapeDistance(m.shape, segmentShape(pts, j, t.width));
          if (d < clearance - 1e-6 && d < gap) {
            gap = d;
            hit = j;
          }
        }
        if (hit < 0) break;
        if (++pushes > limit) return { ok: false, moved, reason: 'too many tracks in the way' };
        // Push the segment to the side of the mover it already lies on.
        const a = pts[hit];
        const b = pts[hit + 1];
        const u = unit(sub(b, a));
        const n: Vec = [u[1], -u[0]];
        const mid: Vec = mul(add(a, b), 0.5);
        const ref = m.shape.kind === 'capsule' ? closestOnSegment(mid, m.shape.a, m.shape.b) : centroid(m.shape.points);
        const side = Math.sign(dot(sub(mid, ref), n)) || 1;
        // Distance along the normal still missing (exact for parallel segments, a little more otherwise).
        const amount = (clearance - gap + EPS) * side;
        const next = dragSegment(pts, hit, amount);
        if (!next) return { ok: false, moved, reason: `a ${net ?? 'track'} track can't bend that far` };
        moved.set(t.id, next);
        // The new segments push in turn.
        for (let j = 0; j < next.length - 1; j++) queue.push({ layer: t.layer, net, shape: segmentShape(next, j, t.width) });
      }
    }
  }

  // Pushed tracks must still clear pads, vias, the edge, each other and the movers.
  for (const [id, pts] of moved) {
    const t = tracks.get(id)!;
    const net = opt.trackNet(t);
    for (let j = 0; j < pts.length - 1; j++) {
      const seg = segmentShape(pts, j, t.width);
      if (shapeEdgeDistance(seg, edges) < 0.2) return { ok: false, moved, reason: 'a pushed track would reach the board edge' };
      for (const it of fixed) {
        if (!it.layers.includes(t.layer)) continue;
        const itNet = opt.netOf(it);
        if (net !== null && itNet === net) continue;
        if (shapeDistance(seg, it.shape) < clearance - 1e-6) return { ok: false, moved, reason: `a pushed ${net ?? ''} track would hit a ${it.type}`.replace('  ', ' ') };
      }
      for (const m of movers) if (m.layer === t.layer && (m.net === null || m.net !== net) && shapeDistance(seg, m.shape) < clearance - 1e-6) return { ok: false, moved, reason: 'no room to push' };
    }
  }
  return { ok: true, moved };
}

/**
 * The first copper of another net (pad, via or track) that the movers come closer to than the
 * clearance, described for the status line, or null when they fit.
 */
export function firstCollision(movers: Mover[], opt: ShoveOptions): string | null {
  const clearance = opt.pcb.rules.clearance;
  for (const m of movers) {
    for (const it of opt.items) {
      if (!it.layers.includes(m.layer) || (it.type === 'track' && opt.skip?.has(it.ref))) continue;
      const net = opt.netOf(it);
      if (m.net !== null && net === m.net) continue;
      if (shapeDistance(m.shape, it.shape) < clearance - 1e-6) return `too close to ${net ?? 'unconnected'} ${it.type === 'pad' ? 'pad' : it.type}`;
    }
  }
  return null;
}

function closestOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return a;
  const k = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return add(a, mul(ab, k));
}

const centroid = (pts: Vec[]): Vec => mul(pts.reduce((s, p) => add(s, p), [0, 0] as Vec), 1 / pts.length);

/** A track's points as movers (one capsule per segment). */
export function trackMovers(layer: CopperLayer, net: string | null, width: number, points: Vec[]): Mover[] {
  const out: Mover[] = [];
  for (let j = 0; j < points.length - 1; j++) out.push({ layer, net, shape: segmentShape(points, j, width) });
  return out;
}

/** The board with pushed tracks applied. */
export const applyShove = (pcb: Pcb, moved: Map<string, Vec[]>): Pcb =>
  moved.size ? { ...pcb, tracks: pcb.tracks.map((t) => (moved.has(t.id) ? { ...t, points: moved.get(t.id)! } : t)) } : pcb;
