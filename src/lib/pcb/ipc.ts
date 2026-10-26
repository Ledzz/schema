/*
 * Footprints generated from package dimensions, for parts whose footprint is missing from the
 * JLCPCB library or wrong. Surface-mount land patterns follow IPC-7351B at nominal density
 * (level B): pad length and spacing come from the lead span, terminal length and lead width with
 * their tolerances, plus solder fillets at the toe, heel and side. Through-hole headers and DIPs
 * use common pad and drill sizes. Millimetres, y down, origin at the body centre, pin 1 at the top
 * left and pins numbered counter-clockwise as seen from the top.
 */
import type { Vec } from '../schematic/types';
import type { FootprintGeom, Graphic, PadGeom } from './footprint';

/** A dimension with its tolerance range, from a datasheet's min and max. */
export interface Dim {
  min: number;
  max: number;
}

export type PackageFamily = 'chip' | 'dual' | 'quad' | 'dual-nolead' | 'quad-nolead' | 'sot23' | 'sot223' | 'header' | 'dip';

export interface PackageSpec {
  family: PackageFamily;
  /** Pin count (without an exposed pad); per row for headers. */
  pins: number;
  pitch: number;
  /** Body size across the pin rows (x) and along them (y). */
  bodyWidth: number;
  bodyLength: number;
  /** Toe-to-toe span across the rows (gull-wing and chips); defaults from the body for no-lead parts. */
  span?: Dim;
  /** Length of a lead's foot (terminal length). */
  leadLength: Dim;
  leadWidth: Dim;
  /** Exposed pad under the body (no-lead packages), numbered after the pins. */
  ep?: { width: number; length: number };
  /** Through-hole: rows (headers), drill and pad diameter. */
  rows?: 1 | 2;
  drill?: number;
  pad?: number;
}

const F = 0.05; // fabrication tolerance
const P = 0.025; // placement tolerance
/** Narrowest copper gap left between neighbouring pads. */
const MIN_GAP = 0.2;
const SILK = 0.15;

const rms = (...v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
/** Positions to 1 µm, rounding halves away from 0 so footprints stay symmetric. */
const r3 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 1000)) / 1000 || 0;
const to05 = (v: number) => Math.round(v * 20) / 20;
const nom = (d: Dim) => (d.min + d.max) / 2;
export const dim = (min: number, max = min): Dim => ({ min: Math.min(min, max), max: Math.max(min, max) });

interface Fillets {
  toe: number;
  heel: number;
  side: number;
}

const GULL_WING = (pitch: number): Fillets => ({ toe: 0.35, heel: 0.35, side: pitch > 0.625 ? 0.03 : 0.01 });
const NO_LEAD: Fillets = { toe: 0.3, heel: 0, side: -0.04 };
const CHIP = (length: number): Fillets => (length >= 1.5 ? { toe: 0.35, heel: 0, side: 0 } : { toe: 0.2, heel: 0, side: 0 });

/** IPC-7351 pad length, width and row centre distance for a row of leads. */
export function landPattern(span: Dim, lead: Dim, width: Dim, f: Fillets, pitch?: number): { length: number; width: number; centre: number } {
  const cL = span.max - span.min;
  const cT = lead.max - lead.min;
  const cW = width.max - width.min;
  const cS = rms(cL, cT, cT);
  const sMax = nom(span) - 2 * nom(lead) + cS / 2;
  const z = to05(span.min + 2 * f.toe + rms(cL, F, P));
  const g = Math.max(to05(sMax - 2 * f.heel - rms(cS, F, P)), MIN_GAP);
  let x = to05(width.min + 2 * f.side + rms(cW, F, P));
  if (pitch) x = Math.min(x, r2(pitch - MIN_GAP));
  return { length: r3((z - g) / 2), width: x, centre: r3((z + g) / 4) };
}

