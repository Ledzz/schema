/*
 * Copper pour filling with Clipper (integer coordinates, 0.1 µm per unit).
 *
 * fill = (zone outline ∩ board inset by the edge clearance − cutouts, holes, keepouts)
 *        − other-net copper, drill holes and other-net zone fills grown by the pour clearance
 *        − same-net pads grown by the thermal gap        (thermal connection)
 *        ∪ thermal spokes (kept clear of other-net copper)
 * then copper narrower than minWidth is removed (shrink + grow) and islands that touch no
 * same-net copper are dropped. Fills are derived data, recomputed from the board.
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec } from '../schematic/types';
import { pointInPolygon, rotateDeg, type CopperItem, type CopperShape, type WorldPad } from './geometry';
import { circlePolygon, type BoardEdges } from './outline';
import type { CopperLayer, Keepout, Pcb, Pour } from './types';

// CommonJS module: Node exposes it as `default`, bundlers as the namespace itself.
const ClipperLib: typeof ClipperNS = (ClipperNS as unknown as { default?: typeof ClipperNS }).default ?? ClipperNS;
type Path = ClipperNS.Path;
type Paths = ClipperNS.Paths;

const S = 1e4;
const ARC_TOLERANCE = 0.005 * S;
/** Copper to board edge. */
export const POUR_EDGE_CLEARANCE = 0.3;

export interface FillArea {
  outer: Vec[];
  holes: Vec[][];
}

export interface ThermalReport {
  designator: string;
  number: string;
  center: Vec;
  /** Spokes that actually reach the pour (0–4). */
  spokes: number;
}

export interface PourFill {
  pour: Pour;
  areas: FillArea[];
  thermals: ThermalReport[];
}

const toPath = (pts: Vec[]): Path => {
  const p: Path = pts.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }));
  // Drop a repeated closing point and normalise orientation, so NonZero unions never cancel.
  if (p.length > 1 && p[0].X === p[p.length - 1].X && p[0].Y === p[p.length - 1].Y) p.pop();
  if (!ClipperLib.Clipper.Orientation(p)) p.reverse();
  return p;
};
const fromPath = (p: Path): Vec[] => p.map((q) => [q.X / S, q.Y / S] as Vec);

function boolean(type: ClipperNS.ClipType, subject: Paths, clip: Paths): Paths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}
const union = (a: Paths, b: Paths = []) => boolean(ClipperLib.ClipType.ctUnion, a, b);
const difference = (a: Paths, b: Paths) => (b.length ? boolean(ClipperLib.ClipType.ctDifference, a, b) : a);
const intersect = (a: Paths, b: Paths) => boolean(ClipperLib.ClipType.ctIntersection, a, b);

function offset(input: Paths, delta: number, end: ClipperNS.EndType): Paths {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  co.AddPaths(input, ClipperLib.JoinType.jtRound, end);
  const out: Paths = [];
  co.Execute(out, delta * S);
  return out;
}

/** Copper shape grown by `grow` mm, as closed polygons. */
function grownShape(shape: CopperShape, grow: number): Paths {
  if (shape.kind === 'capsule') {
    const b: Vec = shape.a[0] === shape.b[0] && shape.a[1] === shape.b[1] ? [shape.a[0] + 1e-4, shape.a[1]] : shape.b;
    const open: Path = [
      { X: Math.round(shape.a[0] * S), Y: Math.round(shape.a[1] * S) },
      { X: Math.round(b[0] * S), Y: Math.round(b[1] * S) },
    ];
    return offset([open], shape.r + grow, ClipperLib.EndType.etOpenRound);
  }
  const poly = [toPath(shape.points)];
  return grow > 0 ? offset(poly, grow, ClipperLib.EndType.etClosedPolygon) : poly;
}

function rectPath(center: Vec, dir: Vec, length: number, width: number): Path {
  const n: Vec = [-dir[1] * (width / 2), dir[0] * (width / 2)];
  const end: Vec = [center[0] + dir[0] * length, center[1] + dir[1] * length];
  return toPath([
    [center[0] + n[0], center[1] + n[1]],
    [end[0] + n[0], end[1] + n[1]],
    [end[0] - n[0], end[1] - n[1]],
    [center[0] - n[0], center[1] - n[1]],
  ]);
}

function collectAreas(node: ClipperNS.PolyNode, out: FillArea[]) {
  for (const child of node.Childs()) {
    if (child.IsHole()) continue;
    const holes = child.Childs().filter((h) => h.IsHole());
    out.push({ outer: fromPath(child.Contour()), holes: holes.map((h) => fromPath(h.Contour())) });
    // Islands inside holes are nested one level deeper.
    for (const hole of holes) collectAreas(hole, out);
  }
}

