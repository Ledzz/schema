/*
 * JLCPCB manufacturing checklist: the board as drawn, measured against JLCPCB's published limits
 * for standard 2-layer FR-4 boards and for PCB assembly (jlcpcb.com/capabilities/pcb-capabilities
 * and /pcb-assembly-capabilities, checked October 2026). Each item reports what the board has,
 * the limit, and whether it passes. Failures are things JLCPCB rejects or cannot build; warnings
 * cost extra, print poorly or need a different service level.
 */
import { buildBom } from '../schematic/bom';
import type { Project, Vec } from '../schematic/types';
import { EXTENDED_SETUP_FEE } from '../../shared/parts';
import { buildBoard, pcbConnectivity, type BoardModel, type PcbConnectivity } from './board';
import { runDrc, silkIssues } from './drc';
import { shapeDistance, type CopperItem, type WorldPad } from './geometry';
import { boardEdges, shapeEdgeDistance } from './outline';
import { POUR_EDGE_CLEARANCE } from './pour';
import { designatorLabel, textStroke, strokeFor } from './silk';
import { copperLayers, emptyPcb, isInner, LAYER_NAMES, type Pcb } from './types';

/** JLCPCB limits used by the checklist (mm). */
export const JLC = {
  boardMin: 3,
  boardMax: [670, 600] as const,
  trace: 0.1,
  /** JLCPCB asks to stay well above the 0.1 mm minimum where possible. */
  traceComfort: 0.127,
  spacing: 0.1,
  viaDrill: 0.15,
  viaDiameter: 0.25,
  /** Via diameter at least this much larger than its hole (0.15 preferred). */
  viaRingDiff: 0.1,
  viaRingDiffPreferred: 0.15,
  pthDrill: [0.15, 6.3] as const,
  pthRing: 0.18,
  pthRingRecommended: 0.25,
  platedSlot: 0.5,
  npthHole: 0.5,
  npthSlot: 1.0,
  viaHoleGap: 0.2,
  padHoleGap: 0.45,
  edge: 0.2,
  silkWidth: 0.15,
  textHeight: 1.0,
  /** 4-layer boards: finer tracks, thinner rings, inner copper kept off the drill holes. */
  multilayer: { trace: 0.09, spacing: 0.09, pthRing: 0.15, pthRingRecommended: 0.2, boardMax: [663, 593] as const, viaHoleToInner: 0.2, pthHoleToInner: 0.3 },
  /** Economic PCBA (one side, 2–50 boards) and standard PCBA board sizes. */
  economicPcba: { min: 10, max: [470, 500] as const, pitch: 0.4 },
  standardPcba: { min: 70, max: [460, 500] as const, pitch: 0.35 },
};

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';
export type CheckGroup = 'Board' | 'Copper' | 'Drills' | 'Silkscreen' | 'Assembly';

export interface CheckItem {
  id: string;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  /** What the board has. */
  value: string;
  /** JLCPCB's requirement. */
  limit: string;
  /** What to do about a warning or failure. */
  detail?: string;
  /** Where to look on the board. */
  at?: Vec;
  /** Parts, tracks or vias involved, for selecting them. */
  refs?: string[];
}

export interface ChecklistOptions {
  /** Include the assembly checks (default true). */
  assembly?: boolean;
  /** Component ids left out of assembly (hand-soldered through-hole parts). */
  skip?: ReadonlySet<string>;
  /** Boards ordered, for the stock check (default 5). */
  quantity?: number;
}

const mm = (v: number) => `${Math.round(v * 1000) / 1000} mm`;
const center = (it: CopperItem): Vec => [(it.box.x1 + it.box.x2) / 2, (it.box.y1 + it.box.y2) / 2];
const padName = (p: WorldPad) => `${p.designator}.${p.number}`;
const list = (names: string[], max = 6) => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

