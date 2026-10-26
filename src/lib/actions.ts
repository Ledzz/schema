/*
 * High-level editing actions shared by the UI and the WebMCP tools.
 */
import type { PartDetail, PartSummary } from '../shared/parts';
import { useEditor, type Placing } from '../store/editor';
import { fetchPartDetail, fetchStock } from './api';
import { nextDesignator } from './schematic/designators';
import { boxContains, boxIntersects, componentBox, normBox, onSegment, samePoint, snap, worldPins, type WorldPin } from './schematic/geometry';
import { portBox } from './schematic/hit';
import { analyze } from './schematic/netlist';
import { dropNoConnects, newId } from './schematic/ops';
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

/**
 * Shift that puts as many of a component's pins as possible on the 10-unit wiring grid. Library
 * symbols with an even number of pins per side are centred between two pins, 5 units off it.
 */
export function pinGridOffset(c: Omit<Component, 'id' | 'designator'>, project: Project = state().project): Vec {
  const pins = worldPins(c, symbolFor(project, c.symbolKey)).map((p) => p.at);
  const fix = (v: number) => snap(v, 10) - v;
  const onGrid = (p: Vec, d: Vec) => Math.abs(fix(p[0] + d[0])) < 0.01 && Math.abs(fix(p[1] + d[1])) < 0.01;
  let best: Vec = [0, 0];
  let most = pins.filter((p) => onGrid(p, best)).length;
  for (const p of pins) {
    const d: Vec = [fix(p[0]), fix(p[1])];
    const n = pins.filter((q) => onGrid(q, d)).length;
    if (n > most) [best, most] = [d, n];
  }
  return best;
}

/** Placement position (snapped) adjusted so the part's pins land on the 10-unit grid. */
export function onPinGrid(placing: Placing, at: Vec, rotation: Rotation): Vec {
  const probe = { ...placing.template, x: snap(at[0]), y: snap(at[1]), rotation, mirror: false };
  const [dx, dy] = pinGridOffset(probe);
  return [probe.x + dx, probe.y + dy];
}

