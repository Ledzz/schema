/*
 * Push-and-shove: dragging a track segment sideways while its neighbours keep their directions,
 * dragging a corner or a whole track with 45° bends, and pushing other nets' tracks and vias out
 * of the way of moving copper (a segment being dragged or a route being drawn), recursively, so
 * they keep the clearance. Pads, vias in pads and the board edge don't move: a push that would
 * run into them fails, and the caller keeps the last good state.
 */
import type { Vec } from '../schematic/types';
import { pointInPolygon, shapeDistance, type CopperItem, type CopperShape } from './geometry';
import { viaHoleConflict, type DrillHole } from './jlcpcb';
import { boardEdges, keepoutAreas, shapeEdgeDistance, type BoardEdges } from './outline';
import { simplifyPath } from './router';
import { copperLayers, type CopperLayer, type Pcb, type Track, type Via } from './types';

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec, b: Vec) => a[0] * b[1] - a[1] * b[0];
const len = (a: Vec) => Math.hypot(a[0], a[1]);
const unit = (a: Vec): Vec => mul(a, 1 / (len(a) || 1));
const round = (p: Vec): Vec => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000];

/** The 45° path from `from` to `to`: a straight run and then a diagonal, without `from`. */
export function posture(from: Vec, to: Vec): Vec[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-9 || ay < 1e-9 || Math.abs(ax - ay) < 1e-9) return [to];
  const corner: Vec = ax > ay ? [from[0] + Math.sign(dx) * (ax - ay), from[1]] : [from[0], from[1] + Math.sign(dy) * (ay - ax)];
  return [corner, to];
}

/** Moves corner `i` of a track to `to`; the tracks on either side bend at 45° to reach it. */
export function dragCorner(points: Vec[], i: number, to: Vec): Vec[] {
  if (i <= 0 || i >= points.length - 1) return points;
  const back = posture(points[i + 1], to).reverse();
  return simplifyPath([...points.slice(0, i), ...posture(points[i - 1], to), ...back.slice(1), ...points.slice(i + 1)]);
}

/** Moves a whole track by `delta`; an end that is `fixed` (on a pad or via) stays and joins it at 45°. */
export function moveTrack(points: Vec[], delta: Vec, fixed: [boolean, boolean] = [false, false]): Vec[] {
  const n = points.length;
  const moved = points.map((p) => add(p, delta));
  const head = fixed[0] ? [points[0], ...posture(points[0], moved[0]).slice(0, -1)] : [];
  const tail = fixed[1] ? posture(moved[n - 1], points[n - 1]) : [];
  return simplifyPath([...head, ...moved, ...tail]).map(round);
}

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
 * A first or last segment too short to follow (a stub into a pad) is replaced by such a jog.
 * Returns null when the move would fold a neighbouring segment back on itself.
 */
export function dragSegment(points: Vec[], i: number, offset: number): Vec[] | null {
  if (i < 0 || i >= points.length - 1 || Math.abs(offset) < 1e-9) return i >= 0 && i < points.length - 1 ? points : null;
  const last = points.length - 1;
  const a = points[i];
  const b = points[i + 1];
  const u = unit(sub(b, a));
  const n: Vec = [u[1], -u[0]];
  const shift = mul(n, offset);
  const a2 = add(a, shift);
  const b2 = add(b, shift);
  // The point where a 45° jog from `p` meets the moved line, ahead of it (dir 1) or behind (-1).
  const jogFrom = (p: Vec, dir: 1 | -1): Vec => add(a2, mul(u, dot(sub(p, a2), u) + dir * Math.abs(cross(u, sub(p, a2)))));
  // A neighbour nearly parallel to the segment would meet the moved line far away: no good.
  const near = (corner: Vec | null, from: Vec) => corner !== null && len(sub(corner, from)) <= Math.abs(offset) * 3 + 1e-9;
  let from = i;
  let to = i + 1;

  // Start side.
  let head: Vec[];
  if (i === 0) head = [a, jogFrom(a, 1)];
  else {
    const p = points[i - 1];
    const v = sub(a, p);
    const corner = intersect(p, v, a2, u);
    if (corner && near(corner, a) && dot(sub(corner, p), v) > 1e-6) head = [corner];
    else if (i - 1 === 0) {
      head = [p, jogFrom(p, 1)];
      from = 0;
    } else return null;
  }
  // End side.
  let tail: Vec[];
  if (i + 1 === last) tail = [jogFrom(b, -1), b];
  else {
    const q = points[i + 2];
    const w = sub(b, q);
    const corner = intersect(q, w, b2, u);
    if (corner && near(corner, b) && dot(sub(corner, q), w) > 1e-6) tail = [corner];
    else if (i + 2 === last) {
      tail = [jogFrom(q, -1), q];
      to = last;
    } else return null;
  }
  // The moved segment must not turn round.
  if (dot(sub(tail[0], head[head.length - 1]), u) <= 1e-6) return null;
  const out = points.slice();
  out.splice(from, to - from + 1, ...head, ...tail);
  return simplifyPath(out).map(round);
}

