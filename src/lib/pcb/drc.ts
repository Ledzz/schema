import type { Vec } from '../schematic/types';
import type { BoardModel, BoardPart, PcbConnectivity } from './board';
import { pointInPolygon, pointShapeDistance, shapeDistance, type CopperItem, type WorldPad } from './geometry';
import { boardEdges, insideBoard, keepoutAreas, shapeEdgeDistance } from './outline';
import { designatorLabel, labelStrokes, logoAreas, strokeFor, textItemStrokes, textStroke } from './silk';
import type { CopperLayer, Pcb } from './types';

export interface DrcIssue {
  severity: 'error' | 'warning';
  message: string;
  at: Vec | null;
  /** Component ids, track ids or via ids involved. */
  refs: string[];
}

const center = (it: CopperItem): Vec => [(it.box.x1 + it.box.x2) / 2, (it.box.y1 + it.box.y2) / 2];

/** Net used for clearance checks; unconnected copper gets a unique pseudo net. */
function effectiveNet(it: CopperItem, conn: PcbConnectivity): string {
  if (it.type === 'pad') return it.net ?? `pad:${it.ref}`;
  return conn.itemNet.get(it.ref) ?? it.net ?? `${it.type}:${it.ref}`;
}

const label = (it: CopperItem, board: BoardModel, conn?: PcbConnectivity) => {
  if (it.type === 'pad') {
    const [cid, idx] = it.ref.split(':');
    const pad = board.pads.find((p) => p.componentId === cid && p.index === Number(idx));
    return pad ? `${pad.designator}.${pad.number}` : 'pad';
  }
  const net = conn?.itemNet.get(it.ref) ?? it.net;
  return net ? `${net} ${it.type}` : it.type;
};

/**
 * Soldered shell tabs of a connector with a metal body (USB, RJ45, card sockets): slotted holes,
 * or one pad number used several times. Pin headers have neither.
 */
export function shellPads(part: BoardPart): WorldPad[] {
  if (!/^(J|CN|CON|USB|X)\d/i.test(part.component.designator)) return [];
  const uses = new Map<string, number>();
  for (const p of part.pads) uses.set(p.number, (uses.get(p.number) ?? 0) + 1);
  return part.pads.filter((p) => (p.hole && Math.abs(p.hole.w - p.hole.h) > 1e-6) || (uses.get(p.number) ?? 0) > 1);
}

/** Closed component-outline polygons of a part, or its bounding box when it has none. */
function bodyOutlines(part: BoardPart): Vec[][] {
  const closed = part.graphics.filter((g) => g.layer === 'outline' && g.points.length > 3 && Math.hypot(g.points[0][0] - g.points.at(-1)![0], g.points[0][1] - g.points.at(-1)![1]) < 1e-3);
  if (closed.length) return closed.map((g) => g.points);
  const b = part.box;
  return [[[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]]];
}

export interface ShellArea {
  part: BoardPart;
  layer: CopperLayer;
  outlines: Vec[][];
  /** Nets of the shell tabs; their copper may run under the body. */
  nets: Set<string | null>;
}

/** Board areas under metal-shelled connectors, which other nets' copper should stay out of. */
export function shellAreas(board: BoardModel): ShellArea[] {
  return board.parts.flatMap((part) => {
    const shell = shellPads(part);
    return shell.length ? [{ part, layer: part.placement.side, outlines: bodyOutlines(part), nets: new Set(shell.map((p) => p.net)) }] : [];
  });
}

/**
 * Tracks and vias of other nets under a metal-shelled connector, where only solder mask separates
 * them from the shell. Copper within 0.5 mm of its own net's pads on the part is how a track
 * reaches them, so it doesn't count.
 */
