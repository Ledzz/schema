/*
 * Footprint geometry for the PCB editor, in millimetres with y pointing down.
 *
 * EasyEDA Pro footprint records (units: mil, y-up):
 *   ["PAD", id, locked, net, layer, number, x, y, rot, hole, shape, special, holeDx, holeDy, holeRot, plated, …]
 *     layer 1 = top, 2 = bottom, 12 = through-hole; hole ["ROUND", w, h] | ["SLOT", len, width] | null
 *     shape ["RECT", w, h, radius%] | ["ELLIPSE", w, h] | ["OVAL", w, h] | ["POLYGON", [x, y, …]]
 *   ["POLY", id, locked, net, layer, width, path, …]   layer 3/4 = silkscreen, 48 = component outline
 *   ["FILL", id, locked, net, layer, width, style, [path, …], …]
 */

import type { Vec } from '../schematic/types';

export const MIL = 0.0254;

export type PadLayer = 'top' | 'bottom' | 'through';
export type GraphicLayer = 'silkTop' | 'silkBottom' | 'outline';

export interface PadGeom {
  number: string;
  x: number;
  y: number;
  rotation: number;
  shape: 'rect' | 'oval' | 'circle' | 'polygon';
  w: number;
  h: number;
  /** Corner radius in mm (rect only). */
  radius: number;
  /** Polygon outline relative to the pad centre (unrotated). */
  points: Vec[];
  layer: PadLayer;
  hole: { w: number; h: number; rotation: number; dx: number; dy: number } | null;
}

export interface Graphic {
  layer: GraphicLayer;
  /** Open or closed polyline. */
  points: Vec[];
  width: number;
  filled: boolean;
}

export interface FootprintGeom {
  pads: PadGeom[];
  graphics: Graphic[];
  /** Bounding box of pads and outline (courtyard-like). */
  bbox: { x1: number; y1: number; x2: number; y2: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** mil -> mm, rounded to 0.1 µm so round-trips through mil stay clean. */
const mm = (v: unknown): number => Math.round(num(v) * MIL * 1e4) / 1e4;
const pt = (x: unknown, y: unknown): Vec => [mm(x), -mm(y) || 0];

function circlePoints(c: Vec, r: number, segments = 24): Vec[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * 2 * Math.PI;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as Vec;
  });
}

/**
 * Points along an arc from a to b (y-down) that sweeps `deg` degrees counter-clockwise in the
 * y-up source data. Excludes a, includes b.
 */
export function arcPoints(a: Vec, b: Vec, deg: number): Vec[] {
  const theta = (deg * Math.PI) / 180;
  // Work in y-up coordinates where a positive angle is counter-clockwise.
  const [ax, ay] = [a[0], -a[1]];
  const [bx, by] = [b[0], -b[1]];
  const d = Math.hypot(bx - ax, by - ay);
  if (Math.abs(theta) < 1e-6 || d < 1e-9) return [b];
  const h = d / (2 * Math.tan(theta / 2));
  const cx = (ax + bx) / 2 + (-(by - ay) / d) * h;
  const cy = (ay + by) / 2 + ((bx - ax) / d) * h;
  const r = Math.hypot(ax - cx, ay - cy);
  const start = Math.atan2(ay - cy, ax - cx);
  const steps = Math.max(4, Math.ceil(Math.abs(deg) / 10));
  const out: Vec[] = [];
  for (let i = 1; i < steps; i++) {
    const t = start + (theta * i) / steps;
    out.push([cx + r * Math.cos(t), -(cy + r * Math.sin(t))]);
  }
  out.push(b);
  return out;
}

/** Converts an EasyEDA path to polylines (mm). */
export function pathToPolyline(path: unknown[]): { points: Vec[]; closed: boolean } | null {
  if (path[0] === 'CIRCLE') {
    return { points: circlePoints(pt(path[1], path[2]), mm(path[3])), closed: true };
  }
  if (path[0] === 'R') {
    const [x, y] = pt(path[1], path[2]);
    const w = mm(path[3]);
    const h = mm(path[4]);
    return { points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], closed: true };
  }
  if (typeof path[0] !== 'number') return null;
  const points: Vec[] = [pt(path[0], path[1])];
  let mode = 'L';
  for (let i = 2; i < path.length; ) {
    const tok = path[i];
    if (typeof tok === 'string') {
      mode = tok;
      i++;
      continue;
    }
    if (mode === 'ARC' || mode === 'CARC') {
      const end = pt(path[i + 1], path[i + 2]);
      points.push(...arcPoints(points[points.length - 1], end, num(path[i])));
      i += 3;
    } else {
      points.push(pt(path[i], path[i + 1]));
      i += 2;
    }
  }
  const first = points[0];
  const last = points[points.length - 1];
  return { points, closed: Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6 };
}

