import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { frameAround, groupMembers, groupTab, hitGroup, nextGroupColor, resizeGroup, withGroupContents } from '../src/lib/schematic/groups';
import { deleteItems, duplicateItems, moveItems } from '../src/lib/schematic/ops';
import { hitTest, itemsInBox } from '../src/lib/schematic/hit';
import { mergeSheet, sheetView } from '../src/lib/schematic/sheets';
import { resolverFor } from '../src/lib/schematic/symbols';
import { fitGroup, groupItems, removeGroup, selectGroupContents, updateGroup } from '../src/lib/grouping';
import { TOOLS, runTool } from '../src/lib/webmcp';
import type { SchematicGroup } from '../src/lib/schematic/types';
import { comp, project } from './fixtures';

const resolve = resolverFor(project({}));
const st = () => useEditor.getState();
const tool = (name: string, input: Record<string, unknown> = {}) => runTool(TOOLS.find((t) => t.name === name)!, input);

/** R1 inside a frame at the origin, R2 well outside, a wire inside, a label inside and one outside. */
const frame: SchematicGroup = { id: 'g1', name: 'Power', x: -50, y: -50, width: 100, height: 100, color: 'amber' };
const doc = () =>
  project({
    components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 200, 0)],
    wires: [
      { id: 'w1', points: [[-30, 20], [30, 20]] },
      { id: 'w2', points: [[-30, 30], [300, 30]] },
    ],
    ports: [
      { id: 'p1', kind: 'label', name: 'IN', x: -20, y: 0, rotation: 0 },
      { id: 'p2', kind: 'label', name: 'OUT', x: 220, y: 0, rotation: 0 },
    ],
    groups: [frame],
  });

describe('group geometry', () => {
  it('finds what is inside a frame', () => {
    expect(groupMembers(doc(), frame, resolve).sort()).toEqual(['a', 'p1', 'w1']);
  });

  it('is grabbed by its tab or border, never by the room inside', () => {
    const d = doc();
    // The tab is only as wide as the name.
    expect(hitGroup(d.groups!, [-40, -55], 2)).toBe('g1');
    expect(hitGroup(d.groups!, [20, -55], 2)).toBeNull();
    expect(hitGroup(d.groups!, [-50, 10], 2)).toBe('g1');
    expect(hitGroup(d.groups!, [20, 30], 2)).toBeNull();
    // Through hitTest a part inside still wins over the frame.
    expect(hitTest(d, resolve, [0, 0], 2)).toBe('a');
    expect(hitTest(d, resolve, [50, 10], 2)).toBe('g1');
    expect(hitTest(d, resolve, [20, 40], 2)).toBeNull();
  });

  it('is box-selected only when the box takes in the whole frame', () => {
    const d = doc();
    expect(itemsInBox(d, resolve, { x1: -60, y1: -70, x2: 60, y2: 60 })).toContain('g1');
    expect(itemsInBox(d, resolve, { x1: -10, y1: -10, x2: 40, y2: 40 })).not.toContain('g1');
  });

  it('frames outlines with room around them on the grid, and keeps a minimum size when resized', () => {
    expect(frameAround([{ x1: -20, y1: -4, x2: 20, y2: 4 }])).toEqual({ x: -40, y: -30, width: 80, height: 60 });
    const small = resizeGroup(frame, 2, [-40, -40]);
    expect([small.width, small.height]).toEqual([40, 40]);
    expect(resizeGroup(frame, 0, [-80, -70])).toMatchObject({ x: -80, y: -70, width: 130, height: 120 });
    expect(groupTab(frame).y2).toBe(frame.y);
  });

  it('hands out the palette colour used least', () => {
    expect(nextGroupColor([])).toBe('indigo');
    expect(nextGroupColor([{ ...frame, color: 'indigo' }])).toBe('emerald');
  });
});

