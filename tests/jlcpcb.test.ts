import { describe, expect, it } from 'vitest';
import { checklistReady, jlcpcbChecklist, type CheckItem } from '../src/lib/pcb/jlcpcb';
import { buildBoard } from '../src/lib/pcb/board';
import { builtinFootprintDoc } from '../src/lib/pcb/footprint';
import { emptyPcb, type Pcb } from '../src/lib/pcb/types';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';
import type { Project } from '../src/lib/schematic/types';
import { addVia } from '../src/lib/pcb/actions';
import { useEditor } from '../src/store/editor';
import { TOOLS, runTool } from '../src/lib/webmcp';

/** Two 0603 resistors from the JLCPCB library, joined by a 0.25 mm track, on a 20 × 10 board. */
function fixture(extra: Partial<Pcb> = {}, lcsc = true): Project {
  const sym = { title: 'R', dataStr: PASSIVE_SYMBOLS.resistor, source: 'builtin' as const };
  const part = (id: string, designator: string, x: number) => ({
    id,
    symbolKey: 'r',
    unit: 0,
    designator,
    value: '1k',
    x,
    y: 0,
    rotation: 0 as const,
    mirror: false,
    attrs: {},
    ...(lcsc ? { lcsc: 'C21190', partClass: 'basic' as const } : {}),
  });
  const project: Project = {
    version: 1,
    id: 'p',
    name: 'test',
    updatedAt: 0,
    symbols: { r: sym },
    components: [part('a', 'R1', 0), part('b', 'R2', 100)],
    wires: [{ id: 'w', points: [[20, 0], [80, 0]] }],
    ports: [],
    pcb: {
      ...emptyPcb(),
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 },
      footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
      footprintOf: { a: 'builtin:0603', b: 'builtin:0603' },
      placements: [
        { componentId: 'a', x: 5, y: 5, rotation: 0, side: 'top' },
        { componentId: 'b', x: 12, y: 5, rotation: 0, side: 'top' },
      ],
    },
  };
  // Route R1.2 to R2.1 so the board is complete.
  const pads = buildBoard(project, project.pcb!).pads;
  const [p, q] = [pads.find((x) => x.designator === 'R1' && x.number === '2')!, pads.find((x) => x.designator === 'R2' && x.number === '1')!];
  project.pcb = { ...project.pcb!, tracks: [{ id: 't', layer: 'top', width: 0.25, points: [p.center, q.center], net: null }], ...extra };
  return project;
}

const item = (items: CheckItem[], id: string) => items.find((i) => i.id === id)!;

