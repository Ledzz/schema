/*
 * The project library and files on disk. Every project opened in this browser is autosaved in
 * IndexedDB as it is edited, so a reload or the start screen's recent list brings it back with
 * its unsaved edits. A project can also be linked to a file on disk: Save writes it there with
 * the File System Access API where the browser has it (Chrome, Edge) and as a download
 * elsewhere. The dev-only sync with the designs/ folder is in designs.ts.
 */
import { emptyProject, useEditor, type FileLink } from '../store/editor';
import { dbAll, dbDelete, dbGet, dbPut } from './db';
import { detachDesign, openDesign, openFromUrl, saveDesign } from './designs';
import { fitView } from './editing';
import { downloadText, safeFileName } from './actions';
import { componentBox, unionBoxes } from './schematic/geometry';
import { newId } from './schematic/ops';
import { sheetView, sheetsOf } from './schematic/sheets';
import { resolverFor } from './schematic/symbols';
import type { Project, Vec } from './schematic/types';
import type { Box } from './easyeda/symbol';

const CURRENT_KEY = 'schematics:current';
/** Where projects were kept before the library (one project, in localStorage). */
const LEGACY_KEY = 'schematics:project';
const st = () => useEditor.getState();

/** A sketch of the busiest sheet for the start screen: part outlines and wires. */
export interface ProjectPreview {
  bounds: Box;
  boxes: Box[];
  wires: Vec[][];
}

/** What the start screen lists about a project; the project itself is stored apart. */
export interface ProjectEntry {
  id: string;
  name: string;
  updatedAt: number;
  /** When it was last shown in the editor. */
  openedAt: number;
  parts: number;
  sheets: number;
  hasPcb: boolean;
  preview: ProjectPreview | null;
  /** The file on disk it is linked to, when there is one. */
  fileName?: string;
  /** updatedAt of the project as last written to that file. */
  savedAt?: number;
  /** The file itself, when the browser can hand it back (File System Access API). */
  handle?: FileSystemFileHandle;
  /** designs/<file> it is synced with (dev only). */
  source?: string;
}

/* The File System Access API is not in TypeScript's DOM library yet. */
interface PickerOptions {
  types?: { description: string; accept: Record<string, string[]> }[];
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
}
interface WithPickers {
  showOpenFilePicker?: (options?: PickerOptions & { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: PickerOptions) => Promise<FileSystemFileHandle>;
}
interface PermissionHandle {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}
const pickers = (): WithPickers => (typeof window === 'undefined' ? {} : (window as unknown as WithPickers));
const FILE_TYPES = [{ description: 'Schematic project', accept: { 'application/json': ['.json'] } }];

/** Whether this browser can write a project back to the file it came from. */
export const canPickFiles = () => Boolean(pickers().showSaveFilePicker);

/** The handle of the file the open project is linked to; the store only knows its name. */
let handle: FileSystemFileHandle | null = null;

function setLink(link: FileLink | null, h: FileSystemFileHandle | null) {
  handle = h;
  useEditor.setState({ file: link });
}

/** A sketch of the sheet with the most parts; empty projects get none. */
export function previewOf(project: Project): ProjectPreview | null {
  const sheet = sheetsOf(project)
    .map((s) => sheetView(project, s.id))
    .sort((a, b) => b.components.length + b.wires.length - a.components.length - a.wires.length)[0];
  if (!sheet || sheet.components.length + sheet.wires.length === 0) return null;
  const resolve = resolverFor(project);
  const boxes = sheet.components.slice(0, 300).map((c) => componentBox(c, resolve(c.symbolKey)));
  const wires = sheet.wires.slice(0, 400).map((w) => w.points);
  const bounds = unionBoxes([
    ...boxes,
    ...wires.map((pts) => ({ x1: Math.min(...pts.map((p) => p[0])), y1: Math.min(...pts.map((p) => p[1])), x2: Math.max(...pts.map((p) => p[0])), y2: Math.max(...pts.map((p) => p[1])) })),
  ]);
  return bounds ? { bounds, boxes, wires } : null;
}

const metaOf = (project: Project): Pick<ProjectEntry, 'id' | 'name' | 'updatedAt' | 'parts' | 'sheets' | 'hasPcb' | 'preview'> => ({
  id: project.id,
  name: project.name,
  updatedAt: project.updatedAt,
  parts: project.components.length,
  sheets: sheetsOf(project).length,
  hasPcb: Boolean(project.pcb?.placements.length),
  preview: previewOf(project),
});

function setCurrent(id: string | null) {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* private mode: the library still works for this page */
  }
}

