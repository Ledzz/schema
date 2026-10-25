import type { Vec } from '../schematic/types';
import type { FootprintGeom, Graphic, GraphicLayer, PadGeom } from './footprint';
import type { Board, CopperLayer, Placement, Track, Via } from './types';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Rotates a y-down vector counter-clockwise (as seen on screen) by any angle. */
export function rotateDeg([x, y]: Vec, deg: number): Vec {
  if (deg % 360 === 0) return [x, y];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const rx = x * c + y * s;
  const ry = -x * s + y * c;
  return [Math.abs(rx) < 1e-9 ? 0 : rx, Math.abs(ry) < 1e-9 ? 0 : ry];
}

export function placementToWorld(pl: Pick<Placement, 'x' | 'y' | 'rotation' | 'side'>, p: Vec): Vec {
  const [x, y] = rotateDeg([pl.side === 'bottom' ? -p[0] : p[0], p[1]], pl.rotation);
  return [x + pl.x, y + pl.y];
}

export function worldToPlacement(pl: Pick<Placement, 'x' | 'y' | 'rotation' | 'side'>, p: Vec): Vec {
  const [x, y] = rotateDeg([p[0] - pl.x, p[1] - pl.y], -pl.rotation);
  return [pl.side === 'bottom' ? -x : x, y];
}

export interface WorldPad {
  componentId: string;
  designator: string;
  index: number;
  number: string;
  net: string | null;
  center: Vec;
  rotation: number;
  pad: PadGeom;
  layers: CopperLayer[];
  /** World outline of the copper (polygonized). */
  outline: Vec[];
  shape: CopperShape;
  hole: { center: Vec; w: number; h: number; rotation: number } | null;
}

export type CopperShape = { kind: 'capsule'; a: Vec; b: Vec; r: number } | { kind: 'poly'; points: Vec[] };

function padLocalOutline(pad: PadGeom, grow = 0): Vec[] {
  const w = pad.w + grow * 2;
  const h = pad.h + grow * 2;
  if (pad.shape === 'polygon') {
    if (grow === 0) return pad.points;
    const cx = pad.points.reduce((s, p) => s + p[0], 0) / pad.points.length;
    const cy = pad.points.reduce((s, p) => s + p[1], 0) / pad.points.length;
    return pad.points.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      return [x + ((x - cx) / d) * grow, y + ((y - cy) / d) * grow] as Vec;
    });
  }
  if (pad.shape === 'rect') {
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ];
  }
  // oval / circle: capsule along the long axis
  const r = Math.min(w, h) / 2;
  const half = Math.max(w, h) / 2 - r;
  const pts: Vec[] = [];
  const seg = 8;
  const horizontal = w >= h;
  for (let side = 0; side < 2; side++) {
    const c: Vec = horizontal ? [side === 0 ? half : -half, 0] : [0, side === 0 ? half : -half];
    const base = horizontal ? (side === 0 ? -Math.PI / 2 : Math.PI / 2) : side === 0 ? 0 : Math.PI;
    for (let i = 0; i <= seg; i++) {
      const a = base + (Math.PI * i) / seg;
      pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  }
  return pts;
}

/** Pad rotation in world space (mirroring for the bottom side flips its direction). */
const padWorldRotation = (pl: Placement, pad: PadGeom) => (pl.side === 'bottom' ? pl.rotation - pad.rotation : pl.rotation + pad.rotation);

export function padOutline(pl: Placement, pad: PadGeom, grow = 0): Vec[] {
  const center = placementToWorld(pl, [pad.x, pad.y]);
  const rot = padWorldRotation(pl, pad);
  const mirror = pl.side === 'bottom';
  return padLocalOutline(pad, grow).map((p) => {
    const [x, y] = rotateDeg([mirror ? -p[0] : p[0], p[1]], rot);
    return [x + center[0], y + center[1]] as Vec;
  });
}

function padShape(pl: Placement, pad: PadGeom, center: Vec, outline: Vec[]): CopperShape {
  if (pad.shape === 'oval' || pad.shape === 'circle') {
    const r = Math.min(pad.w, pad.h) / 2;
    const half = Math.max(pad.w, pad.h) / 2 - r;
    const axis = rotateDeg(pad.w >= pad.h ? [half, 0] : [0, half], padWorldRotation(pl, pad));
    return { kind: 'capsule', a: [center[0] - axis[0], center[1] - axis[1]], b: [center[0] + axis[0], center[1] + axis[1]], r };
  }
  return { kind: 'poly', points: outline };
}