export function pointInArea(p: Vec, a: FillArea): boolean {
  return pointInPolygon(p, a.outer) && !a.holes.some((h) => pointInPolygon(p, h));
}

export interface PourInput {
  pcb: Pcb;
  /** Board outline, cutouts and mounting holes. */
  edges: BoardEdges;
  /** Keepout areas (those with `pours` set keep the fill out). */
  keepouts: Keepout[];
  items: CopperItem[];
  pads: WorldPad[];
  /** Fills of higher-priority pours (zones) of other nets on this layer, kept clear like copper. */
  blocked?: FillArea[];
}

export function fillPour(pour: Pour, input: PourInput): PourFill {
  const { pcb, items, pads, edges } = input;
  const clearance = Math.max(pour.clearance, pcb.rules.clearance);
  const layer: CopperLayer = pour.layer;

  let area = offset([toPath(edges.outline)], -POUR_EDGE_CLEARANCE, ClipperLib.EndType.etClosedPolygon);
  // Milled and drilled openings keep the same clearance as the outer edge.
  const openings = [...edges.cutouts, ...edges.holes.map((h) => circlePolygon(h.center, h.r))].map(toPath);
  if (openings.length) area = difference(area, offset(openings, POUR_EDGE_CLEARANCE, ClipperLib.EndType.etClosedPolygon));
  const kept = input.keepouts.filter((k) => k.pours && k.layers.includes(layer) && k.outline.length >= 3).map((k) => toPath(k.outline));
  if (kept.length) area = difference(area, union(kept));
  const zone = pour.outline && pour.outline.length >= 3 ? pour.outline : null;
  if (zone) area = intersect([toPath(zone)], area);

  const foreign: Paths = [];
  const thermalCut: Paths = [];
  const thermalPads: WorldPad[] = [];
  const anchors: Vec[] = [];
  const padByRef = new Map(pads.map((p) => [`${p.componentId}:${p.index}`, p]));
  for (const it of items) {
    if (!it.layers.includes(layer)) continue;
    // Tracks and vias carry the net they were drawn with.
    if (it.net === pour.net) {
      if (it.type === 'pad') {
        const pad = padByRef.get(it.ref);
        if (pad) anchors.push(pad.center);
        // A zone only reports thermals for the pads it covers.
        if (pad && pour.connection === 'thermal' && (!zone || pointInPolygon(pad.center, zone))) {
          thermalPads.push(pad);
          thermalCut.push(...grownShape(it.shape, pour.thermalGap));
        }
      } else if (it.shape.kind === 'capsule') anchors.push(it.shape.a, it.shape.b);
      continue;
    }
    foreign.push(...grownShape(it.shape, clearance));
  }
  for (const a of input.blocked ?? []) {
    const copper = difference([toPath(a.outer)], a.holes.map(toPath));
    foreign.push(...offset(copper, clearance, ClipperLib.EndType.etClosedPolygon));
  }
  // Drilled holes need clearance from the pour whatever their copper.
  for (const pad of pads) {
    if (!pad.hole || !pad.layers.includes(layer) || pad.net === pour.net) continue;
    foreign.push(...grownShape({ kind: 'capsule', a: pad.hole.center, b: pad.hole.center, r: Math.min(pad.hole.w, pad.hole.h) / 2 }, clearance));
  }

  const allowed = difference(area, union(foreign));
  let fill = difference(allowed, thermalCut);

  // Thermal spokes along the pad's own axes.
  const spokeDirs = (pad: WorldPad): { dir: Vec; reach: number }[] =>
    (
      [
        [[1, 0], pad.pad.w / 2],
        [[-1, 0], pad.pad.w / 2],
        [[0, 1], pad.pad.h / 2],
        [[0, -1], pad.pad.h / 2],
      ] as [Vec, number][]
    ).map(([d, half]) => ({ dir: rotateDeg(d, pad.rotation), reach: half }));
  if (thermalPads.length) {
    const spokes: Paths = [];
    for (const pad of thermalPads) {
      for (const { dir, reach } of spokeDirs(pad)) spokes.push(rectPath(pad.center, dir, reach + pour.thermalGap + pour.spokeWidth, pour.spokeWidth));
    }
    fill = union(fill, intersect(union(spokes), allowed));
  }

  // Remove slivers thinner than minWidth (morphological opening).
  if (pour.minWidth > 0 && fill.length) {
    const opened = offset(offset(fill, -pour.minWidth / 2, ClipperLib.EndType.etClosedPolygon), pour.minWidth / 2, ClipperLib.EndType.etClosedPolygon);
    fill = intersect(opened, fill);
  }

  const c = new ClipperLib.Clipper();
  c.AddPaths(fill, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const all: FillArea[] = [];
  collectAreas(tree, all);
  // Keep only islands connected to same-net copper.
  const areas = all.filter((a) => anchors.some((p) => pointInArea(p, a)));

  const thermals: ThermalReport[] = thermalPads.map((pad) => ({
    designator: pad.designator,
    number: pad.number,
    center: pad.center,
    spokes: spokeDirs(pad).filter(({ dir, reach }) => {
      const d = reach + pour.thermalGap / 2;
      const probe: Vec = [pad.center[0] + dir[0] * d, pad.center[1] + dir[1] * d];
      return areas.some((a) => pointInArea(probe, a));
    }).length,
  }));
  return { pour, areas, thermals };
}

/** SVG path data (even-odd) for fill areas. */
export function areasToSvgPath(areas: FillArea[]): string {
  const ring = (pts: Vec[]) => `M${pts.map((p) => `${p[0].toFixed(4)} ${p[1].toFixed(4)}`).join('L')}Z`;
  return areas.map((a) => ring(a.outer) + a.holes.map(ring).join('')).join('');
}

/** What mergeAreas joins: copper shapes, polylines stroked with round ends, and filled areas. */
export interface MergeInput {
  shapes?: CopperShape[];
  strokes?: { points: Vec[]; width: number }[];
  areas?: FillArea[];
  /** Cut out of the result (drill holes). */
  holes?: Vec[][];
  /** Kept only inside this outline (the board). */
  clip?: Vec[];
  /** Drop outline points closer than this (mm) to the simplified outline; 0 keeps them all. */
  tolerance?: number;
}

/** Douglas–Peucker on a closed ring: the fewest points within `tol` of the original. */
function simplifyRing(ring: Vec[], tol: number): Vec[] {
  if (ring.length <= 4 || tol <= 0) return ring;
  const keep = new Uint8Array(ring.length);
  const dist = (p: Vec, a: Vec, b: Vec) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return l < 1e-12 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / l;
  };
  const run = (i: number, j: number) => {
    let far = -1;
    let best = tol;
    for (let k = i + 1; k < j; k++) {
      const d = dist(ring[k], ring[i], ring[j % ring.length]);
      if (d > best) {
        best = d;
        far = k;
      }
    }
    if (far < 0) return;
    keep[far] = 1;
    run(i, far);
    run(far, j);
  };
  // Split the ring at its first point and the point farthest from it.
  let opposite = 1;
  for (let k = 1; k < ring.length; k++) if (Math.hypot(ring[k][0] - ring[0][0], ring[k][1] - ring[0][1]) > Math.hypot(ring[opposite][0] - ring[0][0], ring[opposite][1] - ring[0][1])) opposite = k;
  keep[0] = keep[opposite] = 1;
  run(0, opposite);
  run(opposite, ring.length);
  const out = ring.filter((_, k) => keep[k]);
  return out.length >= 3 ? out : ring;
}

