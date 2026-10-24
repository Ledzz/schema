/*
 * Parser for EasyEDA Pro symbol documents ("dataStr").
 *
 * A document is newline-separated JSON arrays, e.g.
 *   ["PART","LM358.1",{"BBOX":[-40,-27,40,27]}]
 *   ["RECT","e3",-40,27,40,-27,0,0,0,"st1",0]                    id, x1, y1, x2, y2, rx, ry, rot, style
 *   ["PIN","e5",1,null,-50,10,10,0,null,0,0,1]                    id, display, electric, x, y, length, rotation
 *   ["ATTR","e6","e5","NAME","VIN",false,true,-36,4,0,"st3",0]    id, parent, key, value, keyVisible, valueVisible, x, y
 * Coordinates are y-up; a pin's (x, y) is its connection point and it extends `length`
 * units in the direction of `rotation` (0 = +x) towards the body. Shapes listed after a
 * PART record belong to that unit of a multi-unit symbol.
 *
 * The parser converts everything to y-down screen coordinates.
 */

export type Vec = [number, number];

export interface SymbolPin {
  id: string;
  number: string;
  name: string;
  /** Connection point. */
  x: number;
  y: number;
  length: number;
  /** Unit vector from the connection point towards the symbol body. */
  dir: Vec;
  electrical: string;
  showName: boolean;
  showNumber: boolean;
}

export type SymbolShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'poly'; points: number[]; closed: boolean }
  | { kind: 'path'; d: string }
  | { kind: 'text'; x: number; y: number; text: string; size: number; rotation: number };

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SymbolUnit {
  name: string;
  shapes: SymbolShape[];
  pins: SymbolPin[];
  bbox: Box;
}

