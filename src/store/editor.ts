import { create } from 'zustand';
import { newId, syncBlocks, type Doc } from '../lib/schematic/ops';
import { FIRST_SHEET, sheetView, sheetsOf } from '../lib/schematic/sheets';
import type { Component, NetPort, PortKind, Project, Rotation, Vec } from '../lib/schematic/types';
import type { PartClass } from '../shared/parts';
import type { CopperLayer } from '../lib/pcb/types';
import type { DrcIssue } from '../lib/pcb/drc';

export type Tool = 'select' | 'wire' | 'label' | 'power' | 'ground' | 'noconnect' | 'hier' | 'place';
/** How routing and track dragging treat other nets' tracks in the way. */
export type RouteMode = 'push' | 'walk' | 'ignore';
export const ROUTE_MODE_NAMES: Record<RouteMode, string> = { push: 'Push', walk: 'Walk around', ignore: 'Ignore' };

export type PcbTool = 'select' | 'route' | 'via' | 'hole' | 'keepout' | 'cutout' | 'zone' | 'outline' | 'text';
/** PCB tools that draw an area: drag a rectangle, or click corners and close the shape. */
export const SHAPE_TOOLS: readonly PcbTool[] = ['keepout', 'cutout', 'zone', 'outline'];

export interface RouteDraft {
  net: string | null;
  layer: CopperLayer;
  width: number;
  points: Vec[];
}

export interface Placing {
  symbolKey: string;
  prefix: string;
  template: Omit<Component, 'id' | 'x' | 'y' | 'designator'>;
}

export interface PortTemplate {
  kind: PortKind;
  name: string;
  rotation: Rotation;
}

export interface View {
  /** screen = world * zoom + (x, y) */
  x: number;
  y: number;
  zoom: number;
}

export interface AgentLogEntry {
  id: string;
  at: number;
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
}

export type LeftTab = 'project' | 'bom' | 'check';
export type RightTab = 'properties' | 'agent';

const HISTORY_LIMIT = 200;
const STORAGE_KEY = 'schematics:project';

export function emptyProject(name = 'Untitled'): Project {
  return { version: 1, id: newId('prj'), name, updatedAt: Date.now(), components: [], wires: [], ports: [], symbols: {} };
}

function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Project;
      if (p.version === 1 && Array.isArray(p.components)) return p;
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return emptyProject();
}

const docOf = (p: Project): Doc => ({ components: p.components, wires: p.wires, ports: p.ports, symbols: p.symbols, pcb: p.pcb, sheets: p.sheets, blocks: p.blocks });

/** Symbols and footprints are append-only caches, so history never removes them. */
function keepCaches(target: Doc, current: Project): Doc {
  const symbols = { ...target.symbols, ...current.symbols };
  const pcb = target.pcb && current.pcb ? { ...target.pcb, footprints: { ...target.pcb.footprints, ...current.pcb.footprints } } : target.pcb;
  return { ...target, symbols, pcb };
}

interface EditorState {
  project: Project;
  past: Doc[];
  future: Doc[];
  /** Document before the current drag/transient edit started. */
  transientBase: Doc | null;
  selection: string[];
  tool: Tool;
  placing: Placing | null;
  portTemplate: PortTemplate;
  placementRotation: Rotation;
  placementMirror: boolean;
  view: View;
  canvasSize: { width: number; height: number };
  cursor: Vec;
  wireDraft: Vec[] | null;
  /** The schematic sheet being shown and drawn on. */
  currentSheet: string;
  setCurrentSheet: (sheet: string) => void;
  /** Swaps the direction of the next bend of the wire being drawn. */
  wireFlip: boolean;
  /** The wire was started from a pin in the select tool: go back to it when the wire ends. */
  wireOneShot: boolean;
  /** Last name used for each kind of label or flag, offered when the tool starts again. */
  portNames: Partial<Record<PortKind, string>>;
  theme: 'dark' | 'light';
  libraryOpen: boolean;
  libraryHeight: number;
  leftTab: LeftTab;
  rightTab: RightTab;
  /** Set to drive the library panel from elsewhere (inspector "replace", agent tools…). */
  libraryRequest: { q: string; nonce: number; replaceId?: string; types?: PartClass[] } | null;
  highlightNet: string | null;
  agentLog: AgentLogEntry[];
  toast: { id: number; message: string; tone: 'info' | 'error' } | null;

