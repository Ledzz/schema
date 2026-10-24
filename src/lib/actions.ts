/*
 * High-level editing actions shared by the UI and the WebMCP tools.
 */
import type { PartDetail, PartSummary } from '../shared/parts';
import { useEditor, type Placing } from '../store/editor';
import { fetchPartDetail, fetchStock } from './api';
import { nextDesignator, splitDesignator } from './schematic/designators';
import { boxContains, boxIntersects, componentBox, normBox, onSegment, samePoint, snap, worldPins, type WorldPin } from './schematic/geometry';
import { portBox } from './schematic/hit';
import { analyze } from './schematic/netlist';
import { newId } from './schematic/ops';
import { autoRoute, portRotationFor, routePins, type RouteObstacles } from './schematic/route';
import { resolverFor, symbolFor } from './schematic/symbols';
import type { Component, NetPort, PortKind, Project, Rotation, StoredSymbol, Vec } from './schematic/types';

const state = () => useEditor.getState();

/** Loads part data and makes sure its symbol is stored in the project. */
export async function loadPart(lcsc: string): Promise<{ detail: PartDetail; symbolKey: string }> {
  const code = lcsc.trim().toUpperCase();
  const detail = await fetchPartDetail(code);
  const project = state().project;
  const key = detail.device?.symbol ? `lcsc:${code}` : `generic:${code}`;
  if (!project.symbols[key]) {
    const stored: StoredSymbol = detail.device?.symbol
      ? { title: detail.device.symbol.title || detail.device.title, dataStr: detail.device.symbol.dataStr, source: 'easyeda' }
      : { title: detail.part?.mpn ?? code, dataStr: '', source: 'generic', pinCount: 2 };
    state().addSymbols({ [key]: stored });
  }
  return { detail, symbolKey: key };
}

function partAttrs(detail: PartDetail): Record<string, string> {
  const a = detail.device?.attributes ?? {};
  const p = detail.part;
  const attrs: Record<string, string> = {
    Manufacturer: p?.manufacturer || a['Manufacturer'] || '',
    'Manufacturer Part': p?.mpn || a['Manufacturer Part'] || '',
    Package: p?.package || a['Supplier Footprint'] || '',
    Footprint: detail.device?.footprint?.title || a['Supplier Footprint'] || p?.package || '',
    Datasheet: p?.datasheet || a['Datasheet'] || '',
    Description: p?.description || '',
    Supplier: 'LCSC',
    'Supplier Part': p?.lcsc || detail.device?.lcsc || '',
  };
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v));
}

/** "R?" -> "R"; EasyEDA keeps the designator on the device rather than on every symbol. */
export function designatorPrefix(designator: string | undefined): string {
  return (designator ?? '').replace(/\?+$/, '').replace(/[^A-Za-z_]/g, '');
}

export function placingFromDetail(detail: PartDetail, symbolKey: string): Placing {
  const symbol = symbolFor(state().project, symbolKey);
  const p: PartSummary | null = detail.part;
  const value = detail.device?.attributes['Value'] || p?.mpn || detail.device?.title || symbol.title;
  return {
    symbolKey,
    prefix: designatorPrefix(detail.device?.attributes['Designator']) || symbol.prefix,
    template: {
      symbolKey,
      unit: 0,
      value,
      rotation: 0,
      mirror: false,
      lcsc: p?.lcsc ?? detail.device?.lcsc,
      partClass: p?.partClass,
      stock: p?.stock,
      prices: p?.prices,
      attrs: partAttrs(detail),
    },
  };
}

/** Starts interactive placement of a part (click on the canvas to drop it). */
export async function beginPlacePart(lcsc: string) {
  try {
    const { detail, symbolKey } = await loadPart(lcsc);
    state().startPlacing(placingFromDetail(detail, symbolKey));
  } catch (err) {
    state().notify(`Could not load ${lcsc}: ${(err as Error).message}`, 'error');
  }
}

/** Commits a component from a placement template. */
export function placeComponent(placing: Placing, at: Vec, rotation: Rotation = 0, mirror = false, designator?: string): Component {
  let created!: Component;
  state().commit((doc) => {
    created = {
      ...placing.template,
      id: newId('c'),
      x: snap(at[0]),
      y: snap(at[1]),
      rotation,
      mirror,
      attrs: { ...placing.template.attrs },
      designator: designator || nextDesignator(placing.prefix, doc.components),
    };
    return { ...doc, components: [...doc.components, created] };
  });
  return created;
}

