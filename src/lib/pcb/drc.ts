import type { Vec } from '../schematic/types';
import type { BoardModel, PcbConnectivity } from './board';
import { shapeDistance, type CopperItem } from './geometry';
import type { Pcb } from './types';

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

const label = (it: CopperItem, board: BoardModel) => {
  if (it.type === 'pad') {
    const [cid, idx] = it.ref.split(':');
    const pad = board.pads.find((p) => p.componentId === cid && p.index === Number(idx));
    return pad ? `${pad.designator}.${pad.number}` : 'pad';
  }
  return it.type;
};

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
          message: d === 0 ? `${label(a, board)} touches ${label(b, board)} (different nets)` : `Clearance ${d.toFixed(3)} mm between ${label(a, board)} and ${label(b, board)} (min ${clearance} mm)`,
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

  const { board: b } = pcb;
  const edge = 0.2;
  for (const it of board.items) {
    if (it.box.x1 < b.x + edge || it.box.y1 < b.y + edge || it.box.x2 > b.x + b.width - edge || it.box.y2 > b.y + b.height - edge) {
      issues.push({ severity: 'error', message: `${label(it, board)} is outside the board or closer than ${edge} mm to the edge`, at: center(it), refs: [it.ref.split(':')[0]] });
    }
  }

  const smdPads = board.items.filter((it) => it.type === 'pad' && it.layers.length === 1);
  for (const v of pcb.vias) {
    const via = board.items.find((it) => it.type === 'via' && it.ref === v.id)!;
    const pad = smdPads.find((p) => shapeDistance(p.shape, via.shape) === 0);
    if (pad) issues.push({ severity: 'warning', message: `Via in SMD pad ${label(pad, board)} (solder can wick into the hole)`, at: [v.x, v.y], refs: [v.id] });
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
