import { componentBox, nextRotation, onSegment, rotate, samePoint, snap, worldPins } from './geometry';
import { portBox } from './hit';
import type { Box } from '../easyeda/symbol';
import { simplify } from './route';
import type { SymbolResolver } from './symbols';
import { blockPins, blockSlot, hierNames, sheetOf } from './sheets';
import type { Component, NetPort, Project, SheetBlock, Vec, Wire } from './types';

export type Doc = Pick<Project, 'components' | 'wires' | 'ports' | 'symbols' | 'footprints' | 'parts' | 'pcb' | 'sheets' | 'blocks'>;

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
  transformBlock: (b: SheetBlock) => SheetBlock = (b) => b,
): Pick<Doc, 'components' | 'wires' | 'ports' | 'blocks'> {
  const moves: { from: Vec; to: Vec }[] = [];
  const blocks = (doc.blocks ?? []).map((b) => {
    if (!ids.has(b.id)) return b;
    const next = transformBlock(b);
    const after = blockPins(next);
    blockPins(b).forEach((p, i) => moves.push({ from: p.at, to: after[i].at }));
    return next;
  });
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
  return { components, wires, ports, blocks };
}

export function moveItems(doc: Doc, ids: ReadonlySet<string>, dx: number, dy: number, symbols: SymbolResolver): Doc {
  if (dx === 0 && dy === 0) return doc;
  const { components, wires, ports, blocks } = transformItems(
    doc,
    ids,
    symbols,
    (c) => ({ ...c, x: c.x + dx, y: c.y + dy }),
    (p) => ({ ...p, x: p.x + dx, y: p.y + dy }),
    (b) => ({ ...b, x: b.x + dx, y: b.y + dy }),
  );
  // A moved wire whose end is on something staying put keeps that end, turning towards it.
  const staying = {
    ...doc,
    components: doc.components.filter((c) => !ids.has(c.id)),
    wires: doc.wires.filter((w) => !ids.has(w.id)),
    ports: doc.ports.filter((p) => !ids.has(p.id)),
    blocks: (doc.blocks ?? []).filter((b) => !ids.has(b.id)),
  };
  return {
    ...doc,
    components,
    wires: wires.map((w) => {
      if (!ids.has(w.id)) return w;
      const n = w.points.length;
      const fixed: [boolean, boolean] = [attachedAt(staying, symbols, w.points[0], w.id), attachedAt(staying, symbols, w.points[n - 1], w.id)];
      if (!fixed[0] && !fixed[1]) return { ...w, points: w.points.map(([x, y]) => [x + dx, y + dy] as Vec) };
      const moved = new Set(w.points.map((_, i) => i).filter((i) => !(i === 0 && fixed[0]) && !(i === n - 1 && fixed[1])));
      return { ...w, points: moveWirePoints(w.points, moved, [dx, dy], fixed) };
    }),
    ports,
    blocks,
  };
}

/** Whether a point is connected to something in `doc` other than `wireId`: a pin, a block pin, a label or flag, or another wire. */
export function attachedAt(doc: Pick<Doc, 'components' | 'wires' | 'ports' | 'blocks'>, symbols: SymbolResolver, p: Vec, wireId?: string): boolean {
  if (doc.ports.some((q) => samePoint([q.x, q.y], p))) return true;
  if ((doc.blocks ?? []).some((b) => blockPins(b).some((pin) => samePoint(pin.at, p)))) return true;
  if (doc.wires.some((w) => w.id !== wireId && w.points.some((q, i) => (i === 0 ? samePoint(p, q) : onSegment(p, w.points[i - 1], q))))) return true;
  return doc.components.some((c) => worldPins(c, symbols(c.symbolKey)).some((pin) => samePoint(pin.at, p)));
}

/**
 * Moves some vertices of an orthogonal wire by `delta` and keeps every segment horizontal or
 * vertical: the far end of a segment with one moved vertex follows across the segment. An end
 * marked `fixed` (connected to something) stays where it is and the wire turns towards it.
 */
