/*
 * PCB editing actions shared by the PCB editor UI and the WebMCP tools.
 */
import { useEditor } from '../../store/editor';
import { fetchPartDetail } from '../api';
import { downloadText, safeFileName } from '../actions';
import { samePoint } from '../schematic/geometry';
import { newId } from '../schematic/ops';
import { bomToJlcpcbCsv, buildBom } from '../schematic/bom';
import type { Component, Project, Vec } from '../schematic/types';
import { zip } from '../zip';
import { buildBoard, footprintGeom, pcbConnectivity, type Airwire, type BoardModel } from './board';
import { pointShapeDistance, shapeDistance, type CopperItem, type WorldPad } from './geometry';
import { runDrc, shellAreas } from './drc';
import { builtinFootprintDoc } from './footprint';
import { generateCpl, generateGerbers } from './gerber';
import { routeConnection, simplifyPath } from './router';
import { DEFAULT_POUR, emptyPcb, type CopperLayer, type Pcb, type Placement, type Pour, type StoredFootprint, type Track, type Via } from './types';
import { fitPcbView } from './view';

const st = () => useEditor.getState();

export const snapMm = (v: number, step = 0.25) => Math.round(v / step) * step;

export function currentPcb(project: Project = st().project): Pcb {
  return project.pcb ?? emptyPcb();
}

export function boardModel(project: Project = st().project) {
  const pcb = currentPcb(project);
  const board = buildBoard(project, pcb);
  return { pcb, board, conn: pcbConnectivity(board, pcb) };
}

function commitPcb(fn: (pcb: Pcb) => Pcb) {
  st().commit((doc) => ({ ...doc, pcb: fn(doc.pcb ?? emptyPcb()) }));
}

/* ---------- sync from schematic ---------- */

const POLARIZED = new Set(['diode', 'led']);

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export interface SyncReport {
  added: string[];
  removed: number;
  missing: string[];
}

/**
 * Brings the PCB in line with the schematic: loads footprints, adds placements for new parts
 * (packed in schematic order), removes deleted parts. Existing positions are kept.
 */
