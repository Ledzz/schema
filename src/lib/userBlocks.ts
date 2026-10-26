/*
 * The user's own circuit blocks: a saved selection of parts, wires, labels and flags (with the
 * symbols they need), kept in this browser and inserted like the built-in blocks. Each net name
 * in a block is offered for renaming when it is inserted, so a second copy can get its own nets.
 */
import { useEditor } from '../store/editor';
import { downloadText } from './actions';
import { contentBounds } from './editing';
import { nextDesignator, splitDesignator } from './schematic/designators';
import { snap } from './schematic/geometry';
import { newId } from './schematic/ops';
import type { Component, NetPort, Project, StoredSymbol, Vec, Wire } from './schematic/types';

const KEY = 'schematics:blocks';
const st = () => useEditor.getState();

export interface UserBlock {
  id: string;
  title: string;
  description: string;
  savedAt: number;
  /** Positions relative to the block's top-left corner. */
  components: Component[];
  wires: Wire[];
  ports: NetPort[];
  symbols: Record<string, StoredSymbol>;
}

export function loadUserBlocks(): UserBlock[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function store(list: UserBlock[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    throw new Error('Could not save: browser storage is full or unavailable');
  }
}

/** Net names in a block (labels and power or ground flags), which can be renamed on insert. */
export const blockNets = (b: Pick<UserBlock, 'ports'>) => [...new Set(b.ports.filter((p) => p.kind !== 'noconnect' && p.name.trim()).map((p) => p.name))];

/** Saves the selected items as a block; returns it. */
export function saveUserBlock(title: string, description: string, ids: ReadonlySet<string>, project: Project = st().project): UserBlock {
  const name = title.trim();
  if (!name) throw new Error('Give the block a name');
  const components = project.components.filter((c) => ids.has(c.id));
  const wires = project.wires.filter((w) => ids.has(w.id));
  const ports = project.ports.filter((p) => ids.has(p.id));
  if (components.length === 0) throw new Error('Select at least one part to save as a block');
  const xs = [...components.map((c) => c.x), ...wires.flatMap((w) => w.points.map((p) => p[0])), ...ports.map((p) => p.x)];
  const ys = [...components.map((c) => c.y), ...wires.flatMap((w) => w.points.map((p) => p[1])), ...ports.map((p) => p.y)];
  // Whole grid steps, so pins stay on the grid wherever the block goes.
  const [dx, dy] = [snap(Math.min(...xs), 10), snap(Math.min(...ys), 10)];
  const block: UserBlock = {
    id: newId('blk'),
    title: name,
    description: description.trim(),
    savedAt: Date.now(),
    components: components.map((c) => ({ ...c, x: c.x - dx, y: c.y - dy })),
    wires: wires.map((w) => ({ ...w, points: w.points.map(([x, y]) => [x - dx, y - dy] as Vec) })),
    ports: ports.map((p) => ({ ...p, x: p.x - dx, y: p.y - dy })),
    symbols: Object.fromEntries([...new Set(components.map((c) => c.symbolKey))].filter((k) => project.symbols[k]).map((k) => [k, project.symbols[k]])),
  };
  store([...loadUserBlocks().filter((b) => b.title !== name), block]);
  return block;
}

export function deleteUserBlock(id: string) {
  store(loadUserBlocks().filter((b) => b.id !== id));
}

/**
 * Inserts a saved block right of the drawing (or at `at`) as one undo step: new designators,
 * and nets renamed as given. Returns the ids of what it added.
 */
export function insertUserBlock(block: UserBlock, renames: Record<string, string> = {}, at?: Vec): string[] {
  const project = st().project;
  const bounds = contentBounds(project);
  const origin: Vec = at ?? (bounds ? [snap(bounds.x2 + 100, 10), snap(bounds.y1, 10)] : [0, 0]);
  const rename = (name: string) => renames[name]?.trim() || name;
  let ids: string[] = [];
  st().addSymbols(block.symbols);
  st().commit((doc) => {
    const placed = [...doc.components];
    const components = block.components.map((c) => {
      const copy: Component = { ...c, id: newId('c'), x: c.x + origin[0], y: c.y + origin[1], attrs: { ...c.attrs } };
      copy.designator = nextDesignator(splitDesignator(c.designator).prefix, placed);
      placed.push(copy);
      return copy;
    });
    const wires = block.wires.map((w) => ({ id: newId('w'), points: w.points.map(([x, y]) => [x + origin[0], y + origin[1]] as Vec) }));
    const ports = block.ports.map((p) => ({ ...p, id: newId('n'), name: p.kind === 'noconnect' ? p.name : rename(p.name), x: p.x + origin[0], y: p.y + origin[1] }));
    ids = [...components, ...wires, ...ports].map((i) => i.id);
    return { ...doc, components: [...doc.components, ...components], wires: [...doc.wires, ...wires], ports: [...doc.ports, ...ports] };
  });
  return ids;
}

/** Downloads every saved block as one JSON file. */
export function exportUserBlocks() {
  downloadText('schematic-blocks.json', JSON.stringify({ kind: 'schematic-blocks', version: 1, blocks: loadUserBlocks() }, null, 2), 'application/json');
}

/** Adds the blocks in an exported file (replacing ones with the same name); returns how many. */
export async function importUserBlocks(file: File): Promise<number> {
  let data: { kind?: string; blocks?: UserBlock[] };
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not a blocks file`);
  }
  if (data.kind !== 'schematic-blocks' || !Array.isArray(data.blocks)) throw new Error(`${file.name} is not a blocks file`);
  const incoming = data.blocks.filter((b) => b.title && Array.isArray(b.components)).map((b) => ({ ...b, id: newId('blk') }));
  const names = new Set(incoming.map((b) => b.title));
  store([...loadUserBlocks().filter((b) => !names.has(b.title)), ...incoming]);
  return incoming.length;
}