/** Writes the open project and its entry to the library (the entry keeps its link and times). */
export async function rememberProject(touch = false): Promise<void> {
  const { project, file, sourceFile } = st();
  const existing = await dbGet<ProjectEntry>('projects', project.id);
  const entry: ProjectEntry = {
    ...existing,
    ...metaOf(project),
    openedAt: touch || !existing ? Date.now() : existing.openedAt,
    fileName: file?.name ?? existing?.fileName,
    savedAt: file?.savedAt ?? existing?.savedAt,
    handle: handle ?? existing?.handle,
    source: sourceFile ?? undefined,
  };
  await dbPut('docs', { id: project.id, project });
  await dbPut('projects', entry);
  setCurrent(project.id);
}

/** The library's projects, most recently opened first. */
export async function listProjects(): Promise<ProjectEntry[]> {
  const entries = await dbAll<ProjectEntry>('projects');
  return entries.sort((a, b) => b.openedAt - a.openedAt);
}

/** Takes a project out of the library; a linked file on disk is left alone. */
export async function removeProject(id: string): Promise<void> {
  await dbDelete('projects', id);
  await dbDelete('docs', id);
  for (const chat of await dbAll<{ id: string }>('chats', 'projectId', id)) await dbDelete('chats', chat.id);
  if (st().project.id === id) setCurrent(null);
}

const withDefaults = (p: Project): Project => ({ ...p, ports: p.ports ?? [], symbols: p.symbols ?? {}, id: p.id ?? newId('prj') });

/** A project parsed from a file's text; anything else is refused with a reason. */
export function parseProjectFile(text: string): Project {
  let p: Project;
  try {
    p = JSON.parse(text) as Project;
  } catch {
    throw new Error('not JSON');
  }
  if (!p || p.version !== 1 || !Array.isArray(p.components) || !Array.isArray(p.wires)) throw new Error('not a schematic project file');
  return withDefaults(p);
}

/** Shows a project in the editor, fitted, and closes the start screen. */
function show(project: Project, link: FileLink | null, h: FileSystemFileHandle | null) {
  st().loadProject(project);
  setLink(link, h);
  requestAnimationFrame(() => fitView());
  void rememberProject(true);
}

/** Starts an empty project, in the schematic editor (there is no board to show yet). */
export function startNewProject(name = 'Untitled') {
  detachDesign();
  st().setMode('schematic');
  show(emptyProject(name), null, null);
}

/** Opens a project from the library, or the file it is linked to when that is newer. */
export async function openProject(id: string): Promise<void> {
  const s = st();
  if (s.project.id === id && s.booted) {
    s.setStartOpen(false);
    return;
  }
  const entry = await dbGet<ProjectEntry>('projects', id);
  const doc = await dbGet<{ id: string; project: Project }>('docs', id);
  if (!entry || !doc) {
    s.notify('That project is no longer in this browser', 'error');
    return;
  }
  detachDesign();
  if (entry.source) {
    // A design from the designs/ folder: back in step with the file.
    await openDesign(entry.source, { askIfNewer: true });
    void rememberProject(true);
    return;
  }
  const stored = withDefaults(doc.project);
  const link: FileLink | null = entry.fileName ? { name: entry.fileName, savedAt: entry.savedAt ?? 0, writable: false } : null;
  const h = entry.handle ?? null;
  if (!h || !link) return show(stored, link, null);

  const granted = await askPermission(h);
  if (!granted) return show(stored, link, null);
  try {
    const f = await h.getFile();
    // The file changed since it was last written here: prefer it unless the browser's copy has unsaved edits.
    const diskNewer = f.lastModified > link.savedAt + 1000;
    const unsaved = stored.updatedAt > link.savedAt;
    if (diskNewer && (!unsaved || confirm(`${f.name} changed on disk, and this browser also has unsaved edits to it. Load the file and drop those edits?`))) {
      const project = parseProjectFile(await f.text());
      return show(project, { name: f.name, savedAt: project.updatedAt, writable: true }, h);
    }
  } catch (err) {
    s.notify(`Could not read ${h.name}: ${(err as Error).message}`, 'error');
  }
  show(stored, { ...link, writable: true }, h);
}