export interface SymbolDef {
  title: string;
  /** Designator prefix, e.g. "R" for "R?". */
  prefix: string;
  units: SymbolUnit[];
  attrs: Record<string, string>;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const visible = (v: unknown): boolean => v === true || v === 1;

function round(v: number): number {
  // `|| 0` also turns -0 into 0.
  return Math.round(v * 1000) / 1000 || 0;
}

function direction(rotation: number): Vec {
  const rad = (rotation * Math.PI) / 180;
  // y-up rotation, flipped to y-down.
  return [round(Math.cos(rad)), round(-Math.sin(rad))];
}

/** SVG path for a circular arc through three points (y-down coordinates). */
export function threePointArc(a: Vec, m: Vec, b: Vec): string {
  const [ax, ay] = a;
  const [mx, my] = m;
  const [bx, by] = b;
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  if (Math.abs(d) < 1e-9) return `M${ax} ${ay}L${bx} ${by}`;
  const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
  const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const cross = (mx - ax) * (by - ay) - (my - ay) * (bx - ax);
  const angle = (p: Vec) => Math.atan2(p[1] - uy, p[0] - ux);
  let sweepAngle = angle(b) - angle(a);
  if (cross > 0) {
    if (sweepAngle < 0) sweepAngle += 2 * Math.PI;
  } else if (sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  const large = Math.abs(sweepAngle) > Math.PI ? 1 : 0;
  const sweep = cross > 0 ? 1 : 0;
  return `M${round(ax)} ${round(ay)}A${round(r)} ${round(r)} 0 ${large} ${sweep} ${round(bx)} ${round(by)}`;
}

function emptyUnit(name: string): SymbolUnit {
  return { name, shapes: [], pins: [], bbox: { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity } };
}

function grow(box: Box, x: number, y: number) {
  box.x1 = Math.min(box.x1, x);
  box.y1 = Math.min(box.y1, y);
  box.x2 = Math.max(box.x2, x);
  box.y2 = Math.max(box.y2, y);
}

export function parseSymbol(dataStr: string, title = ''): SymbolDef {
  const units: SymbolUnit[] = [];
  const attrs: Record<string, string> = {};
  const pinsById = new Map<string, SymbolPin>();
  let unit: SymbolUnit | null = null;
  const current = () => {
    if (!unit) {
      unit = emptyUnit(title || 'A');
      units.push(unit);
    }
    return unit;
  };

  for (const line of dataStr.split(/\r?\n/)) {
    if (!line.startsWith('[')) continue;
    let rec: unknown[];
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(rec)) continue;
    const type = rec[0];
    switch (type) {
      case 'PART': {
        unit = emptyUnit(String(rec[1] ?? `${units.length + 1}`));
        units.push(unit);
        break;
      }
      case 'RECT': {
        const [x1, y1, x2, y2] = [num(rec[2]), -num(rec[3]), num(rec[4]), -num(rec[5])];
        current().shapes.push({
          kind: 'rect',
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          r: num(rec[6]),
        });
        break;
      }
      case 'ELLIPSE':
        current().shapes.push({ kind: 'ellipse', cx: num(rec[2]), cy: -num(rec[3]), rx: num(rec[4]), ry: num(rec[5], num(rec[4])) });
        break;
      case 'CIRCLE':
        current().shapes.push({ kind: 'ellipse', cx: num(rec[2]), cy: -num(rec[3]), rx: num(rec[4]), ry: num(rec[4]) });
        break;
      case 'POLY':
      case 'POLYLINE': {
        const raw = Array.isArray(rec[2]) ? (rec[2] as unknown[]) : [];
        const points: number[] = [];
        for (let i = 0; i + 1 < raw.length; i += 2) points.push(num(raw[i]), -num(raw[i + 1]));
        if (points.length >= 4) current().shapes.push({ kind: 'poly', points, closed: visible(rec[3]) });
        break;
      }
      case 'ARC': {
        const p = rec.slice(2, 8).map((v) => num(v));
        current().shapes.push({ kind: 'path', d: threePointArc([p[0], -p[1]], [p[2], -p[3]], [p[4], -p[5]]) });
        break;
      }
      case 'BEZIER': {
        const raw = Array.isArray(rec[2]) ? (rec[2] as unknown[]).map((v) => num(v)) : [];
        if (raw.length >= 8) {
          let d = `M${raw[0]} ${-raw[1]}`;
          for (let i = 2; i + 5 < raw.length; i += 6) {
            d += `C${raw[i]} ${-raw[i + 1]} ${raw[i + 2]} ${-raw[i + 3]} ${raw[i + 4]} ${-raw[i + 5]}`;
          }
          current().shapes.push({ kind: 'path', d });
        }
        break;
      }
      case 'TEXT':
        current().shapes.push({
          kind: 'text',
          x: num(rec[2]),
          y: -num(rec[3]),
          rotation: num(rec[4]),
          text: String(rec[5] ?? ''),
          size: 6,
        });
        break;
      case 'PIN': {
        const pin: SymbolPin = {
          id: String(rec[1]),
          number: '',
          name: '',
          x: num(rec[4]),
          y: -num(rec[5]),
          length: num(rec[6], 10),
          dir: direction(num(rec[7])),
          electrical: '',
          showName: true,
          showNumber: true,
        };
        pinsById.set(pin.id, pin);
        current().pins.push(pin);
        break;
      }
      case 'ATTR': {
        const parent = String(rec[2] ?? '');
        const key = String(rec[3] ?? '');
        const value = rec[4] == null ? '' : String(rec[4]);
        if (!parent) {
          attrs[key] = value;
          break;
        }
        const pin = pinsById.get(parent);
        if (!pin) break;
        if (key === 'NAME') {
          pin.name = value;
          pin.showName = visible(rec[6]);
        } else if (key === 'NUMBER') {
          pin.number = value;
          pin.showNumber = visible(rec[6]);
        } else if (key === 'Pin Type') {
          pin.electrical = value;
        }
        break;
      }
    }
  }

  if (units.length === 0) units.push(emptyUnit(title || 'A'));
  for (const u of units) {
    for (const s of u.shapes) {
      if (s.kind === 'rect') {
        grow(u.bbox, s.x, s.y);
        grow(u.bbox, s.x + s.w, s.y + s.h);
      } else if (s.kind === 'ellipse') {
        grow(u.bbox, s.cx - s.rx, s.cy - s.ry);
        grow(u.bbox, s.cx + s.rx, s.cy + s.ry);
      } else if (s.kind === 'poly') {
        for (let i = 0; i < s.points.length; i += 2) grow(u.bbox, s.points[i], s.points[i + 1]);
      } else if (s.kind === 'text') {
        grow(u.bbox, s.x, s.y);
      }
    }
    for (const p of u.pins) {
      if (!p.number) p.number = p.name || p.id;
      grow(u.bbox, p.x, p.y);
    }
    if (!Number.isFinite(u.bbox.x1)) u.bbox = { x1: -10, y1: -10, x2: 10, y2: 10 };
  }

  const designator = attrs['Designator'] ?? '';
  const prefix = designator.replace(/\?+$/, '').replace(/[^A-Za-z_]/g, '') || 'U';
  return { title: title || attrs['Symbol'] || 'Symbol', prefix, units, attrs };
}

/** Fallback symbol for parts without library data: a box with the given pin count. */
export function genericSymbol(title: string, pinCount = 2, prefix = 'U'): SymbolDef {
  const perSide = Math.ceil(pinCount / 2);
  const height = Math.max(2, perSide) * 10 + 10;
  const top = -Math.round(height / 2 / 10) * 10;
  const pins: SymbolPin[] = [];
  for (let i = 0; i < pinCount; i++) {
    const left = i < perSide;
    // Counter-clockwise numbering: down the left side, up the right side.
    const row = left ? i : pinCount - 1 - i;
    const y = top + 10 + row * 10;
    pins.push({
      id: `p${i + 1}`,
      number: String(i + 1),
      name: String(i + 1),
      x: left ? -40 : 40,
      y,
      length: 10,
      dir: left ? [1, 0] : [-1, 0],
      electrical: '',
      showName: false,
      showNumber: true,
    });
  }
  const unit: SymbolUnit = {
    name: title,
    shapes: [{ kind: 'rect', x: -30, y: top, w: 60, h: height, r: 0 }],
    pins,
    bbox: { x1: -40, y1: top, x2: 40, y2: top + height },
  };
  return { title, prefix, units: [unit], attrs: {} };
}
