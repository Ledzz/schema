import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { addSheet, attachPort, connectPins, connectivity, deleteSheet, findEnd, placeBlock } from '../src/lib/actions';
import { analyze } from '../src/lib/schematic/netlist';
import { moveItems, syncBlocks, type Doc } from '../src/lib/schematic/ops';
import { onSheet, sheetView, sheetsOf } from '../src/lib/schematic/sheets';
import { resolverFor } from '../src/lib/schematic/symbols';
import { comp, project } from './fixtures';

const resolve = resolverFor(project({}));
const st = () => useEditor.getState();
const sheets = [
  { id: 's1', name: 'Main' },
  { id: 's2', name: 'Power' },
];
/** Pins of the nets, as "R1.2", by net name. */
const nets = (p: Parameters<typeof analyze>[0]) => Object.fromEntries(analyze(p, resolve).nets.map((n) => [n.name, n.members.map((m) => `${m.designator}.${m.pinNumber}`).sort()]));

describe('sheets', () => {
  it('joins labels across sheets but nothing else', () => {
    // R1 and R2 lie on top of each other, on different sheets; a wire on sheet 2 ends on R1's pin.
    const p = project({
      sheets,
      components: [comp('a', 'res', 'R1', 0, 0, { sheet: 's1' }), comp('b', 'res', 'R2', 0, 0, { sheet: 's2' })],
      wires: [{ id: 'w', points: [[20, 0], [60, 0]], sheet: 's2' }],
      ports: [
        { id: 'l1', kind: 'label', name: 'SIG', x: -20, y: 0, rotation: 0, sheet: 's1' },
        { id: 'l2', kind: 'label', name: 'SIG', x: -20, y: 0, rotation: 0, sheet: 's2' },
      ],
    });
    const c = analyze(p, resolve);
    expect(nets(p).SIG).toEqual(['R1.1', 'R2.1']);
    // R1.2 is not on the sheet-2 wire, which only reaches R2.2.
    expect(c.pinNet.get('a:e6')).toBeUndefined();
    expect(c.junctions).toEqual([]);
  });

  it('connects hierarchical ports only through their block', () => {
    // Sheet 2 has R2 with hierarchical ports IN and OUT; sheet 1 has R1 wired to the block's IN pin.
    // Sheet 3 has its own IN port, which must stay a separate net.
    const p = project({
      sheets: [...sheets, { id: 's3', name: 'Other' }],
      components: [comp('a', 'res', 'R1', 0, 0, { sheet: 's1' }), comp('b', 'res', 'R2', 0, 0, { sheet: 's2' }), comp('c', 'res', 'R3', 0, 0, { sheet: 's3' })],
      ports: [
        { id: 'h1', kind: 'hier', name: 'IN', x: -20, y: 0, rotation: 180, sheet: 's2' },
        { id: 'h2', kind: 'hier', name: 'OUT', x: 20, y: 0, rotation: 0, sheet: 's2' },
        { id: 'h3', kind: 'hier', name: 'IN', x: -20, y: 0, rotation: 180, sheet: 's3' },
      ],
      // The block's IN pin is at (100, 20): pins run down its left edge from 20 below the top.
      blocks: [{ id: 'k', sheet: 's1', child: 's2', x: 100, y: 0, width: 100, pins: ['IN', 'OUT'] }],
      wires: [{ id: 'w', points: [[20, 0], [60, 0], [60, 20], [100, 20]], sheet: 's1' }],
    });
    const n = nets(p);
    expect(n['Power/IN']).toEqual(['R1.2', 'R2.1']);
    // OUT reaches the block but nothing on sheet 1; sheet 3's IN is its own net.
    expect(n['Power/OUT']).toEqual(['R2.2']);
    expect(n['Other/IN']).toEqual(['R3.1']);
    expect(analyze(p, resolve).issues.some((i) => i.message.includes('Hierarchical port IN on Other has no block'))).toBe(true);
  });

  it('edits one sheet at a time', () => {
    // A wire on sheet 2 ends where R1 (sheet 1) has a pin: moving R1 must not drag it.
    const p = project({
      sheets,
      components: [comp('a', 'res', 'R1', 0, 0, { sheet: 's1' })],
      wires: [{ id: 'w', points: [[20, 0], [60, 0]], sheet: 's2' }],
    });
    const moved = onSheet<Doc>(p, 's1', (v) => moveItems(v, new Set(['a']), 0, 30, resolve));
    expect(moved.wires[0].points).toEqual([[20, 0], [60, 0]]);
    expect(moved.components[0]).toMatchObject({ y: 30, sheet: 's1' });
    expect(sheetView(moved, 's2').wires).toHaveLength(1);
  });
});

