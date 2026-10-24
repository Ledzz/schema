/*
 * Editor commands bound to keyboard shortcuts, menus and toolbar buttons.
 */
import { useEditor } from '../store/editor';
import { nextDesignator, splitDesignator, annotate } from './schematic/designators';
import { componentBox, unionBoxes } from './schematic/geometry';
import { portBox } from './schematic/hit';
import { deleteItems, duplicateItems, mirrorItems, rotateItems, addWire, newId, type Doc } from './schematic/ops';
import { resolverFor } from './schematic/symbols';
import type { Component, Project, Vec } from './schematic/types';
import { emptyProject } from '../store/editor';
import { downloadText, safeFileName } from './actions';

const st = () => useEditor.getState();
const selectedSet = () => new Set(st().selection);
const symbols = () => resolverFor(st().project);

export function deleteSelection() {
  const ids = selectedSet();
  if (ids.size === 0) return;
  st().commit((doc) => deleteItems(doc, ids));
  st().setSelection([]);
}

export function rotateSelection() {
  const s = st();
  if (s.tool === 'place' || s.tool === 'label' || s.tool === 'power' || s.tool === 'ground') return s.rotatePlacement();
  const ids = selectedSet();
  if (ids.size) s.commit((doc) => rotateItems(doc, ids, symbols()));
}

export function mirrorSelection() {
  const s = st();
  if (s.tool === 'place') return s.mirrorPlacement();
  const ids = selectedSet();
  if (ids.size) s.commit((doc) => mirrorItems(doc, ids, symbols()));
}

const renameCopy = (c: Component, placed: Component[]) => nextDesignator(splitDesignator(c.designator).prefix, placed);

export function duplicateSelection() {
  const ids = selectedSet();
  if (ids.size === 0) return;
  let created: string[] = [];
  st().commit((doc) => {
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

export function paste() {
  if (!clipboard) return;
  const clip = clipboard;
  const off = 30;
  let created: string[] = [];
  st().addSymbols(clip.symbols);
  st().commit((doc) => {
    const placed = [...doc.components];
    const components = clip.components.map((c) => {
      const copy: Component = { ...c, id: newId('c'), x: c.x + off, y: c.y + off, attrs: { ...c.attrs } };
      copy.designator = renameCopy(copy, placed);
      placed.push(copy);
      return copy;
    });
    const wires = clip.wires.map((w) => ({ id: newId('w'), points: w.points.map(([x, y]) => [x + off, y + off] as Vec) }));
    const ports = clip.ports.map((p) => ({ ...p, id: newId('n'), x: p.x + off, y: p.y + off }));
    created = [...components, ...wires, ...ports].map((i) => i.id);
    // Repeated pastes cascade instead of stacking.
    clipboard = { ...clip, components, wires, ports };
    return { ...doc, components: [...doc.components, ...components], wires: [...doc.wires, ...wires], ports: [...doc.ports, ...ports] };
  });
  st().setSelection(created);
}

export function selectAll() {
  const { project } = st();
  st().setSelection([...project.components, ...project.wires, ...project.ports].map((i) => i.id));
}

export function finishWireDraft() {
  const draft = st().wireDraft;
  st().setWireDraft(null);
  if (draft && draft.length >= 2) st().commit((doc) => addWire(doc, draft).doc);
}

export function contentBounds(project: Project) {
  const resolve = resolverFor(project);
  const boxes = [
    ...project.components.map((c) => componentBox(c, resolve(c.symbolKey))),
    ...project.ports.map(portBox),
    ...project.wires.map((w) => {
      const xs = w.points.map((p) => p[0]);
      const ys = w.points.map((p) => p[1]);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }),
  ];
  return unionBoxes(boxes);
}

export function fitView(ids?: string[]) {
  const { project, canvasSize } = st();
  const subset: Project = ids?.length
    ? {
        ...project,
        components: project.components.filter((c) => ids.includes(c.id)),
        wires: project.wires.filter((w) => ids.includes(w.id)),
        ports: project.ports.filter((p) => ids.includes(p.id)),
      }
    : project;
  const b = contentBounds(subset);
  if (!b) {
    st().setView({ x: canvasSize.width / 2, y: canvasSize.height / 2, zoom: 2.5 });
    return;
  }
  const margin = 60;
  const w = Math.max(b.x2 - b.x1, 40);
  const h = Math.max(b.y2 - b.y1, 40);
  const zoom = Math.min(8, Math.max(0.2, Math.min((canvasSize.width - margin * 2) / w, (canvasSize.height - margin * 2) / h)));
  st().setView({
    zoom,
    x: canvasSize.width / 2 - ((b.x1 + b.x2) / 2) * zoom,
    y: canvasSize.height / 2 - ((b.y1 + b.y2) / 2) * zoom,
  });
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
  const { project } = st();
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