describe('group editing', () => {
  it('moves its contents with the frame and nothing else', () => {
    const moved = moveItems(doc(), new Set(['g1']), 100, 0, resolve);
    expect(moved.groups![0]).toMatchObject({ x: 50, y: -50 });
    expect(moved.components.find((c) => c.id === 'a')).toMatchObject({ x: 100, y: 0 });
    expect(moved.components.find((c) => c.id === 'b')).toMatchObject({ x: 200, y: 0 });
    expect(moved.ports.find((p) => p.id === 'p1')).toMatchObject({ x: 80, y: 0 });
    expect(moved.wires.find((w) => w.id === 'w1')!.points).toEqual([[70, 20], [130, 20]]);
    // The wire that leaves the frame is not inside it, so it stays.
    expect(moved.wires.find((w) => w.id === 'w2')!.points).toEqual([[-30, 30], [300, 30]]);
  });

  it('deleting the frame leaves its contents', () => {
    const out = deleteItems(doc(), new Set(['g1']), resolve);
    expect(out.groups).toEqual([]);
    expect(out.components.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('duplicates the frame with its contents', () => {
    const d = doc();
    const ids = withGroupContents(d, new Set(['g1']), resolve);
    const { doc: out, newIds } = duplicateItems(d, ids, [20, 20], (c) => `${c.designator}'`);
    expect(out.groups).toHaveLength(2);
    expect(newIds).toHaveLength(4);
  });

  it('stays on its sheet', () => {
    const d = project({ sheets: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }], groups: [{ ...frame, sheet: 's2' }] });
    expect(sheetView(d, 's1').groups).toEqual([]);
    expect(sheetView(d, 's2').groups).toHaveLength(1);
    const merged = mergeSheet(d, 's1', { ...sheetView(d, 's1'), groups: [{ ...frame, id: 'g2', sheet: undefined }] });
    expect(merged.groups!.map((g) => [g.id, g.sheet])).toEqual([['g1', 's2'], ['g2', 's1']]);
  });
});

describe('group actions', () => {
  beforeEach(() => st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0), comp('b', 'res', 'R2', 200, 0), comp('c', 'res', 'R3', 0, 100)] })));

  it('frames a selection as one undo step and selects the frame', () => {
    const g = groupItems(['a', 'c'], 'Input');
    expect(g).toMatchObject({ name: 'Input', x: -40, y: -30, width: 80, height: 160 });
    expect(st().selection).toEqual([g.id]);
    expect(st().project.groups).toHaveLength(1);
    st().undo();
    expect(st().project.groups ?? []).toHaveLength(0);
  });

  it('renames, refits and removes a frame, keeping the parts', () => {
    const g = groupItems(['a'], 'Input');
    updateGroup(g.id, { name: ' Regulator ', width: 400 });
    expect(st().project.groups![0]).toMatchObject({ name: 'Regulator', width: 400 });
    expect(selectGroupContents(g.id).sort()).toEqual(['a', 'b']);
    fitGroup(g.id);
    expect(st().project.groups![0].width).toBe(280);
    removeGroup(g.id);
    expect(st().project.groups).toEqual([]);
    expect(st().project.components).toHaveLength(3);
    expect(() => updateGroup(g.id, { name: ' ' })).toThrow(/name/);
  });

  it('is driven by the agent tools', async () => {
    const added = (await tool('add_group', { name: 'Power', around: ['R1', 'R3'], color: 'amber' })) as { parts: string[]; color: string };
    expect(added.parts).toEqual(['R1', 'R3']);
    expect(added.color).toBe('amber');
    const listed = (await tool('list_groups')) as { groups: { name: string; parts: string[] }[] };
    expect(listed.groups.map((g) => [g.name, g.parts])).toEqual([['Power', ['R1', 'R3']]]);
    const { components: info } = (await tool('list_components', { include_pins: false })) as { components: { designator: string; group?: string }[] };
    expect(info.find((c) => c.designator === 'R1')?.group).toBe('Power');
    expect(info.find((c) => c.designator === 'R2')?.group).toBeUndefined();
    const updated = (await tool('update_group', { group: 'Power', name: 'Supply', width: 400, fit: true })) as { name: string; width: number };
    expect(updated.name).toBe('Supply');
    // Fit after widening: the frame wraps R1 and R3 again, which now also takes in R2 (it was inside the wide frame).
    expect(updated.width).toBe(280);
    await expect(tool('add_group', { name: 'Odd' })).rejects.toThrow(/around/);
    await expect(tool('add_group', { name: 'Odd', around: ['R9'] })).rejects.toThrow(/R9/);
    await expect(tool('remove_group', { group: 'Nope' })).rejects.toThrow(/Supply/);
    expect(await tool('remove_group', { group: 'Supply' })).toEqual({ removed: 'Supply' });
    expect(st().project.groups).toEqual([]);
  });
});