export async function syncPcb(): Promise<SyncReport> {
  const project = st().project;
  const pcb = currentPcb(project);
  const fetched: Record<string, StoredFootprint> = {};
  const footprintOf: Record<string, string | null> = {};

  const keys = await mapLimit(project.components, 4, async (c): Promise<string | null> => {
    if (c.lcsc) {
      const key = `lcsc:${c.lcsc.toUpperCase()}`;
      if (pcb.footprints[key] || fetched[key]) return key;
      try {
        const d = await fetchPartDetail(c.lcsc);
        if (d.device?.footprint) {
          fetched[key] = { title: d.device.footprint.title, dataStr: d.device.footprint.dataStr, source: 'easyeda' };
          return key;
        }
      } catch {
        /* fall back below */
      }
    }
    if (c.generic) {
      const polar = POLARIZED.has(c.generic.kind);
      const key = `builtin:${c.generic.size}${polar ? ':k' : ''}`;
      const doc = builtinFootprintDoc(c.generic.size, polar);
      if (doc) {
        fetched[key] ??= { title: `${c.generic.size}${polar ? ' (polarized)' : ''}`, dataStr: doc, source: 'builtin' };
        return key;
      }
    }
    return null;
  });
  project.components.forEach((c, i) => (footprintOf[c.id] = keys[i]));
  const footprints = { ...pcb.footprints, ...fetched };

  const live = new Set(project.components.map((c) => c.id));
  const kept = pcb.placements.filter((p) => live.has(p.componentId));
  const placed = new Set(kept.map((p) => p.componentId));
  const fresh = project.components.filter((c) => !placed.has(c.id));
  // Schematic order (top-to-bottom, left-to-right) keeps related parts together.
  fresh.sort((a, b) => Math.round(a.y / 60) - Math.round(b.y / 60) || a.x - b.x);

  let board = pcb.board;
  const sizes = fresh.map((c) => {
    const key = footprintOf[c.id];
    const fp = key ? footprintGeom(footprints[key]) : null;
    return fp ? { w: fp.bbox.x2 - fp.bbox.x1, h: fp.bbox.y2 - fp.bbox.y1, cx: (fp.bbox.x1 + fp.bbox.x2) / 2, cy: (fp.bbox.y1 + fp.bbox.y2) / 2 } : { w: 2, h: 2, cx: 0, cy: 0 };
  });
  if (kept.length === 0 && fresh.length) {
    // First sync: size the board to roughly three times the parts' area.
    const area = sizes.reduce((s, z) => s + (z.w + 1.5) * (z.h + 1.5), 0) * 3;
    const width = Math.max(20, Math.ceil(Math.sqrt((area * 4) / 3) / 5) * 5);
    const height = Math.max(15, Math.ceil((width * 3) / 4 / 5) * 5);
    board = { ...board, width, height };
  }
  const gap = 1.5;
  let x = board.x + 2;
  let y = board.y + 2;
  let rowH = 0;
  const added: Placement[] = fresh.map((c, i) => {
    const s = sizes[i];
    if (x + s.w > board.x + board.width - 2 && x > board.x + 2) {
      x = board.x + 2;
      y += rowH + gap;
      rowH = 0;
    }
    // Position the footprint origin so its bounding box starts at (x, y).
    const pl: Placement = { componentId: c.id, x: snapMm(x + s.w / 2 - s.cx, 0.05), y: snapMm(y + s.h / 2 - s.cy, 0.05), rotation: 0, side: 'top' };
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
    return pl;
  });

  const signatures = Object.fromEntries(project.components.map((c) => [c.id, partSignature(c)]));
  st().commit((doc) => ({
    ...doc,
    pcb: { ...currentPcb({ ...project, pcb: doc.pcb }), board, footprints, footprintOf, signatures, placements: [...kept, ...added] },
  }));
  return {
    added: fresh.map((c) => c.designator),
    removed: pcb.placements.length - kept.length,
    missing: project.components.filter((c) => !footprintOf[c.id]).map((c) => c.designator),
  };
}

/** Switches to the PCB editor, bringing the board up to date with the schematic. */
export async function enterPcb() {
  st().setMode('pcb');
  if (!pcbOutOfDate(st().project)) return;
  try {
    const firstSync = !st().project.pcb?.placements.length;
    const r = await syncPcb();
    if (firstSync) fitPcbView();
    const parts = [r.added.length && `${r.added.length} added`, r.removed && `${r.removed} removed`].filter(Boolean).join(', ');
    st().notify(`PCB updated${parts ? `: ${parts}` : ''}${r.missing.length ? `; no footprint for ${r.missing.join(', ')}` : ''}`);
  } catch (err) {
    st().notify(`PCB update failed: ${(err as Error).message}`, 'error');
  }
}

/** What decides a part's footprint; a change means the PCB needs syncing. */
const partSignature = (c: Component) => `${c.lcsc ?? ''}|${c.generic?.size ?? ''}`;

/** True when parts were added, removed or re-assigned since the last sync. */
export function pcbOutOfDate(project: Project): boolean {
  const pcb = project.pcb;
  if (!pcb) return project.components.length > 0;
  const ids = new Set(project.components.map((c) => c.id));
  if (pcb.placements.some((p) => !ids.has(p.componentId))) return true;
  const placed = new Set(pcb.placements.map((p) => p.componentId));
  return project.components.some((c) => !placed.has(c.id) || pcb.signatures?.[c.id] !== partSignature(c));
}

/* ---------- editing ---------- */

export function movePlacements(pcb: Pcb, ids: ReadonlySet<string>, dx: number, dy: number): Pcb {
  return { ...pcb, placements: pcb.placements.map((p) => (ids.has(p.componentId) ? { ...p, x: p.x + dx, y: p.y + dy } : p)) };
}