function copperUnderShells(board: BoardModel, pcb: Pcb, conn: PcbConnectivity): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const step = 0.1;
  for (const { part, outlines, nets: shellNets } of shellAreas(board)) {
    const inside = (p: Vec) => outlines.some((b) => pointInPolygon(p, b));
    const name = part.component.designator;
    for (const t of pcb.tracks) {
      const net = conn.itemNet.get(t.id) ?? t.net;
      if (t.layer !== part.placement.side || shellNets.has(net)) continue;
      const own = part.pads.filter((p) => p.net !== null && p.net === net);
      let length = 0;
      let first: Vec | null = null;
      for (let i = 1; i < t.points.length; i++) {
        const [a, b] = [t.points[i - 1], t.points[i]];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 0; k < n; k++) {
          const p: Vec = [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n];
          if (!inside(p) || own.some((pad) => pointShapeDistance(p, pad.shape) <= 0.5)) continue;
          length += Math.hypot(b[0] - a[0], b[1] - a[1]) / n;
          first ??= p;
        }
      }
      if (length >= 0.3) {
        issues.push({
          severity: 'warning',
          message: `${net ?? 'Unconnected'} track runs ${length.toFixed(1)} mm under ${name}'s metal shell, insulated only by solder mask; route it outside the connector body`,
          at: first,
          refs: [t.id, part.component.id],
        });
      }
    }
    for (const v of pcb.vias) {
      const net = conn.itemNet.get(v.id) ?? v.net;
      if (shellNets.has(net) || !inside([v.x, v.y])) continue;
      issues.push({ severity: 'warning', message: `${net ?? 'Unconnected'} via under ${name}'s metal shell; move it outside the connector body`, at: [v.x, v.y], refs: [v.id, part.component.id] });
    }
  }
  return issues;
}

/** Tracks, vias and parts inside keepout areas (mounting-hole rings included), per its switches. */
function keepoutViolations(board: BoardModel, pcb: Pcb, conn: PcbConnectivity): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const holeIds = new Set((pcb.holes ?? []).map((h) => h.id));
  for (const k of keepoutAreas(pcb)) {
    if (k.outline.length < 3) continue;
    const area = { kind: 'poly' as const, points: k.outline };
    const where = holeIds.has(k.id) ? 'the mounting hole ring' : 'a keepout area';
    if (k.tracks) {
      for (const t of pcb.tracks) {
        if (!k.layers.includes(t.layer)) continue;
        const hit = t.points.slice(1).find((p, i) => shapeDistance({ kind: 'capsule', a: t.points[i], b: p, r: t.width / 2 }, area) === 0);
        if (hit) issues.push({ severity: 'error', message: `${conn.itemNet.get(t.id) ?? t.net ?? 'Unconnected'} track crosses ${where}`, at: hit, refs: [t.id, k.id] });
      }
    }
    if (k.vias) {
      for (const v of pcb.vias) {
        if (shapeDistance({ kind: 'capsule', a: [v.x, v.y], b: [v.x, v.y], r: v.diameter / 2 }, area) === 0) {
          issues.push({ severity: 'error', message: `${conn.itemNet.get(v.id) ?? v.net ?? 'Unconnected'} via inside ${where}`, at: [v.x, v.y], refs: [v.id, k.id] });
        }
      }
    }
    if (k.parts) {
      for (const part of board.parts) {
        if (!part.fp || !k.layers.includes(part.placement.side)) continue;
        const b = part.box;
        const body = { kind: 'poly' as const, points: [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]] as Vec[] };
        if (shapeDistance(body, area) === 0) issues.push({ severity: 'error', message: `${part.component.designator} is inside ${where}`, at: [part.placement.x, part.placement.y], refs: [part.component.id, k.id] });
      }
    }
  }
  return issues;
}

/**
 * Silkscreen JLCPCB would not print: text, logos and designators running off the board, or lying
 * on pads (silkscreen is trimmed from exposed copper, so the text comes out broken).
 */
