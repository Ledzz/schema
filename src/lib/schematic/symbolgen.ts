/*
 * Symbols made in the app: a rectangular IC symbol generated from a pin list, and the helpers the
 * symbol editor uses to keep a symbol's bounds and pins consistent after edits.
 */
import { unitBox, type SymbolDef, type SymbolPin, type SymbolShape, type SymbolUnit } from '../easyeda/symbol';
import type { Vec } from './types';

export type PinSide = 'left' | 'right' | 'top' | 'bottom';

export interface PinSpec {
  number: string;
  name?: string;
  /** Where the pin goes; pins without a side are split between left and right in order. */
  side?: PinSide;
  /** Electrical type, e.g. "Power", "Input", "Output", "Bidirectional", "Passive". */
  type?: string;
}

export const PIN_LENGTH = 10;
const PITCH = 10;
/** Width of a pin-name character at the canvas's 5.5-unit pin font, with a little slack. */
const CHAR = 3.4;

/** Unit vector from a pin's free end into the body, by side. */
export const SIDE_DIR: Record<PinSide, Vec> = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] };

/** The side a pin sticks out of, from its direction. */
export function sideOf(pin: Pick<SymbolPin, 'dir'>): PinSide {
  const [dx, dy] = pin.dir;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'left' : 'right';
  return dy > 0 ? 'top' : 'bottom';
}

const ceilTo = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step;

/**
 * A rectangular symbol with the pins on its sides, top to bottom and left to right in the order
 * given. Pin ends are on the 10-unit grid; the body is sized so the pin names fit inside.
 */
export function icSymbol(title: string, prefix: string, specs: PinSpec[]): SymbolDef {
  if (!specs.length) throw new Error('A symbol needs at least one pin');
  const numbers = new Set<string>();
  for (const s of specs) {
    const n = String(s.number).trim();
    if (!n) throw new Error('Every pin needs a number');
    if (numbers.has(n)) throw new Error(`Pin number ${n} is used twice`);
    numbers.add(n);
  }
  // Pins without a side: the first half on the left, the rest on the right.
  const loose = specs.filter((s) => !s.side);
  const half = Math.ceil(loose.length / 2);
  const sideOfSpec = (s: PinSpec): PinSide => s.side ?? (loose.indexOf(s) < half ? 'left' : 'right');
  const sides: Record<PinSide, PinSpec[]> = { left: [], right: [], top: [], bottom: [] };
  for (const s of specs) sides[sideOfSpec(s)].push(s);

  const nameLen = (list: PinSpec[]) => Math.max(0, ...list.map((s) => (s.name && s.name !== s.number ? s.name.length : 0)));
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  const cols = Math.max(sides.top.length, sides.bottom.length);
  // Names of top and bottom pins run into the body: keep bands for them clear of the side pins.
  const band = (list: PinSpec[]) => (list.length ? ceilTo(nameLen(list) * CHAR + 2, PITCH) : 0);
  const [topBand, bottomBand] = [band(sides.top), band(sides.bottom)];
  // Room for names facing each other across the body, and for the pins along each edge.
  const width = Math.max(40, ceilTo((nameLen(sides.left) + nameLen(sides.right)) * CHAR + 10, 20), ceilTo((cols + 1) * PITCH, 20));
  const height = ceilTo(topBand + (rows + 1) * PITCH + bottomBand, 20);
  const [x1, y1] = [-width / 2, -height / 2];

  let id = 0;
  const pin = (s: PinSpec, side: PinSide, at: Vec): SymbolPin => {
    const dir = SIDE_DIR[side];
    return {
      id: `p${++id}`,
      number: String(s.number).trim(),
      name: s.name?.trim() || String(s.number).trim(),
      x: at[0] - dir[0] * PIN_LENGTH,
      y: at[1] - dir[1] * PIN_LENGTH,
      length: PIN_LENGTH,
      dir,
      electrical: s.type ?? '',
      showName: !!s.name?.trim() && s.name.trim() !== String(s.number).trim(),
      showNumber: true,
    };
  };
  // Edge positions: centred along each side, on the grid.
  const along = (count: number, from: number, size: number) => {
    const start = from + ceilTo((size - (count - 1) * PITCH) / 2, PITCH);
    return Array.from({ length: count }, (_, i) => start + i * PITCH);
  };
  const pins: SymbolPin[] = [
    ...along(sides.left.length, y1 + topBand, height - topBand - bottomBand).map((y, i) => pin(sides.left[i], 'left', [x1, y])),
    ...along(sides.right.length, y1 + topBand, height - topBand - bottomBand).map((y, i) => pin(sides.right[i], 'right', [x1 + width, y])),
    ...along(sides.top.length, x1, width).map((x, i) => pin(sides.top[i], 'top', [x, y1])),
    ...along(sides.bottom.length, x1, width).map((x, i) => pin(sides.bottom[i], 'bottom', [x, y1 + height])),
  ];
  const unit: SymbolUnit = { name: title, shapes: [{ kind: 'rect', x: x1, y: y1, w: width, h: height, r: 0 }], pins, bbox: { x1: 0, y1: 0, x2: 0, y2: 0 } };
  unit.bbox = unitBox(unit);
  return { title, prefix: prefix || 'U', units: [unit], attrs: {} };
}

