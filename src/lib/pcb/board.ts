import { analyze } from '../schematic/netlist';
import { resolverFor, symbolFor } from '../schematic/symbols';
import { unitOf } from '../schematic/geometry';
import type { Component, Project, Vec } from '../schematic/types';
import { parsePcbFootprint, type FootprintGeom, type Graphic } from './footprint';
import { fillPour, pointInArea, type PourFill } from './pour';
import {
  boardOutline,
  padItem,
  placementBox,
  pointInPolygon,
  pointSegDist,
  trackItems,
  viaItem,
  worldGraphics,
  worldPads,
  type Box,
  type CopperItem,
  type WorldPad,
} from './geometry';
import type { CopperLayer, Pcb, Placement, StoredFootprint } from './types';

const parsed = new WeakMap<StoredFootprint, FootprintGeom>();

export function footprintGeom(stored: StoredFootprint | undefined): FootprintGeom | null {
  if (!stored) return null;
  let g = parsed.get(stored);
  if (!g) {
    g = parsePcbFootprint(stored.dataStr);
    parsed.set(stored, g);
  }
  return g;
}

export interface BoardPart {
  placement: Placement;
  component: Component;
  fp: FootprintGeom | null;
  box: Box;
  pads: WorldPad[];
  graphics: Graphic[];
}

export interface BoardModel {
  parts: BoardPart[];
  pads: WorldPad[];
  items: CopperItem[];
  /** Filled copper pours. */
  fills: PourFill[];
  /** Schematic pin net by component id and pin number. */
  pinNets: Map<string, Map<string, string>>;
  missingFootprints: Component[];
}

/** Pin number -> net for every component, from the schematic. */
export function schematicPinNets(project: Project): Map<string, Map<string, string>> {
  const resolve = resolverFor(project);
  const conn = analyze(project, resolve);
  const out = new Map<string, Map<string, string>>();
  for (const c of project.components) {
    const nets = new Map<string, string>();
    for (const pin of unitOf(symbolFor(project, c.symbolKey), c.unit).pins) {
      const net = conn.pinNet.get(`${c.id}:${pin.id}`);
      if (net) nets.set(pin.number, net);
    }
    out.set(c.id, nets);
  }
  return out;
}

export function buildBoard(project: Project, pcb: Pcb): BoardModel {
  const pinNets = schematicPinNets(project);
  const byId = new Map(project.components.map((c) => [c.id, c]));
  const parts: BoardPart[] = [];
  const missingFootprints: Component[] = [];
  for (const placement of pcb.placements) {
    const component = byId.get(placement.componentId);
    if (!component) continue;
    const key = pcb.footprintOf[component.id];
    const fp = key ? footprintGeom(pcb.footprints[key]) : null;
    if (!fp) {
      missingFootprints.push(component);
      parts.push({ placement, component, fp: null, box: { x1: placement.x - 1, y1: placement.y - 1, x2: placement.x + 1, y2: placement.y + 1 }, pads: [], graphics: [] });
      continue;
    }
    const nets = pinNets.get(component.id);
    parts.push({
      placement,
      component,
      fp,
      box: placementBox(placement, fp),
      pads: worldPads(placement, fp, component.designator, (n) => nets?.get(n) ?? null),
      graphics: worldGraphics(placement, fp),
    });
  }
  const pads = parts.flatMap((p) => p.pads);
  const items = [...pads.map(padItem), ...pcb.tracks.flatMap(trackItems), ...pcb.vias.map(viaItem)];
  const outline = boardOutline(pcb.board);
  const fills = (pcb.pours ?? []).map((pour) => fillPour(pour, { pcb, boardOutline: outline, items, pads }));
  return { parts, pads, items, fills, pinNets, missingFootprints };
}

/* ---------- connectivity ---------- */

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.parent.set(x, r);
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface Airwire {
  net: string;
  a: Vec;
  b: Vec;
  /** Copper layers available at each end. */
  aLayers: CopperLayer[];
  bLayers: CopperLayer[];
}

interface Anchor {
  p: Vec;
  layers: CopperLayer[];
}

export interface Short {
  nets: string[];
  at: Vec;
}

export interface PcbConnectivity {
  airwires: Airwire[];
  /** net -> number of unrouted connections */
  unrouted: Map<string, number>;
  shorts: Short[];
  /** track/via id -> net reached through copper */
  itemNet: Map<string, string>;
}

const nodeOf = (it: CopperItem) => (it.type === 'pad' ? `p:${it.ref}` : it.type === 'via' ? `v:${it.ref}` : `t:${it.ref}`);

function endpointTouches(p: Vec, layer: CopperLayer, it: CopperItem): boolean {
  if (!it.layers.includes(layer)) return false;
  const s = it.shape;
  if (s.kind === 'capsule') return pointSegDist(p, s.a, s.b) <= s.r + 1e-3;
  return pointInPolygon(p, s.points);
}

