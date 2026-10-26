/*
 * DXF import of a board outline, for boards that must match an enclosure drawing: lines, arcs,
 * circles, polylines (with arc bulges), splines and ellipses from the ENTITIES section are
 * chained into closed loops. The biggest loop is the outline (its arcs kept as bulges), smaller
 * circles inside it are mounting holes and other loops inside it are cutouts. Coordinates come
 * out in millimetres with y down and the outline's top-left corner at (0, 0).
 */
import type { Vec } from '../schematic/types';
import { flattenOutline, pointInPolygon } from './geometry';

export interface DxfOutline {
  outline: Vec[];
  /** Bulge of each outline edge (0 = straight), for Board.outlineBulges. */
  bulges: number[];
  cutouts: Vec[][];
  holes: { x: number; y: number; diameter: number }[];
  width: number;
  height: number;
  /** The drawing's units, as read from $INSUNITS or given. */
  units: DxfUnits;
  warnings: string[];
}

export type DxfUnits = 'mm' | 'cm' | 'm' | 'inch' | 'mil';
const SCALE: Record<DxfUnits, number> = { mm: 1, cm: 10, m: 1000, inch: 25.4, mil: 0.0254 };
/** $INSUNITS codes. */
const INSUNITS: Record<number, DxfUnits> = { 1: 'inch', 4: 'mm', 5: 'cm', 6: 'm', 8: 'mil' };
/** Circles up to this diameter (mm) become mounting holes; bigger ones are round cutouts. */
const MAX_HOLE = 8;
/** Ends this close (mm) join. */
const JOIN = 0.01;

/** A run of edges: points[i] → points[i + 1] with bulges[i]. */
interface Piece {
  points: Vec[];
  bulges: number[];
  circle?: { center: Vec; r: number };
}

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) throw new Error('Not a DXF file: expected group codes on alternate lines (binary DXF is not supported; save as ASCII DXF)');
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

/** Entities as lists of group pairs, and the header's $INSUNITS. */
function readEntities(all: Pair[]): { entities: { type: string; data: Pair[] }[]; insunits: number | null } {
  let section = '';
  let insunits: number | null = null;
  const entities: { type: string; data: Pair[] }[] = [];
  let current: { type: string; data: Pair[] } | null = null;
  for (let i = 0; i < all.length; i++) {
    const [code, value] = all[i];
    if (code === 0 && value === 'SECTION') {
      section = all[i + 1]?.[1] ?? '';
      current = null;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      section = '';
      current = null;
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS') insunits = Number(all[i + 1]?.[1]);
    if (section !== 'ENTITIES') continue;
    if (code === 0) {
      current = { type: value, data: [] };
      entities.push(current);
    } else current?.data.push([code, value]);
  }
  return { entities, insunits };
}

const num = (data: Pair[], code: number, fallback = 0) => {
  const p = data.find(([c]) => c === code);
  return p ? Number(p[1]) : fallback;
};

/** De Boor evaluation of a B-spline (weights optional) at parameter t. */
function bspline(ctrl: Vec[], weights: number[] | null, knots: number[], degree: number, t: number): Vec {
  let k = degree;
  while (k < ctrl.length - 1 && t >= knots[k + 1]) k++;
  const d = Array.from({ length: degree + 1 }, (_, j) => {
    const p = ctrl[j + k - degree];
    const w = weights?.[j + k - degree] ?? 1;
    return [p[0] * w, p[1] * w, w];
  });
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const den = knots[i + degree - r + 1] - knots[i];
      const a = den === 0 ? 0 : (t - knots[i]) / den;
      d[j] = d[j].map((v, q) => (1 - a) * d[j - 1][q] + a * v);
    }
  }
  return [d[degree][0] / d[degree][2], d[degree][1] / d[degree][2]];
}