describe('JLCPCB checklist', () => {
  it('passes a clean board and lists every group', () => {
    const items = jlcpcbChecklist(fixture());
    expect(items.filter((i) => i.status === 'fail')).toEqual([]);
    expect(checklistReady(items)).toBe(true);
    expect(new Set(items.map((i) => i.group))).toEqual(new Set(['Board', 'Copper', 'Silkscreen', 'Assembly']));
    expect(item(items, 'spacing').status).toBe('pass');
  });

  it('fails thin tracks and tight design rules, and warns about tracks near the minimum', () => {
    const thin = (w: number) => fixture({ tracks: [{ id: 't', layer: 'top', width: w, points: [[2, 8], [18, 8]], net: null }] });
    expect(item(jlcpcbChecklist(thin(0.08)), 'trace').status).toBe('fail');
    expect(item(jlcpcbChecklist(thin(0.11)), 'trace').status).toBe('warn');
    const rules = jlcpcbChecklist(fixture({ rules: { ...emptyPcb().rules, clearance: 0.08 } }));
    expect(item(rules, 'rules').status).toBe('fail');
    expect(checklistReady(rules)).toBe(false);
  });

  it('measures copper spacing on the actual copper', () => {
    // A foreign track whose edge is 0.08 mm from the routed one (0.25 mm wide along y = 5).
    const near = (y: number) => jlcpcbChecklist(fixture({ tracks: [...fixture().pcb!.tracks, { id: 'x', layer: 'top', width: 0.2, points: [[7, y], [10, y]], net: 'OTHER' }] }));
    const tight = item(near(5.305), 'spacing');
    expect(tight.status).toBe('fail');
    expect(tight.value).toMatch(/^closest 0\.08 mm/);
    expect(item(near(5.5), 'spacing').status).toBe('pass');
  });

  it('checks via sizes, extra-cost vias and hole spacing', () => {
    const via = (id: string, x: number, drill: number, diameter: number) => ({ id, x, y: 2, drill, diameter, net: null });
    expect(item(jlcpcbChecklist(fixture({ vias: [via('v', 3, 0.1, 0.3)] })), 'via').status).toBe('fail');
    const small = item(jlcpcbChecklist(fixture({ vias: [via('v', 3, 0.25, 0.4)] })), 'via');
    expect(small.status).toBe('warn');
    expect(small.detail).toMatch(/costs more/);
    expect(item(jlcpcbChecklist(fixture({ vias: [via('v', 3, 0.3, 0.6)] })), 'via').status).toBe('pass');
    const stacked = jlcpcbChecklist(fixture({ vias: [via('v', 3, 0.3, 0.6), via('w', 3.25, 0.3, 0.6)] }));
    expect(item(stacked, 'holegap').status).toBe('fail');
  });

  it('checks non-plated holes, cutouts and the board size', () => {
    expect(item(jlcpcbChecklist(fixture({ holes: [{ id: 'h', x: 17, y: 8, diameter: 0.4, keepout: 0.4 }] })), 'npth').status).toBe('fail');
    const board = { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0, cutouts: [{ id: 'c', outline: [[15, 7], [18, 7], [18, 7.8], [15, 7.8]] as [number, number][] }] };
    expect(item(jlcpcbChecklist(fixture({ board })), 'npth').status).toBe('fail');
    expect(item(jlcpcbChecklist(fixture({ board: { x: 0, y: 0, width: 700, height: 10, cornerRadius: 0 } })), 'size').status).toBe('fail');
  });

  it('warns about thin or small silkscreen', () => {
    const items = jlcpcbChecklist(fixture({ texts: [{ id: 't1', text: 'TINY', x: 10, y: 8.5, size: 0.8, rotation: 0, side: 'top', stroke: 0.1 }] }));
    expect(item(items, 'silkwidth').status).toBe('warn');
    expect(item(items, 'textheight').value).toContain('"TINY"');
  });

  it('checks assembly: library parts, sides and board size', () => {
    expect(item(jlcpcbChecklist(fixture({}, false)), 'lcsc').status).toBe('fail');
    const flipped = fixture();
    flipped.pcb!.placements[1] = { ...flipped.pcb!.placements[1], side: 'bottom' };
    expect(item(jlcpcbChecklist(flipped), 'sides').status).toBe('warn');
    // 20 × 10 mm fits economic PCBA but not standard PCBA on its own.
    expect(item(jlcpcbChecklist(fixture()), 'pcbasize').status).toBe('info');
    expect(jlcpcbChecklist(fixture(), { assembly: false }).some((i) => i.group === 'Assembly')).toBe(false);
  });
});

describe('via placement keeps hole spacing', () => {
  const via = { id: 'v', x: 3, y: 3, drill: 0.3, diameter: 0.6, net: null };

  it('refuses a via whose hole would crowd another', () => {
    useEditor.getState().loadProject(fixture({ vias: [via] }));
    expect(addVia([3.25, 3], null)).toBeNull();
    expect(addVia([4, 3], null)).not.toBeNull();
    expect(useEditor.getState().project.pcb!.vias).toHaveLength(2);
  });

  it('rejects agent vias too close to existing holes or to each other', async () => {
    useEditor.getState().loadProject(fixture({ vias: [via] }));
    const add = TOOLS.find((t) => t.name === 'pcb_add_vias')!;
    // The wired net has no label in this fixture; take its generated name from R1.2.
    const project = useEditor.getState().project;
    const net = buildBoard(project, project.pcb!).pads.find((p) => p.designator === 'R1' && p.number === '2')!.net!;
    await expect(runTool(add, { net, points: [[3.2, 3]] })).rejects.toThrow(/too close/);
    await expect(runTool(add, { net, points: [[15, 2], [15.3, 2]] })).rejects.toThrow(/new via/);
  });
});