/** Copper that is moving: a segment being dragged or the route being drawn. */
export interface Mover {
  layer: CopperLayer;
  net: string | null;
  shape: CopperShape;
}

export interface ShoveOptions {
  pcb: Pcb;
  /** Pads and vias (tracks in this list are ignored: the board's tracks are pushed). */
  items: CopperItem[];
  /** Drilled holes, for the spacing of pushed vias (unchecked when left out). */
  holes?: DrillHole[];
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
  /** Pushed vias, by id, with their new centres. */
  vias: Map<string, Vec>;
  /** Why it failed, for the status line. */
  reason?: string;
}

const segmentShape = (pts: Vec[], j: number, width: number): CopperShape => ({ kind: 'capsule', a: pts[j], b: pts[j + 1], r: width / 2 });
const EPS = 0.005;

const viaShape = (c: Vec, v: Via): CopperShape => ({ kind: 'capsule', a: c, b: c, r: v.diameter / 2 });

/**
 * Pushes tracks and vias of other nets away from the movers until everything keeps the design
 * clearance. A pushed segment or via becomes a mover itself, so pushes ripple outwards; tracks
 * ending on a pushed via follow it. Fails when something would have to cross a pad, a via in a
 * pad or the board edge, when a pushed via would crowd another hole or enter a keepout, or when
 * it needs too many pushes.
 */
