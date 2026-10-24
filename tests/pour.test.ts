import { describe, expect, it } from 'vitest';
import { builtinFootprintDoc } from '../src/lib/pcb/footprint';
import { buildBoard, pcbConnectivity } from '../src/lib/pcb/board';
import { pointShapeDistance, rotateDeg } from '../src/lib/pcb/geometry';
import { pointInArea } from '../src/lib/pcb/pour';
import { runDrc } from '../src/lib/pcb/drc';
import { generateGerbers } from '../src/lib/pcb/gerber';
import { DEFAULT_POUR, emptyPcb, type Pcb, type Pour } from '../src/lib/pcb/types';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';
import type { Project, Vec } from '../src/lib/schematic/types';

/**
 * R1 and R2 (0603) on a 20 x 10 mm board: R1.2–R2.1 is SIG, R1.1 and R2.2 are GND.
 */
function fixture(pours: Partial<Pour>[] = [{}], extra: Partial<Pcb> = {}): Project {
  const sym = { title: 'R', dataStr: PASSIVE_SYMBOLS.resistor, source: 'builtin' as const };
  const pcb: Pcb = {
    ...emptyPcb(),
    board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 },
    footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
    footprintOf: { a: 'builtin:0603', b: 'builtin:0603' },
    placements: [
      { componentId: 'a', x: 6, y: 5, rotation: 0, side: 'top' },
      { componentId: 'b', x: 14, y: 5, rotation: 0, side: 'top' },
    ],
    pours: pours.map((p, i) => ({ ...DEFAULT_POUR, id: `z${i}`, net: 'GND', layer: 'top', ...p })),
    ...extra,
  };
  return {
    version: 1,
    id: 'p',
    name: 'pour',
    updatedAt: 0,
    symbols: { r: sym },
    components: [
      { id: 'a', symbolKey: 'r', unit: 0, designator: 'R1', value: '1k', x: 0, y: 0, rotation: 0, mirror: false, attrs: {} },
      { id: 'b', symbolKey: 'r', unit: 0, designator: 'R2', value: '1k', x: 100, y: 0, rotation: 0, mirror: false, attrs: {} },
    ],
    wires: [{ id: 'w', points: [[20, 0], [80, 0]] }],
    ports: [
      { id: 'l', kind: 'label', name: 'SIG', x: 50, y: 0, rotation: 0 },
      { id: 'g1', kind: 'ground', name: 'GND', x: -20, y: 0, rotation: 0 },
      { id: 'g2', kind: 'ground', name: 'GND', x: 120, y: 0, rotation: 0 },
    ],
    pcb,
  };
}

const inFill = (board: ReturnType<typeof buildBoard>, p: Vec) => board.fills.some((f) => f.areas.some((a) => pointInArea(p, a)));

describe('copper pours', () => {
  it('connects GND pads through the pour', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    expect(board.fills[0].areas.length).toBeGreaterThan(0);
    const conn = pcbConnectivity(board, project.pcb!);
    expect(conn.unrouted.get('GND') ?? 0).toBe(0);
    expect(conn.unrouted.get('SIG')).toBe(1);
  });

  it('keeps the clearance to pads of other nets', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const sig = board.pads.filter((p) => p.net === 'SIG');
    for (const area of board.fills[0].areas) {
      for (const v of [area.outer, ...area.holes].flat()) {
        for (const pad of sig) expect(pointShapeDistance(v, pad.shape)).toBeGreaterThanOrEqual(DEFAULT_POUR.clearance - 0.01);
      }
    }
    for (const pad of sig) expect(inFill(board, pad.center)).toBe(false);
  });

  it('keeps clear of the board edge', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const xs = board.fills[0].areas.flatMap((a) => a.outer.map((p) => p[0]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(20 - 0.3 + 1e-6);
  });

  it('builds thermal reliefs with four spokes', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const pad = board.pads.find((p) => p.designator === 'R1' && p.number === '1')!;
    const thermal = board.fills[0].thermals.find((t) => t.designator === 'R1' && t.number === '1')!;
    expect(thermal.spokes).toBe(4);
    // Diagonal from the pad corner, inside the thermal gap: no copper.
    const corner: Vec = [pad.center[0] - pad.pad.w / 2 - 0.15, pad.center[1] - pad.pad.h / 2 - 0.15];
    expect(inFill(board, corner)).toBe(false);
    // On the spoke, inside the gap: copper.
    const spoke = rotateDeg([-1, 0], pad.rotation);
    expect(inFill(board, [pad.center[0] + spoke[0] * (pad.pad.w / 2 + 0.15), pad.center[1] + spoke[1] * (pad.pad.w / 2 + 0.15)])).toBe(true);
  });

  it('connects pads solidly when asked', () => {
    const project = fixture([{ connection: 'solid' }]);
    const board = buildBoard(project, project.pcb!);
    const pad = board.pads.find((p) => p.designator === 'R1' && p.number === '1')!;
    expect(inFill(board, [pad.center[0] - pad.pad.w / 2 - 0.15, pad.center[1] - pad.pad.h / 2 - 0.15])).toBe(true);
    expect(board.fills[0].thermals).toEqual([]);
  });

  it('drops islands with no same-net copper', () => {
    const project = fixture([{ layer: 'bottom' }]);
    const board = buildBoard(project, project.pcb!);
    expect(board.fills[0].areas).toEqual([]);
    const issues = runDrc(board, project.pcb!, pcbConnectivity(board, project.pcb!));
    expect(issues.some((i) => i.message.includes('no copper left'))).toBe(true);
  });

  it('a via carries GND to a bottom pour', () => {
    const project = fixture([{ layer: 'bottom' }], { vias: [{ id: 'v', x: 3, y: 5, diameter: 0.6, drill: 0.3, net: 'GND' }] });
    const board = buildBoard(project, project.pcb!);
    expect(board.fills[0].areas.length).toBe(1);
    expect(inFill(board, [3, 5])).toBe(true);
  });

  it('exports pour regions with clear-polarity holes', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const top = generateGerbers(project.pcb!, board, 't').find((f) => f.name === 't-F_Cu.gtl')!.content;
    expect(top).toContain('G36*');
    expect(top).toContain('%LPC*%');
    // Back to dark polarity before pads are flashed.
    expect(top.lastIndexOf('%LPD*%')).toBeGreaterThan(top.lastIndexOf('%LPC*%'));
    expect(top.indexOf('D03*')).toBeGreaterThan(top.lastIndexOf('%LPD*%'));
  });

  it('fills quickly', () => {
    const project = fixture([{}, { layer: 'bottom' }]);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) buildBoard(project, project.pcb!);
    expect((performance.now() - t0) / 10).toBeLessThan(50);
  });
});