export function rotateSelected(step = 90) {
  const ids = new Set(st().pcbSelection);
  commitPcb((pcb) => ({ ...pcb, placements: pcb.placements.map((p) => (ids.has(p.componentId) ? { ...p, rotation: (((p.rotation + step) % 360) + 360) % 360 } : p)) }));
}

export function flipSelected() {
  const ids = new Set(st().pcbSelection);
  commitPcb((pcb) => ({ ...pcb, placements: pcb.placements.map((p) => (ids.has(p.componentId) ? { ...p, side: p.side === 'top' ? 'bottom' : 'top' } : p)) }));
}

export function deleteSelectedCopper() {
  const ids = new Set(st().pcbSelection);
  commitPcb((pcb) => ({
    ...pcb,
    tracks: pcb.tracks.filter((t) => !ids.has(t.id)),
    vias: pcb.vias.filter((v) => !ids.has(v.id)),
    pours: (pcb.pours ?? []).filter((z) => !ids.has(z.id)),
  }));
  st().setPcbSelection(st().pcbSelection.filter((id) => !ids.has(id) || st().project.components.some((c) => c.id === id)));
}

export function updatePlacement(componentId: string, patch: Partial<Placement>) {
  commitPcb((pcb) => ({ ...pcb, placements: pcb.placements.map((p) => (p.componentId === componentId ? { ...p, ...patch } : p)) }));
}

export function updateBoard(patch: Partial<Pcb['board']>) {
  commitPcb((pcb) => ({ ...pcb, board: { ...pcb.board, ...patch } }));
}

export function updateRules(patch: Partial<Pcb['rules']>) {
  commitPcb((pcb) => ({ ...pcb, rules: { ...pcb.rules, ...patch } }));
}

