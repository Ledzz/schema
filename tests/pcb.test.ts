import { describe, expect, it } from 'vitest';
import { builtinFootprintDoc, parsePcbFootprint, arcPoints, MIL } from '../src/lib/pcb/footprint';
import { placementToWorld, worldPads, shapeDistance, type CopperShape } from '../src/lib/pcb/geometry';
import { buildBoard, pcbConnectivity } from '../src/lib/pcb/board';
import { runDrc } from '../src/lib/pcb/drc';
import { routeConnection } from '../src/lib/pcb/router';
import { generateCpl, generateDrill, generateGerbers } from '../src/lib/pcb/gerber';
import { textStrokes } from '../src/lib/pcb/font';
import { emptyPcb, type Pcb } from '../src/lib/pcb/types';
import { zip } from '../src/lib/zip';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';
import type { Project } from '../src/lib/schematic/types';

const THT = [
  '["PAD","a",0,"",12,"1",-50,0,0,["ROUND",40,40],["RECT",66,66,0],[],0,0,0,1,0]',
  '["PAD","b",0,"",12,"2",50,0,90,["SLOT",60,30],["OVAL",66,100],[],0,0,0,1,0]',
  '["POLY","s",0,"",3,6,[-100,50,"L",100,50],0]',
].join('\n');

describe('footprint parsing', () => {
  it('converts mil to mm, flips y and reads holes', () => {
    const fp = parsePcbFootprint(THT);
    expect(fp.pads[0]).toMatchObject({ number: '1', layer: 'through', shape: 'rect' });
    expect(fp.pads[0].x).toBeCloseTo(-50 * MIL);
    expect(fp.pads[0].hole?.w).toBeCloseTo(40 * MIL);
    expect(fp.pads[1]).toMatchObject({ shape: 'oval', rotation: 90 });
    expect(fp.graphics[0].layer).toBe('silkTop');
    expect(fp.graphics[0].points[0][1]).toBeCloseTo(-50 * MIL);
  });

  it('builds built-in chip footprints', () => {
    const fp = parsePcbFootprint(builtinFootprintDoc('0603', false)!);
    expect(fp.pads.map((p) => p.number)).toEqual(['1', '2']);
    expect(fp.pads[1].x - fp.pads[0].x).toBeCloseTo(1.65, 2);
    expect(fp.pads[0].w).toBeCloseTo(0.8, 2);
    expect(builtinFootprintDoc('9999', false)).toBeNull();
  });

  it('samples arcs that end on the target point', () => {
    const pts = arcPoints([0, 0], [2, 0], 180);
    expect(pts.at(-1)).toEqual([2, 0]);
    // A CCW half-circle in y-up data passes below the chord in y-down coordinates.
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(1, 1);
  });
});

describe('placement transforms', () => {
  it('rotates counter-clockwise and mirrors bottom-side parts', () => {
    expect(placementToWorld({ x: 10, y: 10, rotation: 90, side: 'top' }, [1, 0])).toEqual([10, 9]);
    expect(placementToWorld({ x: 0, y: 0, rotation: 0, side: 'bottom' }, [1, 2])).toEqual([-1, 2]);
  });

  it('puts SMD pads of bottom parts on the bottom layer', () => {
    const fp = parsePcbFootprint(builtinFootprintDoc('0402', false)!);
    const pads = worldPads({ componentId: 'c', x: 0, y: 0, rotation: 0, side: 'bottom' }, fp, 'R1', () => null);
    expect(pads.every((p) => p.layers.join() === 'bottom')).toBe(true);
  });

  it('measures copper distances', () => {
    const a: CopperShape = { kind: 'capsule', a: [0, 0], b: [10, 0], r: 0.1 };
    const b: CopperShape = { kind: 'capsule', a: [0, 1], b: [10, 1], r: 0.1 };
    const sq: CopperShape = { kind: 'poly', points: [[2, 2], [3, 2], [3, 3], [2, 3]] };
    expect(shapeDistance(a, b)).toBeCloseTo(0.8);
    expect(shapeDistance(b, sq)).toBeCloseTo(0.9);
    expect(shapeDistance(sq, { kind: 'capsule', a: [2.5, 2.5], b: [2.5, 2.5], r: 0.1 })).toBe(0);
  });
});

/** Two resistors R1 (0603) wired in the schematic on net SIG, placed 5 mm apart. */
function fixture(extra: Partial<Pcb> = {}): Project {
  const sym = { title: 'R', dataStr: PASSIVE_SYMBOLS.resistor, source: 'builtin' as const };
  const pcb: Pcb = {
    ...emptyPcb(),
    board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 },
    footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
    footprintOf: { a: 'builtin:0603', b: 'builtin:0603' },
    placements: [
      { componentId: 'a', x: 5, y: 5, rotation: 0, side: 'top' },
      { componentId: 'b', x: 12, y: 5, rotation: 0, side: 'top' },
    ],
    ...extra,
  };
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
    // R1 pin 2 (x=20) to R2 pin 1 (x=80)
    wires: [{ id: 'w', points: [[20, 0], [80, 0]] }],
    ports: [{ id: 'l', kind: 'label', name: 'SIG', x: 50, y: 0, rotation: 0 }],
    pcb,
  };
}