/** Free spot to the right of the current drawing, used when no position is given. */
export function nextFreePosition(): Vec {
  const { project } = state();
  if (project.components.length === 0) return [0, 0];
  const xs = project.components.map((c) => c.x);
  const ys = project.components.map((c) => c.y);
  return [snap(Math.max(...xs) + 120, 10), snap(Math.min(...ys), 10)];
}

export async function placePartAt(
  lcsc: string,
  opts: { x?: number; y?: number; rotation?: Rotation; designator?: string; value?: string } = {},
): Promise<Component> {
  const { detail, symbolKey } = await loadPart(lcsc);
  const placing = placingFromDetail(detail, symbolKey);
  if (opts.value) placing.template.value = opts.value;
  const at: Vec = opts.x !== undefined && opts.y !== undefined ? [opts.x, opts.y] : nextFreePosition();
  return placeComponent(placing, at, opts.rotation ?? 0, false, opts.designator);
}

export function addPort(kind: PortKind, name: string, at: Vec, rotation: Rotation = 0): NetPort {
  const port: NetPort = { id: newId('n'), kind, name, x: snap(at[0]), y: snap(at[1]), rotation };
  state().commit((doc) => ({ ...doc, ports: [...doc.ports, port] }));
  return port;
}

export interface ResolvedPin extends WorldPin {
  component: Component;
}

/** Resolves "R1.2" / "U1.VIN" / "U1.PA9" style references. */
export function findPin(ref: string, project: Project = state().project): ResolvedPin {
  const m = /^\s*([^.\s]+)\.(.+?)\s*$/.exec(ref);
  if (!m) throw new Error(`Pin reference "${ref}" must look like R1.1 or U1.VIN`);
  const [, designator, pinKey] = m;
  const component = project.components.find((c) => c.designator.toLowerCase() === designator.toLowerCase());
  if (!component) throw new Error(`No component ${designator}`);
  const pins = worldPins(component, symbolFor(project, component.symbolKey));
  const lower = pinKey.toLowerCase();
  const pin =
    pins.find((p) => p.pin.number.toLowerCase() === lower) ??
    pins.find((p) => p.pin.name.toLowerCase() === lower) ??
    pins.find((p) => p.pin.name.toLowerCase().split(/[/\s]/).includes(lower));
  if (!pin) {
    const available = pins.map((p) => (p.pin.name && p.pin.name !== p.pin.number ? `${p.pin.number}(${p.pin.name})` : p.pin.number));
    throw new Error(`${designator} has no pin "${pinKey}". Pins: ${available.join(', ')}`);
  }
  return { ...pin, component };
}

function routeObstacles(project: Project, except: Vec[]): RouteObstacles {
  const resolve = resolverFor(project);
  const keep = (p: Vec) => !except.some((e) => samePoint(e, p));
  return {
    boxes: [...project.components.map((c) => componentBox(c, resolve(c.symbolKey))), ...project.ports.filter((p) => p.kind !== 'noconnect').map(portBox)],
    points: [
      ...project.components.flatMap((c) => worldPins(c, resolve(c.symbolKey)).map((p) => p.at)),
      ...project.wires.flatMap((w) => [w.points[0], w.points[w.points.length - 1]]),
      ...project.ports.map((p) => [p.x, p.y] as Vec),
    ].filter(keep),
    segments: project.wires.flatMap((w) => w.points.slice(1).map((p, i) => [w.points[i], p] as [Vec, Vec])),
  };
}

export function connectPins(a: string, b: string): { wireId: string; points: Vec[] } {
  const pa = findPin(a);
  const pb = findPin(b);
  const project = state().project;
  const obstacles = routeObstacles(project, [pa.at, pb.at]);
  const resolve = resolverFor(project);
  const bodiesOnly: RouteObstacles = { boxes: project.components.map((c) => componentBox(c, resolve(c.symbolKey))), points: [], segments: obstacles.segments };
  const attempts = [
    () => autoRoute(pa, pb, obstacles),
    () => autoRoute(pa, pb, obstacles, 5),
    // Crowded around the pins: only keep clear of part bodies.
    () => autoRoute(pa, pb, bodiesOnly, 5),
    () => routePins(pa, pb),
  ];
  let points: Vec[] | null = null;
  for (const attempt of attempts) {
    const r = attempt();
    if (r && !createsContact(project, r, [pa.at, pb.at])) {
      points = r;
      break;
    }
  }
  if (!points) throw new Error(`Cannot wire ${a} to ${b} without touching other connections; use net labels on both pins instead`);
  const id = newId('w');
  state().commit((doc) => ({ ...doc, wires: [...doc.wires, { id, points }] }));
  return { wireId: id, points };
}

