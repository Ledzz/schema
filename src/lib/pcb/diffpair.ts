/*
 * Differential pairs and length tuning, the geometry and bookkeeping: pairs found by net name
 * (USB_DP/USB_DN, D+/D-, CLK_P/CLK_N), routed lengths per net, an impedance estimate for a
 * pair on the board's stack-up, splitting a pair's centreline into its two tracks, and the
 * meanders that add length to a straight run. Store-facing actions are in tuning.ts.
 */
import type { Vec } from '../schematic/types';
import type { DiffPair, Pcb } from './types';

/** Same letter case as `like`. */
const caseOf = (like: string, letter: string) => (like === like.toLowerCase() ? letter.toLowerCase() : letter.toUpperCase());

/**
 * Suffix rules for the halves of a pair, most specific first: the positive half's pattern, and
 * the names its negative half may have.
 */
const PAIR_RULES: { re: RegExp; partners: (base: string, sign: string) => string[] }[] = [
  { re: /^(.+)(\+)$/, partners: (b) => [`${b}-`] },
  { re: /^(.*D)(P)$/i, partners: (b, s) => [b + caseOf(s, 'N'), b + caseOf(s, 'M')] },
  { re: /^(.+[_-])(P)$/i, partners: (b, s) => [b + caseOf(s, 'N')] },
  { re: /^(.+[A-Z0-9])(P)$/, partners: (b) => [`${b}N`] },
];

/** Nets that look like the two halves of a differential pair, by name. */
export function detectPairs(nets: Iterable<string>): { name: string; positive: string; negative: string }[] {
  const all = new Set(nets);
  const out: { name: string; positive: string; negative: string }[] = [];
  for (const net of all) {
    for (const rule of PAIR_RULES) {
      const m = rule.re.exec(net);
      const negative = m && rule.partners(m[1], m[2]).find((n) => all.has(n) && n !== net);
      if (!m || !negative) continue;
      out.push({ name: m[1].replace(/[_-]$/, '') || net, positive: net, negative });
      break;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Routed track length of each net (mm), with the vias it uses. */
export function netLengths(pcb: Pick<Pcb, 'tracks' | 'vias'>, netOf: (id: string, fallback: string | null) => string | null): Map<string, { length: number; vias: number }> {
  const out = new Map<string, { length: number; vias: number }>();
  const entry = (net: string) => {
    let e = out.get(net);
    if (!e) out.set(net, (e = { length: 0, vias: 0 }));
    return e;
  };
  for (const t of pcb.tracks) {
    const net = netOf(t.id, t.net);
    if (net) entry(net).length += polylineLength(t.points);
  }
  for (const v of pcb.vias) {
    const net = netOf(v.id, v.net);
    if (net) entry(net).vias++;
  }
  return out;
}

export const polylineLength = (points: Vec[]) => points.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);

/**
 * Lengths of a pair's two nets for matching: over the tracks routed as the pair when both nets
 * have some, so branches such as USB-C's D+/D- bridges don't count; otherwise over whole nets.
 */
export function pairLengths(
  pair: Pick<DiffPair, 'id' | 'positive' | 'negative'>,
  pcb: Pick<Pcb, 'tracks' | 'vias'>,
  netOf: (id: string, fallback: string | null) => string | null,
): { positive: number; negative: number; coupled: boolean } {
  const tagged = (net: string) => pcb.tracks.filter((t) => t.pair === pair.id && netOf(t.id, t.net) === net).reduce((s, t) => s + polylineLength(t.points), 0);
  const [p, n] = [tagged(pair.positive), tagged(pair.negative)];
  if (p > 0 && n > 0) return { positive: p, negative: n, coupled: true };
  const all = netLengths(pcb, netOf);
  return { positive: all.get(pair.positive)?.length ?? 0, negative: all.get(pair.negative)?.length ?? 0, coupled: false };
}

/**
 * Dielectric between an outer layer and the next copper on JLCPCB's standard 1.6 mm stack-ups:
 * the whole core on a 2-layer board, the 7628 prepreg on a 4-layer one (JLC04161H-7628).
 */
export function outerDielectric(layers: 2 | 4 = 2): { height: number; er: number } {
  return layers === 4 ? { height: 0.2104, er: 4.4 } : { height: 1.53, er: 4.5 };
}

/**
 * Differential impedance (Ω) of an edge-coupled microstrip pair: IPC-2141 single-ended impedance
 * with its coupling factor. Good to some 10 % for the usual geometries; a field solver or
 * JLCPCB's impedance calculator is the reference.
 */
export function diffImpedance(width: number, gap: number, height: number, er: number, thickness = 0.035): number {
  const z0 = (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * height) / (0.8 * width + thickness));
  return 2 * z0 * (1 - 0.48 * Math.exp((-0.96 * gap) / height));
}

/** The track width giving `target` Ω differential at a gap (bisection), or null when none would. */
export function widthForImpedance(target: number, gap: number, height: number, er: number): number | null {
  let lo = 0.05;
  let hi = 5;
  if (diffImpedance(hi, gap, height, er) > target || diffImpedance(lo, gap, height, er) < target) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (diffImpedance(mid, gap, height, er) > target) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k];
const unit = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const r3 = (v: Vec): Vec => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000];