describe('connectivity and DRC', () => {
  it('reports the airwire until a track joins the pads', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const pads = board.pads.filter((p) => p.net === 'SIG');
    expect(pads.map((p) => `${p.designator}.${p.number}`).sort()).toEqual(['R1.2', 'R2.1']);
    let conn = pcbConnectivity(board, project.pcb!);
    expect(conn.unrouted.get('SIG')).toBe(1);
    expect(runDrc(board, project.pcb!, conn).some((i) => i.message.startsWith('SIG: 1 unrouted'))).toBe(true);

    const [p, q] = pads;
    const routed = fixture({ tracks: [{ id: 't', layer: 'top', width: 0.25, points: [p.center, q.center], net: 'SIG' }] });
    const b2 = buildBoard(routed, routed.pcb!);
    conn = pcbConnectivity(b2, routed.pcb!);
    expect(conn.airwires).toHaveLength(0);
    expect(conn.itemNet.get('t')).toBe('SIG');
  });

  it('flags clearance violations and shorts', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const r1pad1 = board.pads.find((p) => p.designator === 'R1' && p.number === '1')!;
    const r2pad1 = board.pads.find((p) => p.designator === 'R2' && p.number === '1')!;
    // Track from R2.1 (SIG) running into R1.1 (no net) shorts different copper.
    const bad = fixture({ tracks: [{ id: 't', layer: 'top', width: 0.25, points: [r2pad1.center, r1pad1.center], net: 'SIG' }] });
    const b = buildBoard(bad, bad.pcb!);
    const issues = runDrc(b, bad.pcb!, pcbConnectivity(b, bad.pcb!));
    expect(issues.some((i) => i.severity === 'error' && /touches|Clearance/.test(i.message))).toBe(true);
  });
});

describe('router', () => {
  it('routes around a foreign-net obstacle', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const [p, q] = board.pads.filter((x) => x.net === 'SIG');
    const obstacle = { key: 'x', type: 'track' as const, ref: 'x', layers: ['top' as const], net: 'OTHER', shape: { kind: 'capsule' as const, a: [8.5, 2] as [number, number], b: [8.5, 8] as [number, number], r: 0.2 }, box: { x1: 8.3, y1: 1.8, x2: 8.7, y2: 8.2 } };
    const r = routeConnection({ point: p.center, layers: ['top'] }, { point: q.center, layers: ['top'] }, {
      net: 'SIG',
      width: 0.25,
      rules: project.pcb!.rules,
      board: project.pcb!.board,
      items: [...board.items, obstacle],
      netOf: (it) => it.net,
    });
    expect(r).not.toBeNull();
    const all = r!.tracks.flatMap((t) => t.points);
    expect(all[0]).toEqual(p.center);
    // Either it went around the obstacle on top, or it used the bottom layer through vias.
    const onTop = r!.tracks.filter((t) => t.layer === 'top');
    for (const t of onTop) {
      for (let i = 1; i < t.points.length; i++) {
        const d = shapeDistance({ kind: 'capsule', a: t.points[i - 1], b: t.points[i], r: 0.125 }, obstacle.shape);
        expect(d).toBeGreaterThanOrEqual(0.2 - 1e-6);
      }
    }
  });
});

describe('fabrication output', () => {
  const project = fixture({ vias: [{ id: 'v', x: 8, y: 2, diameter: 0.6, drill: 0.3, net: 'SIG' }] });
  const board = buildBoard(project, project.pcb!);

  it('writes Gerber layers with apertures and the board outline', () => {
    const files = generateGerbers(project.pcb!, board, 'demo');
    expect(files.map((f) => f.name)).toContain('demo-F_Cu.gtl');
    const top = files.find((f) => f.name === 'demo-F_Cu.gtl')!.content;
    expect(top).toContain('%FSLAX46Y46*%');
    expect(top).toMatch(/%ADD10R,0\.8\d*X0\.95\d*\*%/);
    expect(top).toContain('D03*');
    expect(top.trim().endsWith('M02*')).toBe(true);
    const edge = files.find((f) => f.name.endsWith('Edge_Cuts.gm1'))!.content;
    expect(edge).toContain('X20000000Y10000000D01*');
  });

  it('writes drill and pick-and-place files', () => {
    const drl = generateDrill(project.pcb!, board);
    expect(drl).toContain('T1C0.300');
    expect(drl).toContain('X8.000Y8.000');
    const cpl = generateCpl(project.pcb!, board).split('\n');
    expect(cpl[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
    expect(cpl[1]).toBe('R1,5.000mm,5.000mm,Top,0');
  });

  it('packs files into a zip', () => {
    const z = zip([{ name: 'a.txt', content: 'hello' }]);
    expect([...z.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(z.slice(35, 40))).toBe('hello');
  });

  it('renders silkscreen text as strokes', () => {
    const s = textStrokes('R1', [0, 0], 1);
    expect(s.length).toBe(4);
    expect(s.flat().every(([x, y]) => Math.abs(x) <= 1 && Math.abs(y) <= 0.5 + 1e-9)).toBe(true);
  });
});