const rect = (number: string, x: number, y: number, w: number, h: number): PadGeom => ({
  number,
  x: r3(x),
  y: r3(y),
  rotation: 0,
  shape: 'rect',
  w: r3(w),
  h: r3(h),
  radius: r2(Math.min(w, h) * 0.25),
  points: [],
  layer: 'top',
  hole: null,
});

const tht = (number: string, x: number, y: number, size: number, drill: number, square: boolean): PadGeom => ({
  number,
  x: r3(x),
  y: r3(y),
  rotation: 0,
  shape: square ? 'rect' : 'circle',
  w: size,
  h: size,
  radius: 0,
  points: [],
  layer: 'through',
  hole: { w: drill, h: drill, rotation: 0, dx: 0, dy: 0 },
});

const line = (layer: Graphic['layer'], points: Vec[], width = SILK): Graphic => ({ layer, points: points.map(([x, y]) => [r3(x), r3(y)] as Vec), width, filled: false });
const box = (layer: Graphic['layer'], w: number, h: number, width = 0.1): Graphic =>
  line(layer, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]], width);
function dot(at: Vec, r = 0.15): Graphic {
  const points = Array.from({ length: 13 }, (_, i) => [r2(at[0] + r * Math.cos((i / 12) * 2 * Math.PI)), r2(at[1] + r * Math.sin((i / 12) * 2 * Math.PI))] as Vec);
  return { layer: 'silkTop', points, width: 0.1, filled: true };
}

/** Pad outlines, for keeping silkscreen off them. */
const padBox = (p: PadGeom) => ({ x1: p.x - p.w / 2, y1: p.y - p.h / 2, x2: p.x + p.w / 2, y2: p.y + p.h / 2 });

/** A silkscreen line from a to b (horizontal or vertical) with the parts near pads left out. */
function silkAround(pads: PadGeom[], a: Vec, b: Vec): Graphic[] {
  const horizontal = a[1] === b[1];
  const [lo, hi] = horizontal ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const clear = MIN_GAP + SILK / 2;
  // Stretches of the line that pass too close to a pad.
  const blocked = pads
    .map(padBox)
    .filter((q) => (horizontal ? a[1] > q.y1 - clear && a[1] < q.y2 + clear : a[0] > q.x1 - clear && a[0] < q.x2 + clear))
    .map((q) => (horizontal ? [q.x1 - clear, q.x2 + clear] : [q.y1 - clear, q.y2 + clear]))
    .sort((p, q) => p[0] - q[0]);
  const out: Graphic[] = [];
  let from = lo;
  for (const [s, e] of blocked) {
    if (s > from + 0.2) out.push(line('silkTop', horizontal ? [[from, a[1]], [Math.min(s, hi), a[1]]] : [[a[0], from], [a[0], Math.min(s, hi)]]));
    from = Math.max(from, e);
    if (from >= hi) break;
  }
  if (hi > from + 0.2) out.push(line('silkTop', horizontal ? [[from, a[1]], [hi, a[1]]] : [[a[0], from], [a[0], hi]]));
  return out;
}

function geom(pads: PadGeom[], graphics: Graphic[]): FootprintGeom {
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const grow = (x: number, y: number) => {
    b.x1 = Math.min(b.x1, x);
    b.y1 = Math.min(b.y1, y);
    b.x2 = Math.max(b.x2, x);
    b.y2 = Math.max(b.y2, y);
  };
  for (const p of pads) {
    const q = padBox(p);
    grow(q.x1, q.y1);
    grow(q.x2, q.y2);
  }
  for (const g of graphics) if (g.layer === 'outline') for (const [x, y] of g.points) grow(x, y);
  return { pads, graphics, bbox: Number.isFinite(b.x1) ? b : { x1: -1, y1: -1, x2: 1, y2: 1 } };
}

