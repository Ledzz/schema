/*
 * Editor commands bound to keyboard shortcuts, menus and toolbar buttons.
 */
import { useEditor } from '../store/editor';
import { nextDesignator, splitDesignator, annotate } from './schematic/designators';
import { componentBox, samePoint, snap, unionBoxes } from './schematic/geometry';
import { blockBox, onSheet, sheetOf, sheetView } from './schematic/sheets';
import { portBox } from './schematic/hit';
import { alignItems, deleteItems, dropNoConnects, duplicateItems, mirrorItems, rotateItems, addWire, newId, type AlignMode, type Doc } from './schematic/ops';
import { connectionNear } from './schematic/hit';
import { elbow, simplify, wireVerticalFirst } from './schematic/route';
import { resolverFor } from './schematic/symbols';
import type { Component, Project, Vec } from './schematic/types';
import { emptyProject } from '../store/editor';
import { downloadText, endByKey, planPinRoute, safeFileName, type PinEnd } from './actions';

const st = () => useEditor.getState();
const selectedSet = () => new Set(st().selection);
const symbols = () => resolverFor(st().project);

/** The project as seen on the sheet being drawn on. */
export const currentView = (): Project => sheetView(st().project, st().currentSheet);

/** Commits an edit to the sheet being drawn on: geometry never reaches other sheets. */
export const commitSheet = (edit: (view: Doc) => Doc) => st().commit((doc) => onSheet(doc, st().currentSheet, edit));

export function deleteSelection() {
  const ids = selectedSet();
  if (ids.size === 0) return;
  commitSheet((doc) => deleteItems(doc, ids, symbols()));
  st().setSelection([]);
}

export function rotateSelection() {
  const s = st();
  if (s.tool === 'place' || s.tool === 'label' || s.tool === 'power' || s.tool === 'ground' || s.tool === 'hier') return s.rotatePlacement();
  const ids = selectedSet();
  if (ids.size) commitSheet((doc) => rotateItems(doc, ids, symbols()));
}

export function mirrorSelection() {
  const s = st();
  if (s.tool === 'place') return s.mirrorPlacement();
  const ids = selectedSet();
  if (ids.size) commitSheet((doc) => mirrorItems(doc, ids, symbols()));
}

/** A copy's designator, numbered after every part of the project (on any sheet). */
const renameCopy = (c: Component, placed: Component[]) => {
  const elsewhere = st().project.components.filter((x) => sheetOf(x, st().project) !== st().currentSheet);
  return nextDesignator(splitDesignator(c.designator).prefix, [...elsewhere, ...placed]);
};

export function duplicateSelection() {
  const ids = selectedSet();
  if (ids.size === 0) return;
  let created: string[] = [];
  commitSheet((doc) => {
    const r = duplicateItems(doc, ids, [20, 20], renameCopy);
    created = r.newIds;
    return r.doc;
  });
  st().setSelection(created);
}

let clipboard: Doc | null = null;

export function copySelection() {
  const ids = selectedSet();
  if (ids.size === 0) return;
  const { project } = st();
  clipboard = {
    components: project.components.filter((c) => ids.has(c.id)),
    wires: project.wires.filter((w) => ids.has(w.id)),
    ports: project.ports.filter((p) => ids.has(p.id)),
    symbols: project.symbols,
  };
}

export const hasClipboard = () => clipboard !== null;

/** Pastes the copied items, 30 units further on, or with their top-left corner at `at`. */
export function paste(at?: Vec) {
  if (!clipboard) return;
  const clip = clipboard;
  let off: Vec = [30, 30];
  if (at) {
    const xs = [...clip.components.map((c) => c.x), ...clip.wires.flatMap((w) => w.points.map((p) => p[0])), ...clip.ports.map((p) => p.x)];
    const ys = [...clip.components.map((c) => c.y), ...clip.wires.flatMap((w) => w.points.map((p) => p[1])), ...clip.ports.map((p) => p.y)];
    off = [snap(at[0] - Math.min(...xs), 10), snap(at[1] - Math.min(...ys), 10)];
  }
  let created: string[] = [];
  st().addSymbols(clip.symbols);
  // Pasted onto the sheet being drawn on, wherever it was copied from.
  commitSheet((doc) => {
    const placed = [...doc.components];
    const components = clip.components.map((c) => {
      const copy: Component = { ...c, id: newId('c'), x: c.x + off[0], y: c.y + off[1], attrs: { ...c.attrs } };
      copy.designator = renameCopy(copy, placed);
      placed.push(copy);
      return copy;
    });
    const wires = clip.wires.map((w) => ({ id: newId('w'), points: w.points.map(([x, y]) => [x + off[0], y + off[1]] as Vec) }));
    const ports = clip.ports.map((p) => ({ ...p, id: newId('n'), x: p.x + off[0], y: p.y + off[1] }));
    created = [...components, ...wires, ...ports].map((i) => i.id);
    // Repeated pastes cascade instead of stacking.
    clipboard = { ...clip, components, wires, ports };
    return { ...doc, components: [...doc.components, ...components], wires: [...doc.wires, ...wires], ports: [...doc.ports, ...ports] };
  });
  st().setSelection(created);
}