/** Pieces in drawing units (y up), ignoring layers and blocks. */
function pieces(entities: { type: string; data: Pair[] }[], warnings: string[]): Piece[] {
  const out: Piece[] = [];
  const skipped = new Map<string, number>();
  for (let e = 0; e < entities.length; e++) {
    const { type, data } = entities[e];
    // An extrusion of (0, 0, -1) mirrors the entity's x (DXF object coordinates).
    const mirror = num(data, 230, 1) < 0 ? -1 : 1;
    const pt = (x: number, y: number): Vec => [x * mirror, y];
    if (type === 'LINE') {
      out.push({ points: [pt(num(data, 10), num(data, 20)), pt(num(data, 11), num(data, 21))], bulges: [0] });
    } else if (type === 'ARC') {
      const c = pt(num(data, 10), num(data, 20));
      const r = num(data, 40);
      let a0 = (num(data, 50) * Math.PI) / 180;
      let a1 = (num(data, 51) * Math.PI) / 180;
      if (mirror < 0) [a0, a1] = [Math.PI - a1, Math.PI - a0];
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      out.push({ points: [[c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)], [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)]], bulges: [Math.tan(sweep / 4)] });
    } else if (type === 'CIRCLE') {
      const c = pt(num(data, 10), num(data, 20));
      const r = num(data, 40);
      out.push({ points: [[c[0] + r, c[1]], [c[0] - r, c[1]], [c[0] + r, c[1]]], bulges: [1, 1], circle: { center: c, r } });
    } else if (type === 'LWPOLYLINE') {
      const points: Vec[] = [];
      const bulges: number[] = [];
      for (const [code, value] of data) {
        if (code === 10) {
          points.push([Number(value) * mirror, 0]);
          bulges.push(0);
        } else if (code === 20 && points.length) points[points.length - 1][1] = Number(value);
        else if (code === 42 && bulges.length) bulges[bulges.length - 1] = Number(value) * mirror;
      }
      if (points.length < 2) continue;
      if (num(data, 70) & 1) points.push(points[0]);
      else bulges.pop();
      out.push({ points, bulges: bulges.slice(0, points.length - 1) });
    } else if (type === 'POLYLINE') {
      const points: Vec[] = [];
      const bulges: number[] = [];
      let j = e + 1;
      for (; j < entities.length && entities[j].type === 'VERTEX'; j++) {
        points.push(pt(num(entities[j].data, 10), num(entities[j].data, 20)));
        bulges.push(num(entities[j].data, 42) * mirror);
      }
      e = j;
      if (points.length < 2) continue;
      if (num(data, 70) & 1) points.push(points[0]);
      else bulges.pop();
      out.push({ points, bulges: bulges.slice(0, points.length - 1) });
    } else if (type === 'SPLINE') {
      const degree = num(data, 71, 3);
      const knots = data.filter(([c]) => c === 40).map(([, v]) => Number(v));
      const weights = data.filter(([c]) => c === 41).map(([, v]) => Number(v));
      const ctrl: Vec[] = [];
      const fit: Vec[] = [];
      for (let i = 0; i < data.length; i++) {
        if (data[i][0] === 10) ctrl.push(pt(Number(data[i][1]), Number(data.slice(i).find(([c]) => c === 20)?.[1] ?? 0)));
        if (data[i][0] === 11) fit.push(pt(Number(data[i][1]), Number(data.slice(i).find(([c]) => c === 21)?.[1] ?? 0)));
      }
      let points: Vec[];
      if (ctrl.length > degree && knots.length === ctrl.length + degree + 1) {
        const [t0, t1] = [knots[degree], knots[ctrl.length]];
        const steps = Math.max(16, (ctrl.length - degree) * 16);
        points = Array.from({ length: steps + 1 }, (_, i) => bspline(ctrl, weights.length === ctrl.length ? weights : null, knots, degree, t0 + ((t1 - t0) * i) / steps));
      } else if (fit.length >= 2) points = fit;
      else continue;
      out.push({ points, bulges: points.slice(1).map(() => 0) });
    } else if (type === 'ELLIPSE') {
      const c = pt(num(data, 10), num(data, 20));
      const major: Vec = [num(data, 11) * mirror, num(data, 21)];
      const ratio = num(data, 40, 1);
      const p0 = num(data, 41, 0);
      let p1 = num(data, 42, 2 * Math.PI);
      while (p1 <= p0) p1 += 2 * Math.PI;
      const minor: Vec = [-major[1] * ratio, major[0] * ratio];
      const steps = Math.max(16, Math.ceil(((p1 - p0) / (2 * Math.PI)) * 96));
      const points = Array.from({ length: steps + 1 }, (_, i) => {
        const t = p0 + ((p1 - p0) * i) / steps;
        return [c[0] + major[0] * Math.cos(t) + minor[0] * Math.sin(t), c[1] + major[1] * Math.cos(t) + minor[1] * Math.sin(t)] as Vec;
      });
      out.push({ points, bulges: points.slice(1).map(() => 0) });
    } else if (!['VERTEX', 'SEQEND', 'POINT'].includes(type)) skipped.set(type, (skipped.get(type) ?? 0) + 1);
  }
  if (skipped.size) warnings.push(`Ignored ${[...skipped].map(([t, n]) => `${n} ${t}`).join(', ')}`);
  return out;
}

