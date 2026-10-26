import { nextRotation, onSegment, rotate, samePoint, snap, worldPins } from './geometry';
import { simplify } from './route';
import type { SymbolResolver } from './symbols';
import type { Component, NetPort, Project, Vec, Wire } from './types';

export type Doc = Pick<Project, 'components' | 'wires' | 'ports' | 'symbols' | 'pcb'>;

let counter = 0;
export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}${(counter++).toString(36)}`;
}

const isSelected = (ids: ReadonlySet<string>) => (item: { id: string }) => ids.has(item.id);

/** Re-attaches wire ends that sat on a pin which moved from `from` to `to`, keeping wires orthogonal. */
function dragWireEnd(wire: Wire, endIndex: number, to: Vec): Wire {
  const pts = wire.points.map((p) => [...p] as Vec);
  const last = pts.length - 1;
  const from = pts[endIndex];
  if (pts.length === 2) {
    const fixed = pts[endIndex === 0 ? 1 : 0];
    const horizontal = from[1] === fixed[1];
    let path: Vec[];
    if (to[0] === fixed[0] || to[1] === fixed[1]) path = [fixed, to];
    else if (horizontal) {
      const mx = snap((fixed[0] + to[0]) / 2, 5);
      path = [fixed, [mx, fixed[1]], [mx, to[1]], to];
    } else {
      const my = snap((fixed[1] + to[1]) / 2, 5);
      path = [fixed, [fixed[0], my], [to[0], my], to];
    }
    if (endIndex === 0) path.reverse();
    return { ...wire, points: simplify(path) };
  }
  const n = endIndex === 0 ? 1 : last - 1;
  const neighbour = pts[n];
  if (from[1] === neighbour[1]) neighbour[1] = to[1];
  else if (from[0] === neighbour[0]) neighbour[0] = to[0];
  pts[endIndex] = to;
  return { ...wire, points: simplify(pts) };
}

/**
 * Applies `transform` to the selected components and `transformPort` to the selected ports (net
 * labels and flags), and keeps attached, unselected wires connected to the pins and anchors that
 * moved.
 */
function transformItems(
  doc: Doc,
  ids: ReadonlySet<string>,
  symbols: SymbolResolver,
  transform: (c: Component) => Component,
  transformPort: (p: NetPort) => NetPort = (p) => p,
): Pick<Doc, 'components' | 'wires' | 'ports'> {
  const moves: { from: Vec; to: Vec }[] = [];
  const components = doc.components.map((c) => {
    if (!ids.has(c.id)) return c;
    const next = transform(c);
    const symbol = symbols(c.symbolKey);
    const before = worldPins(c, symbol);
    const after = worldPins(next, symbol);
    before.forEach((b, i) => moves.push({ from: b.at, to: after[i].at }));
    return next;
  });
  const ports = doc.ports.map((p) => {
    if (!ids.has(p.id)) return p;
    const next = transformPort(p);
    moves.push({ from: [p.x, p.y], to: [next.x, next.y] });
    return next;
  });
  const wires = doc.wires.map((w) => {
    if (ids.has(w.id) || w.points.length < 2) return w;
    let out = w;
    for (const endIndex of [0, w.points.length - 1]) {
      const end = w.points[endIndex];
      const move = moves.find((m) => samePoint(m.from, end));
      if (move && !samePoint(move.from, move.to)) {
        const idx = endIndex === 0 ? 0 : out.points.length - 1;
        out = dragWireEnd(out, idx, move.to);
      }
    }
    return out;
  });
  return { components, wires, ports };
}

export function moveItems(doc: Doc, ids: ReadonlySet<string>, dx: number, dy: number, symbols: SymbolResolver): Doc {
  if (dx === 0 && dy === 0) return doc;
  const { components, wires, ports } = transformItems(
    doc,
    ids,
    symbols,
    (c) => ({ ...c, x: c.x + dx, y: c.y + dy }),
    (p) => ({ ...p, x: p.x + dx, y: p.y + dy }),
  );
  return {
    ...doc,
    components,
    wires: wires.map((w) => (ids.has(w.id) ? { ...w, points: w.points.map(([x, y]) => [x + dx, y + dy] as Vec) } : w)),
    ports,
  };
}

/** Updates one component (e.g. a new position or rotation) and keeps attached wires connected. */
export function updateComponentItem(doc: Doc, id: string, patch: Partial<Component>, symbols: SymbolResolver): Doc {
  const { components, wires } = transformItems(doc, new Set([id]), symbols, (c) => ({ ...c, ...patch }));
  return { ...doc, components, wires };
}

function selectionCenter(doc: Doc, ids: ReadonlySet<string>): Vec {
  const pts: Vec[] = [
    ...doc.components.filter(isSelected(ids)).map((c) => [c.x, c.y] as Vec),
    ...doc.ports.filter(isSelected(ids)).map((p) => [p.x, p.y] as Vec),
    ...doc.wires.filter(isSelected(ids)).flatMap((w) => w.points),
  ];
  if (pts.length === 0) return [0, 0];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [snap((Math.min(...xs) + Math.max(...xs)) / 2, 10), snap((Math.min(...ys) + Math.max(...ys)) / 2, 10)];
}

/** Rotates the selection 90° counter-clockwise around its centre. */
export function rotateItems(doc: Doc, ids: ReadonlySet<string>, symbols: SymbolResolver): Doc {
  const center = selectionCenter(doc, ids);
  const around = ([x, y]: Vec): Vec => {
    const [rx, ry] = rotate([x - center[0], y - center[1]], 90);
    return [rx + center[0], ry + center[1]];
  };
  const { components, wires, ports } = transformItems(
    doc,
    ids,
    symbols,
    (c) => {
      const [x, y] = around([c.x, c.y]);
      return { ...c, x, y, rotation: nextRotation(c.rotation) };
    },
    (p) => {
      const [x, y] = around([p.x, p.y]);
      return { ...p, x, y, rotation: nextRotation(p.rotation) };
    },
  );
  return {
    ...doc,
    components,
    wires: wires.map((w) => (ids.has(w.id) ? { ...w, points: w.points.map(around) } : w)),
    ports,
  };
}

/** Mirrors selected components horizontally around their own origin. */
export function mirrorItems(doc: Doc, ids: ReadonlySet<string>, symbols: SymbolResolver): Doc {
  const { components, wires } = transformItems(doc, ids, symbols, (c) => ({ ...c, mirror: !c.mirror }));
  return { ...doc, components, wires };
}

/**
 * Deletes the selected items. With `symbols`, deleting parts also removes the wiring left
 * attached to nothing: wires, labels, flags and no-connect markers that touched a deleted part's
 * pins and no longer reach any remaining pin.
 */
export function deleteItems(doc: Doc, ids: ReadonlySet<string>, symbols?: SymbolResolver): Doc {
  const keep = (item: { id: string }) => !ids.has(item.id);
  const out: Doc = {
    ...doc,
    components: doc.components.filter(keep),
    wires: doc.wires.filter(keep),
    ports: doc.ports.filter(keep),
  };
  const removed = doc.components.filter(isSelected(ids));
  if (!symbols || removed.length === 0) return out;
  const orphans = orphanedWiring(
    out,
    removed.flatMap((c) => worldPins(c, symbols(c.symbolKey)).map((p) => p.at)),
    out.components.flatMap((c) => worldPins(c, symbols(c.symbolKey)).map((p) => p.at)),
  );
  if (orphans.size === 0) return out;
  return { ...out, wires: out.wires.filter((w) => !orphans.has(w.id)), ports: out.ports.filter((p) => !orphans.has(p.id)) };
}

/**
 * Ids of the wires and ports in groups of touching wiring that reach one of the `freed` points
 * and none of the remaining `pins`.
 */
function orphanedWiring(doc: Doc, freed: Vec[], pins: Vec[]): Set<string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r)) r = parent.get(r)!;
    if (r !== x) parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // Connection points of each item: wire ends and port anchors.
  const items: { id: string; at: Vec[] }[] = [
    ...doc.wires.filter((w) => w.points.length >= 2).map((w) => ({ id: w.id, at: [w.points[0], w.points[w.points.length - 1]] })),
    ...doc.ports.map((p) => ({ id: p.id, at: [[p.x, p.y] as Vec] })),
  ];
  const onWire = (p: Vec, w: Wire) => w.points.some((q, i) => (i === 0 ? samePoint(p, q) : onSegment(p, w.points[i - 1], q)));
  for (const it of items) {
    for (const w of doc.wires) if (w.id !== it.id && it.at.some((p) => onWire(p, w))) union(it.id, w.id);
    for (const other of items) if (other.id !== it.id && it.at.some((p) => other.at.some((q) => samePoint(p, q)))) union(it.id, other.id);
  }
  const touched = new Set<string>();
  const anchored = new Set<string>();
  for (const it of items) {
    if (it.at.some((p) => freed.some((f) => samePoint(p, f)))) touched.add(find(it.id));
    if (it.at.some((p) => pins.some((q) => samePoint(p, q)))) anchored.add(find(it.id));
  }
  const out = new Set<string>();
  for (const it of items) {
    const root = find(it.id);
    if (touched.has(root) && !anchored.has(root)) out.add(it.id);
  }
  return out;
}

/** Removes `wireId`'s segment that contains `segIndex`, splitting the wire in two. */
export function deleteWireSegment(doc: Doc, wireId: string, segIndex: number): Doc {
  const wires: Wire[] = [];
  for (const w of doc.wires) {
    if (w.id !== wireId) {
      wires.push(w);
      continue;
    }
    const a = w.points.slice(0, segIndex + 1);
    const b = w.points.slice(segIndex + 1);
    if (a.length >= 2) wires.push({ id: w.id, points: a });
    if (b.length >= 2) wires.push({ id: newId('w'), points: b });
  }
  return { ...doc, wires };
}

export function duplicateItems(
  doc: Doc,
  ids: ReadonlySet<string>,
  offset: Vec,
  rename: (c: Component, placed: Component[]) => string,
): { doc: Doc; newIds: string[] } {
  const newIds: string[] = [];
  const placed = [...doc.components];
  const components = doc.components.filter(isSelected(ids)).map((c) => {
    const copy: Component = { ...c, id: newId('c'), x: c.x + offset[0], y: c.y + offset[1], attrs: { ...c.attrs } };
    copy.designator = rename(copy, placed);
    placed.push(copy);
    newIds.push(copy.id);
    return copy;
  });
  const wires = doc.wires.filter(isSelected(ids)).map((w) => {
    const copy: Wire = { id: newId('w'), points: w.points.map(([x, y]) => [x + offset[0], y + offset[1]] as Vec) };
    newIds.push(copy.id);
    return copy;
  });
  const ports = doc.ports.filter(isSelected(ids)).map((p) => {
    const copy: NetPort = { ...p, id: newId('n'), x: p.x + offset[0], y: p.y + offset[1] };
    newIds.push(copy.id);
    return copy;
  });
  return {
    doc: { ...doc, components: [...doc.components, ...components], wires: [...doc.wires, ...wires], ports: [...doc.ports, ...ports] },
    newIds,
  };
}

/** Removes no-connect markers at `points`: a pin that gets wired or labelled is connected after all. */
export function dropNoConnects(doc: Doc, points: Vec[]): Doc {
  const drop = (p: NetPort) => p.kind === 'noconnect' && points.some((q) => samePoint(q, [p.x, p.y]));
  return doc.ports.some(drop) ? { ...doc, ports: doc.ports.filter((p) => !drop(p)) } : doc;
}

/** Adds a wire after dropping duplicate and collinear points. */
export function addWire(doc: Doc, points: Vec[]): { doc: Doc; id: string | null } {
  const pts = simplify(points);
  if (pts.length < 2) return { doc, id: null };
  const wire: Wire = { id: newId('w'), points: pts };
  return { doc: { ...doc, wires: [...doc.wires, wire] }, id: wire.id };
}