/** Aligns or distributes the selected parts and labels as one undo step. */
export function alignSelection(mode: AlignMode) {
  const ids = selectedSet();
  commitSheet((doc) => alignItems(doc, ids, mode, symbols()));
}

export function selectAll() {
  const project = currentView();
  st().setSelection([...project.components, ...project.wires, ...project.ports, ...(project.blocks ?? [])].map((i) => i.id));
}

export function finishWireDraft() {
  const { wireDraft: draft, wireOneShot } = st();
  st().setWireDraft(null);
  if (draft && draft.length >= 2) commitSheet((doc) => dropNoConnects(addWire(doc, draft).doc, [draft[0], draft[draft.length - 1]]));
  if (wireOneShot) st().setTool('select');
}

/** Takes the last corner off the wire being drawn; returns false when no wire is being drawn. */
export function removeWirePoint(): boolean {
  const { wireDraft: draft, wireOneShot } = st();
  if (!draft) return false;
  if (draft.length > 1) st().setWireDraft(draft.slice(0, -1));
  else {
    st().setWireDraft(null);
    if (wireOneShot) st().setTool('select');
  }
  return true;
}

const pinAt = (project: Project, p: Vec): PinEnd | null => {
  const hit = connectionNear(project, resolverFor(project), p, 0.01);
  return (hit?.kind === 'pin' || hit?.kind === 'block') && hit.ref ? endByKey(hit.ref, project) : null;
};

/**
 * The wire being drawn as it would be with its next point at `to`. From one pin straight to
 * another it is routed around parts (unless the bend was flipped, which asks for a plain bend);
 * otherwise it is an L-bend that leaves a pin along the pin and turns at each corner.
 */
export function wireDraftTo(draft: Vec[], to: Vec, project: Project = currentView(), flip = st().wireFlip): { points: Vec[]; routed: boolean } {
  const start = pinAt(project, draft[0]);
  if (draft.length === 1 && start && !flip) {
    const end = pinAt(project, to);
    const route = end && !samePoint(end.at, start.at) ? planPinRoute(project, start, end) : null;
    if (route) return { points: route, routed: true };
  }
  const last = draft[draft.length - 1];
  const vertical = wireVerticalFirst(draft, to, draft.length === 1 && start ? start.dir : null, flip);
  return { points: simplify([...draft, ...elbow(last, to, vertical).slice(1)]), routed: false };
}

export function contentBounds(project: Project) {
  const resolve = resolverFor(project);
  const boxes = [
    ...project.components.map((c) => componentBox(c, resolve(c.symbolKey))),
    ...project.ports.map(portBox),
    ...(project.blocks ?? []).map(blockBox),
    ...project.wires.map((w) => {
      const xs = w.points.map((p) => p[0]);
      const ys = w.points.map((p) => p[1]);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }),
  ];
  return unionBoxes(boxes);
}

/** Height of the schematic's floating toolbar, which sits over the top of the canvas. */
const TOOLBAR_HEIGHT = 56;

/** Bounds of the given items on the sheet shown, after switching to their sheet when none are on it. */
function itemBounds(ids: string[]) {
  const whole = st().project;
  const items = [...whole.components, ...whole.wires, ...whole.ports, ...(whole.blocks ?? [])].filter((i) => ids.includes(i.id));
  if (items.length && !items.some((i) => sheetOf(i, whole) === st().currentSheet)) st().setCurrentSheet(sheetOf(items[0], whole));
  const project = currentView();
  return contentBounds({
    ...project,
    components: project.components.filter((c) => ids.includes(c.id)),
    wires: project.wires.filter((w) => ids.includes(w.id)),
    ports: project.ports.filter((p) => ids.includes(p.id)),
    blocks: (project.blocks ?? []).filter((b) => ids.includes(b.id)),
  });
}