/** Smallest gap between copper of different nets (pads without a net count as their own net). */
function minSpacing(board: BoardModel, conn: PcbConnectivity, window = 0.5): { gap: number; at?: Vec; refs: string[]; what: string } {
  const netOf = (it: CopperItem) => (it.type === 'pad' ? (it.net ?? `pad:${it.ref}`) : (conn.itemNet.get(it.ref) ?? it.net ?? `${it.type}:${it.ref}`));
  const label = (it: CopperItem) => {
    if (it.type !== 'pad') return `${conn.itemNet.get(it.ref) ?? it.net ?? 'unconnected'} ${it.type}`;
    const [cid, idx] = it.ref.split(':');
    const pad = board.pads.find((p) => p.componentId === cid && p.index === Number(idx));
    return pad ? padName(pad) : 'pad';
  };
  const items = [...board.items].sort((a, b) => a.box.x1 - b.box.x1);
  const nets = items.map(netOf);
  let best = { gap: Infinity, at: undefined as Vec | undefined, refs: [] as string[], what: '' };
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.box.x1 > a.box.x2 + window) break;
      if (nets[i] === nets[j] || b.box.y1 > a.box.y2 + window || b.box.y2 < a.box.y1 - window) continue;
      if (!a.layers.some((l) => b.layers.includes(l))) continue;
      const d = shapeDistance(a.shape, b.shape);
      if (d < best.gap) best = { gap: d, at: center(a), refs: [a.ref.split(':')[0], b.ref.split(':')[0]], what: `${label(a)} and ${label(b)}` };
    }
  }
  return best;
}

export interface DrillHole {
  center: Vec;
  /** Drill diameter (slot width for slots). */
  d: number;
  /** Slot length beyond the width (0 for round holes). */
  len: number;
  kind: 'via' | 'pth' | 'npth';
  net: string | null;
  name: string;
  /** Via id, component id or mounting hole id, for selecting it. */
  ref?: string;
}

/** Every drilled hole on the board: vias, through-hole pads and mounting holes. */
export function drilledHoles(pcb: Pcb, board: BoardModel, conn: PcbConnectivity): DrillHole[] {
  const out: DrillHole[] = pcb.vias.map((v) => {
    const net = conn.itemNet.get(v.id) ?? v.net;
    return { center: [v.x, v.y] as Vec, d: v.drill, len: 0, kind: 'via' as const, net, name: `${net ?? 'unconnected'} via`, ref: v.id };
  });
  for (const p of board.pads) {
    if (!p.hole) continue;
    const d = Math.min(p.hole.w, p.hole.h);
    // A pad no bigger than its hole has no copper ring: a non-plated hole (locating peg).
    const plated = Math.min(p.pad.w, p.pad.h) > d + 0.01;
    out.push({ center: p.hole.center, d, len: Math.abs(p.hole.w - p.hole.h), kind: plated ? 'pth' : 'npth', net: p.net, name: padName(p), ref: p.componentId });
  }
  for (const h of pcb.holes ?? []) out.push({ center: [h.x, h.y], d: h.diameter, len: 0, kind: 'npth', net: null, name: 'mounting hole', ref: h.id });
  return out;
}

/** Edge-to-edge distance JLCPCB needs between two holes. */
export const holeGap = (a: Pick<DrillHole, 'kind'>, b: Pick<DrillHole, 'kind'>) => (a.kind === 'via' && b.kind === 'via' ? JLC.viaHoleGap : JLC.padHoleGap);

/**
 * Why a new via hole at `at` would break JLCPCB's hole spacing (naming the hole it crowds), or
 * null when it fits. An existing via at the same spot also counts: stacked vias overlap.
 */
export function viaHoleConflict(at: Vec, drill: number, holes: DrillHole[]): string | null {
  for (const h of holes) {
    const gap = Math.hypot(at[0] - h.center[0], at[1] - h.center[1]) - drill / 2 - (h.d + h.len) / 2;
    const need = holeGap({ kind: 'via' }, h);
    if (gap < need - 1e-6) return `${h.name} at ${h.center.map((v) => Math.round(v * 1000) / 1000).join(', ')} is ${gap < 0 ? 'overlapping' : `only ${mm(gap)} away`} (holes need ${mm(need)})`;
  }
  return null;
}

