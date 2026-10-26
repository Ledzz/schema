import { describe, expect, it } from 'vitest';
import { buildBoard, pcbConnectivity } from '../src/lib/pcb/board';
import { runDrc } from '../src/lib/pcb/drc';
import { builtinFootprintDoc } from '../src/lib/pcb/footprint';
import { generateGerbers } from '../src/lib/pcb/gerber';
import { routeConnection } from '../src/lib/pcb/router';
import { jlcpcbChecklist } from '../src/lib/pcb/jlcpcb';
import { addPours, autoroute, planeLayers, routingLayers, setLayerCount } from '../src/lib/pcb/actions';
import { copperLayers, emptyPcb, type Pcb } from '../src/lib/pcb/types';
import { useEditor } from '../src/store/editor';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';
import type { Project } from '../src/lib/schematic/types';

/** R1 at (5, 5) and R2 at (12, 5) joined by net SIG (labelled), on a 20 × 10 board with `layers`. */
function fixture(extra: Partial<Pcb> = {}, layers: 2 | 4 = 4): Project {
  const sym = { title: 'R', dataStr: PASSIVE_SYMBOLS.resistor, source: 'builtin' as const };
  return {
    version: 1,
    id: 'p',
    name: 'test',
    updatedAt: 0,
    symbols: { r: sym },
    components: [
      { id: 'a', symbolKey: 'r', unit: 0, designator: 'R1', value: '1k', x: 0, y: 0, rotation: 0, mirror: false, attrs: {} },
      { id: 'b', symbolKey: 'r', unit: 0, designator: 'R2', value: '1k', x: 100, y: 0, rotation: 0, mirror: false, attrs: {} },
    ],
    wires: [{ id: 'w', points: [[20, 0], [80, 0]] }],
    ports: [{ id: 'l', kind: 'label', name: 'SIG', x: 50, y: 0, rotation: 0 }],
    pcb: {
      ...emptyPcb(),
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0, layers },
      footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
      footprintOf: { a: 'builtin:0603', b: 'builtin:0603' },
      placements: [
        { componentId: 'a', x: 5, y: 5, rotation: 0, side: 'top' },
        { componentId: 'b', x: 12, y: 5, rotation: 0, side: 'top' },
      ],
      ...extra,
    },
  };
}

const plane = { id: 'z', net: 'SIG', layer: 'inner1' as const, outline: null, clearance: 0.3, connection: 'thermal' as const, thermalGap: 0.3, spokeWidth: 0.35, minWidth: 0.2 };