const reversed = (p: Piece): Piece => ({ points: [...p.points].reverse(), bulges: [...p.bulges].reverse().map((b) => -b) });
const near = (a: Vec, b: Vec, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

/** Chains pieces end to end into closed loops (open ring + bulges); counts what stays open. */
function loops(all: Piece[], tol: number): { loops: { points: Vec[]; bulges: number[]; circle?: Piece['circle'] }[]; open: number } {
  const left = [...all];
  const out: { points: Vec[]; bulges: number[]; circle?: Piece['circle'] }[] = [];
  let open = 0;
  while (left.length) {
    let chain = left.shift()!;
    for (;;) {
      if (chain.points.length > 2 && near(chain.points[0], chain.points[chain.points.length - 1], tol)) break;
      const end = chain.points[chain.points.length - 1];
      const i = left.findIndex((p) => near(p.points[0], end, tol) || near(p.points[p.points.length - 1], end, tol));
      if (i < 0) break;
      const next = near(left[i].points[0], end, tol) ? left[i] : reversed(left[i]);
      left.splice(i, 1);
      chain = { points: [...chain.points, ...next.points.slice(1)], bulges: [...chain.bulges, ...next.bulges], circle: undefined };
    }
    const closed = chain.points.length > 2 && near(chain.points[0], chain.points[chain.points.length - 1], tol);
    if (closed) out.push({ points: chain.points.slice(0, -1), bulges: chain.bulges, circle: chain.circle });
    else open++;
  }
  return { loops: out, open };
}

const areaOf = (pts: Vec[]) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2);

/** Reads a board outline from DXF text. `units` overrides the drawing's own ($INSUNITS, else mm). */
export function parseDxfOutline(text: string, units?: DxfUnits): DxfOutline {
  const warnings: string[] = [];
  const { entities, insunits } = readEntities(pairs(text));
  const unit: DxfUnits = units ?? (insunits !== null ? (INSUNITS[insunits] ?? 'mm') : 'mm');
  if (!units && insunits !== null && !INSUNITS[insunits] && insunits !== 0) warnings.push(`Unknown $INSUNITS ${insunits}: read as millimetres`);
  const scale = SCALE[unit];
  // Into millimetres with y down (which turns arcs the other way).
  const scaled = pieces(entities, warnings).map(
    (p): Piece => ({
      points: p.points.map(([x, y]) => [x * scale, -y * scale]),
      bulges: p.bulges.map((b) => -b),
      circle: p.circle && { center: [p.circle.center[0] * scale, -p.circle.center[1] * scale], r: p.circle.r * scale },
    }),
  );
  const found = loops(scaled, JOIN);
  if (found.open) warnings.push(`${found.open} open path${found.open === 1 ? '' : 's'} left out (ends that don't meet)`);
  if (!found.loops.length) throw new Error('No closed outline in the drawing: the board edge must be a closed shape of lines, arcs, polylines or splines');
  const flat = found.loops.map((l) => ({ ...l, flat: flattenOutline(l.points, l.bulges).points }));
  flat.sort((a, b) => areaOf(b.flat) - areaOf(a.flat));
  const [board, ...rest] = flat;
  const xs = board.flat.map((p) => p[0]);
  const ys = board.flat.map((p) => p[1]);
  const [ox, oy] = [Math.min(...xs), Math.min(...ys)];
  const move = (p: Vec): Vec => [Math.round((p[0] - ox) * 1e4) / 1e4, Math.round((p[1] - oy) * 1e4) / 1e4];
  const cutouts: Vec[][] = [];
  const holes: DxfOutline['holes'] = [];
  let outside = 0;
  for (const l of rest) {
    if (!pointInPolygon(l.flat[0], board.flat)) {
      outside++;
      continue;
    }
    if (l.circle && l.circle.r * 2 <= MAX_HOLE) {
      const [x, y] = move(l.circle.center);
      holes.push({ x, y, diameter: Math.round(l.circle.r * 2 * 1e4) / 1e4 });
    } else cutouts.push(l.flat.slice(0, -1).map(move));
  }
  if (outside) warnings.push(`${outside} shape${outside === 1 ? '' : 's'} outside the board left out`);
  return {
    outline: board.points.map(move),
    bulges: board.bulges.map((b) => Math.round(b * 1e9) / 1e9 || 0),
    cutouts,
    holes,
    width: Math.round((Math.max(...xs) - ox) * 1e4) / 1e4,
    height: Math.round((Math.max(...ys) - oy) * 1e4) / 1e4,
    units: unit,
    warnings,
  };
}