export function moveWirePoints(points: Vec[], moved: ReadonlySet<number>, delta: Vec, fixed: [boolean, boolean] = [false, false]): Vec[] {
  const n = points.length;
  const last = n - 1;
  const isFixed = (i: number) => (i === 0 && fixed[0]) || (i === last && fixed[1]);
  const pts = points.map((p, i) => (moved.has(i) ? ([p[0] + delta[0], p[1] + delta[1]] as Vec) : ([...p] as Vec)));
  for (let a = 0; a < last; a++) {
    if (moved.has(a) === moved.has(a + 1)) continue;
    const j = moved.has(a) ? a + 1 : a;
    const horizontal = points[a][1] === points[a + 1][1] && points[a][0] !== points[a + 1][0];
    const vertical = points[a][0] === points[a + 1][0] && points[a][1] !== points[a + 1][1];
    if (horizontal) pts[j] = [pts[j][0], pts[j][1] + delta[1]];
    else if (vertical) pts[j] = [pts[j][0] + delta[0], pts[j][1]];
  }
  // A fixed end that had to move becomes a corner, with the end itself left in place.
  const head = isFixed(0) && !samePoint(pts[0], points[0]) ? [points[0]] : [];
  const tail = isFixed(last) && !samePoint(pts[last], points[last]) ? [points[last]] : [];
  return simplify([...head, ...pts, ...tail]);
}

/** Part of a wire being dragged: a segment (moves sideways) or a vertex (a corner or an end). */
export type WireGrab = { segment: number } | { vertex: number };

/**
 * Drags part of a wire by `delta`. A segment moves across itself and its neighbours stretch; a
 * corner moves freely; an end moves and leaves whatever it was on. Ends that stay on a pin,
 * label or other wire keep their place with a jog, and labels and other wires' ends on the moved
 * stretch follow it.
 */