type FlagLayout = { points: Vec[]; rotation: Rotation };

/** Candidate stub/flag layouts for a pin, most conventional first. */
function flagLayouts(pin: ResolvedPin, kind: Exclude<PortKind, 'noconnect'>): FlagLayout[] {
  const out: Vec = [-pin.dir[0], -pin.dir[1]];
  const along = (k: number): Vec => [pin.at[0] + out[0] * k, pin.at[1] + out[1] * k];
  const straight = (len: number): FlagLayout => ({ points: [pin.at, along(len)], rotation: portRotationFor(kind, out) });
  if (kind === 'label' || out[1] !== 0) return [20, 30, 40, 60, 80].map(straight);
  // Power flags point up and ground flags down, so turn the stub vertical.
  const v = kind === 'power' ? -1 : 1;
  const elbow = (len: number, rise: number): FlagLayout => {
    const e = along(len);
    return { points: [pin.at, e, [e[0], e[1] + v * rise]], rotation: 0 };
  };
  // Upright flags first; sideways ones keep dense pin columns (e.g. SOT-223) wireable.
  return [elbow(10, 10), elbow(20, 10), straight(20), straight(30), elbow(30, 10), elbow(40, 10), straight(40), elbow(60, 10), straight(60), elbow(20, 30), straight(80)];
}

/**
 * Whether a new wire would electrically touch existing wiring: its far end on another pin, wire
 * or label anchor (including mid-wire T-junctions), or an existing wire end / anchor on it.
 */
function createsContact(project: Project, points: Vec[], allowed: Vec[]): boolean {
  const resolve = resolverFor(project);
  const ok = (p: Vec) => allowed.some((a) => samePoint(a, p));
  const end = points[points.length - 1];
  const segs = points.slice(1).map((p, i) => [points[i], p] as [Vec, Vec]);
  if (!ok(end)) {
    const pins = project.components.flatMap((c) => worldPins(c, resolve(c.symbolKey)).map((p) => p.at));
    if (pins.some((p) => samePoint(p, end))) return true;
    for (const w of project.wires) for (let i = 1; i < w.points.length; i++) if (onSegment(end, w.points[i - 1], w.points[i])) return true;
  }
  const anchors = [
    ...project.wires.flatMap((w) => [w.points[0], w.points[w.points.length - 1]]),
    ...project.ports.filter((p) => p.kind !== 'noconnect').map((p) => [p.x, p.y] as Vec),
  ].filter((a) => !ok(a));
  return anchors.some((a) => segs.some(([p, q]) => onSegment(a, p, q)));
}

/** Number of collisions between a flag layout and the drawing (0 = clear, Infinity = would short). */
function layoutConflicts(project: Project, layout: FlagLayout, port: NetPort, self: Vec): number {
  const resolve = resolverFor(project);
  const flag = portBox(port);
  const compBoxes = project.components.map((c) => componentBox(c, resolve(c.symbolKey)));
  const stubPoints = layout.points.slice(1);
  let conflicts = 0;
  for (const b of compBoxes) if (boxIntersects(b, flag) || stubPoints.some((p) => boxContains(b, p, -0.5))) conflicts += 3;
  // Keep the lane in front of every other pin free so it can still be wired.
  const lanes = project.components.flatMap((c) =>
    worldPins(c, resolve(c.symbolKey))
      .filter((p) => !samePoint(p.at, self))
      .map((p) => {
        const b = normBox(p.at, [p.at[0] - p.dir[0] * 30, p.at[1] - p.dir[1] * 30]);
        return { x1: b.x1 - 1, y1: b.y1 - 1, x2: b.x2 + 1, y2: b.y2 + 1 };
      }),
  );
  const stubBoxes = layout.points.slice(1).map((p, i) => normBox(layout.points[i], p));
  for (const lane of lanes) if (boxIntersects(lane, flag) || stubBoxes.some((s) => boxIntersects(lane, s))) conflicts += 2;
  for (const p of project.ports) {
    const box = portBox(p);
    if (boxIntersects(box, flag) || stubBoxes.some((s) => boxIntersects(box, s))) conflicts += 2;
  }
  for (const w of project.wires) {
    for (let i = 1; i < w.points.length; i++) {
      const seg = normBox(w.points[i - 1], w.points[i]);
      if (boxIntersects(seg, flag) || stubBoxes.some((s) => boxIntersects(seg, s))) conflicts += 1;
    }
  }
  // Any electrical contact with other wiring would short the new net to it: forbidden.
  if (createsContact(project, layout.points, [self])) return Infinity;
  return conflicts;
}

