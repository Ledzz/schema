/*
 * Dev-only round trip with project files in ./designs (written by `pnpm schem` and the skills).
 * Open one with /?open=<file>.json (add &mode=pcb for the board); Save writes edits back to the file.
 */
import { useEditor } from '../store/editor';
import { fitView } from './editing';
import { enterPcb } from './pcb/actions';
import { fitPcbView } from './pcb/view';
import type { Project } from './schematic/types';

const SOURCE_KEY = 'schematics:source';
const st = () => useEditor.getState();

export function rememberedSource(): string | null {
  try {
    return localStorage.getItem(SOURCE_KEY);
  } catch {
    return null;
  }
}

function setSource(name: string | null) {
  try {
    if (name) localStorage.setItem(SOURCE_KEY, name);
    else localStorage.removeItem(SOURCE_KEY);
  } catch {
    /* ignore */
  }
  useEditor.setState({ sourceFile: name });
}

type Mode = 'schematic' | 'pcb';

export async function openDesign(name: string, opts: { askIfNewer?: boolean; mode?: Mode } = {}) {
  const res = await fetch(`/api/dev/designs/${encodeURIComponent(name)}`);
  const body = await res.json();
  if (!res.ok) {
    st().notify(body.error ?? `Could not open designs/${name}`, 'error');
    return;
  }
  const file = body as Project;
  const current = st().project;
  // Keep unsaved browser edits unless the user agrees to drop them.
  const keepBrowserEdits =
    opts.askIfNewer &&
    rememberedSource() === name &&
    current.id === file.id &&
    current.updatedAt > file.updatedAt &&
    !confirm(`Your browser has newer, unsaved changes to ${name}. Discard them and load the file?`);
  if (!keepBrowserEdits) st().loadProject({ ...file, ports: file.ports ?? [], symbols: file.symbols ?? {} });
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
  const res = await fetch(`/api/dev/designs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(st().project),
  });
  if (!res.ok) {
    st().notify(`Could not save designs/${name}`, 'error');
    return false;
  }
  st().notify(`Saved designs/${name}`);
  return true;
}

let openedFromUrl = false;

/** Opens the design named in ?open= (and the editor named in ?mode=) when the page loads. */
export function openFromUrl() {
  if (!import.meta.env.DEV || openedFromUrl) return;
  openedFromUrl = true;
  const params = new URLSearchParams(location.search);
  const name = params.get('open');
  const mode = params.get('mode');
  if (name) openDesign(name.replace(/^designs\//, ''), { askIfNewer: true, mode: mode === 'pcb' || mode === 'schematic' ? mode : undefined });
  else if (rememberedSource()) useEditor.setState({ sourceFile: rememberedSource() });
}

export function detachDesign() {
  setSource(null);
}
