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
import { pointShapeDistance, rotateDeg, shapeDistance, trackItems, viaItem, worldToPlacement, type CopperItem, type CopperShape } from './geometry';
import { POUR_EDGE_CLEARANCE } from './pour';
import { runDrc, shellAreas } from './drc';
import { builtinFootprintDoc } from './footprint';
import { generateCpl, generateGerbers } from './gerber';
import { boardEdges, edgeDistance, insideBoard, keepoutAreas, withOutline } from './outline';
import { edgeField, routeConnection, simplifyPath } from './router';
import { DEFAULT_HOLE, DEFAULT_POUR, copperLayers, emptyPcb, isInner, sideOfLayer, type CopperLayer, type Side, type Cutout, type DesignatorLabel, type Keepout, type MountingHole, type Pcb, type Placement, type Pour, type SilkLogo, type SilkText, type StoredFootprint, type Track, type Via } from './types';
import { labelId, TEXT_SIZE } from './silk';
import { drilledHoles, viaHoleConflict } from './jlcpcb';
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

/**
 * Moves selected parts, designators, text, logos, mounting holes, keepouts, cutouts and zones. A
 * designator moves only with an explicit position (see pinLabels) and not when its part moves too.
 */
export function movePlacements(pcb: Pcb, ids: ReadonlySet<string>, dx: number, dy: number): Pcb {
  const shift = (outline: Vec[]) => outline.map(([x, y]) => [x + dx, y + dy] as Vec);
  const cutouts = pcb.board.cutouts?.map((c) => (ids.has(c.id) ? { ...c, outline: shift(c.outline) } : c));
  const moveLabel = (p: Placement): Placement => {
    const l = p.label;
    if (!ids.has(labelId(p.componentId)) || l?.x === undefined || l?.y === undefined) return p;
    const [ux, uy] = worldToPlacement({ x: 0, y: 0, rotation: p.rotation, side: p.side }, [dx, dy]);
    return { ...p, label: { ...l, x: l.x + ux, y: l.y + uy } };
  };
  return {
    ...pcb,
    placements: pcb.placements.map((p) => (ids.has(p.componentId) ? { ...p, x: p.x + dx, y: p.y + dy } : moveLabel(p))),
    texts: pcb.texts?.map((t) => (ids.has(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t)),
    logos: pcb.logos?.map((l) => (ids.has(l.id) ? { ...l, x: l.x + dx, y: l.y + dy } : l)),
    holes: pcb.holes?.map((h) => (ids.has(h.id) ? { ...h, x: h.x + dx, y: h.y + dy } : h)),
    keepouts: pcb.keepouts?.map((k) => (ids.has(k.id) ? { ...k, outline: shift(k.outline) } : k)),
    pours: pcb.pours?.map((z) => (ids.has(z.id) && z.outline ? { ...z, outline: shift(z.outline) } : z)),
    board: cutouts ? { ...pcb.board, cutouts } : pcb.board,
  };
}

/** Ids that move with movePlacements: parts, designators, text, logos, holes, keepouts, cutouts and zones. */
export function movableIds(pcb: Pcb, ids: Iterable<string>): Set<string> {
  const movable = new Set([
    ...pcb.placements.flatMap((p) => [p.componentId, labelId(p.componentId)]),
    ...(pcb.texts ?? []).map((t) => t.id),
    ...(pcb.logos ?? []).map((l) => l.id),
    ...(pcb.holes ?? []).map((h) => h.id),
    ...(pcb.keepouts ?? []).map((k) => k.id),
    ...(pcb.board.cutouts ?? []).map((c) => c.id),
    ...(pcb.pours ?? []).filter((z) => z.outline).map((z) => z.id),
  ]);
  return new Set([...ids].filter((id) => movable.has(id)));
}

/** Drops repeated and closing points; null when fewer than three corners remain. */
function cleanShape(points: Vec[]): Vec[] | null {
  const out = points.filter((p, i) => i === 0 || !samePoint(p, points[i - 1]));
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out.length >= 3 ? out : null;
}

/**
 * Turns a shape drawn with an area tool into a keepout, cutout, pour zone or the board outline,
 * selects it and returns to the select tool.
 */
export function finishShape(points: Vec[]) {
  const s = st();
  const tool = s.pcbTool;
  const shape = cleanShape(points);
  s.setShapeDraft(null);
  if (!shape) return s.notify('An area needs at least three corners');
  let id: string | null = null;
  if (tool === 'outline') {
    setBoardOutline(shape);
    s.notify('Board outline changed; parts and copper outside it show up in the design check');
  } else if (tool === 'keepout') id = addKeepout(shape).id;
  else if (tool === 'cutout') id = addCutout(shape).id;
  else if (tool === 'zone') {
    const net = s.pcbHighlightNet ?? boardNets()[0];
    if (!net) return s.notify('Add parts to the board before drawing a pour zone', 'error');
    id = addPours(net, [s.activeLayer], { outline: shape })[0].id;
    s.notify(`Pour zone on ${net} (${s.activeLayer}); change its net in the panel on the right`);
  }
  s.setPcbTool('select');
  if (id) s.setPcbSelection([id]);
}

/** Places one mounting hole with the default size, if it fits on the board. */
export function placeMountingHole(at: Vec) {
  const pcb = currentPcb();
  const edges = boardEdges(pcb);
  if (!insideBoard(at, edges) || edgeDistance(at, edges) < DEFAULT_HOLE.diameter / 2 + 0.3) return st().notify('A mounting hole must sit inside the board, clear of its edges', 'error');
  const [hole] = addMountingHoles([at]);
  st().setPcbSelection([hole.id]);
}

/** Sets a custom board outline (closed polygon), or goes back to the rectangle with null. */
export function setBoardOutline(outline: Vec[] | null) {
  commitPcb((pcb) => ({ ...pcb, board: withOutline(pcb.board, outline) }));
}

export function addCutout(outline: Vec[]): Cutout {
  const cutout: Cutout = { id: newId('cut'), outline };
  commitPcb((pcb) => ({ ...pcb, board: { ...pcb.board, cutouts: [...(pcb.board.cutouts ?? []), cutout] } }));
  return cutout;
}

export function addMountingHoles(points: Vec[], diameter = DEFAULT_HOLE.diameter, keepout = DEFAULT_HOLE.keepout): MountingHole[] {
  const holes = points.map(([x, y]): MountingHole => ({ id: newId('hole'), x, y, diameter, keepout: Math.max(keepout, diameter) }));
  commitPcb((pcb) => ({ ...pcb, holes: [...(pcb.holes ?? []), ...holes] }));
  return holes;
}

export function addKeepout(outline: Vec[], opts: Partial<Omit<Keepout, 'id' | 'outline'>> = {}): Keepout {
  const keepout: Keepout = { id: newId('keep'), outline, layers: copperLayers(currentPcb()), tracks: true, vias: true, pours: true, parts: false, ...opts };
  commitPcb((pcb) => ({ ...pcb, keepouts: [...(pcb.keepouts ?? []), keepout] }));
  return keepout;
}

export function updateMechanical(id: string, patch: Partial<MountingHole> & Partial<Keepout>) {
  commitPcb((pcb) => ({
    ...pcb,
    holes: pcb.holes?.map((h) => (h.id === id ? { ...h, ...(patch as Partial<MountingHole>) } : h)),
    keepouts: pcb.keepouts?.map((k) => (k.id === id ? { ...k, ...(patch as Partial<Keepout>) } : k)),
  }));
}

/**
 * Removes mounting holes, keepouts, cutouts, pours, text, logos, tracks or vias by id, and hides
 * the designators whose label ids are given; returns how many items that affected.
 */
export function removePcbItems(ids: ReadonlySet<string>): number {
  const pcb = currentPcb();
  const items = [pcb.holes ?? [], pcb.keepouts ?? [], pcb.board.cutouts ?? [], pcb.pours ?? [], pcb.texts ?? [], pcb.logos ?? [], pcb.tracks, pcb.vias].flat();
  const labels = pcb.placements.filter((p) => ids.has(labelId(p.componentId)) && !p.label?.hidden).length;
  const count = items.filter((x) => ids.has(x.id)).length + labels;
  if (count) {
    commitPcb((p) => ({
      ...p,
      placements: p.placements.map((q) => (ids.has(labelId(q.componentId)) ? { ...q, label: { ...q.label, hidden: true } } : q)),
      texts: (p.texts ?? []).filter((t) => !ids.has(t.id)),
      logos: (p.logos ?? []).filter((l) => !ids.has(l.id)),
      tracks: p.tracks.filter((t) => !ids.has(t.id)),
      vias: p.vias.filter((v) => !ids.has(v.id)),
      pours: (p.pours ?? []).filter((z) => !ids.has(z.id)),
      holes: (p.holes ?? []).filter((h) => !ids.has(h.id)),
      keepouts: (p.keepouts ?? []).filter((k) => !ids.has(k.id)),
      board: { ...p.board, cutouts: (p.board.cutouts ?? []).filter((c) => !ids.has(c.id)) },
    }));
  }
  return count;
}

const turn = (deg: number, step: number) => (((deg + step) % 360) + 360) % 360;

/** Rotates the selected parts, designators, text and logos. */
export function rotateSelected(step = 90) {
  const ids = new Set(st().pcbSelection);
  commitPcb((pcb) => ({
    ...pcb,
    placements: pcb.placements.map((p) =>
      ids.has(p.componentId)
        ? { ...p, rotation: turn(p.rotation, step) }
        : ids.has(labelId(p.componentId))
          ? { ...p, label: { ...p.label, rotation: turn(p.label?.rotation ?? 0, step) } }
          : p,
    ),
    texts: pcb.texts?.map((t) => (ids.has(t.id) ? { ...t, rotation: turn(t.rotation, step) } : t)),
    logos: pcb.logos?.map((l) => (ids.has(l.id) ? { ...l, rotation: turn(l.rotation, step) } : l)),
  }));
}

/** Moves the selected parts, text and logos to the other side of the board. */
export function flipSelected() {
  const ids = new Set(st().pcbSelection);
  const other = (side: Side): Side => (side === 'top' ? 'bottom' : 'top');
  commitPcb((pcb) => ({
    ...pcb,
    placements: pcb.placements.map((p) => (ids.has(p.componentId) ? { ...p, side: other(p.side) } : p)),
    texts: pcb.texts?.map((t) => (ids.has(t.id) ? { ...t, side: other(t.side) } : t)),
    logos: pcb.logos?.map((l) => (ids.has(l.id) ? { ...l, side: other(l.side) } : l)),
  }));
}

/* ---------- silkscreen ---------- */

export function addText(text: string, at: Vec, opts: Partial<Omit<SilkText, 'id' | 'text' | 'x' | 'y'>> = {}): SilkText {
  const t: SilkText = { id: newId('txt'), text, x: at[0], y: at[1], size: TEXT_SIZE, rotation: 0, side: sideOfLayer(st().activeLayer), ...opts };
  commitPcb((pcb) => ({ ...pcb, texts: [...(pcb.texts ?? []), t] }));
  return t;
}

export function updateText(id: string, patch: Partial<Omit<SilkText, 'id'>>) {
  commitPcb((pcb) => ({ ...pcb, texts: pcb.texts?.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function addLogo(logo: Omit<SilkLogo, 'id'>): SilkLogo {
  const l: SilkLogo = { ...logo, id: newId('logo') };
  commitPcb((pcb) => ({ ...pcb, logos: [...(pcb.logos ?? []), l] }));
  return l;
}

/** Changes a logo; a new width scales the height with it. */
export function updateLogo(id: string, patch: Partial<Pick<SilkLogo, 'x' | 'y' | 'width' | 'rotation' | 'side' | 'name'>>) {
  commitPcb((pcb) => ({
    ...pcb,
    logos: pcb.logos?.map((l) => (l.id === id ? { ...l, ...patch, height: patch.width ? (l.height * patch.width) / l.width : l.height } : l)),
  }));
}

/**
 * Changes a part's designator. `at` is a board position (stored relative to the part); null
 * resets the label to its default place and size.
 */
export function updateLabel(componentId: string, patch: (Omit<DesignatorLabel, 'x' | 'y'> & { at?: Vec }) | null) {
  commitPcb((pcb) => ({
    ...pcb,
    placements: pcb.placements.map((p) => {
      if (p.componentId !== componentId) return p;
      if (!patch) return { ...p, label: undefined };
      const { at, ...rest } = patch;
      const local = at ? worldToPlacement(p, at) : null;
      return { ...p, label: { ...p.label, ...rest, ...(local ? { x: local[0], y: local[1] } : {}) } };
    }),
  }));
}

/** Deletes the selected tracks, vias, pours, mounting holes, keepouts and cutouts (not parts). */
export function deleteSelectedCopper() {
  const ids = new Set(st().pcbSelection);
  removePcbItems(ids);
  st().setPcbSelection(st().pcbSelection.filter((id) => !ids.has(id) || st().project.components.some((c) => c.id === id)));
}

export function updatePlacement(componentId: string, patch: Partial<Placement>) {
  commitPcb((pcb) => ({ ...pcb, placements: pcb.placements.map((p) => (p.componentId === componentId ? { ...p, ...patch } : p)) }));
}

/** Switches between 2 and 4 copper layers; going back to 2 deletes the inner-layer copper. */
export function setLayerCount(layers: 2 | 4): { removedTracks: number; removedPours: number } {
  const pcb = currentPcb();
  const drop = layers === 2;
  const removedTracks = drop ? pcb.tracks.filter((t) => isInner(t.layer)).length : 0;
  const removedPours = drop ? (pcb.pours ?? []).filter((p) => isInner(p.layer)).length : 0;
  commitPcb((p) => ({
    ...p,
    board: { ...p.board, layers },
    tracks: drop ? p.tracks.filter((t) => !isInner(t.layer)) : p.tracks,
    pours: drop ? p.pours?.filter((z) => !isInner(z.layer)) : p.pours,
    keepouts: drop ? p.keepouts?.map((k) => ({ ...k, layers: k.layers.filter((l) => !isInner(l)) })).filter((k) => k.layers.length) : p.keepouts,
  }));
  if (drop && isInner(st().activeLayer)) st().setActiveLayer('top');
  return { removedTracks, removedPours };
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

/** Why a via of the design-rule size can't go at `at` (JLCPCB hole spacing), or null. */
export function viaPlacementProblem(at: Vec, project: Project = st().project): string | null {
  const pcb = currentPcb(project);
  const { board, conn } = boardModel(project);
  return viaHoleConflict(at, pcb.rules.viaDrill, drilledHoles(pcb, board, conn));
}

/** Places a via, unless its hole would crowd another drilled hole (then says why). */
export function addVia(at: Vec, net: string | null): Via | null {
  const problem = viaPlacementProblem(at);
  if (problem) {
    st().notify(`No room for a via here: ${problem}`, 'error');
    return null;
  }
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
    // A whole-board pour replaces the net's whole-board pours on those layers; zones add up.
    pours: [...(pcb.pours ?? []).filter((p) => settings.outline || p.outline || !(p.net === net && layers.includes(p.layer))), ...pours],
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
  // Switching layers on an existing via of this net uses it; otherwise a new via must fit.
  const { conn } = boardModel();
  const existing = currentPcb().vias.some((v) => Math.hypot(v.x - end[0], v.y - end[1]) < 0.01 && (conn.itemNet.get(v.id) ?? v.net) === d.net);
  const problem = existing ? null : viaPlacementProblem(end);
  if (problem) return s.notify(`No room for a via here: ${problem}`, 'error');
  const points = [...d.points, ...posture(d.points[d.points.length - 1], end)];
  if (points.length >= 2) addTrack(d.layer, d.width, points, d.net);
  if (!existing) addVia(end, d.net);
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
  /** Pads joined to an inner plane through a stub and via. */
  planes: number;
  /** Pads that found no room for a via to their plane. */
  planeFailed: string[];
}

/** Distance from narrow end copper within which a necked-down track stays narrow. */
const NECK_LENGTH = 1;

/**
 * Widens a route found at the narrow width wherever it can: segments more than NECK_LENGTH from
 * the narrow copper at its ends, and only where the wider copper still clears other nets. This is
 * the usual neck-down into fine-pitch pins, with full-width copper everywhere else.
 */
function neckDown(
  route: { layer: CopperLayer; points: Vec[] },
  narrow: number,
  wide: number,
  fineEnds: CopperShape[],
  others: CopperItem[],
  clearance: number,
): { width: number; points: Vec[] }[] {
  // Break the first and last segments NECK_LENGTH away from the narrow copper they start on.
  const pts = [...route.points];
  const near = (p: Vec) => fineEnds.some((shape) => pointShapeDistance(p, shape) === 0);
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
    const neck = fineEnds.some((shape) => shapeDistance({ ...seg, r: 0 }, shape) < NECK_LENGTH - 1e-6);
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

/**
 * The copper a connection ends on, with its narrow size: the pads containing the end point (an
 * airwire may end on a track vertex inside a pin rather than at the pin's centre), otherwise the
 * net's tracks or vias there, measured from the point itself so a neck-down doesn't follow the
 * whole track.
 */
function endCopper(p: Vec, net: string, board: BoardModel, netOf: (it: CopperItem) => string | null): { size: number; shape: CopperShape }[] {
  const pads = board.pads.filter((pad) => pad.net === net && pointShapeDistance(p, pad.shape) === 0);
  if (pads.length) return pads.map((pad) => ({ size: Math.min(pad.pad.w, pad.pad.h), shape: pad.shape }));
  const point: CopperShape = { kind: 'capsule', a: p, b: p, r: 0 };
  return board.items
    .filter((it) => it.type !== 'pad' && netOf(it) === net && it.shape.kind === 'capsule' && pointShapeDistance(p, it.shape) === 0)
    .map((it) => ({ size: (it.shape as { r: number }).r * 2, shape: point }));
}

function routeOne(project: Project, aw: Airwire, widthOverride?: number): { tracks: Track[]; vias: Via[] } | null {
  const pcb = currentPcb(project);
  const board = buildBoard(project, pcb);
  const conn = pcbConnectivity(board, pcb);
  // Route no wider than the copper at its ends (a 0.5 mm track cannot enter a 0.25 mm QFN pin
  // without crowding its neighbours), then widen away from it.
  const wide = widthOverride ?? trackWidthFor(aw.net, pcb);
  const netOf = (it: (typeof board.items)[number]) => (it.type === 'pad' ? it.net : (conn.itemNet.get(it.ref) ?? it.net));
  const fine = [aw.a, aw.b].flatMap((p) => endCopper(p, aw.net, board, netOf)).filter((e) => e.size < wide);
  const width = fine.length ? Math.max(pcb.rules.minTrackWidth, Math.min(...fine.map((e) => e.size))) : wide;
  // Keep other nets out from under metal connector shells where possible.
  const avoid = shellAreas(board)
    .filter((a) => !a.nets.has(aw.net))
    .map(({ layer, outlines }) => ({ layer, outlines }));
  const opts = { net: aw.net, width, rules: pcb.rules, board: pcb.board, items: board.items, netOf, avoid, edges: edgeField(pcb), keepouts: keepoutAreas(pcb), holes: drilledHoles(pcb, board, conn), layers: routingLayers(pcb) };
  const r = routeConnection({ point: aw.a, layers: aw.aLayers }, { point: aw.b, layers: aw.bLayers }, opts) ?? routeConnection({ point: aw.a, layers: aw.aLayers }, { point: aw.b, layers: aw.bLayers }, { ...opts, margin: 30 });
  if (!r) return null;
  const others = width < wide ? board.items.filter((it) => netOf(it) !== aw.net) : [];
  const pieces = r.tracks.flatMap((t) =>
    width < wide ? neckDown(t, width, wide, fine.map((e) => e.shape), others, pcb.rules.clearance).map((p) => ({ layer: t.layer, ...p })) : [{ layer: t.layer, width, points: t.points }],
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
/* ---------- inner planes ---------- */

/** Inner layers carrying a whole-board pour, with its net: power planes the router leaves alone. */
export function planeLayers(pcb: Pcb): Map<CopperLayer, string> {
  const stack = copperLayers(pcb);
  return new Map((pcb.pours ?? []).filter((p) => !p.outline && isInner(p.layer) && stack.includes(p.layer)).map((p) => [p.layer, p.net] as const));
}

/** Layers the auto-router uses: every copper layer except the planes. */
export function routingLayers(pcb: Pcb): CopperLayer[] {
  const planes = planeLayers(pcb);
  return copperLayers(pcb).filter((l) => !planes.has(l));
}

/**
 * Joins the surface-mount pads of plane nets (say GND on an inner plane) to their plane: a short
 * stub from the pad to a via just outside it, where the via clears other nets, drill holes, SMD
 * pads, keepouts and the edge. Pads already connected to the plane are left alone; through-hole
 * pads reach it by themselves.
 */
function fanoutToPlanes(project: Project, onlyNet?: string): { project: Project; joined: number; failed: string[] } {
  const pcb = currentPcb(project);
  const planes = planeLayers(pcb);
  const planeNets = new Map([...planes].filter(([, n]) => !onlyNet || n === onlyNet).map(([l, n]) => [n, l]));
  if (!planeNets.size) return { project, joined: 0, failed: [] };
  const { board, conn } = boardModel(project);
  const holes = drilledHoles(pcb, board, conn);
  const edges = boardEdges(pcb);
  const keepouts = keepoutAreas(pcb).filter((k) => k.vias && k.outline.length >= 3);
  const { clearance, viaDiameter, viaDrill } = pcb.rules;
  const r = viaDiameter / 2;
  const netOf = (it: CopperItem) => (it.type === 'pad' ? it.net : (conn.itemNet.get(it.ref) ?? it.net));
  const items: { it: CopperItem; net: string | null }[] = board.items.map((it) => ({ it, net: netOf(it) }));
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const failed: string[] = [];
  const snap = (v: number) => Math.round(v / 0.25) * 0.25;

  for (const pad of board.pads) {
    const planeLayer = pad.net ? planeNets.get(pad.net) : undefined;
    if (!pad.net || !planeLayer || pad.hole || pad.layers.length !== 1) continue;
    const fill = board.fills.find((f) => f.pour.layer === planeLayer && !f.pour.outline && f.pour.net === pad.net);
    const island = conn.island(`p:${pad.componentId}:${pad.index}`);
    if (fill?.areas.some((_, i) => conn.island(`z:${fill.pour.id}:${i}`) === island)) continue;

    const layer = pad.layers[0];
    const width = Math.max(pcb.rules.minTrackWidth, Math.min(trackWidthFor(pad.net, pcb), pad.pad.w, pad.pad.h));
    const part = board.parts.find((p) => p.component.id === pad.componentId)!;
    const centre: Vec = [(part.box.x1 + part.box.x2) / 2, (part.box.y1 + part.box.y2) / 2];
    const away = Math.atan2(pad.center[1] - centre[1], pad.center[0] - centre[0]) || -Math.PI / 2;
    const candidates: Vec[] = [];
    const seen = new Set<string>();
    // First straight out along the pad's own axes, outward from the part first, so the stub stays
    // in line with a fine-pitch pin instead of cutting across its neighbours.
    const long = rotateDeg(pad.pad.w >= pad.pad.h ? [1, 0] : [0, 1], pad.rotation);
    const axes = [
      { dir: long, reach: Math.max(pad.pad.w, pad.pad.h) / 2 },
      { dir: [-long[0], -long[1]] as Vec, reach: Math.max(pad.pad.w, pad.pad.h) / 2 },
      { dir: [-long[1], long[0]] as Vec, reach: Math.min(pad.pad.w, pad.pad.h) / 2 },
      { dir: [long[1], -long[0]] as Vec, reach: Math.min(pad.pad.w, pad.pad.h) / 2 },
    ].sort((p, q) => q.dir[0] * Math.cos(away) + q.dir[1] * Math.sin(away) - (p.dir[0] * Math.cos(away) + p.dir[1] * Math.sin(away)));
    for (let step = 0; step < 10; step++)
      for (const { dir, reach } of axes) {
        const dist = reach + r + 0.15 + step * 0.25;
        candidates.push([Math.round((pad.center[0] + dir[0] * dist) * 1000) / 1000, Math.round((pad.center[1] + dir[1] * dist) * 1000) / 1000]);
      }
    // Then anywhere around it on the routing grid, nearest spots first.
    for (let dist = Math.min(pad.pad.w, pad.pad.h) / 2 + r + 0.15; dist <= 3; dist += 0.25)
      for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8]) {
        const a = away + (k * Math.PI) / 8;
        const at: Vec = [snap(pad.center[0] + dist * Math.cos(a)), snap(pad.center[1] + dist * Math.sin(a))];
        const key = at.join(',');
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(at);
        }
      }
    const fits = (at: Vec) => {
      if (!insideBoard(at, edges) || edgeDistance(at, edges) < r + POUR_EDGE_CLEARANCE) return false;
      if (keepouts.some((k) => pointShapeDistance(at, { kind: 'poly', points: k.outline }) < r + 0.05)) return false;
      if (viaHoleConflict(at, viaDrill, holes)) return false;
      const via = { kind: 'capsule' as const, a: at, b: at, r };
      const stub = { kind: 'capsule' as const, a: pad.center, b: at, r: width / 2 };
      return items.every(({ it, net }) => {
        // No via in any SMD pad, its own included: solder would wick into the hole.
        if (it.type === 'pad' && it.layers.length === 1 && shapeDistance(via, it.shape) < 0.1) return false;
        if (net === pad.net) return true;
        if (shapeDistance(via, it.shape) < clearance) return false;
        return !it.layers.includes(layer) || shapeDistance(stub, it.shape) >= clearance;
      });
    };
    const at = candidates.find(fits);
    if (!at) {
      failed.push(`${pad.designator}.${pad.number}`);
      continue;
    }
    const track: Track = { id: newId('t'), layer, width, points: [pad.center, at], net: pad.net };
    const via: Via = { id: newId('v'), x: at[0], y: at[1], diameter: viaDiameter, drill: viaDrill, net: pad.net };
    tracks.push(track);
    vias.push(via);
    for (const it of [...trackItems(track), viaItem(via, copperLayers(pcb))]) items.push({ it, net: pad.net });
    holes.push({ center: at, d: viaDrill, len: 0, kind: 'via', net: pad.net, name: `${pad.net} via` });
  }
  return { project: { ...project, pcb: { ...pcb, tracks: [...pcb.tracks, ...tracks], vias: [...pcb.vias, ...vias] } }, joined: vias.length, failed };
}

/**
 * Routes the airwires `want` accepts one at a time, shortest first, into `project`; returns the
 * updated project. Connections that fail are recorded in the report and not retried.
 */
function routeAirwires(project: Project, want: (a: Airwire) => boolean, width: number | undefined, report: AutorouteReport): Project {
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
    const pending = conn.airwires.filter((a) => want(a) && !skip.has(`${a.net}|${a.a}|${a.b}`)).sort((p, q) => samePart(p) - samePart(q) || length(p) - length(q));
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
  return project;
}

/**
 * Auto-routes unrouted connections, optionally of one net and at a given width, as one undo step.
 * On boards with inner planes the other nets go first, then each pad of a plane net drops into its
 * plane through a via in the room left (vias placed first would block fine-pitch pins), and only
 * pads that found no room are routed with tracks.
 */
export function autoroute(net?: string, width?: number): AutorouteReport {
  const report: AutorouteReport = { routed: 0, failed: [], planes: 0, planeFailed: [] };
  const planeNets = new Set(planeLayers(currentPcb()).values());
  const wanted = (a: Airwire) => !net || a.net === net;
  let project = routeAirwires(st().project, (a) => wanted(a) && !planeNets.has(a.net), width, report);
  if (planeNets.size) {
    const fanout = fanoutToPlanes(project, net);
    report.planes = fanout.joined;
    report.planeFailed = fanout.failed;
    project = routeAirwires(fanout.project, (a) => wanted(a) && planeNets.has(a.net), width, report);
  }
  if (report.routed > 0 || report.planes > 0) {
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