  commit: (fn: (doc: Doc) => Doc) => void;
  /** Changes the document without a new undo step (folds into the previous one). */
  amend: (fn: (doc: Doc) => Doc) => void;
  quickEditId: string | null;
  setQuickEdit: (id: string | null) => void;
  /** The "Order from JLCPCB" sheet is open. */
  orderOpen: boolean;
  setOrderOpen: (open: boolean) => void;
  /** The circuit block picker is open. */
  blocksOpen: boolean;
  setBlocksOpen: (open: boolean) => void;
  /** The ⌘F find box is open. */
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  /** The "Save as block" dialog is open (for the current selection). */
  saveBlockOpen: boolean;
  setSaveBlockOpen: (open: boolean) => void;
  /** The PCB editor shows the 3D view instead of the 2D canvas. */
  pcb3d: boolean;
  setPcb3d: (on: boolean) => void;

  mode: 'schematic' | 'pcb';
  setMode: (mode: 'schematic' | 'pcb') => void;
  pcbView: View;
  setPcbView: (view: View) => void;
  pcbTool: PcbTool;
  setPcbTool: (tool: PcbTool) => void;
  activeLayer: CopperLayer;
  setActiveLayer: (layer: CopperLayer) => void;
  pcbSelection: string[];
  setPcbSelection: (ids: string[]) => void;
  routeDraft: RouteDraft | null;
  setRouteDraft: (draft: RouteDraft | null) => void;
  /** Corners clicked so far with an area tool (keepout, cutout, zone, outline). */
  shapeDraft: Vec[] | null;
  setShapeDraft: (points: Vec[] | null) => void;
  pcbHighlightNet: string | null;
  setPcbHighlightNet: (net: string | null) => void;
  pcbCursor: Vec;
  setPcbCursor: (p: Vec) => void;
  pcbLeftTab: 'parts' | 'nets' | 'drc' | 'jlcpcb';
  setPcbLeftTab: (tab: 'parts' | 'nets' | 'drc' | 'jlcpcb') => void;
  pcbCanvasSize: { width: number; height: number };
  setPcbCanvasSize: (size: { width: number; height: number }) => void;
  pcbIssues: DrcIssue[];
  setPcbIssues: (issues: DrcIssue[]) => void;
  showPours: boolean;
  setShowPours: (show: boolean) => void;
  routeMode: RouteMode;
  setRouteMode: (mode: RouteMode) => void;
  /** designs/<file> the project was opened from (dev only). */
  sourceFile: string | null;
  beginTransient: () => void;
  updateTransient: (fn: (base: Doc) => Doc) => void;
  endTransient: () => void;
  undo: () => void;
  redo: () => void;
  /** The document now, to fold the edits made after it into one undo step (or drop them). */
  historyMark: () => Doc;
  /** Turns every edit since `mark` into a single undo step. */
  squashHistory: (mark: Doc) => void;
  /** Throws away every edit since `mark`. */
  revertHistory: (mark: Doc) => void;
  addSymbols: (symbols: Project['symbols']) => void;
  loadProject: (p: Project) => void;
  renameProject: (name: string) => void;
  setTool: (tool: Tool) => void;
  startPlacing: (placing: Placing) => void;
  startPort: (kind: PortKind, name?: string) => void;
  /** Starts a wire at a pin from the select tool; the editor returns to select when it ends. */
  startWire: (at: Vec) => void;
  toggleWireFlip: () => void;
  setPortTemplate: (patch: Partial<PortTemplate>) => void;
  rotatePlacement: () => void;
  mirrorPlacement: () => void;
  setSelection: (ids: string[]) => void;
  setView: (view: View) => void;
  setCanvasSize: (size: { width: number; height: number }) => void;
  setCursor: (p: Vec) => void;
  setWireDraft: (draft: Vec[] | null) => void;
  toggleTheme: () => void;
  setLibraryOpen: (open: boolean) => void;
  setLibraryHeight: (h: number) => void;
  setLeftTab: (t: LeftTab) => void;
  setRightTab: (t: RightTab) => void;
  requestLibrary: (q: string, replaceId?: string, types?: PartClass[]) => void;
  setHighlightNet: (net: string | null) => void;
  logAgent: (entry: Omit<AgentLogEntry, 'id' | 'at'>) => void;
  notify: (message: string, tone?: 'info' | 'error') => void;
  updateComponent: (id: string, patch: Partial<Component>) => void;
  updatePort: (id: string, patch: Partial<NetPort>) => void;
}