/** An exposed pad no larger than leaves MIN_GAP to the inner ends of the pads around it. */
function exposedPad(number: number, ep: { width: number; length: number }, innerX: number, innerY = Infinity): PadGeom {
  const w = Math.min(ep.width, 2 * (innerX - MIN_GAP));
  const l = Math.min(ep.length, 2 * (innerY - MIN_GAP));
  return rect(String(number), 0, 0, Math.floor(w * 100) / 100, Math.floor(l * 100) / 100);
}

/** Positions of `n` pins at `pitch`, centred on 0. */
const row = (n: number, pitch: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);

/** Silk for a body with pads on its left and right: top and bottom edges, longer at pin 1. */
function dualSilk(pads: PadGeom[], bodyW: number, bodyL: number, outerX: number): Graphic[] {
  const y = bodyL / 2 + SILK;
  return [...silkAround(pads, [-outerX, -y], [bodyW / 2, -y]), ...silkAround(pads, [-bodyW / 2, y], [bodyW / 2, y])];
}

/** Silk corners for a body with pads on all four sides. */
function quadSilk(pads: PadGeom[], bodyW: number, bodyL: number): Graphic[] {
  const [x, y] = [bodyW / 2 + SILK, bodyL / 2 + SILK];
  return [
    ...silkAround(pads, [-x, -y], [x, -y]),
    ...silkAround(pads, [-x, y], [x, y]),
    ...silkAround(pads, [-x, -y], [-x, y]),
    ...silkAround(pads, [x, -y], [x, y]),
  ];
}

function pinOneDot(pads: PadGeom[], first: PadGeom): Graphic {
  // Outside pad 1, beyond its outer end, nudged away from other pads.
  const q = padBox(first);
  const at: Vec = [q.x1 - 0.45, q.y1 - 0.1];
  const near = pads.some((p) => p !== first && Math.hypot(p.x - at[0], p.y - at[1]) < Math.hypot(p.w, p.h) / 2 + 0.35);
  return dot(near ? [q.x1 - 0.45, q.y1 - 0.5] : at);
}