export function silkIssues(board: BoardModel, pcb: Pcb): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const edges = boardEdges(pcb);
  const padsOn = (side: CopperLayer) => board.pads.filter((p) => p.layers.includes(side));
  const strokeHits = (strokes: Vec[][], width: number, pads: WorldPad[]) =>
    pads.filter((pad) => strokes.some((st) => st.slice(1).some((q, i) => shapeDistance({ kind: 'capsule', a: st[i], b: q, r: width / 2 }, pad.shape) === 0)));
  const offBoard = (points: Vec[]) => points.some((p) => !insideBoard(p, edges));
  const padNames = (pads: WorldPad[]) => pads.slice(0, 3).map((p) => `${p.designator}.${p.number}`).join(', ') + (pads.length > 3 ? ` and ${pads.length - 3} more` : '');

  for (const t of pcb.texts ?? []) {
    const strokes = textItemStrokes(t);
    const name = `Silkscreen text "${t.text.replace(/\n/g, ' ')}"`;
    if (offBoard(strokes.flat())) issues.push({ severity: 'warning', message: `${name} runs off the board`, at: [t.x, t.y], refs: [t.id] });
    const hits = strokeHits(strokes, textStroke(t), padsOn(t.side));
    if (hits.length) issues.push({ severity: 'warning', message: `${name} lies on pad ${padNames(hits)}; JLCPCB trims silkscreen over pads`, at: [t.x, t.y], refs: [t.id] });
  }
  for (const l of pcb.logos ?? []) {
    const areas = logoAreas(l);
    if (offBoard(areas.flatMap((a) => a.outer))) issues.push({ severity: 'warning', message: `Logo "${l.name}" runs off the board`, at: [l.x, l.y], refs: [l.id] });
    const hits = padsOn(l.side).filter((pad) => areas.some((a) => shapeDistance({ kind: 'poly', points: a.outer }, pad.shape) === 0 && !a.holes.some((h) => pointInPolygon(pad.center, h))));
    if (hits.length) issues.push({ severity: 'warning', message: `Logo "${l.name}" lies on pad ${padNames(hits)}; JLCPCB trims silkscreen over pads`, at: [l.x, l.y], refs: [l.id] });
  }
  for (const part of board.parts) {
    if (!part.fp) continue;
    const label = designatorLabel(part);
    const strokes = labelStrokes(label);
    if (!strokes.length) continue;
    if (offBoard(strokes.flat())) issues.push({ severity: 'warning', message: `Designator ${label.text} runs off the board; move it with pcb_set_designator or hide it`, at: label.at, refs: [part.component.id] });
    const hits = strokeHits(strokes, strokeFor(label.size), padsOn(label.side));
    if (hits.length) issues.push({ severity: 'warning', message: `Designator ${label.text} lies on pad ${padNames(hits)}; move it so it stays readable`, at: label.at, refs: [part.component.id] });
  }
  return issues;
}

