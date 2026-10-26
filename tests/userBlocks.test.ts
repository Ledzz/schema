import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from '../src/store/editor';
import { attachPort, connectivity } from '../src/lib/actions';
import { blockNets, deleteUserBlock, insertUserBlock, loadUserBlocks, saveUserBlock } from '../src/lib/userBlocks';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  st().loadProject(project({ components: [comp('a', 'res', 'R1', 100, 50), comp('b', 'res', 'R2', 300, 50)] }));
  attachPort('R1.1', 'label', 'SDA');
  attachPort('R1.2', 'power', '+3V3');
});
afterEach(() => vi.unstubAllGlobals());

describe('saved blocks', () => {
  it('saves a selection with its symbols, relative to its corner', () => {
    const p = st().project;
    const ids = new Set([...p.ports.map((x) => x.id), ...p.wires.map((x) => x.id), 'a']);
    const b = saveUserBlock('Pull-up', 'R and label', ids);
    expect(loadUserBlocks().map((x) => x.title)).toEqual(['Pull-up']);
    expect(b.components).toHaveLength(1);
    expect(Object.keys(b.symbols)).toEqual(['res']);
    expect(blockNets(b).sort()).toEqual(['+3V3', 'SDA']);
    // The block starts at its own corner, on the grid.
    const xs = [...b.components.map((c) => c.x), ...b.ports.map((q) => q.x), ...b.wires.flatMap((w) => w.points.map((q) => q[0]))];
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeLessThan(10);
    // Saving again under the same name replaces it.
    saveUserBlock('Pull-up', '', ids);
    expect(loadUserBlocks()).toHaveLength(1);
  });

  it('inserts a copy with new designators and renamed nets as one undo step', () => {
    const p = st().project;
    const block = saveUserBlock('Pull-up', '', new Set([...p.ports.map((x) => x.id), ...p.wires.map((x) => x.id), 'a']));
    const before = st().past.length;
    const ids = insertUserBlock(block, { SDA: 'SCL' });
    expect(st().past.length).toBe(before + 1);
    expect(ids.length).toBe(1 + block.wires.length + block.ports.length);
    const conn = connectivity();
    expect(conn.nets.find((n) => n.name === 'SCL')!.members.map((m) => m.designator)).toEqual(['R3']);
    // The rail kept its name, so it joins the original +3V3.
    expect(conn.nets.find((n) => n.name === '+3V3')!.members.map((m) => m.designator).sort()).toEqual(['R1', 'R3']);
  });

  it('refuses an empty selection and deletes blocks', () => {
    expect(() => saveUserBlock('Nothing', '', new Set())).toThrow(/at least one part/);
    const b = saveUserBlock('One', '', new Set(['b']));
    deleteUserBlock(b.id);
    expect(loadUserBlocks()).toEqual([]);
  });
});