/** Zooms to fit the sheet, or the given items (switching to their sheet first). */
export function fitView(ids?: string[]) {
  const b = ids?.length ? itemBounds(ids) : contentBounds(currentView());
  const { canvasSize } = st();
  if (!b) {
    st().setView({ x: canvasSize.width / 2, y: canvasSize.height / 2, zoom: 2.5 });
    return;
  }
  const margin = 60;
  // The floating toolbar covers the top of the canvas: fit into the area below it.
  const top = TOOLBAR_HEIGHT;
  const w = Math.max(b.x2 - b.x1, 40);
  const h = Math.max(b.y2 - b.y1, 40);
  // A single small part shouldn't fill the screen.
  const zoom = Math.min(ids?.length ? 4 : 8, Math.max(0.2, Math.min((canvasSize.width - margin * 2) / w, (canvasSize.height - top - margin * 2) / h)));
  st().setView({
    zoom,
    x: canvasSize.width / 2 - ((b.x1 + b.x2) / 2) * zoom,
    y: top + (canvasSize.height - top) / 2 - ((b.y1 + b.y2) / 2) * zoom,
  });
}

/**
 * Brings items into view at the current zoom: switches to their sheet when none are on this one,
 * centres them when any part is out of view, and fits them only when they don't fit.
 */
export function revealItems(ids: string[]) {
  const b = itemBounds(ids);
  const { view, canvasSize: size } = st();
  if (!b || !size.width) return;
  const k = view.zoom;
  const seen = { x1: -view.x / k, y1: (TOOLBAR_HEIGHT - view.y) / k, x2: (size.width - view.x) / k, y2: (size.height - view.y) / k };
  if (b.x1 >= seen.x1 && b.x2 <= seen.x2 && b.y1 >= seen.y1 && b.y2 <= seen.y2) return;
  if (b.x2 - b.x1 > (seen.x2 - seen.x1) * 0.9 || b.y2 - b.y1 > (seen.y2 - seen.y1) * 0.9) return fitView(ids);
  st().setView({ zoom: k, x: size.width / 2 - ((b.x1 + b.x2) / 2) * k, y: (size.height + TOOLBAR_HEIGHT) / 2 - ((b.y1 + b.y2) / 2) * k });
}

/** Shows another sheet, fitted to the window once it is drawn. */
export function openSheet(id: string) {
  st().setCurrentSheet(id);
  requestAnimationFrame(() => fitView());
}

export function zoomBy(factor: number, at?: Vec) {
  const { view, canvasSize } = st();
  const [sx, sy] = at ?? [canvasSize.width / 2, canvasSize.height / 2];
  const zoom = Math.min(20, Math.max(0.15, view.zoom * factor));
  const k = zoom / view.zoom;
  st().setView({ zoom, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k });
}

export function reannotate() {
  st().commit((doc) => {
    const names = annotate(doc.components);
    return { ...doc, components: doc.components.map((c) => ({ ...c, designator: names.get(c.id) ?? c.designator })) };
  });
}

export function newProject(name = 'Untitled') {
  st().loadProject(emptyProject(name));
  fitView();
}

export function saveProjectFile() {
  const { project } = st();
  downloadText(`${safeFileName(project.name)}.schematic.json`, JSON.stringify(project, null, 1), 'application/json');
}

export async function openProjectFile(file: File) {
  try {
    const p = JSON.parse(await file.text()) as Project;
    if (p.version !== 1 || !Array.isArray(p.components) || !Array.isArray(p.wires)) throw new Error('Not a schematic project file');
    st().loadProject({ ...p, ports: p.ports ?? [], symbols: p.symbols ?? {}, id: p.id ?? newId('prj') });
    requestAnimationFrame(() => fitView());
  } catch (err) {
    st().notify(`Could not open file: ${(err as Error).message}`, 'error');
  }
}

/** Serializes the drawing (not the grid) as a standalone SVG. */
export function exportSvg(svg: SVGSVGElement | null) {
  const project = currentView();
  const content = svg?.querySelector('[data-layer="world"]');
  const b = contentBounds(project);
  if (!content || !b) return;
  const pad = 20;
  const clone = content.cloneNode(true) as SVGGElement;
  clone.removeAttribute('transform');
  clone.querySelectorAll('[data-ephemeral]').forEach((n) => n.remove());
  const styles = getComputedStyle(document.documentElement);
  const vars = ['--canvas-bg', '--sym-stroke', '--sym-fill', '--pin', '--pin-text', '--sym-text', '--wire', '--junction', '--label', '--power', '--select', '--highlight', '--unconnected', '--muted'];
  const css = `:root{${vars.map((v) => `${v}:${styles.getPropertyValue(v)}`).join(';')}} text{font-family:Inter,system-ui,sans-serif}`;
  const w = b.x2 - b.x1 + pad * 2;
  const h = b.y2 - b.y1 + pad * 2;
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x1 - pad} ${b.y1 - pad} ${w} ${h}" width="${w * 4}" height="${h * 4}"><style>${css}</style><rect x="${b.x1 - pad}" y="${b.y1 - pad}" width="${w}" height="${h}" fill="var(--canvas-bg)"/>${clone.innerHTML}</svg>`;
  downloadText(`${safeFileName(project.name)}.svg`, out, 'image/svg+xml');
}
