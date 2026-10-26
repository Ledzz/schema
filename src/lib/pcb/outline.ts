/*
 * The board's mechanical shape: outline, milled cutouts, non-plated mounting holes, and the
 * keepout areas (drawn ones plus the copper-free ring around each mounting hole). DRC, the
 * router, pours, Gerbers and the 3D view all ask here instead of assuming a rectangle.
 */
import type { Vec } from '../schematic/types';
import { boardOutline, flattenOutline, pointInPolygon, pointSegDist, shapeDistance, type CopperShape } from './geometry';
import { copperLayers, type Board, type CopperLayer, type Keepout, type MountingHole, type Pcb } from './types';

export interface BoardEdges {
  outline: Vec[];
  cutouts: Vec[][];
  holes: { center: Vec; r: number }[];
  /** Every straight edge of the outline and the cutouts. */
  segments: [Vec, Vec][];
}

const ring = (points: Vec[]): Vec[] =>
  points.length && (points[0][0] !== points[points.length - 1][0] || points[0][1] !== points[points.length - 1][1]) ? [...points, points[0]] : points;

export function circlePolygon(c: Vec, r: number, n = 32): Vec[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as Vec;
  });
}

export function boundsOf(points: Vec[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** A board patch for a new custom outline: the polygon plus its bounding box. */
export function withOutline(board: Board, outline: Vec[] | null, bulges?: number[]): Board {
  const { outline: _drop, outlineBulges: _arcs, ...rect } = board;
  if (!outline || outline.length < 3) return rect;
  const open = ring(outline).slice(0, -1);
  const arcs = bulges?.some((b) => Math.abs(b) > 1e-9) ? open.map((_, i) => bulges[i] ?? 0) : undefined;
  // Arcs can reach past the corners: the bounding box comes from the flattened shape.
  const shape = arcs ? flattenOutline(open, arcs).points.slice(0, -1) : open;
  return { ...rect, ...boundsOf(shape), outline: open, ...(arcs ? { outlineBulges: arcs } : {}) };
}

export function boardEdges(pcb: Pick<Pcb, 'board' | 'holes'>): BoardEdges {
  const outline = boardOutline(pcb.board);
  const cutouts = (pcb.board.cutouts ?? []).filter((c) => c.outline.length >= 3).map((c) => ring(c.outline));
  const segments: [Vec, Vec][] = [];
  for (const poly of [outline, ...cutouts]) for (let i = 1; i < poly.length; i++) segments.push([poly[i - 1], poly[i]]);
  return { outline, cutouts, holes: (pcb.holes ?? []).map((h) => ({ center: [h.x, h.y], r: h.diameter / 2 })), segments };
}

/** Inside the outline and not in a cutout or mounting hole. */
export function insideBoard(p: Vec, edges: BoardEdges): boolean {
  return pointInPolygon(p, edges.outline) && !edges.cutouts.some((c) => pointInPolygon(p, c)) && !edges.holes.some((h) => Math.hypot(p[0] - h.center[0], p[1] - h.center[1]) < h.r);
}

/** Distance from a point to the nearest board edge (outline, cutout or hole wall). */
export function edgeDistance(p: Vec, edges: BoardEdges): number {
  let best = Infinity;
  for (const [a, b] of edges.segments) best = Math.min(best, pointSegDist(p, a, b));
  for (const h of edges.holes) best = Math.min(best, Math.abs(Math.hypot(p[0] - h.center[0], p[1] - h.center[1]) - h.r));
  return best;
}

/** Distance from a copper shape to the nearest board edge (0 when it crosses one). */
export function shapeEdgeDistance(shape: CopperShape, edges: BoardEdges): number {
  let best = Infinity;
  for (const [a, b] of edges.segments) best = Math.min(best, shapeDistance(shape, { kind: 'capsule', a, b, r: 0 }));
  for (const h of edges.holes) {
    // Copper over the hole counts as touching its wall.
    const d = shapeDistance(shape, { kind: 'capsule', a: h.center, b: h.center, r: h.r });
    best = Math.min(best, d);
  }
  return best;
}

/** Drawn keepouts plus the free ring around every mounting hole (on every copper layer). */
export function keepoutAreas(pcb: Pick<Pcb, 'keepouts' | 'holes'> & Partial<Pick<Pcb, 'board'>>): Keepout[] {
  const layers = pcb.board ? copperLayers({ board: pcb.board }) : (['top', 'bottom'] as CopperLayer[]);
  const rings = (pcb.holes ?? []).map(
    (h: MountingHole): Keepout => ({
      id: h.id,
      outline: circlePolygon([h.x, h.y], Math.max(h.keepout, h.diameter) / 2),
      layers,
      tracks: true,
      vias: true,
      pours: true,
      parts: true,
    }),
  );
  return [...(pcb.keepouts ?? []), ...rings];
}

/** SVG path data for the board with its cutouts as holes (draw with fill-rule evenodd). */
export function boardSvgPath(pcb: Pick<Pcb, 'board' | 'holes'>): string {
  const edges = boardEdges(pcb);
  const loop = (poly: Vec[]) => `M${poly.map((p) => `${p[0].toFixed(4)} ${p[1].toFixed(4)}`).join('L')}Z`;
  return [edges.outline, ...edges.cutouts].map(loop).join('');
}

/** Rectangle as a closed outline. */
export function rectOutline(x1: number, y1: number, x2: number, y2: number): Vec[] {
  const [a, b] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [c, d] = [Math.min(y1, y2), Math.max(y1, y2)];
  return [
    [a, c],
    [b, c],
    [b, d],
    [a, d],
  ];
}

/** Hole positions in the four corners of the board's bounding box, `inset` from its edges. */
export function cornerHolePositions(board: Board, inset: number): Vec[] {
  const { x, y, width, height } = board;
  return [
    [x + inset, y + inset],
    [x + width - inset, y + inset],
    [x + width - inset, y + height - inset],
    [x + inset, y + height - inset],
  ];
}

/** True when two non-adjacent edges of the closed polygon cross. */
export function selfIntersects(points: Vec[]): boolean {
  const poly = ring(points).slice(0, -1);
  const n = poly.length;
  const cross = (o: Vec, a: Vec, b: Vec) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % n]];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [c, d] = [poly[j], poly[(j + 1) % n]];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    }
  }
  return false;
}
