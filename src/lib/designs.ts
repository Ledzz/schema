/*
 * Dev-only round trip with project files in ./designs (written by `pnpm schem` and the skills).
 * Open one with /?open=<file>.json (add &mode=pcb for the board); Save writes edits back to the file.
 * While a design is open, changes to its file on disk (for example from an agent) load by
 * themselves unless the page has unsaved edits of its own.
 */
import { useEditor } from '../store/editor';
import { fitView } from './editing';
import { enterPcb } from './pcb/actions';
import { fitPcbView } from './pcb/view';
import type { Project } from './schematic/types';

const SOURCE_KEY = 'schematics:source';
const SYNCED_KEY = 'schematics:synced';
const st = () => useEditor.getState();

export function rememberedSource(): string | null {
  try {
    return localStorage.getItem(SOURCE_KEY);
  } catch {
    return null;
  }
}

/** updatedAt of the design as last loaded from or saved to its file; later edits are unsaved. */
let syncedAt = 0;

function markSynced(updatedAt: number) {
  syncedAt = updatedAt;
  try {
    localStorage.setItem(SYNCED_KEY, String(updatedAt));
  } catch {
    /* ignore */
  }
}

const hasLocalEdits = () => st().project.updatedAt > syncedAt;

function setSource(name: string | null) {
  try {
    if (name) localStorage.setItem(SOURCE_KEY, name);
    else localStorage.removeItem(SOURCE_KEY);
  } catch {
    /* ignore */
  }
  useEditor.setState({ sourceFile: name });
}

async function fetchDesign(name: string): Promise<Project | { error: string }> {
  const res = await fetch(`/api/dev/designs/${encodeURIComponent(name)}`);
  const body = await res.json();
  return res.ok ? (body as Project) : { error: body.error ?? `Could not open designs/${name}` };
}

const withDefaults = (file: Project): Project => ({ ...file, ports: file.ports ?? [], symbols: file.symbols ?? {} });

type Mode = 'schematic' | 'pcb';

export async function openDesign(name: string, opts: { askIfNewer?: boolean; mode?: Mode } = {}) {
  const file = await fetchDesign(name);
  if ('error' in file) {
    st().notify(file.error, 'error');
    return;
  }
  const current = st().project;
  // Keep unsaved browser edits unless the user agrees to drop them.
  const keepBrowserEdits =
    opts.askIfNewer &&
    rememberedSource() === name &&
    current.id === file.id &&
    current.updatedAt > file.updatedAt &&
    !confirm(`Your browser has newer, unsaved changes to ${name}. Discard them and load the file?`);
  if (!keepBrowserEdits) {
    st().loadProject(withDefaults(file));
    markSynced(file.updatedAt);
  }
  setSource(name);
  if (opts.mode === 'pcb') await enterPcb();
  else if (opts.mode) st().setMode(opts.mode);
  if (keepBrowserEdits) return;
  requestAnimationFrame(() => (st().mode === 'pcb' ? fitPcbView() : fitView()));
  st().notify(`Opened designs/${name}`);
}

export async function saveDesign(): Promise<boolean> {
  const name = st().sourceFile;
  if (!name) return false;
  const project = st().project;
  const res = await fetch(`/api/dev/designs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(project),
  });
  if (!res.ok) {
    st().notify(`Could not save designs/${name}`, 'error');
    return false;
  }
  markSynced(project.updatedAt);
  st().notify(`Saved designs/${name}`);
  return true;
}

/** Loads the open design again after its file changed, keeping the view and editor mode. */
async function reloadChanged(name: string) {
  if (st().sourceFile !== name) return;
  const file = await fetchDesign(name);
  // Our own save comes back through the watcher too; nothing new then.
  if ('error' in file || file.updatedAt === syncedAt) return;
  if (hasLocalEdits() || file.id !== st().project.id) {
    st().notify(`designs/${name} changed on disk, but this page has unsaved edits. File → Reload designs/${name} loads the file and drops them.`, 'error');
    return;
  }
  st().loadProject(withDefaults(file));
  markSynced(file.updatedAt);
  st().notify(`Updated from designs/${name}`);
}

let openedFromUrl = false;

/** Opens the design named in ?open= (and the editor named in ?mode=) when the page loads. */
export function openFromUrl() {
  if (!import.meta.env.DEV || openedFromUrl) return;
  openedFromUrl = true;
  const params = new URLSearchParams(location.search);
  const name = params.get('open');
  const mode = params.get('mode');
  if (name) {
    openDesign(name.replace(/^designs\//, ''), { askIfNewer: true, mode: mode === 'pcb' || mode === 'schematic' ? mode : undefined });
    return;
  }
  const remembered = rememberedSource();
  if (!remembered) return;
  // Back on a remembered design: pick up whatever changed in the file meanwhile.
  try {
    syncedAt = Number(localStorage.getItem(SYNCED_KEY)) || 0;
  } catch {
    /* ignore */
  }
  useEditor.setState({ sourceFile: remembered });
  void reloadChanged(remembered);
}

export function detachDesign() {
  setSource(null);
}

if (import.meta.hot) {
  import.meta.hot.on('schematics:design-changed', (data: { name: string }) => void reloadChanged(data.name));
}
