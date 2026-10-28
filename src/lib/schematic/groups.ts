/*
 * Groups: named frames around the functional parts of a schematic (power, MCU, sensors…).
 * A group is a region on one sheet; what is inside it is its contents, found by geometry
 * whenever it matters (moving the frame, listing its parts), so nothing has to be kept in
 * step. The frame is grabbed by its name tab or its border, so clicking inside it still
 * selects what is there.
 */
import type { Box } from '../easyeda/symbol';
import { boxContains, componentBox, snap, unionBoxes } from './geometry';
import type { SymbolResolver } from './symbols';
import type { Component, GroupColor, NetPort, SchematicGroup, Vec, Wire } from './types';

export const GROUP_COLORS: Record<GroupColor, string> = {
  indigo: '#6366f1',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  sky: '#0ea5e9',
  violet: '#8b5cf6',
  slate: '#64748b',
};
export const GROUP_COLOR_NAMES = Object.keys(GROUP_COLORS) as GroupColor[];

/** Room left around the contents when a frame is drawn around them. */
export const GROUP_PAD = 20;
/** The name tab sits on top of the frame. */
export const GROUP_TAB_HEIGHT = 9;
const MIN_SIZE = 40;

export const groupColor = (g: Pick<SchematicGroup, 'color'>): string => GROUP_COLORS[g.color ?? 'indigo'];

/** The next colour of the palette after the ones in use, so neighbouring groups look different. */
export function nextGroupColor(groups: SchematicGroup[]): GroupColor {
  const counts = new Map(GROUP_COLOR_NAMES.map((c) => [c, 0]));
  for (const g of groups) counts.set(g.color ?? 'indigo', (counts.get(g.color ?? 'indigo') ?? 0) + 1);
  return GROUP_COLOR_NAMES.reduce((best, c) => (counts.get(c)! < counts.get(best)! ? c : best), GROUP_COLOR_NAMES[0]);
}

export const groupBox = (g: SchematicGroup): Box => ({ x1: g.x, y1: g.y, x2: g.x + g.width, y2: g.y + g.height });

/** The name tab above the frame's top-left corner. */
export function groupTab(g: SchematicGroup): Box {
  const width = Math.min(g.width, Math.max(g.name.length * 4.4 + 8, 24));
  return { x1: g.x, y1: g.y - GROUP_TAB_HEIGHT, x2: g.x + width, y2: g.y };
}

/** The group under a point: its tab or its border (not the room inside), topmost first. */
export function hitGroup(groups: SchematicGroup[], p: Vec, tol: number): string | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (boxContains(groupTab(g), p, tol / 2)) return g.id;
    const b = groupBox(g);
    if (boxContains(b, p, tol) && !boxContains(b, p, -tol)) return g.id;
  }
  return null;
}

/** The corner of a group's frame within `tol` of a point: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left. */
export function groupCornerAt(g: SchematicGroup, p: Vec, tol: number): number | null {
  const b = groupBox(g);
  const corners: Vec[] = [
    [b.x1, b.y1],
    [b.x2, b.y1],
    [b.x2, b.y2],
    [b.x1, b.y2],
  ];
  const i = corners.findIndex((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) <= tol);
  return i >= 0 ? i : null;
}

/** The frame with one corner dragged to `to`, never smaller than a part. */
export function resizeGroup(g: SchematicGroup, corner: number, to: Vec): SchematicGroup {
  const b = groupBox(g);
  const [x, y] = [snap(to[0], 10), snap(to[1], 10)];
  const right = corner === 1 || corner === 2;
  const bottom = corner === 2 || corner === 3;
  const x1 = right ? b.x1 : Math.min(x, b.x2 - MIN_SIZE);
  const x2 = right ? Math.max(x, b.x1 + MIN_SIZE) : b.x2;
  const y1 = bottom ? b.y1 : Math.min(y, b.y2 - MIN_SIZE);
  const y2 = bottom ? Math.max(y, b.y1 + MIN_SIZE) : b.y2;
  return { ...g, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

type Contents = { components: Component[]; wires: Wire[]; ports: NetPort[] };

/** What is inside a group: parts by the centre of their outline, labels by their anchor, wires wholly inside. */
export function groupMembers(doc: Contents, g: SchematicGroup, symbols: SymbolResolver): string[] {
  const b = groupBox(g);
  const inside = (p: Vec) => boxContains(b, p, 0.5);
  const ids: string[] = [];
  for (const c of doc.components) {
    const cb = componentBox(c, symbols(c.symbolKey));
    if (inside([(cb.x1 + cb.x2) / 2, (cb.y1 + cb.y2) / 2])) ids.push(c.id);
  }
  for (const w of doc.wires) if (w.points.every(inside)) ids.push(w.id);
  for (const p of doc.ports) if (inside([p.x, p.y])) ids.push(p.id);
  return ids;
}

/** The ids plus the contents of every group among them, so a frame takes its parts along. */
export function withGroupContents(doc: Contents & { groups?: SchematicGroup[] }, ids: ReadonlySet<string>, symbols: SymbolResolver): Set<string> {
  const all = new Set(ids);
  for (const g of doc.groups ?? []) if (ids.has(g.id)) for (const id of groupMembers(doc, g, symbols)) all.add(id);
  return all;
}

/** The group a part belongs to, by its outline's centre (the smallest one when frames nest). */
export function groupOf(groups: SchematicGroup[], box: Box): SchematicGroup | undefined {
  const c: Vec = [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
  return groups.filter((g) => boxContains(groupBox(g), c, 0.5)).sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

/** A frame around some outlines, padded and on the grid; null when there is nothing to frame. */
export function frameAround(boxes: Box[], pad = GROUP_PAD): Pick<SchematicGroup, 'x' | 'y' | 'width' | 'height'> | null {
  const b = unionBoxes(boxes);
  if (!b) return null;
  const x = snap(b.x1 - pad, 10) - (snap(b.x1 - pad, 10) > b.x1 - pad ? 10 : 0);
  const y = snap(b.y1 - pad, 10) - (snap(b.y1 - pad, 10) > b.y1 - pad ? 10 : 0);
  const x2 = snap(b.x2 + pad, 10) + (snap(b.x2 + pad, 10) < b.x2 + pad ? 10 : 0);
  const y2 = snap(b.y2 + pad, 10) + (snap(b.y2 + pad, 10) < b.y2 + pad ? 10 : 0);
  return { x, y, width: Math.max(MIN_SIZE, x2 - x), height: Math.max(MIN_SIZE, y2 - y) };
}

/** Moves a frame; its contents are moved by whoever moves the frame. */
export const shiftGroup = (g: SchematicGroup, dx: number, dy: number): SchematicGroup => ({ ...g, x: g.x + dx, y: g.y + dy });
