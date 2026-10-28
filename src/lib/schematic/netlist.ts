import { onSegment, pointKey, samePoint, worldPins } from './geometry';
import { blockPins, sheetOf, sheetsOf } from './sheets';
import type { SymbolResolver } from './symbols';
import type { Component, NetPort, Project, Vec, Wire } from './types';

/*
 * Connectivity rules (similar to EasyEDA / KiCad):
 *  - items whose connection points coincide are connected (pin, wire end, label/power anchor);
 *  - a wire end, label or power anchor lying anywhere on a wire connects to that wire (T-junction);
 *  - a pin in the middle of a wire is NOT connected (the wire has to end on it);
 *  - labels, power and ground flags with the same name are connected globally.
 */

export interface NetMember {
  componentId: string;
  designator: string;
  pinId: string;
  pinNumber: string;
  pinName: string;
}

export interface Net {
  name: string;
  /** True when no label/power flag names the net. */
  auto: boolean;
  members: NetMember[];
  names: string[];
}

export interface PinRef {
  componentId: string;
  designator: string;
  pinId: string;
  pinNumber: string;
  pinName: string;
  at: Vec;
}

export interface ErcIssue {
  severity: 'error' | 'warning';
  message: string;
  at?: Vec;
  itemId?: string;
}

export interface Connectivity {
  nets: Net[];
  /** `${componentId}:${pinId}` (or `${blockId}:${port}` for a block's pin) -> net name */
  pinNet: Map<string, string>;
  /** wire / port id -> net name */
  itemNet: Map<string, string>;
  junctions: { at: Vec; sheet: string }[];
  unconnected: PinRef[];
  issues: ErcIssue[];
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const segments = (w: Wire): [Vec, Vec][] => w.points.slice(1).map((p, i) => [w.points[i], p]);
const NAMED_PORTS = new Set<NetPort['kind']>(['label', 'power', 'ground']);

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function analyze(project: Pick<Project, 'components' | 'wires' | 'ports' | 'sheets' | 'blocks'>, symbols: SymbolResolver): Connectivity {
  const uf = new UnionFind();
  // Geometry only connects things on the same sheet.
  const at = (sheet: string, p: Vec) => `${sheet}|${pointKey(p)}`;
  const sheetName = new Map(sheetsOf(project).map((sh) => [sh.id, sh.name]));
  const atPoint = new Map<string, string[]>();
  const add = (sheet: string, p: Vec, node: string) => {
    const k = at(sheet, p);
    const list = atPoint.get(k);
    if (list) list.push(node);
    else atPoint.set(k, [node]);
  };

  const pins: (PinRef & { node: string; sheet: string })[] = [];
  for (const c of project.components) {
    for (const wp of worldPins(c, symbols(c.symbolKey))) {
      const node = `p:${c.id}:${wp.pin.id}`;
      pins.push({
        node,
        sheet: sheetOf(c, project),
        componentId: c.id,
        designator: c.designator,
        pinId: wp.pin.id,
        pinNumber: wp.pin.number,
        pinName: wp.pin.name,
        at: wp.at,
      });
      add(sheetOf(c, project), wp.at, node);
    }
  }

  const noConnect = new Set<string>();
  const namedPorts = project.ports.filter((p) => NAMED_PORTS.has(p.kind));
  const hierPorts = project.ports.filter((p) => p.kind === 'hier');
  for (const p of project.ports) {
    if (p.kind === 'noconnect') noConnect.add(at(sheetOf(p, project), [p.x, p.y]));
    else add(sheetOf(p, project), [p.x, p.y], `n:${p.id}`);
  }

  // Block pins, joined to the hierarchical ports of the same name on the block's sheet.
  const blockNodes: string[] = [];
  for (const b of project.blocks ?? []) {
    for (const pin of blockPins(b)) {
      const node = `b:${b.id}:${pin.name}`;
      blockNodes.push(node);
      add(sheetOf(b, project), pin.at, node);
      uf.union(node, `hier:${b.child}:${pin.name}`);
    }
  }

  const wireEnds: { wire: Wire; at: Vec }[] = [];
  for (const w of project.wires) {
    if (w.points.length < 2) continue;
    const ends = [w.points[0], w.points[w.points.length - 1]];
    for (const e of ends) {
      wireEnds.push({ wire: w, at: e });
      add(sheetOf(w, project), e, `w:${w.id}`);
    }
  }

  // Coincident connection points.
  for (const nodes of atPoint.values()) for (let i = 1; i < nodes.length; i++) uf.union(nodes[0], nodes[i]);

  // T-junctions: wire ends and port anchors anywhere on a wire of the same sheet. Candidates
  // come from a coarse grid of cells, so a sheet with hundreds of wires is not every end
  // against every segment (which took ~100 ms and made big schematics stutter).
  const passThrough = new Map<string, number>();
  const anchored = project.ports.filter((p) => p.kind !== 'noconnect');
  const CELL = 50;
  const cellOf = (sheet: string, p: Vec) => `${sheet}|${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
  const endsByCell = new Map<string, number[]>();
  wireEnds.forEach((e, i) => {
    const k = cellOf(sheetOf(e.wire, project), e.at);
    const list = endsByCell.get(k);
    if (list) list.push(i);
    else endsByCell.set(k, [i]);
  });
  const portsByCell = new Map<string, NetPort[]>();
  for (const p of anchored) {
    const k = cellOf(sheetOf(p, project), [p.x, p.y]);
    const list = portsByCell.get(k);
    if (list) list.push(p);
    else portsByCell.set(k, [p]);
  }
  // The cells a segment's bounding box touches, one further on each side for points on a boundary.
  const cellsAlong = (sheet: string, a: Vec, b: Vec): string[] => {
    const x1 = Math.floor(Math.min(a[0], b[0]) / CELL) - 1;
    const x2 = Math.floor(Math.max(a[0], b[0]) / CELL) + 1;
    const y1 = Math.floor(Math.min(a[1], b[1]) / CELL) - 1;
    const y2 = Math.floor(Math.max(a[1], b[1]) / CELL) + 1;
    const out: string[] = [];
    for (let cx = x1; cx <= x2; cx++) for (let cy = y1; cy <= y2; cy++) out.push(`${sheet}|${cx},${cy}`);
    return out;
  };
  for (const w of project.wires) {
    const sheet = sheetOf(w, project);
    for (const [a, b] of segments(w)) {
      const seenEnds = new Set<number>();
      for (const k of cellsAlong(sheet, a, b)) {
        for (const i of endsByCell.get(k) ?? []) {
          if (seenEnds.has(i)) continue;
          seenEnds.add(i);
          const e = wireEnds[i];
          if (e.wire === w || !onSegment(e.at, a, b)) continue;
          uf.union(`w:${w.id}`, `w:${e.wire.id}`);
          if (!samePoint(e.at, a) && !samePoint(e.at, b)) {
            const key = at(sheet, e.at);
            passThrough.set(key, (passThrough.get(key) ?? 0) + 2);
          }
        }
        for (const p of portsByCell.get(k) ?? []) if (onSegment([p.x, p.y], a, b)) uf.union(`w:${w.id}`, `n:${p.id}`);
      }
    }
  }

  // Same-named labels and power flags, on any sheet; hierarchical ports only reach their blocks.
  for (const p of namedPorts) if (p.name.trim()) uf.union(`n:${p.id}`, `name:${p.name.trim()}`);
  for (const p of hierPorts) if (p.name.trim()) uf.union(`n:${p.id}`, `hier:${sheetOf(p, project)}:${p.name.trim()}`);

  // Junction dots where three or more wire ends / pins meet.
  const junctions: { at: Vec; sheet: string }[] = [];
  const seen = new Set<string>();
  for (const e of wireEnds) {
    const sheet = sheetOf(e.wire, project);
    const k = at(sheet, e.at);
    if (seen.has(k)) continue;
    seen.add(k);
    const items = (atPoint.get(k) ?? []).filter((n) => !n.startsWith('n:')).length + (passThrough.get(k) ?? 0);
    if (items >= 3) junctions.push({ at: e.at, sheet });
  }

  // Group pins into nets.
  const groupSize = new Map<string, number>();
  const allNodes = [
    ...pins.map((p) => p.node),
    ...project.wires.map((w) => `w:${w.id}`),
    ...project.ports.filter((p) => p.kind !== 'noconnect').map((p) => `n:${p.id}`),
    ...blockNodes,
  ];
  for (const n of allNodes) {
    const r = uf.find(n);
    groupSize.set(r, (groupSize.get(r) ?? 0) + 1);
  }
  const namesByRoot = new Map<string, Set<string>>();
  const priority = new Map<string, number>();
  for (const p of namedPorts) {
    const name = p.name.trim();
    if (!name) continue;
    const r = uf.find(`n:${p.id}`);
    if (!namesByRoot.has(r)) namesByRoot.set(r, new Set());
    namesByRoot.get(r)!.add(name);
    priority.set(name, Math.min(priority.get(name) ?? 9, p.kind === 'label' ? 1 : 0));
  }
  // A net named only by hierarchical ports takes "sheet/port": the same port name on two sheets
  // belongs to two different nets.
  for (const p of hierPorts) {
    if (!p.name.trim()) continue;
    const name = `${sheetName.get(sheetOf(p, project)) ?? 'Sheet'}/${p.name.trim()}`;
    const r = uf.find(`n:${p.id}`);
    if (!namesByRoot.has(r)) namesByRoot.set(r, new Set());
    namesByRoot.get(r)!.add(name);
    priority.set(name, 2);
  }

  const byRoot = new Map<string, NetMember[]>();
  const unconnected: PinRef[] = [];
  const issues: ErcIssue[] = [];
  for (const p of pins) {
    const r = uf.find(p.node);
    const nc = noConnect.has(at(p.sheet, p.at));
    if ((groupSize.get(r) ?? 1) <= 1) {
      if (!nc) unconnected.push(p);
      continue;
    }
    if (nc) issues.push({ severity: 'warning', message: `${p.designator} pin ${p.pinNumber} is marked no-connect but is connected`, at: p.at, itemId: p.componentId });
    const members = byRoot.get(r) ?? [];
    members.push({ componentId: p.componentId, designator: p.designator, pinId: p.pinId, pinNumber: p.pinNumber, pinName: p.pinName });
    byRoot.set(r, members);
  }

  const nets: Net[] = [];
  const pinNet = new Map<string, string>();
  const rootName = new Map<string, string>();
  for (const [root, members] of byRoot) {
    members.sort((a, b) => naturalCompare(a.designator, b.designator) || naturalCompare(a.pinNumber, b.pinNumber));
    const names = [...(namesByRoot.get(root) ?? [])].sort((a, b) => (priority.get(a) ?? 9) - (priority.get(b) ?? 9) || naturalCompare(a, b));
    const name = names[0] ?? `Net-(${members[0].designator}-Pad${members[0].pinNumber})`;
    // Two power flags on one net (e.g. +3V3 and GND) is a short, not just an alias.
    const flagNames = names.filter((n) => priority.get(n) === 0);
    const given = names.filter((n) => (priority.get(n) ?? 9) < 2);
    if (flagNames.length > 1) issues.push({ severity: 'error', message: `Power nets shorted together: ${flagNames.join(', ')}` });
    else if (given.length > 1) issues.push({ severity: 'warning', message: `Net has several names: ${given.join(', ')}` });
    if (members.length === 1 && names.length === 0) {
      issues.push({ severity: 'warning', message: `${members[0].designator} pin ${members[0].pinNumber} is wired to nothing else`, itemId: members[0].componentId });
    }
    nets.push({ name, auto: names.length === 0, members, names });
    rootName.set(root, name);
    for (const m of members) pinNet.set(`${m.componentId}:${m.pinId}`, name);
  }
  const itemNet = new Map<string, string>();
  const nameOf = (node: string) => {
    const r = uf.find(node);
    return rootName.get(r) ?? [...(namesByRoot.get(r) ?? [])][0];
  };
  for (const w of project.wires) {
    const n = nameOf(`w:${w.id}`);
    if (n) itemNet.set(w.id, n);
  }
  for (const p of [...namedPorts, ...hierPorts]) {
    const n = nameOf(`n:${p.id}`);
    if (n) itemNet.set(p.id, n);
  }
  for (const node of blockNodes) {
    const n = nameOf(node);
    if (n) pinNet.set(node.slice(2), n);
  }
  // A hierarchical port no block uses leads nowhere.
  const used = new Set((project.blocks ?? []).map((b) => b.child));
  for (const p of hierPorts) {
    const sheet = sheetOf(p, project);
    if (!used.has(sheet)) issues.push({ severity: 'warning', message: `Hierarchical port ${p.name} on ${sheetName.get(sheet) ?? 'a sheet'} has no block using that sheet`, at: [p.x, p.y], itemId: p.id });
  }
  nets.sort((a, b) => Number(a.auto) - Number(b.auto) || naturalCompare(a.name, b.name));

  for (const p of unconnected) {
    issues.push({ severity: 'warning', message: `${p.designator} pin ${p.pinNumber}${p.pinName && p.pinName !== p.pinNumber ? ` (${p.pinName})` : ''} is unconnected`, at: p.at, itemId: p.componentId });
  }
  const designators = new Map<string, Component[]>();
  for (const c of project.components) designators.set(c.designator, [...(designators.get(c.designator) ?? []), c]);
  for (const [d, list] of designators) {
    if (list.length > 1) issues.push({ severity: 'error', message: `Duplicate designator ${d}`, itemId: list[1].id });
    if (d.endsWith('?')) issues.push({ severity: 'error', message: `${d} is not annotated`, itemId: list[0].id });
  }

  return { nets, pinNet, itemNet, junctions, unconnected, issues };
}

/** Plain-text netlist ("NET name: R1.1 U1.3 …"). */
export function formatNetlist(conn: Connectivity): string {
  return conn.nets.map((n) => `${n.name}: ${n.members.map((m) => `${m.designator}.${m.pinNumber}`).join(' ')}`).join('\n');
}