export function jlcpcbChecklist(project: Project, opts: ChecklistOptions = {}): CheckItem[] {
  const pcb = project.pcb ?? emptyPcb();
  const board = buildBoard(project, pcb);
  const conn = pcbConnectivity(board, pcb);
  const items: CheckItem[] = [];
  const add = (item: CheckItem) => items.push(item);
  const b = pcb.board;
  const stack = copperLayers(pcb);
  const multi = stack.length > 2;
  // Limits that differ for multilayer boards.
  const lim = {
    trace: multi ? JLC.multilayer.trace : JLC.trace,
    spacing: multi ? JLC.multilayer.spacing : JLC.spacing,
    pthRing: multi ? JLC.multilayer.pthRing : JLC.pthRing,
    pthRingRecommended: multi ? JLC.multilayer.pthRingRecommended : JLC.pthRingRecommended,
    boardMax: multi ? JLC.multilayer.boardMax : JLC.boardMax,
  };

  /* ---------- board ---------- */
  const issues = runDrc(board, pcb, conn);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  add({
    id: 'drc',
    group: 'Board',
    title: 'Design rule check',
    status: errors.length ? 'fail' : 'pass',
    value: errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : `no errors${warnings.length ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}`,
    limit: 'no errors (unrouted nets, shorts, clearance)',
    detail: errors.length ? `First: ${errors[0].message}. The DRC tab lists them all.` : undefined,
    at: errors[0]?.at ?? undefined,
    refs: errors[0]?.refs,
  });
  const [maxW, maxH] = lim.boardMax;
  const sizeOk = Math.min(b.width, b.height) >= JLC.boardMin && Math.max(b.width, b.height) <= maxW && Math.min(b.width, b.height) <= maxH;
  add({
    id: 'size',
    group: 'Board',
    title: 'Board size',
    status: sizeOk ? 'pass' : 'fail',
    value: `${b.width} × ${b.height} mm`,
    limit: `${JLC.boardMin} × ${JLC.boardMin} mm to ${maxW} × ${maxH} mm`,
  });
  if (multi) {
    const planes = (pcb.pours ?? []).filter((p) => !p.outline && p.layer !== 'top' && p.layer !== 'bottom');
    add({
      id: 'stack',
      group: 'Board',
      title: 'Layer stack',
      status: planes.length ? 'info' : 'warn',
      value: stack.map((l) => `${LAYER_NAMES[l]}${planes.find((p) => p.layer === l) ? ` (${planes.find((p) => p.layer === l)!.net} plane)` : ''}`).join(', '),
      limit: "4 layers on JLCPCB's default stackup, 1.6 mm",
      detail: planes.length ? undefined : 'No inner plane yet: a GND plane on Inner 1 is what makes 4 layers worth it.',
    });
  }

  /* ---------- copper ---------- */
  const tracks = pcb.tracks;
  if (tracks.length) {
    const thin = tracks.reduce((m, t) => (t.width < m.width ? t : m), tracks[0]);
    add({
      id: 'trace',
      group: 'Copper',
      title: 'Track width',
      status: thin.width < lim.trace - 1e-6 ? 'fail' : thin.width < JLC.traceComfort - 1e-6 ? 'warn' : 'pass',
      value: `thinnest ${mm(thin.width)}`,
      limit: `≥ ${mm(lim.trace)} (keep ≥ ${mm(JLC.traceComfort)} where you can)`,
      detail: thin.width < JLC.traceComfort ? 'Widen the thinnest tracks, or accept the tighter etching tolerance.' : undefined,
      at: thin.points[0],
      refs: [thin.id],
    });
  }
  const spacing = minSpacing(board, conn);
  const pourGap = Math.min(...(pcb.pours ?? []).map((p) => Math.max(p.clearance, pcb.rules.clearance)), Infinity);
  const gap = Math.min(spacing.gap, pourGap);
  add({
    id: 'spacing',
    group: 'Copper',
    title: 'Copper spacing',
    status: gap < lim.spacing - 1e-6 ? 'fail' : 'pass',
    value: gap === Infinity ? 'no copper of different nets within 0.5 mm' : spacing.gap <= pourGap ? `closest ${mm(spacing.gap)} (${spacing.what})` : `closest ${mm(pourGap)} (pour clearance)`,
    limit: `≥ ${mm(lim.spacing)} between tracks, pads and pours of different nets`,
    detail: gap < lim.spacing ? 'Move the copper apart; footprints with pads closer than this cannot be made either.' : undefined,
    at: spacing.gap <= pourGap ? spacing.at : undefined,
    refs: spacing.gap <= pourGap ? spacing.refs : undefined,
  });
  const edges = boardEdges(pcb);
  // Pours keep their own distance from the edge.
  let edge = { d: pcb.pours?.length ? POUR_EDGE_CLEARANCE : Infinity, at: undefined as Vec | undefined, refs: [] as string[] };
  for (const it of board.items) {
    const d = shapeEdgeDistance(it.shape, edges);
    if (d < edge.d) edge = { d, at: center(it), refs: [it.ref.split(':')[0]] };
  }
  add({
    id: 'edge',
    group: 'Copper',
    title: 'Copper to board edge',
    status: edge.d < JLC.edge - 1e-6 ? 'fail' : 'pass',
    value: edge.d === Infinity ? 'no copper yet' : `closest ${mm(edge.d)}`,
    limit: `≥ ${mm(JLC.edge)} from routed edges, cutouts and holes`,
    at: edge.at,
    refs: edge.refs,
  });
  const r = pcb.rules;
  const ruleProblems = [
    r.clearance < lim.spacing && `clearance ${mm(r.clearance)}`,
    Math.min(r.trackWidth, r.minTrackWidth) < lim.trace && `track width ${mm(Math.min(r.trackWidth, r.minTrackWidth))}`,
    r.viaDrill < JLC.viaDrill && `via drill ${mm(r.viaDrill)}`,
    r.viaDiameter - r.viaDrill < JLC.viaRingDiff - 1e-6 && `via ${mm(r.viaDiameter)} on a ${mm(r.viaDrill)} drill`,
  ].filter((x): x is string => !!x);
  add({
    id: 'rules',
    group: 'Copper',
    title: 'Design rules',
    status: ruleProblems.length ? 'fail' : 'pass',
    value: ruleProblems.length ? `below JLCPCB: ${ruleProblems.join(', ')}` : `clearance ${mm(r.clearance)}, tracks ${mm(Math.min(r.trackWidth, r.minTrackWidth))}+, vias ${r.viaDiameter}/${r.viaDrill} mm`,
    limit: 'rules the router and DRC use stay within JLCPCB limits',
    detail: ruleProblems.length ? 'Raise them in the Design rules panel so new routing stays manufacturable.' : undefined,
  });

  /* ---------- drills ---------- */
  if (pcb.vias.length) {
    const smallestDrill = Math.min(...pcb.vias.map((v) => v.drill));
    const smallestDia = Math.min(...pcb.vias.map((v) => v.diameter));
    const tightRing = Math.min(...pcb.vias.map((v) => v.diameter - v.drill));
    const extraCost = pcb.vias.filter((v) => v.drill < 0.2 - 1e-6 || (v.drill < 0.3 - 1e-6 && v.diameter < 0.45 - 1e-6));
    const fail = smallestDrill < JLC.viaDrill - 1e-6 || smallestDia < JLC.viaDiameter - 1e-6 || tightRing < JLC.viaRingDiff - 1e-6;
    add({
      id: 'via',
      group: 'Drills',
      title: 'Vias',
      status: fail ? 'fail' : extraCost.length || tightRing < JLC.viaRingDiffPreferred - 1e-6 ? 'warn' : 'pass',
      value: `${pcb.vias.length} vias, smallest ${smallestDia}/${smallestDrill} mm (diameter/drill)`,
      limit: `drill ≥ ${mm(JLC.viaDrill)}, diameter ≥ ${mm(JLC.viaDiameter)} and ≥ drill + ${JLC.viaRingDiff} mm; drills under 0.3 mm cost extra unless 0.2 mm+ with a 0.45 mm+ via`,
      detail: fail
        ? 'Use larger vias (0.6/0.3 mm is the cheapest common size).'
        : extraCost.length
          ? `${extraCost.length} via${extraCost.length > 1 ? 's' : ''} need JLCPCB's small-via option, which costs more; pick it when ordering or enlarge them.`
          : undefined,
      at: extraCost[0] ? [extraCost[0].x, extraCost[0].y] : undefined,
      refs: extraCost.map((v) => v.id),
    });
  }
  const all = drilledHoles(pcb, board, conn);
  const pth = board.pads.filter((p) => p.hole && Math.min(p.pad.w, p.pad.h) > Math.min(p.hole.w, p.hole.h) + 0.01);
  if (pth.length) {
    const rings = pth.map((p) => ({ pad: p, ring: (Math.min(p.pad.w, p.pad.h) - Math.min(p.hole!.w, p.hole!.h)) / 2, d: Math.min(p.hole!.w, p.hole!.h), slot: Math.abs(p.hole!.w - p.hole!.h) > 1e-6 }));
    const worst = rings.reduce((m, x) => (x.ring < m.ring ? x : m), rings[0]);
    const badDrill = rings.filter((x) => x.d < JLC.pthDrill[0] - 1e-6 || Math.max(x.pad.hole!.w, x.pad.hole!.h) > JLC.pthDrill[1] + 1e-6 || (x.slot && x.d < JLC.platedSlot - 1e-6));
    add({
      id: 'pth',
      group: 'Drills',
      title: 'Plated through-holes',
      status: badDrill.length || worst.ring < lim.pthRing - 1e-6 ? 'fail' : worst.ring < lim.pthRingRecommended - 1e-6 ? 'warn' : 'pass',
      value: `${pth.length} holes, thinnest ring ${mm(worst.ring)} (${padName(worst.pad)})`,
      limit: `drill ${JLC.pthDrill[0]}–${JLC.pthDrill[1]} mm, slots ≥ ${mm(JLC.platedSlot)} wide; copper ring ≥ ${mm(lim.pthRing)} (≥ ${mm(lim.pthRingRecommended)} recommended)`,
      detail: badDrill.length ? `Drill out of range at ${list(badDrill.map((x) => padName(x.pad)))}.` : worst.ring < lim.pthRingRecommended ? 'The footprint has a thin ring; it is usually fine, but a larger pad is safer.' : undefined,
      at: worst.pad.center,
      refs: [worst.pad.componentId],
    });
  }
  const npth = all.filter((h) => h.kind === 'npth');
  const cutouts = b.cutouts ?? [];
  if (npth.length || cutouts.length) {
    const small = npth.filter((h) => h.d < JLC.npthHole - 1e-6);
    const narrow = cutouts.filter((c) => {
      const xs = c.outline.map((p) => p[0]);
      const ys = c.outline.map((p) => p[1]);
      return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < JLC.npthSlot - 1e-6;
    });
    add({
      id: 'npth',
      group: 'Drills',
      title: 'Non-plated holes and cutouts',
      status: small.length || narrow.length ? 'fail' : 'pass',
      value: [npth.length && `${npth.length} hole${npth.length > 1 ? 's' : ''}, smallest ${mm(Math.min(...npth.map((h) => h.d)))}`, cutouts.length && `${cutouts.length} cutout${cutouts.length > 1 ? 's' : ''}`].filter(Boolean).join(', '),
      limit: `holes ≥ ${mm(JLC.npthHole)}, milled cutouts and slots ≥ ${mm(JLC.npthSlot)} wide`,
      detail: small.length || narrow.length ? `Too small: ${list([...small.map((h) => h.name), ...narrow.map(() => 'cutout')])}.` : undefined,
      at: small[0]?.center ?? narrow[0]?.outline[0],
    });
  }
  if (all.length > 1) {
    let tight = { gap: Infinity, need: 0, a: all[0], b: all[1] };
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [p, q] = [all[i], all[j]];
        const gapPQ = Math.hypot(p.center[0] - q.center[0], p.center[1] - q.center[1]) - (p.d + p.len) / 2 - (q.d + q.len) / 2;
        const need = holeGap(p, q);
        if (gapPQ - need < tight.gap - tight.need) tight = { gap: gapPQ, need, a: p, b: q };
      }
    add({
      id: 'holegap',
      group: 'Drills',
      title: 'Hole spacing',
      status: tight.gap < tight.need - 1e-6 ? 'fail' : 'pass',
      value: tight.gap < 0 ? `holes overlap by ${mm(-tight.gap)} (${tight.a.name} and ${tight.b.name})` : `closest ${mm(tight.gap)} (${tight.a.name} and ${tight.b.name})`,
      limit: `≥ ${mm(JLC.viaHoleGap)} between via holes, ≥ ${mm(JLC.padHoleGap)} when a pad or mounting hole is involved`,
      detail: tight.gap < tight.need - 1e-6 ? 'Move one of them, or delete one of two stacked vias of the same net.' : undefined,
      at: tight.a.center,
      refs: [tight.a.ref, tight.b.ref].filter((r): r is string => !!r),
    });
  }

  if (multi && all.length) {
    // Inner copper of other nets must stay clear of every drill hole.
    const inner = board.items.filter((it) => it.layers.some(isInner));
    const netOf = (it: CopperItem) => (it.type === 'pad' ? it.net : (conn.itemNet.get(it.ref) ?? it.net));
    let worst = { slack: Infinity, gap: 0, need: 0, hole: all[0], what: '' };
    for (const h of all) {
      const need = h.kind === 'via' ? JLC.multilayer.viaHoleToInner : JLC.multilayer.pthHoleToInner;
      const drill = { kind: 'capsule' as const, a: h.center, b: h.center, r: (h.d + h.len) / 2 };
      for (const it of inner) {
        if (netOf(it) !== null && netOf(it) === h.net) continue;
        if (it.type === 'via' && it.ref === h.ref) continue;
        if (it.type === 'pad' && it.ref.startsWith(`${h.ref}:`) && it.box.x1 <= h.center[0] && it.box.x2 >= h.center[0] && it.box.y1 <= h.center[1] && it.box.y2 >= h.center[1]) continue;
        const gap = shapeDistance(drill, it.shape);
        if (gap - need < worst.slack) worst = { slack: gap - need, gap, need, hole: h, what: it.type };
      }
    }
    if (worst.slack < Infinity)
      add({
        id: 'innerholes',
        group: 'Drills',
        title: 'Inner layers clear of holes',
        status: worst.slack < -1e-6 ? 'fail' : 'pass',
        value: `closest ${mm(worst.gap)} (${worst.what} to ${worst.hole.name})`,
        limit: `inner copper ≥ ${mm(JLC.multilayer.viaHoleToInner)} from via holes, ≥ ${mm(JLC.multilayer.pthHoleToInner)} from pad holes`,
        at: worst.hole.center,
      });
  }

  /* ---------- silkscreen ---------- */
  const labels = board.parts.filter((p) => p.fp).map((p) => ({ part: p, label: designatorLabel(p) })).filter((x) => !x.label.hidden);
  const texts = pcb.texts ?? [];
  const graphics = board.parts.flatMap((p) => p.graphics.filter((g) => g.layer !== 'outline' && !g.filled).map((g) => ({ part: p, width: g.width })));
  const widths = [
    ...labels.map((x) => ({ w: strokeFor(x.label.size), what: `designator ${x.label.text}` })),
    ...texts.map((t) => ({ w: textStroke(t), what: `text "${t.text.split('\n')[0]}"` })),
    ...graphics.map((g) => ({ w: g.width, what: `${g.part.component.designator} outline` })),
  ];
  if (widths.length) {
    const thinLines = widths.filter((x) => x.w < JLC.silkWidth - 1e-6);
    const thinnest = widths.reduce((m, x) => (x.w < m.w ? x : m), widths[0]);
    add({
      id: 'silkwidth',
      group: 'Silkscreen',
      title: 'Silkscreen line width',
      status: thinLines.length ? 'warn' : 'pass',
      value: `thinnest ${mm(thinnest.w)} (${thinnest.what})`,
      limit: `≥ ${mm(JLC.silkWidth)}; thinner lines may not print`,
      detail: thinLines.length ? `${thinLines.length} line${thinLines.length > 1 ? 's' : ''} below ${mm(JLC.silkWidth)}, e.g. ${list([...new Set(thinLines.map((x) => x.what))], 3)}.` : undefined,
    });
  }
  const small = [...labels.filter((x) => x.label.size < JLC.textHeight - 1e-6).map((x) => x.label.text), ...texts.filter((t) => t.size < JLC.textHeight - 1e-6).map((t) => `"${t.text.split('\n')[0]}"`)];
  if (labels.length || texts.length) {
    add({
      id: 'textheight',
      group: 'Silkscreen',
      title: 'Text height',
      status: small.length ? 'warn' : 'pass',
      value: small.length ? `${small.length} below 1 mm: ${list(small)}` : 'all text 1 mm or taller',
      limit: `≥ ${mm(JLC.textHeight)} to stay legible`,
      detail: small.length ? 'Enlarge them, or accept that very small text may come out blurred.' : undefined,
    });
  }
  const silk = silkIssues(board, pcb);
  add({
    id: 'silkpads',
    group: 'Silkscreen',
    title: 'Silkscreen clear of pads and edges',
    status: silk.length ? 'warn' : 'pass',
    value: silk.length ? `${silk.length} problem${silk.length > 1 ? 's' : ''}: ${silk[0].message}` : 'no text, logo or designator on pads or off the board',
    limit: 'JLCPCB trims silkscreen within 0.15 mm of pads and at the board edge',
    detail: silk.length > 1 ? 'The DRC tab lists them all; move the labels or text.' : undefined,
    at: silk[0]?.at ?? undefined,
    refs: silk[0]?.refs,
  });

  /* ---------- assembly ---------- */
  if (opts.assembly !== false && board.parts.length) {
    const skip = opts.skip ?? new Set<string>();
    const assembled = board.parts.filter((p) => p.component.attrs['Add into BOM'] !== 'no' && !skip.has(p.component.id));
    const cannot = assembled.filter((p) => !p.component.lcsc || !p.fp);
    add({
      id: 'lcsc',
      group: 'Assembly',
      title: 'Parts JLCPCB can assemble',
      status: cannot.length ? 'fail' : 'pass',
      value: cannot.length ? `${cannot.length} without an LCSC part or footprint: ${list(cannot.map((p) => p.component.designator))}` : `all ${assembled.length} parts have an LCSC number and footprint`,
      limit: 'every assembled part comes from the JLCPCB library',
      detail: cannot.length ? 'Replace them with library parts, or mark them "not in BOM" and solder them yourself.' : undefined,
      refs: cannot.map((p) => p.component.id),
    });
    const eco = JLC.economicPcba;
    const std = JLC.standardPcba;
    const fitsEco = Math.min(b.width, b.height) >= eco.min && Math.max(b.width, b.height) <= eco.max[1] && Math.min(b.width, b.height) <= eco.max[0];
    const fitsStd = Math.min(b.width, b.height) >= std.min;
    add({
      id: 'pcbasize',
      group: 'Assembly',
      title: 'Board size for assembly',
      status: fitsEco ? (fitsStd ? 'pass' : 'info') : 'warn',
      value: `${b.width} × ${b.height} mm`,
      limit: `economic PCBA ${eco.min} × ${eco.min} to ${eco.max[0]} × ${eco.max[1]} mm; standard PCBA from ${std.min} × ${std.min} mm`,
      detail: !fitsEco ? 'Too small for assembly on its own: order it as a panel.' : !fitsStd ? 'Fine for economic PCBA; standard PCBA would need a panel or edge rails.' : undefined,
    });
    const sides = new Set(assembled.map((p) => p.placement.side));
    add({
      id: 'sides',
      group: 'Assembly',
      title: 'Assembly sides',
      status: sides.size > 1 ? 'warn' : 'pass',
      value: sides.size > 1 ? 'parts on both sides' : `parts on the ${[...sides][0] ?? 'top'} side only`,
      limit: 'economic PCBA places parts on one side',
      detail: sides.size > 1 ? `Bottom: ${list(assembled.filter((p) => p.placement.side === 'bottom').map((p) => p.component.designator))}. Move them to the top or order standard PCBA (costs more).` : undefined,
    });
    const footprintOf = (id: string) => pcb.footprints[pcb.footprintOf[id] ?? '']?.title ?? '';
    const tiny = assembled.filter((p) => /(?:^|\D)(0201|01005)(?:\D|$)/.test(footprintOf(p.component.id)));
    let pitch = { d: Infinity, part: '' };
    for (const p of assembled) {
      const smd = p.pads.filter((q) => !q.hole);
      for (let i = 0; i < smd.length; i++)
        for (let j = i + 1; j < smd.length; j++) {
          if (smd[i].number === smd[j].number) continue;
          const d = Math.hypot(smd[i].center[0] - smd[j].center[0], smd[i].center[1] - smd[j].center[1]);
          if (d < pitch.d) pitch = { d, part: p.component.designator };
        }
    }
    add({
      id: 'packages',
      group: 'Assembly',
      title: 'Package sizes and pin pitch',
      status: pitch.d < std.pitch - 0.01 ? 'fail' : tiny.length || pitch.d < eco.pitch - 0.01 ? 'warn' : 'pass',
      value: `${tiny.length ? `${list(tiny.map((p) => p.component.designator))} smaller than 0402; ` : ''}finest pin pitch ${pitch.d === Infinity ? '—' : `${mm(pitch.d)} (${pitch.part})`}`,
      limit: `economic PCBA: 0402 and larger, pitch ≥ ${mm(eco.pitch)}; standard: down to 01005, ≥ ${mm(std.pitch)}`,
      detail: tiny.length || pitch.d < eco.pitch - 0.01 ? 'These need standard PCBA.' : undefined,
    });
    const bom = buildBom(assembled.map((p) => p.component), opts.quantity ?? 5);
    add({
      id: 'extended',
      group: 'Assembly',
      title: 'Extended parts',
      status: 'info',
      value: `${bom.byClass.extended} unique extended part${bom.byClass.extended === 1 ? '' : 's'}`,
      limit: `$${EXTENDED_SETUP_FEE} setup fee each; basic and preferred parts have none`,
      detail: bom.byClass.extended ? `About $${bom.setupFee} in setup fees.` : undefined,
    });
    if (bom.lowStock.length)
      add({
        id: 'stock',
        group: 'Assembly',
        title: 'Stock',
        status: 'warn',
        value: `not enough stock for ${list(bom.lowStock.map((l) => l.designators.join('/')))}`,
        limit: 'JLCPCB holds enough of every part for the order',
        detail: 'Refresh stock (Tools menu) or pick alternatives.',
      });
    const tht = assembled.filter((p) => p.pads.some((q) => q.hole));
    if (tht.length)
      add({
        id: 'tht',
        group: 'Assembly',
        title: 'Through-hole parts',
        status: 'info',
        value: list(tht.map((p) => p.component.designator)),
        limit: 'soldered by hand or wave at extra cost',
        detail: 'Leave them out of assembly (hand-solder option) to save the fee.',
      });
  }
  return items;
}

/** Overall result: failures block an order. */
export const checklistReady = (items: CheckItem[]) => !items.some((i) => i.status === 'fail');