/**
 * Drops points where a path doubles back or makes a tiny step (a grid router leaving an off-grid
 * point does both), so the path can be offset cleanly.
 */
export function dropSpikes(points: Vec[], min = 0.05): Vec[] {
  let pts = points;
  for (let changed = true; changed && pts.length > 2; ) {
    changed = false;
    for (let i = 1; i < pts.length - 1; i++) {
      const [p, q, r] = [pts[i - 1], pts[i], pts[i + 1]];
      const u = sub(q, p);
      const v = sub(r, q);
      if (u[0] * v[0] + u[1] * v[1] < 0 || Math.hypot(u[0], u[1]) < min || Math.hypot(v[0], v[1]) < min) {
        pts = [...pts.slice(0, i), ...pts.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * Cuts corners sharper than 45° (a 90° turn, say) into two 45° turns, so the two tracks of a pair
 * keep their spacing round the corner. `cut` is how far each new corner moves from the old one.
 */
export function chamferCorners(points: Vec[], cut: number): Vec[] {
  if (points.length < 3) return points;
  const out: Vec[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [p, q, r] = [points[i - 1], points[i], points[i + 1]];
    const u = unit(sub(q, p));
    const v = unit(sub(r, q));
    const cos = u[0] * v[0] + u[1] * v[1];
    // Turns up to 45° stay; sharper ones get a chamfer no longer than a third of either leg.
    if (cos > Math.cos(Math.PI / 4) + 1e-6) {
      out.push(q);
      continue;
    }
    const c = Math.min(cut, Math.hypot(q[0] - p[0], q[1] - p[1]) / 3, Math.hypot(r[0] - q[0], r[1] - q[1]) / 3);
    out.push(r3(add(q, u, -c)), r3(add(q, v, c)));
  }
  out.push(points[points.length - 1]);
  return out;
}

/** A polyline moved sideways by `d` (positive: left of its direction, y down), with mitred corners. */
export function offsetPolyline(points: Vec[], d: number): Vec[] {
  const normals = points.slice(1).map((p, i) => {
    const u = unit(sub(p, points[i]));
    return [u[1], -u[0]] as Vec;
  });
  return points.map((p, i) => {
    if (i === 0) return r3(add(p, normals[0], d));
    if (i === points.length - 1) return r3(add(p, normals[normals.length - 1], d));
    const [a, b] = [normals[i - 1], normals[i]];
    const m = unit(add(a, b));
    const k = d / Math.max(0.2, m[0] * a[0] + m[1] * a[1]);
    return r3(add(p, m, k));
  });
}

/**
 * Meanders replacing the straight run a→b: `bumps` U-shaped bends of `amplitude` to one side,
 * `spacing` apart (centre to centre), starting `start` along the run, with 45° corners.
 */
export function meanderPath(a: Vec, b: Vec, bumps: number, amplitude: number, spacing: number, side: 1 | -1, start: number): Vec[] {
  const u = unit(sub(b, a));
  const n: Vec = [u[1] * side, -u[0] * side];
  const c = Math.min(spacing, amplitude) * 0.3;
  const at = (along: number, up: number) => r3(add(add(a, u, along), n, up));
  const out: Vec[] = [a];
  for (let i = 0; i < bumps; i++) {
    const x = start + i * 2 * spacing;
    out.push(at(x - c, 0), at(x, c), at(x, amplitude - c), at(x + c, amplitude), at(x + spacing - c, amplitude), at(x + spacing, amplitude - c), at(x + spacing, c), at(x + spacing + c, 0));
  }
  out.push(b);
  return out;
}

/** Length a run of meanders adds over the straight line. */
export function meanderGain(bumps: number, amplitude: number, spacing: number): number {
  const c = Math.min(spacing, amplitude) * 0.3;
  // Each U has two legs of `amplitude`; its four 45° corners each cut (2 - √2) c.
  return bumps * (2 * amplitude - 4 * (2 - Math.SQRT2) * c);
}

/** The amplitude that adds `gain` with `bumps` meanders (meanderGain is increasing in amplitude). */
export function amplitudeFor(gain: number, bumps: number, spacing: number): number {
  let lo = 0;
  let hi = gain;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (meanderGain(bumps, mid, spacing) < gain) lo = mid;
    else hi = mid;
  }
  return hi;
}