async function askPermission(h: FileSystemFileHandle): Promise<boolean> {
  const p = h as unknown as PermissionHandle;
  try {
    if ((await p.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    return (await p.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Opens a project file picked or dropped by the user; `h` is its handle when the browser gives one. */
export async function openProjectFile(file: File, h: FileSystemFileHandle | null = null): Promise<void> {
  let project: Project;
  try {
    project = parseProjectFile(await file.text());
  } catch (err) {
    st().notify(`Could not open ${file.name}: ${(err as Error).message}`, 'error');
    return;
  }
  detachDesign();
  show(project, { name: file.name, savedAt: project.updatedAt, writable: Boolean(h) }, h);
  st().notify(`Opened ${file.name}`);
}

/** Open…: the file picker where the browser has one (so Save can write back), a file input elsewhere. */
export async function openFile(): Promise<void> {
  const picker = pickers().showOpenFilePicker;
  if (picker) {
    try {
      const [h] = await picker({ types: FILE_TYPES });
      if (h) await openProjectFile(await h.getFile(), h);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') st().notify((err as Error).message, 'error');
    }
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void openProjectFile(f);
  };
  input.click();
}

const projectText = () => JSON.stringify(st().project, null, 1);

async function writeHandle(h: FileSystemFileHandle): Promise<void> {
  const w = await h.createWritable();
  await w.write(projectText());
  await w.close();
}

/** Save: to the designs/ file, the linked file, or Save as… when there is neither. */
export async function saveFile(): Promise<boolean> {
  const s = st();
  if (s.sourceFile) return saveDesign();
  if (!handle || !s.file?.writable) return saveFileAs();
  try {
    await writeHandle(handle);
  } catch (err) {
    s.notify(`Could not save ${handle.name}: ${(err as Error).message}`, 'error');
    return false;
  }
  setLink({ name: handle.name, savedAt: s.project.updatedAt, writable: true }, handle);
  void rememberProject();
  s.notify(`Saved ${handle.name}`);
  return true;
}

/** Save as…: a new file through the picker, or a download where the browser has no picker. */
export async function saveFileAs(): Promise<boolean> {
  const s = st();
  const suggested = s.file?.name ?? `${safeFileName(s.project.name)}.schematic.json`;
  const picker = pickers().showSaveFilePicker;
  if (!picker) {
    downloadText(suggested, projectText(), 'application/json');
    setLink({ name: suggested, savedAt: s.project.updatedAt, writable: false }, null);
    void rememberProject();
    return true;
  }
  try {
    const h = await picker({ types: FILE_TYPES, suggestedName: suggested });
    await writeHandle(h);
    setLink({ name: h.name, savedAt: s.project.updatedAt, writable: true }, h);
    void rememberProject();
    s.notify(`Saved ${h.name}`);
    return true;
  } catch (err) {
    if ((err as Error).name !== 'AbortError') s.notify((err as Error).message, 'error');
    return false;
  }
}

/** Downloads a copy without changing what the project is linked to. */
export function downloadCopy() {
  downloadText(`${safeFileName(st().project.name)}.schematic.json`, projectText(), 'application/json');
}

/** Opens a project file dropped on the window; returns false when the drop had none. */
export function openDropped(e: DragEvent): boolean {
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.json$/i.test(f.name));
  if (!file) return false;
  void openProjectFile(file);
  return true;
}

/** The one project the app kept before it had a library, moved into it. */
async function migrateLegacy(): Promise<string | null> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const project = parseProjectFile(raw);
    await dbPut('docs', { id: project.id, project });
    await dbPut('projects', { ...metaOf(project), openedAt: project.updatedAt });
    localStorage.removeItem(LEGACY_KEY);
    return project.id;
  } catch {
    return null;
  }
}

/**
 * Brings back the project that was open last (or shows the start screen), then applies the
 * dev-only ?open= parameter. Runs once when the app starts.
 */
export async function bootWorkspace(): Promise<void> {
  const s = st();
  if (s.booted) return;
  let id: string | null = null;
  try {
    id = localStorage.getItem(CURRENT_KEY);
  } catch {
    /* ignore */
  }
  id ??= await migrateLegacy();
  const doc = id ? await dbGet<{ id: string; project: Project }>('docs', id) : undefined;
  const entry = id ? await dbGet<ProjectEntry>('projects', id) : undefined;
  if (doc) {
    s.loadProject(withDefaults(doc.project));
    const link: FileLink | null = entry?.fileName ? { name: entry.fileName, savedAt: entry.savedAt ?? 0, writable: Boolean(entry.handle) } : null;
    setLink(link, entry?.handle ?? null);
    if (entry?.source) useEditor.setState({ sourceFile: entry.source });
  } else useEditor.setState({ startOpen: true });
  useEditor.setState({ booted: true });
  openFromUrl();
}

// Autosave the open project into the library as it changes.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useEditor.subscribe((state, prev) => {
  if (!state.booted || state.project === prev.project || state.transientBase) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    rememberProject().catch(() => st().notify('Could not autosave: browser storage is full or unavailable', 'error'));
  }, 400);
});