export function updateTrack(id: string, patch: Partial<Track>) {
  commitPcb((pcb) => ({ ...pcb, tracks: pcb.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function addTrack(layer: CopperLayer, width: number, points: Vec[], net: string | null): Track | null {
  const pts = simplifyPath(points);
  if (pts.length < 2) return null;
  const track: Track = { id: newId('t'), layer, width, points: pts, net };
  commitPcb((pcb) => ({ ...pcb, tracks: [...pcb.tracks, track] }));
  return track;
}

export function addVia(at: Vec, net: string | null): Via {
  const { rules } = currentPcb();
  const via: Via = { id: newId('v'), x: at[0], y: at[1], diameter: rules.viaDiameter, drill: rules.viaDrill, net };
  commitPcb((pcb) => ({ ...pcb, vias: [...pcb.vias, via] }));
  return via;
}

/** Places several vias of one net in a single step (thermal or stitching vias). */
export function addVias(points: Vec[], net: string): Via[] {
  const { rules } = currentPcb();
  const vias: Via[] = points.map(([x, y]) => ({ id: newId('v'), x, y, diameter: rules.viaDiameter, drill: rules.viaDrill, net }));
  commitPcb((pcb) => ({ ...pcb, vias: [...pcb.vias, ...vias] }));
  return vias;
}

/* ---------- copper pours ---------- */

/** Adds a pour for `net` on each layer (replacing existing pours of that net there). */
export function addPours(net: string, layers: CopperLayer[] = ['top', 'bottom'], settings: Partial<Omit<Pour, 'id' | 'net' | 'layer'>> = {}): Pour[] {
  const pours: Pour[] = layers.map((layer) => ({ ...DEFAULT_POUR, ...settings, id: newId('z'), net, layer }));
  commitPcb((pcb) => ({
    ...pcb,
    pours: [...(pcb.pours ?? []).filter((p) => !(p.net === net && layers.includes(p.layer))), ...pours],
  }));
  return pours;
}

export function updatePour(id: string, patch: Partial<Omit<Pour, 'id'>>) {
  commitPcb((pcb) => ({ ...pcb, pours: (pcb.pours ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

export function removePours(ids?: string[]) {
  commitPcb((pcb) => ({ ...pcb, pours: ids ? (pcb.pours ?? []).filter((p) => !ids.includes(p.id)) : [] }));
}

/** Nets that have pads on the board, most-connected first (GND first when present). */
export function boardNets(project: Project = st().project): string[] {
  const { board } = boardModel(project);
  const count = new Map<string, number>();
  for (const p of board.pads) if (p.net) count.set(p.net, (count.get(p.net) ?? 0) + 1);
  return [...count].sort((a, b) => Number(/gnd/i.test(b[0])) - Number(/gnd/i.test(a[0])) || b[1] - a[1]).map(([n]) => n);
}

const POWER_NET = /^(gnd|agnd|pgnd|vcc|vdd|vin|vbus|vbat|vm|vmot|vmotor|vs|vsys|\+?\d+v\d*|\+?\d+\.\d+v)$/i;

export function trackWidthFor(net: string | null, pcb: Pcb = currentPcb()): number {
  return net && POWER_NET.test(net.replace(/^\+/, '+')) ? pcb.rules.powerTrackWidth : pcb.rules.trackWidth;
}

/** 45° routing posture from `from` to `to`: straight leg first, then the diagonal. */
export function posture(from: Vec, to: Vec): Vec[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-9 || ay < 1e-9 || Math.abs(ax - ay) < 1e-9) return [to];
  const corner: Vec = ax > ay ? [from[0] + Math.sign(dx) * (ax - ay), from[1]] : [from[0], from[1] + Math.sign(dy) * (ay - ax)];
  return [corner, to];
}

/** While routing: finish the current segment at the cursor, drop a via and continue on the other layer. */
export function viaInDraft(layer?: CopperLayer) {
  const s = st();
  const d = s.routeDraft;
  if (!d) return;
  const next: CopperLayer = layer ?? (d.layer === 'top' ? 'bottom' : 'top');
  if (next === d.layer) return;
  const end = s.pcbCursor;
  const points = [...d.points, ...posture(d.points[d.points.length - 1], end)];
  if (points.length >= 2) addTrack(d.layer, d.width, points, d.net);
  addVia(end, d.net);
  s.setActiveLayer(next);
  s.setRouteDraft({ ...d, layer: next, points: [end] });
}

export function finishDraft() {
  const s = st();
  const d = s.routeDraft;
  if (d && d.points.length >= 2) addTrack(d.layer, d.width, d.points, d.net);
  s.setRouteDraft(null);
}

/* ---------- auto-routing ---------- */

export interface AutorouteReport {
  routed: number;
  failed: { net: string; a: Vec; b: Vec }[];
}

/** Distance from a fine-pitch pad within which a necked-down track stays narrow. */
const NECK_LENGTH = 1;

/**
 * Widens a route found at the narrow width wherever it can: segments more than NECK_LENGTH from
 * the fine-pitch end pads, and only where the wider copper still clears other nets. This is the
 * usual neck-down into fine-pitch pins, with full-width copper everywhere else.
 */
function neckDown(
  route: { layer: CopperLayer; points: Vec[] },
  narrow: number,
  wide: number,
  finePads: WorldPad[],
  others: CopperItem[],
  clearance: number,
): { width: number; points: Vec[] }[] {
  // Break the first and last segments NECK_LENGTH away from a fine-pitch pad they start on.
  const pts = [...route.points];
  const near = (p: Vec) => finePads.some((pad) => pointShapeDistance(p, pad.shape) === 0);
  const breakAt = (from: Vec, to: Vec): Vec | null => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (len <= NECK_LENGTH + 0.2) return null;
    const f = NECK_LENGTH / len;
    return [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
  };
  if (pts.length >= 2 && near(pts[0])) {
    const b = breakAt(pts[0], pts[1]);
    if (b) pts.splice(1, 0, b);
  }
  if (pts.length >= 2 && near(pts[pts.length - 1])) {
    const b = breakAt(pts[pts.length - 1], pts[pts.length - 2]);
    if (b) pts.splice(pts.length - 1, 0, b);
  }
  const widthOf = (a: Vec, b: Vec) => {
    const seg = { kind: 'capsule' as const, a, b, r: wide / 2 };
    const neck = finePads.some((pad) => shapeDistance({ ...seg, r: 0 }, pad.shape) < NECK_LENGTH - 1e-6);
    const clear = others.every((it) => !it.layers.includes(route.layer) || shapeDistance(seg, it.shape) >= clearance - 1e-6);
    return !neck && clear ? wide : narrow;
  };
  // Judge long segments in pieces of up to 1 mm, so a squeeze at one end doesn't keep the
  // whole run narrow.
  const pieces: [Vec, Vec][] = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 0; k < n; k++) pieces.push([lerp(a, b, k / n), lerp(a, b, (k + 1) / n)]);
  }
  const out: { width: number; points: Vec[] }[] = [];
  for (const [a, b] of pieces) {
    const w = widthOf(a, b);
    const last = out[out.length - 1];
    if (last && last.width === w) last.points.push(b);
    else out.push({ width: w, points: [a, b] });
  }
  return out.map((t) => ({ ...t, points: simplifyPath(t.points) }));
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function routeOne(project: Project, aw: Airwire, widthOverride?: number): { tracks: Track[]; vias: Via[] } | null {
  const pcb = currentPcb(project);
  const board = buildBoard(project, pcb);
  const conn = pcbConnectivity(board, pcb);
  // Route no wider than the narrow side of the pads it connects (a 0.5 mm track cannot enter a
  // 0.25 mm QFN pin without crowding its neighbours), then widen away from those pads.
  const wide = widthOverride ?? trackWidthFor(aw.net, pcb);
  const endPads = board.pads.filter((p) => samePoint(p.center, aw.a) || samePoint(p.center, aw.b));
  const finePads = endPads.filter((p) => Math.min(p.pad.w, p.pad.h) < wide);
  const width = finePads.length ? Math.max(pcb.rules.minTrackWidth, Math.min(...finePads.map((p) => Math.min(p.pad.w, p.pad.h)))) : wide;
  const netOf = (it: (typeof board.items)[number]) => (it.type === 'pad' ? it.net : (conn.itemNet.get(it.ref) ?? it.net));
  // Keep other nets out from under metal connector shells where possible.
  const avoid = shellAreas(board)
    .filter((a) => !a.nets.has(aw.net))
    .map(({ layer, outlines }) => ({ layer, outlines }));
  const opts = { net: aw.net, width, rules: pcb.rules, board: pcb.board, items: board.items, netOf, avoid };
  const r = routeConnection({ point: aw.a, layers: aw.aLayers }, { point: aw.b, layers: aw.bLayers }, opts) ?? routeConnection({ point: aw.a, layers: aw.aLayers }, { point: aw.b, layers: aw.bLayers }, { ...opts, margin: 30 });
  if (!r) return null;
  const others = width < wide ? board.items.filter((it) => netOf(it) !== aw.net) : [];
  const pieces = r.tracks.flatMap((t) =>
    width < wide ? neckDown(t, width, wide, finePads, others, pcb.rules.clearance).map((p) => ({ layer: t.layer, ...p })) : [{ layer: t.layer, width, points: t.points }],
  );
  return {
    tracks: pieces.map((t) => ({ id: newId('t'), layer: t.layer, width: t.width, points: t.points, net: aw.net })),
    vias: r.vias.map((v) => ({ id: newId('v'), x: v[0], y: v[1], diameter: pcb.rules.viaDiameter, drill: pcb.rules.viaDrill, net: aw.net })),
  };
}

/**
 * Routes unrouted connections one at a time (shortest first), optionally for one net only and
 * with a given track width (default: by net, see trackWidthFor). Everything is a single undo step.
 */
export function autoroute(net?: string, width?: number): AutorouteReport {
  const report: AutorouteReport = { routed: 0, failed: [] };
  let project = st().project;
  const skip = new Set<string>();
  // A connection that comes back after being routed made no progress (its copper didn't join
  // the pads), so it counts as failed instead of being routed again and again.
  const tried = new Set<string>();
  for (let guard = 0; guard < 500; guard++) {
    const { conn, board } = boardModel(project);
    // Two pins of the same part joined directly (e.g. a driver's two supply pins) would run a
    // track along its pin row and wall the other pins in; route those last, by which time they
    // are usually joined through other parts anyway.
    const partAt = (p: Vec) => board.pads.find((pad) => samePoint(pad.center, p))?.componentId;
    const samePart = (a: Airwire) => {
      const id = partAt(a.a);
      return id !== undefined && id === partAt(a.b) ? 1 : 0;
    };
    const length = (a: Airwire) => Math.hypot(a.a[0] - a.b[0], a.a[1] - a.b[1]);
    const pending = conn.airwires
      .filter((a) => (!net || a.net === net) && !skip.has(`${a.net}|${a.a}|${a.b}`))
      .sort((p, q) => samePart(p) - samePart(q) || length(p) - length(q));
    const aw = pending[0];
    if (!aw) break;
    const key = `${aw.net}|${aw.a}|${aw.b}`;
    const r = tried.has(key) ? null : routeOne(project, aw, width);
    tried.add(key);
    if (!r) {
      skip.add(key);
      report.failed.push({ net: aw.net, a: aw.a, b: aw.b });
      continue;
    }
    const pcb = currentPcb(project);
    project = { ...project, pcb: { ...pcb, tracks: [...pcb.tracks, ...r.tracks], vias: [...pcb.vias, ...r.vias] } };
    report.routed++;
  }
  if (report.routed > 0) {
    const routedPcb = project.pcb!;
    st().commit((doc) => ({ ...doc, pcb: routedPcb }));
  }
  return report;
}

/* ---------- checks and export ---------- */

export function checkPcb(project: Project = st().project) {
  const { pcb, board, conn } = boardModel(project);
  return { issues: runDrc(board, pcb, conn), conn, board };
}

/** Through-hole parts (every pad plated through), which JLCPCB solders by hand at extra cost. */
export function throughHoleParts(board: BoardModel): Component[] {
  return board.parts.filter((p) => p.fp && p.fp.pads.length > 0 && p.fp.pads.every((pad) => pad.layer === 'through')).map((p) => p.component);
}

/**
 * Gerbers, pick-and-place and BOM for the board. Components in `skip` (e.g. through-hole parts
 * the user solders) stay on the board but out of the assembly files.
 */
export function fabricationFiles(project: Project = st().project, skip: ReadonlySet<string> = new Set()) {
  const { pcb, board } = boardModel(project);
  const base = safeFileName(project.name);
  const gerbers = generateGerbers(pcb, board, base);
  return {
    base,
    gerbers,
    cpl: generateCpl(pcb, board, skip),
    bom: bomToJlcpcbCsv(buildBom(project.components.filter((c) => pcb.placements.some((p) => p.componentId === c.id) && !skip.has(c.id)))),
  };
}

/** Downloads the Gerber zip and, for assembly, the CPL and BOM. */
export function exportFabrication(skip: ReadonlySet<string> = new Set(), withAssembly = true): { files: string[] } {
  const { base, gerbers, cpl, bom } = fabricationFiles(st().project, skip);
  const archive = zip(gerbers);
  const url = URL.createObjectURL(new Blob([archive as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}-gerbers.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (!withAssembly) return { files: [`${base}-gerbers.zip`] };
  downloadText(`${base}-CPL.csv`, cpl, 'text/csv');
  downloadText(`${base}-BOM.csv`, bom, 'text/csv');
  return { files: [`${base}-gerbers.zip`, `${base}-CPL.csv`, `${base}-BOM.csv`] };
}

export type { BoardModel };