describe('4-layer boards', () => {
  it('has four copper layers and through-hole copper on all of them', () => {
    const project = fixture({ vias: [{ id: 'v', x: 8, y: 2, diameter: 0.6, drill: 0.3, net: null }] });
    expect(copperLayers(project.pcb!)).toEqual(['top', 'inner1', 'inner2', 'bottom']);
    const board = buildBoard(project, project.pcb!);
    expect(board.items.find((i) => i.type === 'via')!.layers).toEqual(['top', 'inner1', 'inner2', 'bottom']);
    expect(copperLayers(fixture({}, 2).pcb!)).toEqual(['top', 'bottom']);
  });

  it('joins tracks on inner layers through vias', () => {
    const project = fixture();
    const pads = buildBoard(project, project.pcb!).pads.filter((p) => p.net === 'SIG');
    const [p, q] = pads;
    const routed = fixture({
      tracks: [
        { id: 't1', layer: 'top', width: 0.25, points: [p.center, [8, 5]], net: 'SIG' },
        { id: 't2', layer: 'inner2', width: 0.25, points: [[8, 5], [9.5, 5]], net: 'SIG' },
        { id: 't3', layer: 'top', width: 0.25, points: [[9.5, 5], q.center], net: 'SIG' },
      ],
      vias: [
        { id: 'v1', x: 8, y: 5, diameter: 0.6, drill: 0.3, net: 'SIG' },
        { id: 'v2', x: 9.5, y: 5, diameter: 0.6, drill: 0.3, net: 'SIG' },
      ],
    });
    const board = buildBoard(routed, routed.pcb!);
    expect(pcbConnectivity(board, routed.pcb!).unrouted.get('SIG') ?? 0).toBe(0);
  });

  it('routes on an inner layer when both outer layers are walled off', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const [p, q] = board.pads.filter((x) => x.net === 'SIG');
    const wall = (layer: 'top' | 'bottom') => ({ key: `w${layer}`, type: 'track' as const, ref: `w${layer}`, layers: [layer], net: 'OTHER', shape: { kind: 'capsule' as const, a: [8.5, 0.3] as [number, number], b: [8.5, 9.7] as [number, number], r: 0.15 }, box: { x1: 8.35, y1: 0.15, x2: 8.65, y2: 9.85 } });
    const r = routeConnection({ point: p.center, layers: ['top'] }, { point: q.center, layers: ['top'] }, {
      net: 'SIG',
      width: 0.25,
      rules: project.pcb!.rules,
      board: project.pcb!.board,
      items: [...board.items, wall('top'), wall('bottom')],
      netOf: (it) => it.net,
      layers: copperLayers(project.pcb!),
    });
    expect(r).not.toBeNull();
    expect(r!.tracks.some((t) => t.layer === 'inner1' || t.layer === 'inner2')).toBe(true);
    expect(r!.vias.length).toBe(2);
  });

  it('drops pads into an inner plane through vias instead of routing them', () => {
    useEditor.getState().loadProject(fixture({ pours: [plane] }));
    const pcb = useEditor.getState().project.pcb!;
    expect([...planeLayers(pcb)]).toEqual([['inner1', 'SIG']]);
    expect(routingLayers(pcb)).toEqual(['top', 'inner2', 'bottom']);
    const report = autoroute();
    expect(report.planes).toBe(2);
    const done = useEditor.getState().project;
    const board = buildBoard(done, done.pcb!);
    const conn = pcbConnectivity(board, done.pcb!);
    expect(conn.unrouted.get('SIG') ?? 0).toBe(0);
    // Each pad got a short stub to a via, not a track between the parts.
    expect(done.pcb!.tracks.every((t) => Math.hypot(t.points[1][0] - t.points[0][0], t.points[1][1] - t.points[0][1]) < 3)).toBe(true);
    expect(runDrc(board, done.pcb!, conn).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('writes inner-layer Gerbers and keeps mask and paste on the outer faces', () => {
    const project = fixture({ pours: [plane], vias: [{ id: 'v', x: 8, y: 2, diameter: 0.6, drill: 0.3, net: 'SIG' }] });
    const files = generateGerbers(project.pcb!, buildBoard(project, project.pcb!), 'demo');
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['demo-F_Cu.gtl', 'demo-In1_Cu.g2', 'demo-In2_Cu.g3', 'demo-B_Cu.gbl']));
    const inner1 = files.find((f) => f.name === 'demo-In1_Cu.g2')!.content;
    expect(inner1).toContain('%TF.FileFunction,Copper,L2,Inr*%');
    expect(inner1).toContain('G36*');
    expect(files.find((f) => f.name === 'demo-B_Cu.gbl')!.content).toContain('%TF.FileFunction,Copper,L4,Bot*%');
    expect(files.find((f) => f.name === 'demo-In2_Cu.g3')!.content).toContain('X8000000Y8000000D03*');
  });

  it('applies JLCPCB multilayer limits', () => {
    const thin = (layers: 2 | 4) => fixture({ tracks: [{ id: 't', layer: 'top', width: 0.095, points: [[2, 8], [18, 8]], net: null }] }, layers);
    const status = (layers: 2 | 4) => jlcpcbChecklist(thin(layers), { assembly: false }).find((i) => i.id === 'trace')!.status;
    expect(status(2)).toBe('fail');
    expect(status(4)).toBe('warn');
    expect(jlcpcbChecklist(fixture({ pours: [plane] }), { assembly: false }).find((i) => i.id === 'stack')!.value).toContain('Inner 1 (SIG plane)');
  });

  it('drops inner-layer copper when going back to 2 layers', () => {
    useEditor.getState().loadProject(fixture({ tracks: [{ id: 't', layer: 'inner2', width: 0.25, points: [[2, 8], [6, 8]], net: null }] }));
    addPours('SIG', ['inner1']);
    expect(setLayerCount(2)).toEqual({ removedTracks: 1, removedPours: 1 });
    const pcb = useEditor.getState().project.pcb!;
    expect(pcb.board.layers).toBe(2);
    expect(pcb.tracks).toEqual([]);
    expect(pcb.pours).toEqual([]);
  });
});