const GRAPHIC_LAYERS: Record<number, GraphicLayer> = { 3: 'silkTop', 4: 'silkBottom', 48: 'outline' };

export function parsePcbFootprint(dataStr: string): FootprintGeom {
  const pads: PadGeom[] = [];
  const graphics: Graphic[] = [];
  for (const line of dataStr.split(/\r?\n/)) {
    if (!line.startsWith('[')) continue;
    let rec: unknown[];
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(rec)) continue;
    if (rec[0] === 'PAD') {
      const layerId = num(rec[4]);
      const layer: PadLayer | null = layerId === 1 ? 'top' : layerId === 2 ? 'bottom' : layerId === 12 ? 'through' : null;
      if (!layer) continue;
      const shape = Array.isArray(rec[10]) ? (rec[10] as unknown[]) : ['RECT', 10, 10, 0];
      const kind = String(shape[0]).toUpperCase();
      const holeRec = Array.isArray(rec[9]) ? (rec[9] as unknown[]) : null;
      const holeW = holeRec ? mm(holeRec[1]) : 0;
      const [x, y] = pt(rec[6], rec[7]);
      const w = mm(shape[1]);
      const h = mm(shape[2]);
      const pad: PadGeom = {
        number: String(rec[5] ?? ''),
        x,
        y,
        rotation: num(rec[8]),
        shape: kind === 'OVAL' ? 'oval' : kind === 'ELLIPSE' ? (Math.abs(w - h) < 1e-6 ? 'circle' : 'oval') : kind === 'POLYGON' || kind === 'POLY' ? 'polygon' : 'rect',
        w,
        h,
        radius: kind === 'RECT' ? (Math.min(w, h) * num(shape[3])) / 200 : 0,
        points: [],
        layer,
        hole:
          holeW > 0
            ? { w: holeW, h: mm(holeRec![2] ?? holeRec![1]) || holeW, rotation: num(rec[14]), dx: mm(rec[12]), dy: -mm(rec[13]) || 0 }
            : null,
      };
      if (pad.shape === 'polygon') {
        const raw = Array.isArray(shape[1]) ? (shape[1] as unknown[]) : [];
        const poly = pathToPolyline(raw);
        pad.points = poly?.points ?? [];
        // A "POLY" pad path (e.g. the SOT-89 tab keyhole) is drawn in footprint coordinates,
        // already in its final orientation: make it relative to the pad and drop the rotation.
        if (kind === 'POLY') {
          pad.points = pad.points.map(([px, py]) => [px - x, py - y] as Vec);
          pad.rotation = 0;
        }
        if (pad.points.length < 3) pad.shape = 'rect';
        else {
          const xs = pad.points.map((p) => p[0]);
          const ys = pad.points.map((p) => p[1]);
          pad.w = Math.max(...xs) - Math.min(...xs);
          pad.h = Math.max(...ys) - Math.min(...ys);
        }
      }
      // Through-hole pads with a zero-size hole are SMD in disguise.
      if (pad.layer === 'through' && !pad.hole) pad.layer = 'top';
      pads.push(pad);
    } else if (rec[0] === 'POLY' || rec[0] === 'FILL') {
      const layer = GRAPHIC_LAYERS[num(rec[4])];
      if (!layer) continue;
      const filled = rec[0] === 'FILL';
      const paths = filled ? (Array.isArray(rec[7]) ? (rec[7] as unknown[][]) : []) : Array.isArray(rec[6]) ? [rec[6] as unknown[]] : [];
      for (const p of paths) {
        if (!Array.isArray(p)) continue;
        const poly = pathToPolyline(p);
        if (poly && poly.points.length >= 2) graphics.push({ layer, points: poly.points, width: Math.max(mm(rec[5]), 0.1), filled: filled && poly.closed });
      }
    }
  }
  return { pads, graphics, bbox: footprintBox(pads, graphics) };
}