/** A copy of a symbol with fresh bounds, after its shapes or pins were edited. */
export function withBounds(def: SymbolDef): SymbolDef {
  return { ...def, units: def.units.map((u) => ({ ...u, bbox: unitBox(u) })) };
}

/** Pin numbers that appear more than once in a unit, and pins without a number. */
export function pinProblems(def: SymbolDef): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const u of def.units) for (const p of u.pins) seen.set(p.number, (seen.get(p.number) ?? 0) + 1);
  for (const [n, count] of seen) {
    if (!n) out.push('A pin has no number');
    else if (count > 1) out.push(`Pin number ${n} is used ${count} times`);
  }
  return out;
}

/** Parses "1 VCC left" style lines (number, name, optional side) into pin specs. */
export function parsePinList(text: string): PinSpec[] {
  const out: PinSpec[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\t,;]+|\s+/).filter(Boolean);
    const last = parts[parts.length - 1]?.toLowerCase();
    const side = (['left', 'right', 'top', 'bottom'] as const).find((s) => s === last);
    const fields = side ? parts.slice(0, -1) : parts;
    out.push({ number: fields[0], name: fields.slice(1).join(' ') || undefined, side });
  }
  return out;
}

/** A pin (by id) or a body shape (by index) of a symbol unit, as the symbol editor selects them. */
export type SymbolItem = { kind: 'pin'; id: string } | { kind: 'shape'; index: number };

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Absolute coordinates in an SVG path as written by the symbol parser (M, L, C and A commands). */
function pathPoints(d: string): Vec[] {
  const out: Vec[] = [];
  for (const [, cmd, args] of d.matchAll(/([MLCA])([^MLCA]*)/g)) {
    const n = args.trim().split(/[\s,]+/).map(Number);
    if (cmd === 'A') for (let i = 0; i + 6 < n.length; i += 7) out.push([n[i + 5], n[i + 6]]);
    else for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  }
  return out;
}

function movePath(d: string, [dx, dy]: Vec): string {
  return d.replace(/([MLCA])([^MLCA]*)/g, (_, cmd: string, args: string) => {
    const n = args.trim().split(/[\s,]+/).map(Number);
    const moved = n.map((v, i) => (cmd === 'A' ? (i % 7 === 5 ? v + dx : i % 7 === 6 ? v + dy : v) : i % 2 ? v + dy : v + dx));
    return cmd + moved.join(' ');
  });
}