export function padLayers(pl: Placement, pad: PadGeom): CopperLayer[] {
  if (pad.layer === 'through') return ['top', 'bottom'];
  const onTop = pad.layer === 'top';
  return [(pl.side === 'top') === onTop ? 'top' : 'bottom'];
}

export function worldPads(pl: Placement, fp: FootprintGeom, designator: string, padNet: (number: string) => string | null): WorldPad[] {
  return fp.pads.map((pad, index) => {
    const center = placementToWorld(pl, [pad.x, pad.y]);
    const outline = padOutline(pl, pad);
    const hole = pad.hole
      ? {
          center: placementToWorld(pl, [pad.x + pad.hole.dx, pad.y + pad.hole.dy]),
          w: pad.hole.w,
          h: pad.hole.h,
          rotation: pl.side === 'bottom' ? pl.rotation - pad.hole.rotation - pad.rotation : pl.rotation + pad.hole.rotation + pad.rotation,
        }
      : null;
    return {
      componentId: pl.componentId,
      designator,
      index,
      number: pad.number,
      net: padNet(pad.number),
      center,
      rotation: padWorldRotation(pl, pad),
      pad,
      layers: padLayers(pl, pad),
      outline,
      shape: padShape(pl, pad, center, outline),
      hole,
    };
  });
}

export function worldGraphics(pl: Placement, fp: FootprintGeom): Graphic[] {
  const swap: Record<GraphicLayer, GraphicLayer> = { silkTop: 'silkBottom', silkBottom: 'silkTop', outline: 'outline' };
  return fp.graphics.map((g) => ({
    ...g,
    layer: pl.side === 'bottom' ? swap[g.layer] : g.layer,
    points: g.points.map((p) => placementToWorld(pl, p)),
  }));
}

export function placementBox(pl: Placement, fp: FootprintGeom): Box {
  const b = fp.bbox;
  const corners = [
    placementToWorld(pl, [b.x1, b.y1]),
    placementToWorld(pl, [b.x2, b.y1]),
    placementToWorld(pl, [b.x1, b.y2]),
    placementToWorld(pl, [b.x2, b.y2]),
  ];
  return {
    x1: Math.min(...corners.map((c) => c[0])),
    y1: Math.min(...corners.map((c) => c[1])),
    x2: Math.max(...corners.map((c) => c[0])),
    y2: Math.max(...corners.map((c) => c[1])),
  };
}

/* ---------- distances ---------- */

export function pointSegDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function cross(o: Vec, a: Vec, b: Vec) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