function footprintBox(pads: PadGeom[], graphics: Graphic[]) {
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const grow = (x: number, y: number) => {
    b.x1 = Math.min(b.x1, x);
    b.y1 = Math.min(b.y1, y);
    b.x2 = Math.max(b.x2, x);
    b.y2 = Math.max(b.y2, y);
  };
  for (const p of pads) {
    // Polygon pads need not be centred on their anchor (the SOT-89 tab keyhole is not).
    if (p.points.length && p.rotation === 0) {
      for (const [qx, qy] of p.points) grow(p.x + qx, p.y + qy);
      continue;
    }
    const r = p.points.length ? Math.max(...p.points.map(([qx, qy]) => Math.hypot(qx, qy))) : Math.hypot(p.w, p.h) / 2;
    grow(p.x - r, p.y - r);
    grow(p.x + r, p.y + r);
  }
  for (const g of graphics) if (g.layer === 'outline') for (const q of g.points) grow(q[0], q[1]);
  if (!Number.isFinite(b.x1)) return { x1: -1, y1: -1, x2: 1, y2: 1 };
  return b;
}

/*
 * Built-in two-pad footprints for generic passives without an LCSC match (IPC-7351 nominal
 * land patterns). Pad 1 is on the left; for diodes and LEDs it is the cathode.
 */
const TWO_PAD: Record<string, { padW: number; padH: number; pitch: number; body: [number, number] }> = {
  '0201': { padW: 0.46, padH: 0.4, pitch: 0.66, body: [0.6, 0.3] },
  '0402': { padW: 0.54, padH: 0.64, pitch: 1.02, body: [1.0, 0.5] },
  '0603': { padW: 0.8, padH: 0.95, pitch: 1.65, body: [1.6, 0.8] },
  '0805': { padW: 1.03, padH: 1.4, pitch: 1.83, body: [2.0, 1.25] },
  '1206': { padW: 1.13, padH: 1.75, pitch: 2.98, body: [3.2, 1.6] },
  '1210': { padW: 1.13, padH: 2.65, pitch: 2.98, body: [3.2, 2.5] },
  'SOD-123': { padW: 0.9, padH: 1.2, pitch: 3.3, body: [2.7, 1.6] },
  'SOD-123FL': { padW: 1.0, padH: 1.0, pitch: 2.9, body: [2.7, 1.6] },
  'SOD-323': { padW: 0.6, padH: 0.45, pitch: 2.2, body: [1.7, 1.25] },
  'SOD-523': { padW: 0.6, padH: 0.7, pitch: 1.4, body: [1.2, 0.8] },
  SMA: { padW: 2.5, padH: 1.7, pitch: 4.0, body: [4.3, 2.6] },
  SMB: { padW: 2.5, padH: 2.3, pitch: 4.3, body: [4.3, 3.6] },
};

export function builtinFootprintKeys(): string[] {
  return Object.keys(TWO_PAD);
}

/** Built-in footprint as an EasyEDA Pro document, so it flows through the same parser. */
export function builtinFootprintDoc(size: string, polarized: boolean): string | null {
  const spec = TWO_PAD[size];
  if (!spec) return null;
  const m = (mm: number) => Math.round((mm / MIL) * 1000) / 1000;
  const half = spec.pitch / 2;
  const lines = [
    '["DOCTYPE","FOOTPRINT","1.8"]',
    `["PAD","p1",0,"",1,"1",${m(-half)},0,0,null,["RECT",${m(spec.padW)},${m(spec.padH)},0],[],0,0,0,1,0]`,
    `["PAD","p2",0,"",1,"2",${m(half)},0,0,null,["RECT",${m(spec.padW)},${m(spec.padH)},0],[],0,0,0,1,0]`,
  ];
  const [bodyW, bh] = spec.body;
  const cx = m(Math.max(half + spec.padW / 2, bodyW / 2) + 0.15);
  const cy = m(Math.max(spec.padH, bh) / 2 + 0.15);
  lines.push(`["POLY","o",0,"",48,2,[${-cx},${-cy},"L",${cx},${-cy},${cx},${cy},${-cx},${cy},${-cx},${-cy}],0]`);
  // Silk: lines along the body between the pads, plus a cathode bar for polarized parts.
  const sx = m(Math.max(half - spec.padW / 2 - 0.2, 0.1));
  const sy = m(bh / 2 + 0.1);
  if (sx > m(0.2)) {
    lines.push(`["POLY","s1",0,"",3,6,[${-sx},${sy},"L",${sx},${sy}],0]`, `["POLY","s2",0,"",3,6,[${-sx},${-sy},"L",${sx},${-sy}],0]`);
  }
  if (polarized) {
    const bx = m(-half - spec.padW / 2 - 0.25);
    lines.push(`["POLY","k",0,"",3,6,[${bx},${-cy},"L",${bx},${cy}],0]`);
  }
  return lines.join('\n');
}
