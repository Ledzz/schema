import type { Box, SymbolDef, SymbolPin, SymbolUnit } from '../easyeda/symbol';
import type { Component, Rotation, Vec } from './types';

export const GRID = 10;
export const SNAP = 5;

export const snap = (v: number, step = SNAP) => Math.round(v / step) * step;
export const snapVec = ([x, y]: Vec, step = SNAP): Vec => [snap(x, step), snap(y, step)];
export const samePoint = (a: Vec, b: Vec, eps = 0.01) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
export const pointKey = ([x, y]: Vec) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;

/** Rotates a y-down vector counter-clockwise (as seen on screen). */
export function rotate([x, y]: Vec, rotation: number): Vec {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [y, -x];
    case 180:
      return [-x, -y];
    case 270:
      return [-y, x];
    default:
      return [x, y];
  }
}

type Placement = Pick<Component, 'x' | 'y' | 'rotation' | 'mirror'>;

/** Symbol-local point -> world point. */
export function toWorld(c: Placement, p: Vec): Vec {
  const [x, y] = rotate([c.mirror ? -p[0] : p[0], p[1]], c.rotation);
  return [x + c.x, y + c.y];
}

export function dirToWorld(c: Placement, d: Vec): Vec {
  return rotate([c.mirror ? -d[0] : d[0], d[1]], c.rotation);
}

export function unitOf(symbol: SymbolDef, unit: number): SymbolUnit {
  return symbol.units[Math.min(Math.max(unit, 0), symbol.units.length - 1)];
}

export interface WorldPin {
  pin: SymbolPin;
  at: Vec;
  dir: Vec;
}

export function worldPins(c: Placement & { unit: number }, symbol: SymbolDef): WorldPin[] {
  return unitOf(symbol, c.unit).pins.map((pin) => ({
    pin,
    at: toWorld(c, [pin.x, pin.y]),
    dir: dirToWorld(c, pin.dir),
  }));
}

export function transformBox(c: Placement, b: Box): Box {
  const corners = [
    toWorld(c, [b.x1, b.y1]),
    toWorld(c, [b.x2, b.y1]),
    toWorld(c, [b.x1, b.y2]),
    toWorld(c, [b.x2, b.y2]),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

export function componentBox(c: Component, symbol: SymbolDef): Box {
  return transformBox(c, unitOf(symbol, c.unit).bbox);
}

export function boxContains(b: Box, [x, y]: Vec, pad = 0): boolean {
  return x >= b.x1 - pad && x <= b.x2 + pad && y >= b.y1 - pad && y <= b.y2 + pad;
}

export function boxIntersects(a: Box, b: Box): boolean {
  return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
}

export function normBox(a: Vec, b: Vec): Box {
  return { x1: Math.min(a[0], b[0]), y1: Math.min(a[1], b[1]), x2: Math.max(a[0], b[0]), y2: Math.max(a[1], b[1]) };
}

export function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  return boxes.reduce((acc, b) => ({
    x1: Math.min(acc.x1, b.x1),
    y1: Math.min(acc.y1, b.y1),
    x2: Math.max(acc.x2, b.x2),
    y2: Math.max(acc.y2, b.y2),
  }));
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** True when p lies on segment ab (inclusive of the endpoints). */
export function onSegment(p: Vec, a: Vec, b: Vec, eps = 0.01): boolean {
  return distToSegment(p, a, b) < eps;
}

export function nextRotation(r: Rotation, step = 90): Rotation {
  return ((((r + step) % 360) + 360) % 360) as Rotation;
}
