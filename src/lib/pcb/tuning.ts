/*
 * Differential pairs and length tuning on the board: defining pairs, routing a pair's two nets
 * side by side (as one wide route split into two tracks), and adding meanders until a net
 * reaches a target length. Every result is checked against other nets' copper, the board edge
 * and keepouts before it is kept; pure geometry lives in diffpair.ts.
 */
import { useEditor } from '../../store/editor';
import { newId } from '../schematic/ops';
import type { Project, Vec } from '../schematic/types';
import { boardModel, boardNets, currentPcb, routingLayers } from './actions';
import type { Airwire, BoardModel, PcbConnectivity } from './board';
import { amplitudeFor, chamferCorners, detectPairs, dropSpikes, meanderGain, meanderPath, netLengths, offsetPolyline, pairLengths, polylineLength } from './diffpair';
import { shellAreas } from './drc';
import { boxesOverlap, segSegDist, shapeBox, shapeDistance, type CopperItem } from './geometry';
import { boardEdges, insideBoard, keepoutAreas, shapeEdgeDistance } from './outline';
import { edgeField, routeConnection, simplifyPath } from './router';
import type { CopperLayer, DiffPair, Pcb, Track } from './types';

const st = () => useEditor.getState();

/** Copper may not come closer than this to a board edge (as DRC checks). */
const EDGE = 0.2;

/** The board's differential pairs. */
export const diffPairs = (pcb: Pick<Pcb, 'diffPairs'> = currentPcb()): DiffPair[] => pcb.diffPairs ?? [];

/** A pair by name, id or either of its nets. */
export function findPair(ref: string, pcb: Pick<Pcb, 'diffPairs'> = currentPcb()): DiffPair {
  const r = ref.trim().toLowerCase();
  const pair = diffPairs(pcb).find((p) => p.id === ref || [p.name, p.positive, p.negative].some((n) => n.toLowerCase() === r));
  if (!pair) {
    const names = diffPairs(pcb).map((p) => p.name);
    throw new Error(`No differential pair "${ref}". ${names.length ? `Pairs: ${names.join(', ')}` : 'Add one with pcb_add_diff_pair.'}`);
  }
  return pair;
}

function commitPairs(fn: (pairs: DiffPair[]) => DiffPair[]) {
  st().commit((doc) => {
    const pcb = currentPcb({ ...st().project, pcb: doc.pcb });
    return { ...doc, pcb: { ...pcb, diffPairs: fn(pcb.diffPairs ?? []) } };
  });
}

/** Makes two nets a differential pair (width and gap default to the board's track width and clearance). */
export function addDiffPair(positive: string, negative: string, opts: Partial<Pick<DiffPair, 'name' | 'width' | 'gap' | 'tolerance'>> = {}): DiffPair {
  const nets = boardNets();
  for (const n of [positive, negative]) if (!nets.includes(n)) throw new Error(`No net ${n} on the board. Nets: ${nets.join(', ')}`);
  if (positive === negative) throw new Error('A pair needs two different nets');
  const pcb = currentPcb();
  const taken = diffPairs(pcb).find((p) => [p.positive, p.negative].some((n) => n === positive || n === negative));
  if (taken) throw new Error(`${taken.positive}/${taken.negative} is already the pair ${taken.name}`);
  const pair: DiffPair = {
    id: newId('dp'),
    name: opts.name?.trim() || detectPairs([positive, negative])[0]?.name || `${positive}/${negative}`,
    positive,
    negative,
    width: opts.width ?? pcb.rules.trackWidth,
    gap: opts.gap ?? pcb.rules.clearance,
    tolerance: opts.tolerance ?? 0.5,
  };
  if (!(pair.width > 0) || !(pair.gap > 0)) throw new Error('Width and gap must be above 0');
  commitPairs((pairs) => [...pairs, pair]);
  return pair;
}