export function pcbConnectivity(board: BoardModel, pcb: Pcb): PcbConnectivity {
  const uf = new UnionFind();
  const items = board.items;

  // Track ends connect to whatever copper they land on; vias connect to pads/tracks they sit on.
  for (const t of pcb.tracks) {
    if (t.points.length < 2) continue;
    for (const end of [t.points[0], t.points[t.points.length - 1]]) {
      for (const it of items) {
        if (it.ref === t.id && it.type === 'track') continue;
        if (it.box.x1 > end[0] + 0.5 || it.box.x2 < end[0] - 0.5 || it.box.y1 > end[1] + 0.5 || it.box.y2 < end[1] - 0.5) continue;
        if (endpointTouches(end, t.layer, it)) uf.union(`t:${t.id}`, nodeOf(it));
      }
    }
  }
  for (const v of pcb.vias) {
    for (const it of items) {
      if (it.type === 'via' && it.ref === v.id) continue;
      if (endpointTouches([v.x, v.y], 'top', it) || endpointTouches([v.x, v.y], 'bottom', it)) uf.union(`v:${v.id}`, nodeOf(it));
    }
  }

  // Copper pours: each filled island joins the same-net copper it covers.
  for (const f of board.fills) {
    f.areas.forEach((area, i) => {
      const node = `z:${f.pour.id}:${i}`;
      for (const p of board.pads) if (p.net === f.pour.net && p.layers.includes(f.pour.layer) && pointInArea(p.center, area)) uf.union(node, `p:${p.componentId}:${p.index}`);
      for (const v of pcb.vias) if (v.net === f.pour.net && pointInArea([v.x, v.y], area)) uf.union(node, `v:${v.id}`);
      for (const t of pcb.tracks) {
        if (t.layer !== f.pour.layer || t.net !== f.pour.net) continue;
        if (pointInArea(t.points[0], area) || pointInArea(t.points[t.points.length - 1], area)) uf.union(node, `t:${t.id}`);
      }
    });
  }

  // Group pads per net and per copper island.
  const shorts: Short[] = [];
  const islandNets = new Map<string, Set<string>>();
  for (const p of board.pads) {
    if (!p.net) continue;
    const r = uf.find(`p:${p.componentId}:${p.index}`);
    if (!islandNets.has(r)) islandNets.set(r, new Set());
    islandNets.get(r)!.add(p.net);
  }
  const reported = new Set<string>();
  for (const [root, nets] of islandNets) {
    if (nets.size > 1 && !reported.has(root)) {
      reported.add(root);
      const pad = board.pads.find((p) => uf.find(`p:${p.componentId}:${p.index}`) === root)!;
      shorts.push({ nets: [...nets].sort(), at: pad.center });
    }
  }

  const itemNet = new Map<string, string>();
  for (const it of items) {
    if (it.type === 'pad') continue;
    const nets = islandNets.get(uf.find(nodeOf(it)));
    if (nets?.size === 1) itemNet.set(it.ref, [...nets][0]);
  }

  // Ratsnest: minimum spanning tree between the islands of each net.
  const airwires: Airwire[] = [];
  const unrouted = new Map<string, number>();
  const padsByNet = new Map<string, WorldPad[]>();
  for (const p of board.pads) if (p.net) padsByNet.set(p.net, [...(padsByNet.get(p.net) ?? []), p]);
  for (const [net, pads] of padsByNet) {
    const islands = new Map<string, Anchor[]>();
    for (const p of pads) {
      const r = uf.find(`p:${p.componentId}:${p.index}`);
      islands.set(r, [...(islands.get(r) ?? []), { p: p.center, layers: p.layers }]);
    }
    if (islands.size < 2) continue;
    // Track vertices and vias of each island are possible airwire anchors too.
    for (const t of pcb.tracks) {
      const r = uf.find(`t:${t.id}`);
      if (islands.has(r)) islands.get(r)!.push(...t.points.map((p) => ({ p, layers: [t.layer] })));
    }
    for (const v of pcb.vias) {
      const r = uf.find(`v:${v.id}`);
      if (islands.has(r)) islands.get(r)!.push({ p: [v.x, v.y], layers: ['top', 'bottom'] });
    }
    const groups = [...islands.values()];
    const connected = new Set([0]);
    while (connected.size < groups.length) {
      let best: { d: number; j: number; a: Anchor; b: Anchor } | null = null;
      for (const i of connected) {
        for (let j = 0; j < groups.length; j++) {
          if (connected.has(j)) continue;
          for (const a of groups[i])
            for (const b of groups[j]) {
              const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
              if (!best || d < best.d) best = { d, j, a, b };
            }
        }
      }
      if (!best) break;
      connected.add(best.j);
      airwires.push({ net, a: best.a.p, b: best.b.p, aLayers: best.a.layers, bLayers: best.b.layers });
    }
    unrouted.set(net, groups.length - 1);
  }
  return { airwires, unrouted, shorts, itemNet };
}