/** Joins shapes, strokes and areas into areas with holes, e.g. a whole copper or silkscreen layer. */
export function mergeAreas(input: MergeInput): FillArea[] {
  const paths: Paths = [];
  for (const s of input.shapes ?? []) paths.push(...grownShape(s, 0));
  for (const st of input.strokes ?? []) {
    if (st.points.length === 0) continue;
    const pts = st.points.length === 1 ? [st.points[0], [st.points[0][0] + 1e-4, st.points[0][1]] as Vec] : st.points;
    paths.push(...offset([pts.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }))], st.width / 2, ClipperLib.EndType.etOpenRound));
  }
  // An area's holes are cut from it alone, so they don't erase other copper under them.
  for (const a of input.areas ?? []) paths.push(...difference([toPath(a.outer)], a.holes.map(toPath)));
  let merged = union(paths);
  if (input.holes?.length) merged = difference(merged, input.holes.map(toPath));
  if (input.clip) merged = intersect(merged, [toPath(input.clip)]);
  const c = new ClipperLib.Clipper();
  c.AddPaths(merged, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const out: FillArea[] = [];
  collectAreas(tree, out);
  const tol = input.tolerance ?? 0;
  return tol > 0 ? out.map((a) => ({ outer: simplifyRing(a.outer, tol), holes: a.holes.map((h) => simplifyRing(h, tol)) })) : out;
}