/** The pin or shape at a point, pins first and later shapes over earlier ones. */
export function symbolItemAt(unit: SymbolUnit, p: Vec, tol: number): SymbolItem | null {
  for (const pin of unit.pins) {
    if (segmentDistance(p, [pin.x, pin.y], [pin.x + pin.dir[0] * pin.length, pin.y + pin.dir[1] * pin.length]) <= tol) return { kind: 'pin', id: pin.id };
  }
  for (let i = unit.shapes.length - 1; i >= 0; i--) {
    const s = unit.shapes[i];
    let hit = false;
    if (s.kind === 'rect') hit = p[0] >= s.x - tol && p[0] <= s.x + s.w + tol && p[1] >= s.y - tol && p[1] <= s.y + s.h + tol;
    else if (s.kind === 'ellipse') hit = Math.hypot((p[0] - s.cx) / (s.rx + tol), (p[1] - s.cy) / (s.ry + tol)) <= 1;
    else if (s.kind === 'poly') {
      const pts: Vec[] = [];
      for (let k = 0; k + 1 < s.points.length; k += 2) pts.push([s.points[k], s.points[k + 1]]);
      if (s.closed) pts.push(pts[0]);
      hit = pts.slice(1).some((q, k) => segmentDistance(p, pts[k], q) <= tol);
    } else if (s.kind === 'text') hit = p[0] >= s.x - tol && p[0] <= s.x + s.text.length * s.size * 0.6 + tol && p[1] >= s.y - s.size - tol && p[1] <= s.y + tol;
    else hit = pathPoints(s.d).some((q, k, all) => (k ? segmentDistance(p, all[k - 1], q) : Math.hypot(p[0] - q[0], p[1] - q[1])) <= tol * 1.5);
    if (hit) return { kind: 'shape', index: i };
  }
  return null;
}

/** Moves a pin or shape by `d`. */
export function moveSymbolItem(unit: SymbolUnit, item: SymbolItem, d: Vec): SymbolUnit {
  if (item.kind === 'pin') return { ...unit, pins: unit.pins.map((p) => (p.id === item.id ? { ...p, x: p.x + d[0], y: p.y + d[1] } : p)) };
  const shapes = unit.shapes.map((s, i): SymbolShape => {
    if (i !== item.index) return s;
    switch (s.kind) {
      case 'rect':
        return { ...s, x: s.x + d[0], y: s.y + d[1] };
      case 'ellipse':
        return { ...s, cx: s.cx + d[0], cy: s.cy + d[1] };
      case 'poly':
        return { ...s, points: s.points.map((v, k) => v + d[k % 2]) };
      case 'text':
        return { ...s, x: s.x + d[0], y: s.y + d[1] };
      case 'path':
        return { ...s, d: movePath(s.d, d) };
    }
  });
  return { ...unit, shapes };
}

/** Removes a pin or shape. */
export function removeSymbolItem(unit: SymbolUnit, item: SymbolItem): SymbolUnit {
  return item.kind === 'pin' ? { ...unit, pins: unit.pins.filter((p) => p.id !== item.id) } : { ...unit, shapes: unit.shapes.filter((_, i) => i !== item.index) };
}

/** A new pin with its end at `at`, pointing into the body from the nearest side. */
export function newPin(unit: SymbolUnit, at: Vec): SymbolPin {
  const body = unit.shapes.find((s) => s.kind === 'rect');
  const b = body && body.kind === 'rect' ? { x1: body.x, y1: body.y, x2: body.x + body.w, y2: body.y + body.h } : unit.bbox;
  const gaps: [PinSide, number][] = [
    ['left', b.x1 - at[0]],
    ['right', at[0] - b.x2],
    ['top', b.y1 - at[1]],
    ['bottom', at[1] - b.y2],
  ];
  // Outside the body: the side it is beyond; inside: the nearest edge.
  const outside = gaps.filter(([, g]) => g > 0).sort((p, q) => q[1] - p[1])[0];
  const side = outside ? outside[0] : gaps.sort((p, q) => q[1] - p[1])[0][0];
  const numbers = unit.pins.map((p) => Number(p.number)).filter(Number.isFinite);
  const number = String(numbers.length ? Math.max(...numbers) + 1 : unit.pins.length + 1);
  let n = unit.pins.length + 1;
  while (unit.pins.some((p) => p.id === `p${n}`)) n++;
  return { id: `p${n}`, number, name: number, x: at[0], y: at[1], length: PIN_LENGTH, dir: SIDE_DIR[side], electrical: '', showName: false, showNumber: true };
}