/** Generates a footprint for a package. */
export function generateFootprint(spec: PackageSpec): FootprintGeom {
  const { family, pins, pitch } = spec;
  if (!(pins > 0) || !Number.isInteger(pins)) throw new Error('The pin count must be a whole number above 0');
  if (!(pitch > 0) && family !== 'chip' && family !== 'sot223') throw new Error('The pitch must be above 0');
  switch (family) {
    case 'chip': {
      const span = spec.span ?? dim(spec.bodyLength - 0.1, spec.bodyLength + 0.1);
      const lp = landPattern(span, spec.leadLength, spec.leadWidth, CHIP(nom(span)));
      const pads = [rect('1', -lp.centre, 0, lp.length, lp.width), rect('2', lp.centre, 0, lp.length, lp.width)];
      const inner = lp.centre - lp.length / 2 - MIN_GAP - SILK / 2;
      const y = Math.max(spec.bodyWidth / 2, lp.width / 2) + SILK;
      const silk = inner > 0.1 ? [line('silkTop', [[-inner, -y], [inner, -y]]), line('silkTop', [[-inner, y], [inner, y]])] : [];
      return geom(pads, [box('outline', spec.bodyLength, spec.bodyWidth), ...silk]);
    }
    case 'dual':
    case 'dual-nolead': {
      if (pins % 2) throw new Error('A dual-row package needs an even pin count');
      const nolead = family === 'dual-nolead';
      const span = spec.span ?? dim(spec.bodyWidth - 0.1, spec.bodyWidth + 0.1);
      const lp = landPattern(span, spec.leadLength, spec.leadWidth, nolead ? NO_LEAD : GULL_WING(pitch), pitch);
      const ys = row(pins / 2, pitch);
      const pads = [
        ...ys.map((y, i) => rect(String(i + 1), -lp.centre, y, lp.length, lp.width)),
        ...ys.map((y, i) => rect(String(pins - i), lp.centre, y, lp.length, lp.width)),
      ];
      if (spec.ep) pads.push(exposedPad(pins + 1, spec.ep, lp.centre - lp.length / 2));
      const silk = nolead ? quadSilk(pads, spec.bodyWidth, spec.bodyLength) : dualSilk(pads, spec.bodyWidth, spec.bodyLength, lp.centre + lp.length / 2);
      return geom(pads, [box('outline', spec.bodyWidth, spec.bodyLength), ...silk, pinOneDot(pads, pads[0])]);
    }
    case 'quad':
    case 'quad-nolead': {
      if (pins % 4) throw new Error('A quad package needs a pin count divisible by 4');
      const nolead = family === 'quad-nolead';
      const f = nolead ? NO_LEAD : GULL_WING(pitch);
      const k = pins / 4;
      const spanX = spec.span ?? dim(spec.bodyWidth - 0.1, spec.bodyWidth + 0.1);
      const spanY = spec.span ? dim(spec.span.min + spec.bodyLength - spec.bodyWidth, spec.span.max + spec.bodyLength - spec.bodyWidth) : dim(spec.bodyLength - 0.1, spec.bodyLength + 0.1);
      const lx = landPattern(spanX, spec.leadLength, spec.leadWidth, f, pitch);
      const ly = landPattern(spanY, spec.leadLength, spec.leadWidth, f, pitch);
      const along = row(k, pitch);
      const pads = [
        // Left side top to bottom, bottom side left to right, right side bottom to top, top side right to left.
        ...along.map((y, i) => rect(String(i + 1), -lx.centre, y, lx.length, lx.width)),
        ...along.map((x, i) => rect(String(k + i + 1), x, ly.centre, ly.width, ly.length)),
        ...along.map((y, i) => rect(String(2 * k + i + 1), lx.centre, -y, lx.length, lx.width)),
        ...along.map((x, i) => rect(String(3 * k + i + 1), -x, -ly.centre, ly.width, ly.length)),
      ];
      if (spec.ep) pads.push(exposedPad(pins + 1, spec.ep, lx.centre - lx.length / 2, ly.centre - ly.length / 2));
      return geom(pads, [box('outline', spec.bodyWidth, spec.bodyLength), ...quadSilk(pads, spec.bodyWidth, spec.bodyLength), pinOneDot(pads, pads[0])]);
    }
    case 'sot23': {
      if (![3, 5, 6].includes(pins)) throw new Error('SOT-23 comes with 3, 5 or 6 pins');
      const span = spec.span ?? dim(2.1, 2.64);
      const lp = landPattern(span, spec.leadLength, spec.leadWidth, GULL_WING(pitch), pitch);
      // Left column top to bottom, right column bottom to top; SOT-23-3 has two pins left, one right.
      const left = pins === 3 ? [-pitch / 2, pitch / 2] : [-pitch, 0, pitch];
      const right = pins === 3 ? [0] : pins === 5 ? [pitch, -pitch] : [pitch, 0, -pitch];
      const pads = [...left.map((y, i) => rect(String(i + 1), -lp.centre, y, lp.length, lp.width)), ...right.map((y, i) => rect(String(left.length + i + 1), lp.centre, y, lp.length, lp.width))];
      return geom(pads, [box('outline', spec.bodyWidth, spec.bodyLength), ...dualSilk(pads, spec.bodyWidth, spec.bodyLength, lp.centre + lp.length / 2), pinOneDot(pads, pads[0])]);
    }
    case 'sot223': {
      const span = spec.span ?? dim(6.7, 7.3);
      const lp = landPattern(span, spec.leadLength, spec.leadWidth, GULL_WING(2.3), 2.3);
      const tab = landPattern(span, spec.leadLength, dim(2.9, 3.15), GULL_WING(2.3));
      const pads = [...[-2.3, 0, 2.3].map((y, i) => rect(String(i + 1), -lp.centre, y, lp.length, lp.width)), rect('4', tab.centre, 0, tab.length, tab.width)];
      return geom(pads, [box('outline', spec.bodyWidth, spec.bodyLength), ...dualSilk(pads, spec.bodyWidth, spec.bodyLength, lp.centre + lp.length / 2), pinOneDot(pads, pads[0])]);
    }
    case 'header': {
      const rows = spec.rows ?? 1;
      const drill = spec.drill ?? 1.0;
      const size = spec.pad ?? 1.7;
      const ys = row(pins, pitch);
      const xs = rows === 2 ? [-pitch / 2, pitch / 2] : [0];
      // Two-row headers count across the rows: 1 2 / 3 4 / …
      const pads = ys.flatMap((y, i) => xs.map((x, j) => tht(String(i * rows + j + 1), x, y, size, drill, i === 0 && j === 0)));
      const w = rows * pitch;
      const h = pins * pitch;
      return geom(pads, [box('outline', w, h), box('silkTop', w + 0.24, h + 0.24, SILK)]);
    }
    case 'dip': {
      if (pins % 2) throw new Error('A DIP needs an even pin count');
      const spacing = spec.bodyWidth;
      const drill = spec.drill ?? 0.8;
      const size = spec.pad ?? 1.6;
      const ys = row(pins / 2, pitch);
      const pads = [...ys.map((y, i) => tht(String(i + 1), -spacing / 2, y, size, drill, i === 0)), ...ys.map((y, i) => tht(String(pins - i), spacing / 2, y, size, drill, false))];
      const bodyW = spacing - size - 0.4;
      const h = spec.bodyLength;
      const notch = Math.min(1, bodyW / 3);
      const silk = line('silkTop', [[-notch, -h / 2], [-bodyW / 2, -h / 2], [-bodyW / 2, h / 2], [bodyW / 2, h / 2], [bodyW / 2, -h / 2], [notch, -h / 2]]);
      return geom(pads, [box('outline', spacing, h), silk]);
    }
  }
}