export async function placePartAt(
  lcsc: string,
  opts: { x?: number; y?: number; rotation?: Rotation; designator?: string; value?: string } = {},
): Promise<Component> {
  const { detail, symbolKey } = await loadPart(lcsc);
  const placing = placingFromDetail(detail, symbolKey);
  if (opts.value) placing.template.value = opts.value;
  const at: Vec = opts.x !== undefined && opts.y !== undefined ? [opts.x, opts.y] : nextFreePosition();
  const rotation = opts.rotation ?? 0;
  return placeComponent(placing, onPinGrid(placing, at, rotation), rotation, false, opts.designator);
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

/** Resolves a `${componentId}:${pinId}` key, as hit testing and connectivity report pins. */
export function pinByKey(key: string, project: Project = state().project): ResolvedPin | null {
  const i = key.indexOf(':');
  const component = project.components.find((c) => c.id === key.slice(0, i));
  const pin = component && worldPins(component, symbolFor(project, component.symbolKey)).find((p) => p.pin.id === key.slice(i + 1));
  return component && pin ? { ...pin, component } : null;
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

/**
 * A wire between two pins that keeps clear of part bodies and doesn't touch other connections,
 * or null when there is no such route.
 */
export function planPinRoute(project: Project, pa: WorldPin, pb: WorldPin): Vec[] | null {
  const obstacles = routeObstacles(project, [pa.at, pb.at]);
  const resolve = resolverFor(project);
  const bodiesOnly: RouteObstacles = { boxes: project.components.map((c) => componentBox(c, resolve(c.symbolKey))), points: [], segments: obstacles.segments };
  const attempts = [
    () => autoRoute(pa, pb, obstacles),
    () => autoRoute(pa, pb, obstacles, 5),
    // Around a big part, e.g. between opposite sides of an IC.
    () => autoRoute(pa, pb, obstacles, 10, 300),
    // Crowded around the pins: only keep clear of part bodies.
    () => autoRoute(pa, pb, bodiesOnly, 5),
    () => autoRoute(pa, pb, bodiesOnly, 5, 300),
    () => routePins(pa, pb),
  ];
  for (const attempt of attempts) {
    const r = attempt();
    if (r && !createsContact(project, r, [pa.at, pb.at])) return r;
  }
  return null;
}

export function connectPins(a: string, b: string): { wireId: string; points: Vec[] } {
  const points = planPinRoute(state().project, findPin(a), findPin(b));
  if (!points) throw new Error(`Cannot wire ${a} to ${b} without touching other connections; use net labels on both pins instead`);
  const id = newId('w');
  state().commit((doc) => dropNoConnects({ ...doc, wires: [...doc.wires, { id, points }] }, [points[0], points[points.length - 1]]));
  return { wireId: id, points };
}

type FlagLayout = { points: Vec[]; rotation: Rotation };

/** Candidate stub/flag layouts for a pin, most conventional first. */
function flagLayouts(pin: ResolvedPin, kind: Exclude<PortKind, 'noconnect'>): FlagLayout[] {
  const out: Vec = [-pin.dir[0], -pin.dir[1]];
  const along = (k: number): Vec => [pin.at[0] + out[0] * k, pin.at[1] + out[1] * k];
  const straight = (len: number): FlagLayout => ({ points: [pin.at, along(len)], rotation: portRotationFor(kind, out) });
  // Turned to the side, for when the pin's own wire already leaves straight out.
  const sides: Vec[] = out[1] !== 0 ? [[1, 0], [-1, 0]] : [[0, -1], [0, 1]];
  const sideways = [10, 20].flatMap((len) =>
    sides.map((s): FlagLayout => {
      const e = along(len);
      return { points: [pin.at, e, [e[0] + s[0] * 20, e[1] + s[1] * 20]], rotation: portRotationFor(kind, s) };
    }),
  );
  if (kind === 'label' || out[1] !== 0) return [...[20, 30, 40, 60, 80].map(straight), ...sideways];
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

/** Wiring a new stub from this pin must not touch: everything except the pin's own net. */
interface ContactScope {
  project: Project;
  allowed: Vec[];
}

/** Number of collisions between a flag layout and the drawing (0 = clear, Infinity = would short). */
function layoutConflicts(project: Project, layout: FlagLayout, port: NetPort, self: Vec, scope: ContactScope): number {
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
      if (boxIntersects(seg, flag)) conflicts += 2;
      else if (stubBoxes.some((s) => boxIntersects(seg, s))) conflicts += 1;
    }
  }
  // Any electrical contact with another net's wiring would short the two: forbidden.
  if (createsContact(scope.project, layout.points, scope.allowed)) return Infinity;
  return conflicts;
}

/**
 * Where a label, power or ground flag goes on a pin: a short stub leading away from the part and
 * the flag at its end, placed clear of other parts and wiring. Null when every layout would touch
 * another net.
 */
export function planAttach(project: Project, pin: ResolvedPin, kind: Exclude<PortKind, 'noconnect'>, name: string): { points: Vec[]; port: NetPort } | null {
  const toPort = (l: FlagLayout): NetPort => {
    const end = l.points[l.points.length - 1];
    return { id: newId('n'), kind, name, x: end[0], y: end[1], rotation: l.rotation };
  };
  // A pin that is already wired may share its net's wiring: touching that only names the net.
  const conn = connectivity(project);
  const net = conn.pinNet.get(`${pin.component.id}:${pin.pin.id}`);
  const scope: ContactScope = net
    ? {
        project: { ...project, wires: project.wires.filter((w) => conn.itemNet.get(w.id) !== net), ports: project.ports.filter((p) => conn.itemNet.get(p.id) !== net) },
        allowed: [pin.at, ...project.components.flatMap((c) => worldPins(c, symbolFor(project, c.symbolKey)).filter((p) => conn.pinNet.get(`${c.id}:${p.pin.id}`) === net).map((p) => p.at))],
      }
    : { project, allowed: [pin.at] };
  // First conflict-free layout, otherwise the least conflicting one.
  let layout = flagLayouts(pin, kind)[0];
  let best = Infinity;
  for (const l of flagLayouts(pin, kind)) {
    const n = layoutConflicts(project, l, toPort(l), pin.at, scope);
    if (n < best) {
      best = n;
      layout = l;
    }
    if (n === 0) break;
  }
  return best === Infinity ? null : { points: layout.points, port: toPort(layout) };
}

/** Adds a planned stub and flag to the project. */
export function commitAttach(plan: { points: Vec[]; port: NetPort }): NetPort {
  state().commit((doc) =>
    dropNoConnects(
      {
        ...doc,
        wires: [...doc.wires, { id: newId('w'), points: plan.points }],
        ports: [...doc.ports, plan.port],
      },
      [plan.points[0]],
    ),
  );
  return plan.port;
}

/** Adds a short wire stub from a pin with a label, power or ground flag at its end. */
export function attachPort(pinRef: string, kind: Exclude<PortKind, 'noconnect'>, name: string): NetPort {
  const plan = planAttach(state().project, findPin(pinRef), kind, name);
  if (!plan) {
    throw new Error(`No room to attach a ${kind === 'label' ? 'label' : 'flag'} to ${pinRef} without touching other wiring; move parts apart or connect it with a wire`);
  }
  return commitAttach(plan);
}

/**
 * Removes the wiring that ends on a pin: wires with an end there, markers sitting on the pin, and
 * labels or flags left dangling at the far end of a removed wire (the stubs attachPort makes).
 */
export function disconnectPin(pinRef: string): { wires: number; labels: string[] } {
  const pin = findPin(pinRef);
  const project = state().project;
  const wires = project.wires.filter((w) => samePoint(w.points[0], pin.at) || samePoint(w.points[w.points.length - 1], pin.at));
  const removed = new Set(wires.map((w) => w.id));
  const kept = project.wires.filter((w) => !removed.has(w.id));
  const touchesKept = (p: Vec) => kept.some((w) => w.points.some((q, i) => (i === 0 ? samePoint(p, q) : onSegment(p, w.points[i - 1], q))));
  const farEnds = wires.flatMap((w) => [w.points[0], w.points[w.points.length - 1]]).filter((p) => !samePoint(p, pin.at));
  const ports = project.ports.filter((p) => {
    const at: Vec = [p.x, p.y];
    return samePoint(at, pin.at) || (farEnds.some((e) => samePoint(e, at)) && !touchesKept(at));
  });
  for (const p of ports) removed.add(p.id);
  if (removed.size) state().commit((doc) => ({ ...doc, wires: doc.wires.filter((w) => !removed.has(w.id)), ports: doc.ports.filter((p) => !removed.has(p.id)) }));
  return { wires: wires.length, labels: ports.map((p) => p.name || p.kind) };
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
      // Keep the designator even when the library uses another prefix (LED1 for a D1, H1 for a J1).
      updated = { ...c, ...placing.template, rotation: c.rotation, mirror: c.mirror, designator: c.designator };
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