/** Adds a short wire stub from a pin with a label, power or ground flag at its end. */
export function attachPort(pinRef: string, kind: Exclude<PortKind, 'noconnect'>, name: string): NetPort {
  const pin = findPin(pinRef);
  const project = state().project;
  const toPort = (l: FlagLayout): NetPort => {
    const end = l.points[l.points.length - 1];
    return { id: newId('n'), kind, name, x: end[0], y: end[1], rotation: l.rotation };
  };
  // First conflict-free layout, otherwise the least conflicting one.
  let layout = flagLayouts(pin, kind)[0];
  let best = Infinity;
  for (const l of flagLayouts(pin, kind)) {
    const n = layoutConflicts(project, l, toPort(l), pin.at);
    if (n < best) {
      best = n;
      layout = l;
    }
    if (n === 0) break;
  }
  if (best === Infinity) {
    throw new Error(`No room to attach a ${kind === 'label' ? 'label' : 'flag'} to ${pinRef} without touching other wiring; move parts apart or connect it with a wire`);
  }
  const { points } = layout;
  const port = toPort(layout);
  state().commit((doc) => ({
    ...doc,
    wires: [...doc.wires, { id: newId('w'), points }],
    ports: [...doc.ports, port],
  }));
  return port;
}

export function markNoConnect(pinRef: string): NetPort {
  const pin = findPin(pinRef);
  return addPort('noconnect', '', pin.at, 0);
}

export async function replacePart(componentId: string, lcsc: string): Promise<Component | null> {
  const { detail, symbolKey } = await loadPart(lcsc);
  const placing = placingFromDetail(detail, symbolKey);
  let updated: Component | null = null;
  state().commit((doc) => ({
    ...doc,
    components: doc.components.map((c) => {
      if (c.id !== componentId) return c;
      const { prefix } = splitDesignator(c.designator);
      const keepDesignator = prefix === placing.prefix;
      updated = {
        ...c,
        ...placing.template,
        rotation: c.rotation,
        mirror: c.mirror,
        designator: keepDesignator ? c.designator : nextDesignator(placing.prefix, doc.components),
      };
      return updated;
    }),
  }));
  return updated;
}

/** Opens the library on basic/preferred parts similar to a component, ready to replace it. */
export function findNoFeeAlternative(c: Component) {
  const pkg = c.attrs['Package'] ?? '';
  const passive = /^[RCLFD]B?$/i.test(c.designator.replace(/\d+$/, ''));
  const base = passive ? c.value.replace(/[Ω±]/g, '').replace(/\s+/g, ' ') : (c.attrs['Manufacturer Part'] ?? c.value).replace(/[-_].*$/, '');
  state().requestLibrary(`${base} ${passive ? pkg : ''}`.trim(), c.id, ['basic', 'preferred']);
}

/** Refreshes stock levels of every placed LCSC part. */
export async function refreshStock(): Promise<number> {
  const codes = [...new Set(state().project.components.map((c) => c.lcsc).filter((c): c is string => !!c))];
  if (codes.length === 0) return 0;
  const rows = await fetchStock(codes);
  const byCode = new Map(rows.map((r) => [r.lcsc.toUpperCase(), r]));
  state().commit((doc) => ({
    ...doc,
    components: doc.components.map((c) => {
      const row = c.lcsc ? byCode.get(c.lcsc.toUpperCase()) : undefined;
      if (!row) return c;
      // Keep "preferred" when the bulk endpoint only says "expand".
      const partClass = row.libraryType === 'base' ? 'basic' : c.partClass === 'preferred' ? 'preferred' : row.libraryType === 'expand' ? 'extended' : c.partClass;
      return { ...c, stock: row.stock, partClass };
    }),
  }));
  return rows.length;
}

export function connectivity(project: Project = state().project) {
  return analyze(project, resolverFor(project));
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (name: string) => name.replace(/[^\w.-]+/g, '_') || 'schematic';