export function shove(movers: Mover[], opt: ShoveOptions): ShoveResult {
  const { pcb } = opt;
  const clearance = pcb.rules.clearance;
  const edges: BoardEdges = boardEdges(pcb);
  const stack = copperLayers(pcb);
  const pads = opt.items.filter((it) => it.type === 'pad');
  const tracks = new Map(pcb.tracks.filter((t) => !opt.skip?.has(t.id)).map((t) => [t.id, t]));
  const moved = new Map<string, Vec[]>();
  const viaPos = new Map<string, Vec>();
  const pointsOf = (t: Track) => moved.get(t.id) ?? t.points;
  const posOf = (v: Via): Vec => viaPos.get(v.id) ?? [v.x, v.y];
  const viaNet = new Map(opt.items.filter((it) => it.type === 'via').map((it) => [it.ref, opt.netOf(it)]));
  const netOfVia = (v: Via) => (viaNet.has(v.id) ? viaNet.get(v.id)! : v.net);
  // Vias in a pad of their own net (thermal vias) stay with the pad.
  const anchored = new Set(
    pcb.vias.filter((v) => pads.some((p) => opt.netOf(p) !== null && opt.netOf(p) === netOfVia(v) && shapeDistance(viaShape([v.x, v.y], v), p.shape) < 1e-6)).map((v) => v.id),
  );
  const queue: Mover[] = [...movers];
  let pushes = 0;
  const limit = opt.limit ?? 60;
  const fail = (reason: string): ShoveResult => ({ ok: false, moved, vias: viaPos, reason });
  const pushSegments = (t: Track, pts: Vec[], net: string | null) => {
    for (let j = 0; j < pts.length - 1; j++) queue.push({ layer: t.layer, net, shape: segmentShape(pts, j, t.width) });
  };

  // The moving copper itself can't push pads, vias in pads or the board edge.
  for (const m of movers) {
    if (shapeEdgeDistance(m.shape, edges) < 0.2) return fail('too close to the board edge');
    for (const it of pads) {
      if (!it.layers.includes(m.layer) || (m.net !== null && opt.netOf(it) === m.net)) continue;
      if (shapeDistance(m.shape, it.shape) < clearance - 1e-6) return fail(`too close to ${opt.netOf(it) ?? 'unconnected'} pad`);
    }
    for (const v of pcb.vias) {
      if (!anchored.has(v.id) || (m.net !== null && netOfVia(v) === m.net)) continue;
      if (shapeDistance(m.shape, viaShape([v.x, v.y], v)) < clearance - 1e-6) return fail(`too close to ${netOfVia(v) ?? 'unconnected'} via in a pad`);
    }
  }

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
        if (++pushes > limit) return fail('too many tracks in the way');
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
        if (!next) return fail(`a ${net ?? 'track'} track can't bend that far`);
        moved.set(t.id, next);
        // The new segments push in turn.
        pushSegments(t, next, net);
      }
    }
    // Vias of other nets in the way move straight away from the mover.
    if (!stack.includes(m.layer)) continue;
    for (const v of pcb.vias) {
      const vnet = netOfVia(v);
      if (anchored.has(v.id) || (m.net !== null && vnet === m.net)) continue;
      const c = posOf(v);
      const d = shapeDistance(m.shape, viaShape(c, v));
      if (d >= clearance - 1e-6) continue;
      if (++pushes > limit) return fail('too many tracks in the way');
      const from = m.shape.kind === 'capsule' ? closestOnSegment(c, m.shape.a, m.shape.b) : centroid(m.shape.points);
      let away = sub(c, from);
      if (len(away) < 1e-9) away = m.shape.kind === 'capsule' ? [m.shape.b[1] - m.shape.a[1], m.shape.a[0] - m.shape.b[0]] : [0, -1];
      const next = round(add(c, mul(unit(away), clearance - d + EPS)));
      viaPos.set(v.id, next);
      // Tracks of the via's net that end on it follow, with a 45° bend where needed.
      const shift = sub(next, c);
      const onVia = (p: Vec) => len(sub(p, c)) <= v.diameter / 2 + 1e-6;
      for (const t of tracks.values()) {
        if (opt.trackNet(t) !== vnet) continue;
        const pts = pointsOf(t);
        const last = pts.length - 1;
        let np: Vec[] | null = null;
        if (onVia(pts[0])) {
          const end = add(pts[0], shift);
          np = [end, ...posture(end, pts[1]), ...pts.slice(2)];
        } else if (onVia(pts[last])) np = [...pts.slice(0, last), ...posture(pts[last - 1], add(pts[last], shift))];
        if (!np) continue;
        np = simplifyPath(np).map(round);
        moved.set(t.id, np);
        pushSegments(t, np, vnet);
      }
      for (const layer of stack) queue.push({ layer, net: vnet, shape: viaShape(next, v) });
    }
  }

  // Pushed tracks must still clear pads, vias, the edge, each other and the movers.
  const fixedVias = pcb.vias.map((v) => ({ v, net: netOfVia(v), shape: viaShape(posOf(v), v) }));
  for (const [id, pts] of moved) {
    const t = tracks.get(id)!;
    const net = opt.trackNet(t);
    for (let j = 0; j < pts.length - 1; j++) {
      const seg = segmentShape(pts, j, t.width);
      if (shapeEdgeDistance(seg, edges) < 0.2) return fail('a pushed track would reach the board edge');
      for (const it of pads) {
        if (!it.layers.includes(t.layer)) continue;
        const itNet = opt.netOf(it);
        if (net !== null && itNet === net) continue;
        if (shapeDistance(seg, it.shape) < clearance - 1e-6) return fail(`a pushed ${net ?? ''} track would hit a pad`.replace('  ', ' '));
      }
      for (const fv of fixedVias) if ((net === null || fv.net !== net) && shapeDistance(seg, fv.shape) < clearance - 1e-6) return fail('a pushed track would hit a via');
      for (const m of movers) if (m.layer === t.layer && (m.net === null || m.net !== net) && shapeDistance(seg, m.shape) < clearance - 1e-6) return fail('no room to push');
    }
  }
  // Pushed vias must clear pads, other vias, the edge, other holes and keepouts.
  const keepouts = keepoutAreas(pcb).filter((k) => k.vias);
  const holes = opt.holes?.map((h) => {
    const v = h.kind === 'via' && h.ref ? viaPos.get(h.ref) : undefined;
    return v ? { ...h, center: v } : h;
  });
  for (const [id, c] of viaPos) {
    const v = pcb.vias.find((x) => x.id === id)!;
    const net = netOfVia(v);
    const shape = viaShape(c, v);
    if (shapeEdgeDistance(shape, edges) < 0.2) return fail('a pushed via would reach the board edge');
    for (const it of pads) if (opt.netOf(it) !== net && shapeDistance(shape, it.shape) < clearance - 1e-6) return fail('a pushed via would hit a pad');
    for (const fv of fixedVias) if (fv.v.id !== id && fv.net !== net && shapeDistance(shape, fv.shape) < clearance - 1e-6) return fail('a pushed via would hit another via');
    for (const m of movers) if ((m.net === null || m.net !== net) && shapeDistance(shape, m.shape) < clearance - 1e-6) return fail('no room to push a via');
    if (holes) {
      const problem = viaHoleConflict(c, v.drill, holes.filter((h) => h.ref !== id));
      if (problem) return fail(`a pushed via would crowd a hole: ${problem}`);
    }
    if (keepouts.some((k) => pointInPolygon(c, k.outline))) return fail('a pushed via would enter a keepout');
  }
  return { ok: true, moved, vias: viaPos };
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

/** The board with pushed tracks and vias applied. */
export function applyShove(pcb: Pcb, moved: Map<string, Vec[]>, vias: Map<string, Vec> = new Map()): Pcb {
  if (!moved.size && !vias.size) return pcb;
  return {
    ...pcb,
    tracks: moved.size ? pcb.tracks.map((t) => (moved.has(t.id) ? { ...t, points: moved.get(t.id)! } : t)) : pcb.tracks,
    vias: vias.size ? pcb.vias.map((v) => (vias.has(v.id) ? { ...v, x: vias.get(v.id)![0], y: vias.get(v.id)![1] } : v)) : pcb.vias,
  };
}