const SOIC_LENGTH: Record<number, number> = { 8: 4.9, 14: 8.65, 16: 9.9 };
const SOIC_WIDE_LENGTH: Record<number, number> = { 16: 10.3, 18: 11.55, 20: 12.8, 24: 15.4, 28: 17.9 };
const TSSOP_LENGTH: Record<number, number> = { 8: 3.0, 14: 5.0, 16: 5.0, 20: 6.5, 24: 7.8, 28: 9.7 };
const SSOP_LENGTH: Record<number, number> = { 16: 6.2, 20: 7.2, 24: 8.2, 28: 10.2 };
/** QFP body (square) and pitch by pin count, as most often made. */
const QFP: Record<number, [number, number]> = { 32: [7, 0.8], 44: [10, 0.8], 48: [7, 0.5], 64: [10, 0.5], 80: [12, 0.5], 100: [14, 0.5], 144: [20, 0.5] };
/** QFN body (square), pitch and exposed pad by pin count. */
const QFN: Record<number, [number, number, number]> = { 12: [3, 0.5, 1.65], 16: [3, 0.5, 1.7], 20: [4, 0.5, 2.6], 24: [4, 0.5, 2.6], 28: [5, 0.5, 3.25], 32: [5, 0.5, 3.45], 40: [6, 0.5, 4.5], 48: [7, 0.5, 5.6], 56: [8, 0.5, 6.2], 64: [9, 0.5, 7.15] };
const CHIPS: Record<string, [number, number, Dim]> = {
  '0201': [0.6, 0.3, dim(0.1, 0.2)],
  '0402': [1.0, 0.5, dim(0.15, 0.35)],
  '0603': [1.6, 0.8, dim(0.15, 0.45)],
  '0805': [2.0, 1.25, dim(0.2, 0.6)],
  '1206': [3.2, 1.6, dim(0.25, 0.75)],
  '1210': [3.2, 2.5, dim(0.25, 0.75)],
  '1812': [4.5, 3.2, dim(0.25, 0.75)],
  '2010': [5.0, 2.5, dim(0.35, 0.85)],
  '2512': [6.35, 3.2, dim(0.35, 0.85)],
};