export function dragWire(doc: Doc, wireId: string, grab: WireGrab, delta: Vec, symbols: SymbolResolver): Doc {
  const wire = doc.wires.find((w) => w.id === wireId);
  if (!wire || (delta[0] === 0 && delta[1] === 0)) return doc;
  const pts = wire.points;
  const last = pts.length - 1;
  let moved: Set<number>;
  let d = delta;
  if ('segment' in grab) {
    const [a, b] = [pts[grab.segment], pts[grab.segment + 1]];
    d = a[1] === b[1] ? [0, delta[1]] : a[0] === b[0] ? [delta[0], 0] : delta;
    moved = new Set([grab.segment, grab.segment + 1]);
  } else moved = new Set([grab.vertex]);
  if (d[0] === 0 && d[1] === 0) return doc;
  // A dragged end leaves what it was on; any other end stays put when it is connected.
  const endFixed = (i: number) => !('vertex' in grab && grab.vertex === i) && attachedAt(doc, symbols, pts[i], wireId);
  const fixed: [boolean, boolean] = [endFixed(0), endFixed(last)];
  const next = moveWirePoints(pts, moved, d, fixed);

  const stays = (p: Vec) => (fixed[0] && samePoint(p, pts[0])) || (fixed[1] && samePoint(p, pts[last]));
  const follow = (p: Vec): Vec | null => {
    if (stays(p)) return null;
    for (const i of moved) if (samePoint(p, pts[i])) return [p[0] + d[0], p[1] + d[1]];
    for (let a = 0; a < last; a++) {
      if ((!moved.has(a) && !moved.has(a + 1)) || !onSegment(p, pts[a], pts[a + 1])) continue;
      return pts[a][1] === pts[a + 1][1] ? [p[0], p[1] + d[1]] : [p[0] + d[0], p[1]];
    }
    return null;
  };
  return {
    ...doc,
    wires: doc.wires.map((w) => {
      if (w.id === wireId) return { ...w, points: next };
      let out = w;
      for (const end of [0, w.points.length - 1]) {
        const to = follow(w.points[end]);
        if (to) out = dragWireEnd(out, end === 0 ? 0 : out.points.length - 1, to);
      }
      return out;
    }),
    ports: doc.ports.map((p) => {
      const to = follow([p.x, p.y]);
      return to ? { ...p, x: to[0], y: to[1] } : p;
    }),
  };
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distribute-x' | 'distribute-y';

/**
 * Lines up the selected parts and labels by their outlines (left/center/right, top/middle/
 * bottom) or spaces them evenly between the outermost two. Moves are whole multiples of the
 * 10-unit grid so pins stay on it, which can leave alignment a few units off; wires follow.
 */
export function alignItems(doc: Doc, ids: ReadonlySet<string>, mode: AlignMode, symbols: SymbolResolver): Doc {
  const items = [
    ...doc.components.filter(isSelected(ids)).map((c) => ({ id: c.id, box: componentBox(c, symbols(c.symbolKey)) })),
    ...doc.ports.filter(isSelected(ids)).map((p) => ({ id: p.id, box: portBox(p) })),
  ];
  if (items.length < (mode.startsWith('distribute') ? 3 : 2)) return doc;
  const horizontal = mode === 'left' || mode === 'center' || mode === 'right' || mode === 'distribute-x';
  const lo = (b: Box) => (horizontal ? b.x1 : b.y1);
  const hi = (b: Box) => (horizontal ? b.x2 : b.y2);
  const mid = (b: Box) => (lo(b) + hi(b)) / 2;
  const shifts = new Map<string, number>();
  if (mode === 'distribute-x' || mode === 'distribute-y') {
    const sorted = [...items].sort((a, b) => mid(a.box) - mid(b.box));
    const first = mid(sorted[0].box);
    const step = (mid(sorted[sorted.length - 1].box) - first) / (sorted.length - 1);
    sorted.forEach((it, i) => shifts.set(it.id, first + step * i - mid(it.box)));
  } else {
    const edge = mode === 'left' || mode === 'top' ? Math.min(...items.map((i) => lo(i.box))) : mode === 'right' || mode === 'bottom' ? Math.max(...items.map((i) => hi(i.box))) : null;
    const center = (Math.min(...items.map((i) => lo(i.box))) + Math.max(...items.map((i) => hi(i.box)))) / 2;
    for (const it of items) {
      const target = mode === 'left' || mode === 'top' ? edge! - lo(it.box) : mode === 'right' || mode === 'bottom' ? edge! - hi(it.box) : center - mid(it.box);
      shifts.set(it.id, target);
    }
  }
  let out = doc;
  for (const [id, shift] of shifts) {
    const d = snap(shift, 10);
    if (d) out = moveItems(out, new Set([id]), horizontal ? d : 0, horizontal ? 0 : d, symbols);
  }
  return out;
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
    blocks: (doc.blocks ?? []).filter(keep),
  };
  const removed = doc.components.filter(isSelected(ids));
  const removedBlocks = (doc.blocks ?? []).filter(isSelected(ids));
  if (!symbols || removed.length + removedBlocks.length === 0) return out;
  const orphans = orphanedWiring(
    out,
    [...removed.flatMap((c) => worldPins(c, symbols(c.symbolKey)).map((p) => p.at)), ...removedBlocks.flatMap((b) => blockPins(b).map((p) => p.at))],
    [...out.components.flatMap((c) => worldPins(c, symbols(c.symbolKey)).map((p) => p.at)), ...(out.blocks ?? []).flatMap((b) => blockPins(b).map((p) => p.at))],
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

/**
 * Brings every block's pins in step with its child sheet's hierarchical ports, without moving a
 * pin onto another pin's wiring: pins keep their places (a renamed port keeps its slot, new ones
 * go at the end), a removed port's slot stays empty while wiring still ends there, and pins that
 * move up into a freed slot take their wires along.
 */
export function syncBlocks<T extends Pick<Project, 'wires' | 'ports' | 'sheets' | 'blocks'>>(doc: T): T {
  if (!doc.blocks?.length) return doc;
  const moves: { sheet: string; from: Vec; to: Vec }[] = [];
  let changed = false;
  const blocks = doc.blocks.map((b) => {
    const names = hierNames(doc, b.child);
    const sheet = sheetOf(b, doc);
    const wired = (at: Vec) =>
      doc.wires.some((w) => sheetOf(w, doc) === sheet && (samePoint(w.points[0], at) || samePoint(w.points[w.points.length - 1], at))) ||
      doc.ports.some((p) => sheetOf(p, doc) === sheet && samePoint([p.x, p.y], at));
    const removed = b.pins.filter((p) => p && !names.includes(p));
    const added = names.filter((n) => !b.pins.includes(n));
    const pins =
      removed.length === 1 && added.length === 1
        ? b.pins.map((p) => (p === removed[0] ? added[0] : p))
        : [...b.pins.flatMap((p, i) => (names.includes(p) ? [p] : wired(blockSlot(b, i)) ? [''] : [])), ...added];
    while (pins.length && !pins[pins.length - 1]) pins.pop();
    if (pins.length === b.pins.length && pins.every((p, i) => p === b.pins[i])) return b;
    changed = true;
    const next = { ...b, pins };
    const after = new Map(blockPins(next).map((p) => [p.name, p.at]));
    for (const p of blockPins(b)) {
      const to = after.get(p.name);
      if (to && !samePoint(to, p.at)) moves.push({ sheet, from: p.at, to });
    }
    return next;
  });
  if (!changed) return doc;
  return followPins({ ...doc, blocks }, moves);
}

/** A connection point that moved, on one sheet. */
export interface PinMove {
  sheet: string;
  from: Vec;
  to: Vec;
}

/**
 * Keeps wiring on connection points that moved without the wires being dragged (a block's pins
 * re-ordering, a symbol redrawn): wire ends at `from` go to `to` with a jog, and labels or markers
 * sitting on the point go with it.
 */
export function followPins<T extends Pick<Project, 'wires' | 'ports' | 'sheets'>>(doc: T, moves: PinMove[]): T {
  const real = moves.filter((m) => !samePoint(m.from, m.to));
  if (!real.length) return doc;
  const sheet = (item: { sheet?: string }) => sheetOf(item, doc);
  const moveAt = (item: { sheet?: string }, at: Vec) => real.find((m) => m.sheet === sheet(item) && samePoint(m.from, at));
  const portsAt = (s: string, at: Vec) => doc.ports.filter((p) => sheet(p) === s && samePoint([p.x, p.y], at));
  const touchesOther = (w: Wire, at: Vec) =>
    doc.wires.some((o) => o !== w && sheet(o) === sheet(w) && o.points.some((q, i) => (i ? onSegment(at, o.points[i - 1], q) : samePoint(at, q))));
  // Labels carried along at the far end of a stub that moves as a whole.
  const carried = new Map<string, Vec>();
  const wires = doc.wires.map((w) => {
    if (w.points.length < 2) return w;
    const last = w.points.length - 1;
    const [ma, mb] = [moveAt(w, w.points[0]), moveAt(w, w.points[last])];
    // A stub from the pin to a label and nothing else: the label goes with the pin, no jog.
    const m = ma && !mb ? ma : mb && !ma ? mb : null;
    const far = ma && !mb ? w.points[last] : w.points[0];
    const tags = m ? portsAt(sheet(w), far).filter((p) => p.kind !== 'noconnect') : [];
    if (m && tags.length && !touchesOther(w, far)) {
      const d: Vec = [m.to[0] - m.from[0], m.to[1] - m.from[1]];
      for (const p of tags) carried.set(p.id, d);
      return { ...w, points: w.points.map(([x, y]) => [x + d[0], y + d[1]] as Vec) };
    }
    let out = w;
    if (ma) out = dragWireEnd(out, 0, ma.to);
    if (mb) out = dragWireEnd(out, out.points.length - 1, mb.to);
    return out;
  });
  const ports = doc.ports.map((p) => {
    const m = moveAt(p, [p.x, p.y]);
    if (m) return { ...p, x: m.to[0], y: m.to[1] };
    const d = carried.get(p.id);
    return d ? { ...p, x: p.x + d[0], y: p.y + d[1] } : p;
  });
  return { ...doc, wires, ports };
}

/** Where pins with the same number go when placed parts take another symbol (or a redrawn one). */
export function symbolPinMoves(doc: Pick<Project, 'components' | 'sheets'>, ids: ReadonlySet<string>, before: SymbolResolver, after: SymbolResolver, newKey?: string): PinMove[] {
  const moves: PinMove[] = [];
  for (const c of doc.components) {
    if (!ids.has(c.id)) continue;
    const next = newKey ? { ...c, symbolKey: newKey, unit: 0 } : c;
    const to = new Map(worldPins(next, after(next.symbolKey)).map((p) => [p.pin.number, p.at]));
    for (const p of worldPins(c, before(c.symbolKey))) {
      const at = to.get(p.pin.number);
      if (at) moves.push({ sheet: sheetOf(c, doc), from: p.at, to: at });
    }
  }
  return moves;
}