describe('block pins', () => {
  const hier = (name: string, y: number) => ({ id: `h${name}`, kind: 'hier' as const, name, x: 0, y, rotation: 0 as const, sheet: 's2' });
  // Pins A, B, C at y 20, 30, 40 on the block's left edge (x 100); B and C are wired.
  const doc = project({
    sheets,
    blocks: [{ id: 'k', sheet: 's1', child: 's2', x: 100, y: 0, width: 80, pins: ['A', 'B', 'C'] }],
    ports: [hier('A', 0), hier('B', 10), hier('C', 20)],
    wires: [
      { id: 'wb', points: [[60, 30], [100, 30]], sheet: 's1' },
      { id: 'wc', points: [[60, 40], [100, 40]], sheet: 's1' },
    ],
  });
  const without = (d: typeof doc, name: string) => ({ ...d, ports: d.ports.filter((p) => p.name !== name) });

  it('keep their places when ports are added or renamed', () => {
    const added = syncBlocks({ ...doc, ports: [...doc.ports, hier('0', 30)] });
    expect(added.blocks![0].pins).toEqual(['A', 'B', 'C', '0']);
    const renamed = syncBlocks({ ...doc, ports: doc.ports.map((p) => (p.name === 'B' ? { ...p, name: 'EN' } : p)) });
    expect(renamed.blocks![0].pins).toEqual(['A', 'EN', 'C']);
    expect(renamed.wires).toBe(doc.wires);
  });

  it('move up with their wires into a free slot, and leave a wired one empty', () => {
    // A had nothing attached: B and C move up and their wires follow.
    const a = syncBlocks(without(doc, 'A'));
    expect(a.blocks![0].pins).toEqual(['B', 'C']);
    expect(a.wires.map((w) => w.points.at(-1))).toEqual([[100, 20], [100, 30]]);
    // B's wire is still there: its slot stays empty so it doesn't reach C.
    const b = syncBlocks(without(doc, 'B'));
    expect(b.blocks![0].pins).toEqual(['A', '', 'C']);
    expect(b.wires).toBe(doc.wires);
    expect(analyze(b, resolve).nets.length).toBe(0);
    // Once that wire is gone the gap closes.
    expect(syncBlocks({ ...b, wires: b.wires.filter((w) => w.id !== 'wb') }).blocks![0].pins).toEqual(['A', 'C']);
  });
});

describe('sheet actions', () => {
  beforeEach(() => st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0)] })));

  it('adds sheets, places blocks that follow their ports, and deletes', () => {
    // The first sheet's existing part stays where it is.
    const power = addSheet('Power');
    expect(sheetsOf(st().project).map((s) => s.name)).toEqual(['Sheet 1', 'Power']);
    expect(st().currentSheet).toBe(power.id);
    // A part on the new sheet, labelled with a hierarchical port.
    st().commit((doc) => ({ ...doc, components: [...doc.components, comp('b', 'res', 'R2', 0, 0, { sheet: power.id })] }));
    st().setCurrentSheet('s1');
    const block = placeBlock([100, 0], power.id);
    expect(block.pins).toEqual([]);
    attachPort('R2.1', 'hier', 'VIN');
    expect(st().project.blocks![0].pins).toEqual(['VIN']);
    expect(() => placeBlock([0, 0], power.id)).toThrow(/already has a block/);
    // Wired to R1 here by the block's pin, which is named after the sheet.
    expect(() => connectPins('R1.2', 'Power.VOUT')).toThrow(/no pin "VOUT". Pins: VIN/);
    connectPins('R1.2', 'Power.VIN');
    expect(connectivity().nets.find((n) => n.name === 'Power/VIN')!.members.map((m) => m.designator)).toEqual(['R1', 'R2']);
    expect(findEnd('power.vin')).toMatchObject({ at: [100, 20], sheet: 's1' });
    expect(() => findEnd('Sheet 1.X')).toThrow(/has no block yet/);
    // Deleting the sheet takes its parts and its block.
    deleteSheet(power.id);
    expect(st().project.components.map((c) => c.designator)).toEqual(['R1']);
    expect(st().project.blocks).toEqual([]);
    expect(() => deleteSheet('s1')).toThrow(/at least one sheet/);
  });
});
