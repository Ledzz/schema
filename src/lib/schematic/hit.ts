import type { Box } from '../easyeda/symbol';
import { boxContains, boxIntersects, componentBox, distToSegment, normBox, rotate, samePoint, worldPins } from './geometry';
import type { SymbolResolver } from './symbols';
import { blockBox, blockPins } from './sheets';
import { groupBox, hitGroup } from './groups';
import type { NetPort, Project, Vec } from './types';

type Doc = Pick<Project, 'components' | 'wires' | 'ports' | 'blocks' | 'groups'>;

export function portBox(p: NetPort): Box {
  if (p.kind === 'noconnect') return { x1: p.x - 4, y1: p.y - 4, x2: p.x + 4, y2: p.y + 4 };
  if (p.kind === 'label' || p.kind === 'hier') {
    const w = Math.max(p.name.length * 4.2 + 4, 10) + 3;
    switch (p.rotation) {
      case 90:
        return { x1: p.x - 5, y1: p.y - w, x2: p.x + 5, y2: p.y };
      case 180:
        return { x1: p.x - w, y1: p.y - 5, x2: p.x, y2: p.y + 5 };
      case 270:
        return { x1: p.x - 5, y1: p.y, x2: p.x + 5, y2: p.y + w };
      default:
        return { x1: p.x, y1: p.y - 5, x2: p.x + w, y2: p.y + 5 };
    }
  }
  const corners: Vec[] = p.kind === 'power' ? [[-7, -14], [7, 0]] : [[-7, 0], [7, 16]];
  const [a, b] = corners.map((c) => rotate(c, p.rotation));
  return normBox([a[0] + p.x, a[1] + p.y], [b[0] + p.x, b[1] + p.y]);
}

/** Topmost item under a world point. */
export function hitTest(doc: Doc, symbols: SymbolResolver, p: Vec, tol: number): string | null {
  for (let i = doc.ports.length - 1; i >= 0; i--) if (boxContains(portBox(doc.ports[i]), p, tol / 2)) return doc.ports[i].id;
  for (let i = doc.wires.length - 1; i >= 0; i--) {
    const w = doc.wires[i];
    for (let k = 1; k < w.points.length; k++) if (distToSegment(p, w.points[k - 1], w.points[k]) <= tol) return w.id;
  }
  for (const b of doc.blocks ?? []) if (boxContains(blockBox(b), p, 1)) return b.id;
  for (let i = doc.components.length - 1; i >= 0; i--) {
    const c = doc.components[i];
    if (boxContains(componentBox(c, symbols(c.symbolKey)), p, 1)) return c.id;
  }
  // A group only by its tab or border, so clicking inside it still reaches what is there.
  return doc.groups?.length ? hitGroup(doc.groups, p, tol) : null;
}

/** The part of a wire under a point: a vertex within `tol`, otherwise a segment. */
export function wireGrabAt(doc: Doc, p: Vec, tol: number): { wireId: string; grab: { segment: number } | { vertex: number }; horizontal: boolean } | null {
  for (let i = doc.wires.length - 1; i >= 0; i--) {
    const w = doc.wires[i];
    const v = w.points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol);
    if (v >= 0) return { wireId: w.id, grab: { vertex: v }, horizontal: false };
    for (let k = 1; k < w.points.length; k++) {
      if (distToSegment(p, w.points[k - 1], w.points[k]) <= tol) return { wireId: w.id, grab: { segment: k - 1 }, horizontal: w.points[k - 1][1] === w.points[k][1] };
    }
  }
  return null;
}

export function itemsInBox(doc: Doc, symbols: SymbolResolver, box: Box): string[] {
  const ids: string[] = [];
  for (const c of doc.components) if (boxIntersects(componentBox(c, symbols(c.symbolKey)), box)) ids.push(c.id);
  for (const w of doc.wires) if (w.points.some((pt) => boxContains(box, pt))) ids.push(w.id);
  for (const p of doc.ports) if (boxContains(box, [p.x, p.y])) ids.push(p.id);
  for (const b of doc.blocks ?? []) if (boxIntersects(blockBox(b), box)) ids.push(b.id);
  // A group frame only when the box takes in the whole of it; a box inside it selects its parts.
  for (const g of doc.groups ?? []) {
    const gb = groupBox(g);
    if (boxContains(box, [gb.x1, gb.y1]) && boxContains(box, [gb.x2, gb.y2])) ids.push(g.id);
  }
  return ids;
}

export interface ConnectionPoint {
  at: Vec;
  kind: 'pin' | 'block' | 'wire-end' | 'wire' | 'port';
  label?: string;
  /** `${componentId}:${pinId}` for pins, the item id otherwise. */
  ref?: string;
}

/** Nearest electrical connection point (pin end, wire, port anchor) within `tol`. */
export function connectionNear(doc: Doc, symbols: SymbolResolver, p: Vec, tol: number): ConnectionPoint | null {
  let best: ConnectionPoint | null = null;
  let bestD = tol;
  // On a tie the first kind wins, so a wired pin still reports the pin.
  const consider = (at: Vec, kind: ConnectionPoint['kind'], ref: string, label?: string) => {
    const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (best ? d < bestD : d <= bestD) {
      bestD = d;
      best = { at, kind, label, ref };
    }
  };
  for (const c of doc.components) {
    for (const wp of worldPins(c, symbols(c.symbolKey))) {
      const name = wp.pin.name && wp.pin.name !== wp.pin.number ? ` (${wp.pin.name})` : '';
      consider(wp.at, 'pin', `${c.id}:${wp.pin.id}`, `${c.designator} pin ${wp.pin.number}${name}`);
    }
  }
  for (const b of doc.blocks ?? []) for (const pin of blockPins(b)) consider(pin.at, 'block', `${b.id}:${pin.name}`, `Block pin ${pin.name}`);
  for (const port of doc.ports) if (port.kind !== 'noconnect') consider([port.x, port.y], 'port', port.id, port.name);
  for (const w of doc.wires) {
    consider(w.points[0], 'wire-end', w.id);
    consider(w.points[w.points.length - 1], 'wire-end', w.id);
  }
  if (best) return best;
  // Points on a wire, snapped to the grid along the segment.
  for (const w of doc.wires) {
    for (let k = 1; k < w.points.length; k++) {
      const a = w.points[k - 1];
      const b = w.points[k];
      if (distToSegment(p, a, b) <= tol) {
        const at: Vec = a[0] === b[0] ? [a[0], Math.round(p[1] / 5) * 5] : a[1] === b[1] ? [Math.round(p[0] / 5) * 5, a[1]] : p;
        if (distToSegment(at, a, b) < 0.01 || samePoint(at, a) || samePoint(at, b)) return { at, kind: 'wire', ref: w.id };
      }
    }
  }
  return null;
}