/** Package names the generator knows, with examples of the forms they take. */
export const PACKAGE_EXAMPLES = [
  '0603',
  'SOT-23',
  'SOT-23-5',
  'SOT-23-6',
  'SOT-223',
  'SOIC-8',
  'SOIC-16W',
  'MSOP-8',
  'MSOP-10',
  'TSSOP-20',
  'SSOP-28',
  'LQFP-48',
  'LQFP-64-10x10-0.5',
  'QFN-32',
  'QFN-24-4x4-0.5-EP2.6',
  'DFN-8-3x3-0.65-EP1.6x2.4',
  'HDR-1x04',
  'HDR-2x05-2.54',
  'DIP-8',
] as const;

/**
 * The spec for a package name such as "SOIC-8", "TSSOP-20", "LQFP-48", "QFN-32-5x5-0.5-EP3.45",
 * "SOT-23-5", "HDR-2x05" or "0603". Sizes in the name override the usual ones for that pin count.
 */
export function packageSpec(name: string): PackageSpec {
  const n = name.trim().toUpperCase().replace(/\s+/g, '');
  const chip = CHIPS[n];
  if (chip) return { family: 'chip', pins: 2, pitch: 0, bodyLength: chip[0], bodyWidth: chip[1], leadLength: chip[2], leadWidth: dim(chip[1] - 0.1, chip[1] + 0.1) };
  if (n === 'SOT-23' || n === 'SOT-23-3' || n === 'SOT23') return sot23(3);
  const sot = /^SOT-?23-([56])$/.exec(n);
  if (sot) return sot23(Number(sot[1]));
  if (n === 'SOT-223' || n === 'SOT223') return { family: 'sot223', pins: 4, pitch: 2.3, bodyWidth: 3.5, bodyLength: 6.5, leadLength: dim(0.75, 1.1), leadWidth: dim(0.66, 0.84) };
  const soic = /^SO(?:IC)?-?(\d+)(W)?$/.exec(n);
  if (soic) {
    const pins = Number(soic[1]);
    const wide = !!soic[2];
    const length = (wide ? SOIC_WIDE_LENGTH : SOIC_LENGTH)[pins] ?? (pins / 2) * 1.27 + 0.5;
    return { family: 'dual', pins, pitch: 1.27, bodyWidth: wide ? 7.5 : 3.9, bodyLength: length, span: wide ? dim(10.0, 10.65) : dim(5.8, 6.2), leadLength: dim(0.4, 1.27), leadWidth: dim(0.31, 0.51) };
  }
  const tssop = /^(T?SSOP|MSOP)-?(\d+)$/.exec(n);
  if (tssop) {
    const pins = Number(tssop[2]);
    if (tssop[1] === 'MSOP') {
      const fine = pins > 8;
      return { family: 'dual', pins, pitch: fine ? 0.5 : 0.65, bodyWidth: 3, bodyLength: 3, span: dim(4.75, 5.05), leadLength: dim(0.4, 0.7), leadWidth: fine ? dim(0.17, 0.27) : dim(0.22, 0.38) };
    }
    if (tssop[1] === 'TSSOP') return { family: 'dual', pins, pitch: 0.65, bodyWidth: 4.4, bodyLength: TSSOP_LENGTH[pins] ?? (pins / 2) * 0.65 + 0.6, span: dim(6.2, 6.6), leadLength: dim(0.45, 0.75), leadWidth: dim(0.19, 0.3) };
    return { family: 'dual', pins, pitch: 0.65, bodyWidth: 5.3, bodyLength: SSOP_LENGTH[pins] ?? (pins / 2) * 0.65 + 1, span: dim(7.4, 8.2), leadLength: dim(0.55, 0.95), leadWidth: dim(0.22, 0.38) };
  }
  const quad = /^(LQFP|TQFP|QFP|QFN|VQFN|WQFN|DFN|SON|WSON)-?(\d+)(?:-(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?))?(?:-P?(\d+(?:\.\d+)?))?(?:-EP(\d+(?:\.\d+)?)(?:X(\d+(?:\.\d+)?))?)?$/.exec(n);
  if (quad) {
    const [, kind, count, bw, bl, pitchText, epw, epl] = quad;
    const pins = Number(count);
    const nolead = !/QFP/.test(kind);
    const dual = /DFN|SON/.test(kind);
    if (!nolead) {
      const [body, pitch] = QFP[pins] ?? [Math.ceil((pins / 4) * 0.5 + 1), 0.5];
      const w = bw ? Number(bw) : body;
      const l = bl ? Number(bl) : w;
      const p = pitchText ? Number(pitchText) : pitch;
      return { family: 'quad', pins, pitch: p, bodyWidth: w, bodyLength: l, span: dim(w + 1.8, w + 2.2), leadLength: dim(0.45, 0.75), leadWidth: p >= 0.8 ? dim(0.3, 0.45) : dim(0.17, 0.27) };
    }
    const [body, pitch, ep] = dual ? [3, 0.65, 1.6] : (QFN[pins] ?? [Math.max(2, Math.ceil((pins / 4) * 0.5 + 1)), 0.5, 0]);
    const w = bw ? Number(bw) : body;
    const l = bl ? Number(bl) : w;
    const p = pitchText ? Number(pitchText) : pitch;
    const epW = epw ? Number(epw) : ep;
    const epL = epl ? Number(epl) : epw ? epW : dual ? 2.4 : ep;
    const lead = p >= 0.65 ? dim(0.25, 0.35) : p >= 0.5 ? dim(0.18, 0.3) : dim(0.15, 0.25);
    return {
      family: dual ? 'dual-nolead' : 'quad-nolead',
      pins,
      pitch: p,
      bodyWidth: w,
      bodyLength: l,
      leadLength: dim(0.3, 0.5),
      leadWidth: lead,
      ep: epW > 0 ? { width: epW, length: epL } : undefined,
    };
  }
  const header = /^(?:HDR|HEADER|PINHEADER)-?([12])X(\d+)(?:-(\d+(?:\.\d+)?))?$/.exec(n);
  if (header) {
    const pitch = header[3] ? Number(header[3]) : 2.54;
    const small = pitch < 2;
    return { family: 'header', pins: Number(header[2]), pitch, rows: Number(header[1]) as 1 | 2, bodyWidth: Number(header[1]) * pitch, bodyLength: Number(header[2]) * pitch, leadLength: dim(0), leadWidth: dim(0), drill: small ? 0.65 : 1.0, pad: small ? 1.0 : 1.7 };
  }
  const dip = /^DIP-?(\d+)(W)?$/.exec(n);
  if (dip) {
    const pins = Number(dip[1]);
    return { family: 'dip', pins, pitch: 2.54, bodyWidth: dip[2] ? 15.24 : 7.62, bodyLength: (pins / 2) * 2.54 + 0.5, leadLength: dim(0), leadWidth: dim(0), drill: 0.8, pad: 1.6 };
  }
  throw new Error(`Unknown package "${name}". Known forms: ${PACKAGE_EXAMPLES.join(', ')}`);
}

function sot23(pins: number): PackageSpec {
  return { family: 'sot23', pins, pitch: 0.95, bodyWidth: 1.6, bodyLength: 2.9, span: pins === 3 ? dim(2.1, 2.64) : dim(2.6, 3.0), leadLength: dim(0.3, 0.6), leadWidth: dim(0.3, 0.5) };
}

/** Pad numbers of a footprint, in natural order (2 before 10). */
export const padNumbers = (fp: Pick<FootprintGeom, 'pads'>) => [...new Set(fp.pads.map((p) => p.number))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
