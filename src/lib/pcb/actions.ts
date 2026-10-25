/*
 * PCB editing actions shared by the PCB editor UI and the WebMCP tools.
 */
import { useEditor } from '../../store/editor';
import { fetchPartDetail } from '../api';
import { downloadText, safeFileName } from '../actions';
import { newId } from '../schematic/ops';
import { bomToJlcpcbCsv, buildBom } from '../schematic/bom';
import type { Component, Project, Vec } from '../schematic/types';
import { zip } from '../zip';
import { buildBoard, footprintGeom, pcbConnectivity, type Airwire, type BoardModel } from './board';
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

const POWER_NET =/^(gnd|agnd|pgnd|vcc|vdd|vin|vbus|vbat|\+?\d+v\d*|\+?\d+\.\d+v)$/i;

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

function routeOne(project: Project, aw: Airwire): { tracks: Track[]; vias: Via[] } | null {
  const pcb = currentPcb(project);
  const board = buildBoard(project, pcb);
  const conn = pcbConnectivity(board, pcb);
  const width = trackWidthFor(aw.net, pcb);
  const netOf = (it: (typeof board.items)[number]) => (it.type === 'pad' ? it.net : (conn.itemNet.get(it.ref) ?? it.net));
  // Keep other nets out from under metal connector shells where possible.
  const avoid = shellAreas(board)
    .filter((a) => !a.nets.has(aw.net))
    .map(({ layer, outlines }) => ({ layer, outlines }));
  const opts = { net: aw.net, width, rules: pcb.rules, board: pcb.board, items: board.items, netOf, avoid };
  const r = routeConnection({ point: aw.a, layers: aw.aLayers }, { point: aw.b, layers: aw.bLayers }, opts) ?? routeConnection({ point: aw.a, layers: aw.aLayers }, { point: aw.b, layers: aw.bLayers }, { ...opts, margin: 30 });
  if (!r) return null;
  return {
    tracks: r.tracks.map((t) => ({ id: newId('t'), layer: t.layer, width, points: t.points, net: aw.net })),
    vias: r.vias.map((v) => ({ id: newId('v'), x: v[0], y: v[1], diameter: pcb.rules.viaDiameter, drill: pcb.rules.viaDrill, net: aw.net })),
  };
}

/**
 * Routes unrouted connections one at a time (shortest first), optionally for one net only.
 * Everything is a single undo step.
 */
export function autoroute(net?: string): AutorouteReport {
  const report: AutorouteReport = { routed: 0, failed: [] };
  let project = st().project;
  const skip = new Set<string>();
  for (let guard = 0; guard < 500; guard++) {
    const { conn } = boardModel(project);
    const pending = conn.airwires
      .filter((a) => (!net || a.net === net) && !skip.has(`${a.net}|${a.a}|${a.b}`))
      .sort((p, q) => Math.hypot(p.a[0] - p.b[0], p.a[1] - p.b[1]) - Math.hypot(q.a[0] - q.b[0], q.a[1] - q.b[1]));
    const aw = pending[0];
    if (!aw) break;
    const r = routeOne(project, aw);
    if (!r) {
      skip.add(`${aw.net}|${aw.a}|${aw.b}`);
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

export function fabricationFiles(project: Project = st().project) {
  const { pcb, board } = boardModel(project);
  const base = safeFileName(project.name);
  const gerbers = generateGerbers(pcb, board, base);
  return {
    base,
    gerbers,
    cpl: generateCpl(pcb, board),
    bom: bomToJlcpcbCsv(buildBom(project.components.filter((c) => pcb.placements.some((p) => p.componentId === c.id)))),
  };
}

export function exportFabrication(): { files: string[] } {
  const { base, gerbers, cpl, bom } = fabricationFiles();
  const archive = zip(gerbers);
  const url = URL.createObjectURL(new Blob([archive as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}-gerbers.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  downloadText(`${base}-CPL.csv`, cpl, 'text/csv');
  downloadText(`${base}-BOM.csv`, bom, 'text/csv');
  return { files: [`${base}-gerbers.zip`, `${base}-CPL.csv`, `${base}-BOM.csv`] };
}

export type { BoardModel };