export function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segSegDist(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segPolyDist(a: Vec, b: Vec, poly: Vec[]): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segSegDist(a, b, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

/** Edge-to-edge distance between two copper shapes (0 when touching or overlapping). */
export function shapeDistance(s: CopperShape, t: CopperShape): number {
  if (s.kind === 'capsule' && t.kind === 'capsule') return Math.max(0, segSegDist(s.a, s.b, t.a, t.b) - s.r - t.r);
  if (s.kind === 'capsule' && t.kind === 'poly') return Math.max(0, segPolyDist(s.a, s.b, t.points) - s.r);
  if (s.kind === 'poly' && t.kind === 'capsule') return Math.max(0, segPolyDist(t.a, t.b, s.points) - t.r);
  const p = s as Extract<CopperShape, { kind: 'poly' }>;
  const q = t as Extract<CopperShape, { kind: 'poly' }>;
  if (pointInPolygon(p.points[0], q.points) || pointInPolygon(q.points[0], p.points)) return 0;
  let best = Infinity;
  for (let i = 0; i < p.points.length; i++) {
    const a = p.points[i];
    const b = p.points[(i + 1) % p.points.length];
    best = Math.min(best, segPolyDist(a, b, q.points));
  }
  return best;
}

export function pointShapeDistance(p: Vec, s: CopperShape): number {
  if (s.kind === 'capsule') return Math.max(0, pointSegDist(p, s.a, s.b) - s.r);
  if (pointInPolygon(p, s.points)) return 0;
  let best = Infinity;
  for (let i = 0; i < s.points.length; i++) best = Math.min(best, pointSegDist(p, s.points[i], s.points[(i + 1) % s.points.length]));
  return best;
}

export function shapeBox(s: CopperShape): Box {
  if (s.kind === 'capsule') {
    return { x1: Math.min(s.a[0], s.b[0]) - s.r, y1: Math.min(s.a[1], s.b[1]) - s.r, x2: Math.max(s.a[0], s.b[0]) + s.r, y2: Math.max(s.a[1], s.b[1]) + s.r };
  }
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/* ---------- copper items ---------- */

export interface CopperItem {
  key: string;
  type: 'pad' | 'track' | 'via';
  /** pad: `${componentId}:${index}`, track: track id, via: via id */
  ref: string;
  layers: CopperLayer[];
  net: string | null;
  shape: CopperShape;
  box: Box;
}

export function trackItems(t: Track): CopperItem[] {
  return t.points.slice(1).map((p, i) => {
    const shape: CopperShape = { kind: 'capsule', a: t.points[i], b: p, r: t.width / 2 };
    return { key: `t:${t.id}:${i}`, type: 'track', ref: t.id, layers: [t.layer], net: t.net, shape, box: shapeBox(shape) };
  });
}

export function viaItem(v: Via): CopperItem {
  const shape: CopperShape = { kind: 'capsule', a: [v.x, v.y], b: [v.x, v.y], r: v.diameter / 2 };
  return { key: `v:${v.id}`, type: 'via', ref: v.id, layers: ['top', 'bottom'], net: v.net, shape, box: shapeBox(shape) };
}

export function padItem(p: WorldPad): CopperItem {
  return { key: `p:${p.componentId}:${p.index}`, type: 'pad', ref: `${p.componentId}:${p.index}`, layers: p.layers, net: p.net, shape: p.shape, box: shapeBox(p.shape) };
}

export const boxesOverlap = (a: Box, b: Box, pad = 0) => a.x1 - pad <= b.x2 && a.x2 + pad >= b.x1 && a.y1 - pad <= b.y2 && a.y2 + pad >= b.y1;

/**
 * Rounds every corner of a polygon with radius r (limited so neighbouring arcs don't overlap),
 * returning a closed ring. Works for convex and concave corners.
 */
export function filletPolygon(points: Vec[], r: number, segments = 8): Vec[] {
  const ring = points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1] ? points.slice(0, -1) : points;
  if (r <= 0 || ring.length < 3) return [...ring, ring[0]];
  const out: Vec[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i + ring.length - 1) % ring.length];
    const cur = ring[i];
    const next = ring[(i + 1) % ring.length];
    const l1 = Math.hypot(prev[0] - cur[0], prev[1] - cur[1]);
    const l2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const v1: Vec = [(prev[0] - cur[0]) / l1, (prev[1] - cur[1]) / l1];
    const v2: Vec = [(next[0] - cur[0]) / l2, (next[1] - cur[1]) / l2];
    const angle = Math.acos(Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1])));
    if (angle > Math.PI - 1e-3) {
      out.push(cur);
      continue;
    }
    // Distance from the corner to the tangent points, capped at half of each edge.
    const t = Math.min(r / Math.tan(angle / 2), l1 / 2, l2 / 2);
    const radius = t * Math.tan(angle / 2);
    const bis: Vec = [v1[0] + v2[0], v1[1] + v2[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    const c: Vec = [cur[0] + (bis[0] / bl) * (radius / Math.sin(angle / 2)), cur[1] + (bis[1] / bl) * (radius / Math.sin(angle / 2))];
    const p1: Vec = [cur[0] + v1[0] * t, cur[1] + v1[1] * t];
    const p2: Vec = [cur[0] + v2[0] * t, cur[1] + v2[1] * t];
    const a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    let sweep = Math.atan2(p2[1] - c[1], p2[0] - c[0]) - a1;
    if (sweep > Math.PI) sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;
    for (let k = 0; k <= segments; k++) {
      const a = a1 + (sweep * k) / segments;
      out.push([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]);
    }
  }
  out.push(out[0]);
  return out;
}

/** Board outline polygon (rounded corners approximated), closed. */
export function boardOutline(b: Board): Vec[] {
  if (b.outline && b.outline.length >= 3) return filletPolygon(b.outline, b.cornerRadius);
  const r = Math.min(b.cornerRadius, b.width / 2, b.height / 2);
  if (r <= 0) {
    return [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height],
      [b.x, b.y + b.height],
      [b.x, b.y],
    ];
  }
  const pts: Vec[] = [];
  const corners: [Vec, number][] = [
    [[b.x + b.width - r, b.y + r], -90],
    [[b.x + b.width - r, b.y + b.height - r], 0],
    [[b.x + r, b.y + b.height - r], 90],
    [[b.x + r, b.y + r], 180],
  ];
  for (const [c, start] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = ((start + (90 * i) / 8) * Math.PI) / 180;
      pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  }
  pts.push(pts[0]);
  return pts;
}