const initialTheme = (): 'dark' | 'light' => {
  try {
    const t = localStorage.getItem('schematics:theme');
    if (t === 'dark' || t === 'light') return t;
  } catch {
    /* ignore */
  }
  return 'dark';
};

let toastId = 0;

/** A new label or flag's name: the project's most used power or ground net, or NET1 for labels. */
function defaultPortName(kind: PortKind, project: Project): string {
  if (kind === 'noconnect') return '';
  if (kind === 'label') return 'NET1';
  if (kind === 'hier') return 'IO1';
  const counts = new Map<string, number>();
  for (const p of project.ports) if (p.kind === kind && p.name.trim()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const used = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return used ?? (kind === 'power' ? 'VCC' : 'GND');
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: loadProject(),
  past: [],
  future: [],
  transientBase: null,
  selection: [],
  tool: 'select',
  placing: null,
  portTemplate: { kind: 'label', name: 'NET1', rotation: 0 },
  placementRotation: 0,
  placementMirror: false,
  view: { x: 400, y: 260, zoom: 2.5 },
  canvasSize: { width: 800, height: 520 },
  cursor: [0, 0],
  wireDraft: null,
  currentSheet: FIRST_SHEET,
  setCurrentSheet: (currentSheet) => {
    // Keep only the selected items that are on the new sheet.
    const v = sheetView(get().project, currentSheet);
    const here = new Set([...v.components, ...v.wires, ...v.ports, ...(v.blocks ?? [])].map((i) => i.id));
    set({ currentSheet, selection: get().selection.filter((id) => here.has(id)), wireDraft: null, quickEditId: null });
  },
  wireFlip: false,
  wireOneShot: false,
  portNames: {},
  theme: initialTheme(),
  libraryOpen: true,
  libraryHeight: 360,
  leftTab: 'project',
  rightTab: 'properties',
  libraryRequest: null,
  highlightNet: null,
  agentLog: [],
  toast: null,

  commit: (fn) => {
    const { project, past } = get();
    const before = docOf(project);
    const changed = fn(before);
    if (changed === before) return;
    // Blocks follow the hierarchical ports on their sheets.
    const after = syncBlocks(changed);
    const ids = new Set([...after.components, ...after.wires, ...after.ports, ...(after.blocks ?? [])].map((i) => i.id));
    set({
      project: { ...project, ...after, updatedAt: Date.now() },
      past: [...past.slice(-HISTORY_LIMIT + 1), before],
      future: [],
      selection: get().selection.filter((id) => ids.has(id)),
    });
  },

  amend: (fn) => {
    const { project } = get();
    const after = fn(docOf(project));
    set({ project: { ...project, ...after, updatedAt: Date.now() } });
  },
  quickEditId: null,
  setQuickEdit: (quickEditId) => set({ quickEditId }),
  orderOpen: false,
  setOrderOpen: (orderOpen) => set({ orderOpen }),
  blocksOpen: false,
  setBlocksOpen: (blocksOpen) => set({ blocksOpen }),
  findOpen: false,
  setFindOpen: (findOpen) => set({ findOpen }),
  saveBlockOpen: false,
  setSaveBlockOpen: (saveBlockOpen) => set({ saveBlockOpen }),
  pcb3d: false,
  setPcb3d: (pcb3d) => set({ pcb3d }),

  mode: (() => {
    try {
      return localStorage.getItem('schematics:mode') === 'pcb' ? 'pcb' : 'schematic';
    } catch {
      return 'schematic';
    }
  })(),
  setMode: (mode) => {
    try {
      localStorage.setItem('schematics:mode', mode);
    } catch {
      /* ignore */
    }
    if (get().routeDraft && get().transientBase) get().endTransient();
    set({ mode, routeDraft: null, shapeDraft: null, quickEditId: null });
  },
  pcbView: { x: 120, y: 80, zoom: 12 },
  setPcbView: (pcbView) => set({ pcbView }),
  pcbTool: 'select',
  setPcbTool: (pcbTool) => {
    // A route drawn in push mode keeps what it pushed so far, as one undo step.
    if (get().routeDraft && get().transientBase) get().endTransient();
    set({ pcbTool, routeDraft: null, shapeDraft: null });
  },
  activeLayer: 'top',
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  pcbSelection: [],
  setPcbSelection: (pcbSelection) => set({ pcbSelection }),
  routeDraft: null,
  setRouteDraft: (routeDraft) => set({ routeDraft }),
  shapeDraft: null,
  setShapeDraft: (shapeDraft) => set({ shapeDraft }),
  pcbHighlightNet: null,
  setPcbHighlightNet: (pcbHighlightNet) => set({ pcbHighlightNet }),
  pcbCursor: [0, 0],
  setPcbCursor: (pcbCursor) => set({ pcbCursor }),
  pcbLeftTab: 'parts',
  setPcbLeftTab: (pcbLeftTab) => set({ pcbLeftTab }),
  pcbCanvasSize: { width: 800, height: 500 },
  setPcbCanvasSize: (pcbCanvasSize) => set({ pcbCanvasSize }),
  pcbIssues: [],
  setPcbIssues: (pcbIssues) => set({ pcbIssues }),
  showPours: true,
  setShowPours: (showPours) => set({ showPours }),
  routeMode: (() => {
    try {
      const m = localStorage.getItem('schematics:routeMode');
      return m === 'walk' || m === 'ignore' ? m : 'push';
    } catch {
      return 'push';
    }
  })(),
  setRouteMode: (routeMode) => {
    try {
      localStorage.setItem('schematics:routeMode', routeMode);
    } catch {
      // Private mode: the choice lasts for this session only.
    }
    set({ routeMode });
  },
  sourceFile: null,

  beginTransient: () => set({ transientBase: docOf(get().project) }),
  updateTransient: (fn) => {
    const base = get().transientBase;
    if (!base) return;
    set({ project: { ...get().project, ...fn(base) } });
  },
  endTransient: () => {
    const { transientBase, project, past } = get();
    if (!transientBase) return;
    const changed =
      transientBase.components !== project.components ||
      transientBase.wires !== project.wires ||
      transientBase.ports !== project.ports ||
      transientBase.pcb !== project.pcb;
    set({
      transientBase: null,
      ...(changed ? { past: [...past.slice(-HISTORY_LIMIT + 1), transientBase], future: [], project: { ...project, updatedAt: Date.now() } } : {}),
    });
  },

  historyMark: () => docOf(get().project),
  squashHistory: (mark) => {
    const { past } = get();
    const i = past.findLastIndex((d) => d.components === mark.components && d.wires === mark.wires && d.ports === mark.ports);
    if (i >= 0) set({ past: past.slice(0, i + 1) });
  },
  revertHistory: (mark) => {
    const { past, project } = get();
    const i = past.findLastIndex((d) => d.components === mark.components && d.wires === mark.wires && d.ports === mark.ports);
    if (i < 0) return;
    set({ project: { ...project, components: mark.components, wires: mark.wires, ports: mark.ports, sheets: mark.sheets, blocks: mark.blocks, updatedAt: Date.now() }, past: past.slice(0, i), selection: [] });
  },
  undo: () => {
    const { past, future, project } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({
      project: { ...project, ...keepCaches(prev, project), updatedAt: Date.now() },
      past: past.slice(0, -1),
      future: [docOf(project), ...future],
      selection: [],
      pcbSelection: [],
    });
  },
  redo: () => {
    const { past, future, project } = get();
    const next = future[0];
    if (!next) return;
    set({
      project: { ...project, ...keepCaches(next, project), updatedAt: Date.now() },
      past: [...past, docOf(project)],
      future: future.slice(1),
      selection: [],
      pcbSelection: [],
    });
  },
  addSymbols: (symbols) => set({ project: { ...get().project, symbols: { ...get().project.symbols, ...symbols } } }),

  loadProject: (p) => set({ project: p, past: [], future: [], selection: [], pcbSelection: [], tool: 'select', placing: null, routeDraft: null, shapeDraft: null, currentSheet: sheetsOf(p)[0].id }),
  renameProject: (name) => set({ project: { ...get().project, name, updatedAt: Date.now() } }),

  setTool: (tool) => set({ tool, placing: tool === 'place' ? get().placing : null, wireDraft: null, wireFlip: false, wireOneShot: false }),
  startPlacing: (placing) => set({ tool: 'place', placing, placementRotation: 0, placementMirror: false, selection: [] }),
  startPort: (kind, name) => {
    const { portNames, project } = get();
    set({ tool: kind, placing: null, wireDraft: null, portTemplate: { kind, name: name ?? portNames[kind] ?? defaultPortName(kind, project), rotation: 0 } });
  },
  startWire: (at) => set({ tool: 'wire', placing: null, wireDraft: [at], wireFlip: false, wireOneShot: true }),
  toggleWireFlip: () => set({ wireFlip: !get().wireFlip }),
  setPortTemplate: (patch) => {
    const portTemplate = { ...get().portTemplate, ...patch };
    set({ portTemplate, portNames: patch.name ? { ...get().portNames, [portTemplate.kind]: patch.name } : get().portNames });
  },
  rotatePlacement: () => {
    const { tool } = get();
    if (tool === 'place') set({ placementRotation: (((get().placementRotation + 90) % 360) as Rotation) });
    else set({ portTemplate: { ...get().portTemplate, rotation: (((get().portTemplate.rotation + 90) % 360) as Rotation) } });
  },
  mirrorPlacement: () => set({ placementMirror: !get().placementMirror }),

  setSelection: (selection) => set({ selection }),
  setView: (view) => set({ view }),
  setCanvasSize: (canvasSize) => set({ canvasSize }),
  setCursor: (cursor) => set({ cursor }),
  setWireDraft: (wireDraft) => set({ wireDraft, wireFlip: false }),
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('schematics:theme', theme);
    } catch {
      /* ignore */
    }
    set({ theme });
  },
  setLibraryOpen: (libraryOpen) => set({ libraryOpen }),
  setLibraryHeight: (libraryHeight) => set({ libraryHeight: Math.min(Math.max(libraryHeight, 180), window.innerHeight - 160) }),
  setLeftTab: (leftTab) => set({ leftTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  requestLibrary: (q, replaceId, types) => set({ libraryOpen: true, libraryRequest: { q, nonce: Date.now(), replaceId, types } }),
  setHighlightNet: (highlightNet) => set({ highlightNet }),
  logAgent: (entry) =>
    set({ agentLog: [{ ...entry, id: newId('log'), at: Date.now() }, ...get().agentLog].slice(0, 100) }),
  notify: (message, tone = 'info') => set({ toast: { id: ++toastId, message, tone } }),

  updateComponent: (id, patch) =>
    get().commit((doc) => ({ ...doc, components: doc.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  updatePort: (id, patch) => get().commit((doc) => ({ ...doc, ports: doc.ports.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
}));

// Autosave the current project.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useEditor.subscribe((state, prev) => {
  if (state.project === prev.project || state.transientBase) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(useEditor.getState().project));
    } catch {
      useEditor.getState().notify('Could not autosave: browser storage is full or unavailable', 'error');
    }
  }, 400);
});