export function runDrc(board: BoardModel, pcb: Pcb, conn: PcbConnectivity): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const { clearance } = pcb.rules;

  // Clearance between copper of different nets (sweep over x).
  const items = [...board.items].sort((a, b) => a.box.x1 - b.box.x1);
  const nets = new Map(items.map((it) => [it.key, effectiveNet(it, conn)]));
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.box.x1 > a.box.x2 + clearance) break;
      if (b.box.y1 > a.box.y2 + clearance || b.box.y2 < a.box.y1 - clearance) continue;
      if (!a.layers.some((l) => b.layers.includes(l))) continue;
      if (nets.get(a.key) === nets.get(b.key)) continue;
      if (a.type === 'track' && b.type === 'track' && a.ref === b.ref) continue;
      // Pads of one footprint are spaced by its designer.
      if (a.type === 'pad' && b.type === 'pad' && a.ref.split(':')[0] === b.ref.split(':')[0]) continue;
      const d = shapeDistance(a.shape, b.shape);
      if (d < clearance - 1e-6) {
        const pair = [a.ref, b.ref].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        issues.push({
          severity: 'error',
          message: d === 0 ? `${label(a, board, conn)} touches ${label(b, board, conn)} (different nets)` : `Clearance ${d.toFixed(3)} mm between ${label(a, board, conn)} and ${label(b, board, conn)} (min ${clearance} mm)`,
          at: center(a),
          refs: [a.ref.split(':')[0], b.ref.split(':')[0]],
        });
      }
    }
  }

  for (const s of conn.shorts) issues.push({ severity: 'error', message: `Short between nets ${s.nets.join(' and ')}`, at: s.at, refs: [] });

  for (const [net, n] of conn.unrouted) {
    if (n > 0) issues.push({ severity: 'error', message: `${net}: ${n} unrouted connection${n > 1 ? 's' : ''}`, at: null, refs: [] });
  }

  // Copper must sit on the board and keep clear of every edge: outline, cutouts, hole walls.
  const edges = boardEdges(pcb);
  const edge = 0.2;
  for (const it of board.items) {
    if (!insideBoard(center(it), edges) || shapeEdgeDistance(it.shape, edges) < edge) {
      issues.push({ severity: 'error', message: `${label(it, board, conn)} is outside the board or closer than ${edge} mm to an edge`, at: center(it), refs: [it.ref.split(':')[0]] });
    }
  }
  issues.push(...keepoutViolations(board, pcb, conn));
  issues.push(...silkIssues(board, pcb));

  // Vias in SMD pads, one line per pad (a grid of thermal vias would otherwise flood the list).
  const smdPads = board.items.filter((it) => it.type === 'pad' && it.layers.length === 1);
  const viasInPad = new Map<CopperItem, string[]>();
  for (const v of pcb.vias) {
    const via = board.items.find((it) => it.type === 'via' && it.ref === v.id)!;
    const pad = smdPads.find((p) => shapeDistance(p.shape, via.shape) === 0);
    if (pad) viasInPad.set(pad, [...(viasInPad.get(pad) ?? []), v.id]);
  }
  for (const [pad, ids] of viasInPad) {
    const what = ids.length > 1 ? `${ids.length} vias` : 'Via';
    issues.push({ severity: 'warning', message: `${what} in SMD pad ${label(pad, board)} (solder can wick into the holes unless JLCPCB tents or fills them)`, at: center(pad), refs: ids });
  }

  const netsOnBoard = new Set(board.pads.map((p) => p.net).filter(Boolean));
  for (const f of board.fills) {
    const where = `${f.pour.net} pour (${f.pour.layer})`;
    if (!netsOnBoard.has(f.pour.net)) issues.push({ severity: 'warning', message: `${where}: no pad is on net ${f.pour.net}`, at: null, refs: [f.pour.id] });
    else if (f.areas.length === 0) issues.push({ severity: 'warning', message: `${where} has no copper left after clearances`, at: null, refs: [f.pour.id] });
    for (const t of f.thermals) {
      if (t.spokes === 0) issues.push({ severity: 'warning', message: `${t.designator}.${t.number} is not reached by the ${where}`, at: t.center, refs: [] });
      else if (t.spokes === 1) issues.push({ severity: 'warning', message: `${t.designator}.${t.number} has only 1 thermal spoke to the ${where}`, at: t.center, refs: [] });
    }
  }

  for (const t of pcb.tracks) {
    if (t.width < pcb.rules.minTrackWidth) issues.push({ severity: 'warning', message: `Track narrower than ${pcb.rules.minTrackWidth} mm`, at: t.points[0], refs: [t.id] });
  }
  for (const c of board.missingFootprints) issues.push({ severity: 'warning', message: `${c.designator} has no footprint`, at: null, refs: [c.id] });
  issues.push(...copperUnderShells(board, pcb, conn));

  // Overlapping parts (by footprint bounding box).
  const parts = board.parts.filter((p) => p.fp);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const p = parts[i];
      const q = parts[j];
      if (p.placement.side !== q.placement.side) continue;
      const ox = Math.min(p.box.x2, q.box.x2) - Math.max(p.box.x1, q.box.x1);
      const oy = Math.min(p.box.y2, q.box.y2) - Math.max(p.box.y1, q.box.y1);
      if (ox > 0.05 && oy > 0.05) {
        issues.push({ severity: 'warning', message: `${p.component.designator} overlaps ${q.component.designator}`, at: [p.placement.x, p.placement.y], refs: [p.component.id, q.component.id] });
      }
    }
  }
  return issues;
}