export function updateDiffPair(id: string, patch: Partial<Pick<DiffPair, 'name' | 'width' | 'gap' | 'tolerance'>>) {
  commitPairs((pairs) => pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

export function removeDiffPair(id: string) {
  commitPairs((pairs) => pairs.filter((p) => p.id !== id));
}

/** Pairs that the nets' names suggest, leaving out those already defined. */
export function suggestedPairs(project: Project = st().project) {
  const pcb = currentPcb(project);
  const used = new Set(diffPairs(pcb).flatMap((p) => [p.positive, p.negative]));
  return detectPairs(boardNets(project)).filter((s) => !used.has(s.positive) && !used.has(s.negative));
}

/** Routed length (mm) and via count of each net. */
export function lengthsOf(project: Project = st().project) {
  const { pcb, conn } = boardModel(project);
  return netLengths(pcb, (id, fallback) => conn.itemNet.get(id) ?? fallback);
}

/* ---------- fitting new copper ---------- */

interface Surroundings {
  pcb: Pcb;
  board: BoardModel;
  conn: PcbConnectivity;
  netOf: (it: CopperItem) => string | null;
  edges: ReturnType<typeof boardEdges>;
  keepouts: ReturnType<typeof keepoutAreas>;
}

function surroundings(project: Project): Surroundings {
  const { pcb, board, conn } = boardModel(project);
  return { pcb, board, conn, netOf: (it) => (it.type === 'pad' ? it.net : (conn.itemNet.get(it.ref) ?? it.net)), edges: boardEdges(pcb), keepouts: keepoutAreas(pcb) };
}

const label = (it: CopperItem, s: Surroundings) => {
  if (it.type === 'pad') {
    const pad = s.board.pads.find((p) => `${p.componentId}:${p.index}` === it.ref);
    return pad ? `${pad.designator}.${pad.number}` : 'a pad';
  }
  return `${s.netOf(it) ?? 'unconnected'} ${it.type}`;
};

/**
 * Why a run of track would not fit, or null when it does: other nets' copper within the
 * clearance (or, for nets listed in `gaps`, within that gap), the board edge, or a keepout.
 */
function misfit(s: Surroundings, layer: CopperLayer, points: Vec[], width: number, own: string, gaps: ReadonlyMap<string, number> = new Map()): string | null {
  const caps = points.slice(1).map((p, i) => ({ kind: 'capsule' as const, a: points[i], b: p, r: width / 2 }));
  const clearance = s.pcb.rules.clearance;
  for (const cap of caps) {
    const box = shapeBox(cap);
    for (const it of s.board.items) {
      if (!it.layers.includes(layer) || !boxesOverlap(box, it.box, clearance)) continue;
      const net = s.netOf(it);
      if (net === own) continue;
      const need = net && gaps.has(net) ? Math.min(gaps.get(net)!, clearance) : clearance;
      if (shapeDistance(cap, it.shape) < need - 1e-3) return `too close to ${label(it, s)}`;
    }
    if (!insideBoard(cap.a, s.edges) || shapeEdgeDistance(cap, s.edges) < EDGE) return 'too close to the board edge';
    for (const k of s.keepouts) {
      if (k.tracks && k.layers.includes(layer) && k.outline.length >= 3 && shapeDistance(cap, { kind: 'poly', points: k.outline }) === 0) return 'in a keepout';
    }
  }
  return null;
}

/* ---------- routing a pair ---------- */

const unit = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const mid = (a: Vec, b: Vec): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (v: Vec) => `(${v[0].toFixed(1)}, ${v[1].toFixed(1)})`;

/** Smallest edge-to-edge gap between two tracks of the same width. */
function trackGap(a: Vec[], b: Vec[], width: number): number {
  let best = Infinity;
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) best = Math.min(best, segSegDist(a[i - 1], a[i], b[j - 1], b[j]));
  return best - width;
}

/**
 * The way out of a pair's two pads: square to the line between them, away from the part they
 * belong to (or towards the other end when they belong to different parts).
 */
function outward(s: Surroundings, p: Vec, n: Vec, other: Vec): Vec {
  const along = unit([n[0] - p[0], n[1] - p[1]]);
  let out: Vec = [along[1], -along[0]];
  const at = mid(p, n);
  const owner = (q: Vec) => s.board.pads.find((pad) => pad.net && shapeDistance(pad.shape, { kind: 'capsule', a: q, b: q, r: 0 }) === 0)?.componentId;
  const part = owner(p) && owner(p) === owner(n) ? s.board.parts.find((x) => x.component.id === owner(p)) : undefined;
  const away: Vec = part ? [at[0] - part.placement.x, at[1] - part.placement.y] : [other[0] - at[0], other[1] - at[1]];
  if (out[0] * away[0] + out[1] * away[1] < 0) out = [-out[0], -out[1]];
  return out;
}

/** Which side of the line a→b a point is on (+1 left, -1 right, y down). */
const sideOf = (a: Vec, b: Vec, q: Vec) => Math.sign((b[0] - a[0]) * (a[1] - q[1]) - (b[1] - a[1]) * (a[0] - q[0]));

/**
 * The pads to run a pair between. A connector often has each net twice (USB-C's A6/B6 and A7/B7),
 * and the ratsnest may pick pads whose order makes the pair swap sides on the way; among the
 * net's pads close to each end, prefer ones that keep the positive net on the same side.
 */
function pairEnds(s: Surroundings, pair: DiffPair, p: Airwire, n: Airwire): { p: Airwire; n: Airwire } {
  const near = (net: string, at: Vec, layers: CopperLayer[]) => [
    { point: at, layers },
    ...s.board.pads.filter((pad) => pad.net === net && dist(pad.center, at) > 1e-6 && dist(pad.center, at) < 3).map((pad) => ({ point: pad.center, layers: pad.layers })),
  ];
  let best: { p: Airwire; n: Airwire; cost: number } | null = null;
  for (const pa of near(pair.positive, p.a, p.aLayers))
    for (const na of near(pair.negative, n.a, n.aLayers))
      for (const pb of near(pair.positive, p.b, p.bLayers))
        for (const nb of near(pair.negative, n.b, n.bLayers)) {
          const [ma, mb] = [mid(pa.point, na.point), mid(pb.point, nb.point)];
          if (sideOf(ma, mb, pa.point) !== sideOf(ma, mb, pb.point)) continue;
          // Closest together at each end, then as near the ratsnest's choice as possible.
          const cost = dist(pa.point, na.point) + dist(pb.point, nb.point) + 0.1 * (dist(pa.point, p.a) + dist(na.point, n.a) + dist(pb.point, p.b) + dist(nb.point, n.b));
          if (!best || cost < best.cost) {
            best = { p: { ...p, a: pa.point, aLayers: pa.layers, b: pb.point, bLayers: pb.layers }, n: { ...n, a: na.point, aLayers: na.layers, b: nb.point, bLayers: nb.layers }, cost };
          }
        }
  return best ?? { p, n };
}

/** Routes one connection of each net of a pair side by side; returns the two tracks, or why not. */
function routePairConnection(project: Project, pair: DiffPair, p0: Airwire, n0: Airwire): { tracks: Track[] } | { reason: string } {
  const s = surroundings(project);
  const { pcb } = s;
  const { p, n } = pairEnds(s, pair, p0, n0);
  const layer = routingLayers(pcb).find((l) => [p.aLayers, p.bLayers, n.aLayers, n.bLayers].every((ls) => ls.includes(l)));
  if (!layer) return { reason: 'its ends are on different layers (pairs are routed on one layer)' };
  // A hair over width + gap, so rounding of the corners can't bring the tracks below the gap.
  const spacing = pair.width + pair.gap + 0.002;
  const wide = 2 * pair.width + pair.gap;
  const pairNet = `pair:${pair.id}`;
  const netOf = (it: CopperItem) => {
    const net = s.netOf(it);
    return net === pair.positive || net === pair.negative ? pairNet : net;
  };
  const [ma, mb] = [mid(p.a, n.a), mid(p.b, n.b)];
  const outA = outward(s, p.a, n.a, mb);
  const outB = outward(s, p.b, n.b, ma);
  const avoid = shellAreas(s.board)
    .filter((a) => !a.nets.has(pair.positive) && !a.nets.has(pair.negative))
    .map(({ layer: l, outlines }) => ({ layer: l, outlines }));
  let reason = 'no room for both tracks';
  // Leave the pads square to their row first; without that, or further out, if it doesn't fit.
  for (const breakout of [1, 0, 2]) {
    const ea: Vec = [ma[0] + outA[0] * breakout, ma[1] + outA[1] * breakout];
    const eb: Vec = [mb[0] + outB[0] * breakout, mb[1] + outB[1] * breakout];
    // A short straight lead keeps the pair square to the pads before the router turns it.
    const lead = breakout ? 0.5 : 0;
    const la: Vec = [ea[0] + outA[0] * lead, ea[1] + outA[1] * lead];
    const lb: Vec = [eb[0] + outB[0] * lead, eb[1] + outB[1] * lead];
    const route = routeConnection({ point: la, layers: [layer] }, { point: lb, layers: [layer] }, {
      net: pairNet,
      width: wide,
      rules: pcb.rules,
      board: pcb.board,
      items: s.board.items,
      netOf,
      edges: edgeField(pcb),
      keepouts: s.keepouts,
      layers: [layer],
      avoid,
    });
    if (!route || route.tracks.length !== 1) continue;
    const centre = chamferCorners(simplifyPath(dropSpikes(simplifyPath([ea, ...route.tracks[0].points, eb]))), spacing);
    const left = offsetPolyline(centre, spacing / 2);
    const right = offsetPolyline(centre, -spacing / 2);
    const leftIsP = dist(left[0], p.a) < dist(left[0], n.a);
    if (leftIsP !== dist(left[left.length - 1], p.b) < dist(left[left.length - 1], n.b)) {
      return { reason: `${pair.positive} and ${pair.negative} swap sides between ${fmt(p.a)} and ${fmt(p.b)}, which needs a crossover (it is left for single routing)` };
    }
    // Each track leaves its own pad straight out (keeping the pads' pitch while beside them), then
    // joins its side of the pair.
    const out = (q: Vec, dir: Vec): Vec => [Math.round((q[0] + dir[0] * breakout) * 1000) / 1000, Math.round((q[1] + dir[1] * breakout) * 1000) / 1000];
    const pPts = simplifyPath([p.a, out(p.a, outA), ...(leftIsP ? left : right), out(p.b, outB), p.b]);
    const nPts = simplifyPath([n.a, out(n.a, outA), ...(leftIsP ? right : left), out(n.b, outB), n.b]);
    const why =
      misfit(s, layer, pPts, pair.width, pair.positive, new Map([[pair.negative, pair.gap]])) ??
      misfit(s, layer, nPts, pair.width, pair.negative, new Map([[pair.positive, pair.gap]])) ??
      (trackGap(pPts, nPts, pair.width) < pair.gap - 0.01 ? 'the tracks come closer than the gap at the ends' : null);
    if (why) {
      reason = why;
      continue;
    }
    const track = (net: string, points: Vec[]): Track => ({ id: newId('t'), layer, width: pair.width, points, net, pair: pair.id });
    return { tracks: [track(pair.positive, pPts), track(pair.negative, nPts)] };
  }
  return { reason };
}

/** Routes a pair's unrouted connections side by side on `project`; what could not be is described. */
export function routePairOn(project: Project, pair: DiffPair): { project: Project; routed: number; failed: string[] } {
  let routed = 0;
  const failed: string[] = [];
  const tried = new Set<string>();
  for (;;) {
    const { conn } = boardModel(project);
    const ps = conn.airwires.filter((a) => a.net === pair.positive && !tried.has(`${a.a}|${a.b}`));
    const ns = conn.airwires.filter((a) => a.net === pair.negative);
    if (!ps.length || !ns.length) break;
    // The negative connection whose ends lie nearest the positive one's, turned to match it.
    const p = ps[0];
    tried.add(`${p.a}|${p.b}`);
    let best: { n: Airwire; d: number } | null = null;
    for (const n of ns) {
      const straight = dist(p.a, n.a) + dist(p.b, n.b);
      const turned = dist(p.a, n.b) + dist(p.b, n.a);
      const cand = straight <= turned ? { n, d: straight } : { n: { ...n, a: n.b, b: n.a, aLayers: n.bLayers, bLayers: n.aLayers }, d: turned };
      if (!best || cand.d < best.d) best = cand;
    }
    const r = routePairConnection(project, pair, p, best!.n);
    if ('reason' in r) {
      failed.push(`${pair.name}: ${r.reason}`);
      continue;
    }
    const pcb = currentPcb(project);
    project = { ...project, pcb: { ...pcb, tracks: [...pcb.tracks, ...r.tracks] } };
    routed += 2;
  }
  return { project, routed, failed };
}

/** Routes a pair's two nets side by side at its width and gap, as one undo step. */
export function routeDiffPair(ref: string): { routed: number; failed: string[] } {
  const pair = findPair(ref);
  const r = routePairOn(st().project, pair);
  if (r.routed) st().commit((doc) => ({ ...doc, pcb: r.project.pcb }));
  return { routed: r.routed, failed: r.failed };
}

/* ---------- length tuning ---------- */

export interface TuneReport {
  net: string;
  before: number;
  after: number;
  target: number;
  /** Length still missing when the meanders found no more room. */
  short: number;
}

export interface TuneOptions {
  /** Largest sideways excursion of a meander (mm, default 1). */
  amplitude?: number;
  /** Centre-to-centre distance of a meander's legs (default three track widths). */
  spacing?: number;
  /** Close enough to the target (mm, default 0.05). */
  tolerance?: number;
  /** Only these of the net's tracks get meanders (default all). */
  only?: (t: Track) => boolean;
  /** These tracks get meanders first (the one selected in the editor, say). */
  prefer?: (t: Track) => boolean;
}

/**
 * Adds meanders to `net`'s straight runs, longest first, until its routed length reaches
 * `target`. Each run of meanders goes to whichever side has room, keeping clear of other nets
 * (a pair partner only by the pair's gap) and of the run's ends.
 */
export function tuneOn(project: Project, net: string, target: number, opts: TuneOptions = {}): { project: Project; report: TuneReport } {
  const tolerance = opts.tolerance ?? 0.05;
  const before = lengthsOf(project).get(net)?.length ?? 0;
  if (!before) throw new Error(`${net} has no routed tracks to tune`);
  const pair = diffPairs(currentPcb(project)).find((p) => p.positive === net || p.negative === net);
  const gaps = new Map(pair ? [[pair.positive === net ? pair.negative : pair.positive, pair.gap]] : []);
  const done = new Set<string>();
  let length = before;
  for (let round = 0; round < 30 && target - length > tolerance; round++) {
    const s = surroundings(project);
    const need = target - length;
    // Straight runs of the net's tracks, preferred tracks and then the longest first, not yet tried.
    const runs = s.pcb.tracks
      .filter((t) => (s.conn.itemNet.get(t.id) ?? t.net) === net && (!opts.only || opts.only(t)))
      .flatMap((t) => t.points.slice(1).map((q, i) => ({ t, i, len: dist(t.points[i], q) })))
      .filter((r) => !done.has(`${r.t.id}:${r.t.points[r.i]}:${r.t.points[r.i + 1]}`))
      .sort((a, b) => Number(!!opts.prefer?.(b.t)) - Number(!!opts.prefer?.(a.t)) || b.len - a.len);
    let applied = false;
    for (const run of runs) {
      const { t, i } = run;
      done.add(`${t.id}:${t.points[i]}:${t.points[i + 1]}`);
      const spacing = opts.spacing ?? Math.max(3 * t.width, t.width + s.pcb.rules.clearance);
      const maxAmp = opts.amplitude ?? 1;
      const margin = Math.max(spacing, 0.6);
      const room = run.len - 2 * margin;
      const most = Math.floor((room / spacing + 1) / 2);
      if (most < 1) continue;
      const [a, b] = [t.points[i], t.points[i + 1]];
      const tryPlace = (bumps: number, amp: number): Vec[] | null => {
        const start = margin + (room - (2 * bumps - 1) * spacing) / 2;
        for (const side of [1, -1] as const) {
          const pts = meanderPath(a, b, bumps, amp, spacing, side, start);
          if (!misfit(s, t.layer, pts, t.width, net, gaps)) return pts;
        }
        return null;
      };
      // The fewest meanders that add all that is missing, else as much as there is room for.
      let chosen: { pts: Vec[]; gain: number } | null = null;
      for (let bumps = 1; bumps <= most && !chosen; bumps++) {
        const amp = Math.max(t.width, amplitudeFor(need, bumps, spacing));
        if (amp > maxAmp || meanderGain(bumps, amp, spacing) > need + tolerance * 4) continue;
        const pts = tryPlace(bumps, amp);
        if (pts) chosen = { pts, gain: meanderGain(bumps, amp, spacing) };
      }
      if (!chosen) {
        for (let amp = maxAmp; amp >= t.width && !chosen; amp *= 0.7) {
          for (let bumps = most; bumps >= 1 && !chosen; bumps--) {
            if (meanderGain(bumps, amp, spacing) > need) continue;
            const pts = tryPlace(bumps, amp);
            if (pts) chosen = { pts, gain: meanderGain(bumps, amp, spacing) };
          }
        }
      }
      if (!chosen) continue;
      const tuned: Track = { ...t, points: simplifyPath([...t.points.slice(0, i), ...chosen.pts, ...t.points.slice(i + 2)]) };
      project = { ...project, pcb: { ...s.pcb, tracks: s.pcb.tracks.map((x) => (x.id === t.id ? tuned : x)) } };
      length += polylineLength(tuned.points) - polylineLength(t.points);
      applied = true;
      break;
    }
    if (!applied) break;
  }
  return { project, report: { net, before, after: length, target, short: Math.max(0, target - length) } };
}

/** Tunes a net to a length, as one undo step. */
export function tuneLength(net: string, target: number, opts: TuneOptions = {}): TuneReport {
  const r = tuneOn(st().project, net, target, opts);
  if (r.report.after !== r.report.before) st().commit((doc) => ({ ...doc, pcb: r.project.pcb }));
  return r.report;
}

/** The lengths a pair is matched by (see pairLengths). */
export function pairLengthsOf(pair: DiffPair, project: Project = st().project) {
  const { pcb, conn } = boardModel(project);
  return pairLengths(pair, pcb, (id, fallback) => conn.itemNet.get(id) ?? fallback);
}

/**
 * Brings the shorter net of a pair up to the longer one, measured over the tracks routed as the
 * pair (where the meanders go too) when there are any.
 */
export function matchPair(ref: string, opts: TuneOptions = {}): TuneReport {
  const pair = findPair(ref);
  const l = pairLengthsOf(pair);
  const shorter = l.positive < l.negative ? pair.positive : pair.negative;
  const total = lengthsOf().get(shorter)?.length ?? 0;
  // Small bumps keep the pair coupled; the gap is the natural scale.
  return tuneLength(shorter, total + Math.abs(l.positive - l.negative), {
    amplitude: Math.max(pair.gap * 2, pair.width * 2),
    tolerance: Math.min(0.05, pair.tolerance / 4),
    only: l.coupled ? (t) => t.pair === pair.id : undefined,
    ...opts,
  });
}
