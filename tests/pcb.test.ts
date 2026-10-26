import { describe, expect, it } from 'vitest';
import { builtinFootprintDoc, parsePcbFootprint, arcPoints, MIL } from '../src/lib/pcb/footprint';
import { placementToWorld, pointInPolygon, worldPads, shapeDistance, type CopperShape } from '../src/lib/pcb/geometry';
import { buildBoard, pcbConnectivity } from '../src/lib/pcb/board';
import { runDrc, shellAreas } from '../src/lib/pcb/drc';
import { renderBoardFace, renderPcbSvg } from '../src/lib/pcb/render';
import { addPours, autoroute, fabricationFiles, movePlacements, removePcbItems, throughHoleParts } from '../src/lib/pcb/actions';
import { useEditor } from '../src/store/editor';
import { edgeField, routeConnection, type RouteEnd } from '../src/lib/pcb/router';
import { generateCpl, generateDrill, generateGerbers, generateNpthDrill } from '../src/lib/pcb/gerber';
import { keepoutAreas, withOutline } from '../src/lib/pcb/outline';
import { pointInArea } from '../src/lib/pcb/pour';
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

  it('reads POLY pads in footprint coordinates, ignoring the pad rotation', () => {
    // A SOT-89-like tab: pad centre at x = -50 mil, keyhole drawn from -100 to +20 mil.
    const fp = parsePcbFootprint('["PAD","t",0,"",1,"2",-50,0,90,["ROUND",0,0],["POLY",[-100,20,"L",20,20,20,-20,-100,-20,-100,20]],[],0,0,0,1,0]');
    const [pad] = fp.pads;
    expect(pad).toMatchObject({ shape: 'polygon', rotation: 0 });
    expect(pad.w).toBeCloseTo(120 * MIL);
    const [world] = worldPads({ componentId: 'c', x: 0, y: 0, rotation: 0, side: 'top' }, fp, 'U1', () => null);
    const xs = world.outline.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-100 * MIL);
    expect(Math.max(...xs)).toBeCloseTo(20 * MIL);
    expect(pointInPolygon(world.center, world.outline)).toBe(true);
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

/** A connector with a metal body: two signal pads, slotted shell tabs and a body outline. */
const SHELLED = [
  '["PAD","p1",0,"",1,"1",-20,-60,0,null,["RECT",20,40,0],[],0,0,0,1,0]',
  '["PAD","p2",0,"",1,"2",20,-60,0,null,["RECT",20,40,0],[],0,0,0,1,0]',
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => `["PAD","s${sx}${sy}",0,"",12,"7",${sx * 100},${sy * 50},0,["SLOT",50,25],["OVAL",45,75],[],0,0,0,1,0]`)),
  '["POLY","o",0,"",48,4,[-120,-80,"L",120,-80,"L",120,80,"L",-120,80,"L",-120,-80],0]',
].join('\n');

/** The R1/R2 fixture plus a connector; with `header`, its tabs become numbered round-hole pins. */
function withConnector(designator: string, tracks: Pcb['tracks'], header = false): Project {
  const project = fixture({ board: { x: 0, y: 0, width: 30, height: 14, cornerRadius: 0 }, tracks });
  const pcb = project.pcb!;
  let pin = 2;
  const doc = header ? SHELLED.replaceAll('["SLOT",50,25]', '["ROUND",30,30]').replace(/,12,"7",/g, () => `,12,"${++pin}",`) : SHELLED;
  return {
    ...project,
    components: [...project.components, { id: 'j', symbolKey: 'r', unit: 0, designator, value: 'USB', x: 200, y: 0, rotation: 0, mirror: false, attrs: {} }],
    pcb: {
      ...pcb,
      footprints: { ...pcb.footprints, conn: { title: 'conn', dataStr: doc, source: 'easyeda' } },
      footprintOf: { ...pcb.footprintOf, j: 'conn' },
      placements: [...pcb.placements, { componentId: 'j', x: 22, y: 7, rotation: 0, side: 'top' }],
    },
  };
}

describe('connectors with a metal shell', () => {
  // Straight through the body of a connector at x = 22 (body ±3 mm, ±2 mm).
  const under = [{ id: 't', layer: 'top' as const, width: 0.25, points: [[18, 7], [26, 7]] as [number, number][], net: 'SIG' }];
  const warnings = (p: Project) => {
    const b = buildBoard(p, p.pcb!);
    return runDrc(b, p.pcb!, pcbConnectivity(b, p.pcb!)).filter((i) => /metal shell/.test(i.message));
  };

  it('warns about other nets running under the shell', () => {
    const issues = warnings(withConnector('J1', under));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/^SIG track runs [\d.]+ mm under J1's metal shell/);
  });

  it('leaves pin headers and non-connectors alone', () => {
    expect(warnings(withConnector('J1', under, true))).toEqual([]);
    expect(warnings(withConnector('U1', under))).toEqual([]);
    expect(warnings(withConnector('J1', [{ ...under[0], layer: 'bottom' }]))).toEqual([]);
  });

  it('routes around the body when it can', () => {
    const project = withConnector('J1', []);
    const board = buildBoard(project, project.pcb!);
    const body = shellAreas(board)[0];
    expect(body.part.component.designator).toBe('J1');
    const opts = { net: 'X', width: 0.25, rules: project.pcb!.rules, board: project.pcb!.board, items: [], netOf: () => null };
    const ends: RouteEnd[] = [{ point: [17, 7], layers: ['top'] }, { point: [27, 7], layers: ['top'] }];
    const crosses = (r: ReturnType<typeof routeConnection>) =>
      r!.tracks.some((t) => t.points.some((p, i) => i > 0 && [0.25, 0.5, 0.75].some((f) => pointInPolygon([t.points[i - 1][0] + (p[0] - t.points[i - 1][0]) * f, t.points[i - 1][1] + (p[1] - t.points[i - 1][1]) * f], body.outlines[0]))));
    expect(crosses(routeConnection(ends[0], ends[1], opts))).toBe(true);
    const avoiding = routeConnection(ends[0], ends[1], { ...opts, avoid: [{ layer: 'top', outlines: body.outlines }] });
    expect(avoiding).not.toBeNull();
    expect(crosses(avoiding)).toBe(false);
  });
});

describe('board picture', () => {
  it('draws copper, rulers, highlights and DRC markers as plain SVG', () => {
    const project = fixture({ tracks: [{ id: 't', layer: 'top', width: 0.25, points: [[5.8, 5], [11.2, 5]], net: 'SIG' }] });
    const board = buildBoard(project, project.pcb!);
    const conn = pcbConnectivity(board, project.pcb!);
    const issue = { severity: 'warning' as const, message: 'x', at: [5, 5] as [number, number], refs: [] };
    const { svg, widthPx, heightPx } = renderPcbSvg(project.pcb!, board, conn, [issue], { highlightNet: 'SIG', widthPx: 560 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="560"')).toBe(true);
    expect(heightPx).toBe(Math.round((560 * 18) / 28));
    expect(widthPx).toBe(560);
    expect(svg).toContain('viewBox="-4 -4 28 18"');
    expect(svg).toMatch(/<polyline points="5\.8,5 11\.2,5" fill="none" stroke="#ffffff"/);
    expect(svg).toContain('stroke="#f59e0b"');
    expect(svg).not.toMatch(/<text/);
  });

  it('draws each finished face over exactly the board for 3D textures', () => {
    const project = fixture({ tracks: [{ id: 't', layer: 'top', width: 0.25, points: [[5.8, 5], [11.2, 5]], net: 'SIG' }] });
    const board = buildBoard(project, project.pcb!);
    const top = renderBoardFace(project.pcb!, board, 'top', 400);
    const bottom = renderBoardFace(project.pcb!, board, 'bottom', 400);
    expect(top.svg).toContain('viewBox="0 0 20 10"');
    expect(top.heightPx).toBe(200);
    expect(top.svg).toContain('5.8,5 11.2,5');
    // The bottom face has no copper of its own here and no parts: mask only.
    expect(bottom.svg).not.toContain('5.8,5 11.2,5');
    expect(bottom.svg).not.toContain('<polygon');
  });
});

describe('ordering', () => {
  it('finds through-hole parts and can leave them out of the assembly files', () => {
    const base = fixture();
    const project: Project = {
      ...base,
      pcb: { ...base.pcb!, footprints: { ...base.pcb!.footprints, tht: { title: 'THT', dataStr: THT, source: 'easyeda' } }, footprintOf: { a: 'builtin:0603', b: 'tht' } },
    };
    const board = buildBoard(project, project.pcb!);
    expect(throughHoleParts(board).map((c) => c.designator)).toEqual(['R2']);
    const all = fabricationFiles(project);
    const smdOnly = fabricationFiles(project, new Set(['b']));
    expect(all.cpl).toContain('R2,');
    expect(smdOnly.cpl).not.toContain('R2,');
    expect(smdOnly.cpl).toContain('R1,');
    expect(all.bom).toContain('R2');
    expect(smdOnly.bom).not.toContain('R2');
  });
});

describe('rip-up and retry', () => {
  it('moves a track that walls a connection off, then routes both', () => {
    // R1.1 and R2.1's outer pads are net OTHER, whose track snakes between the SIG pads from near
    // the top edge to near the bottom; a keepout keeps everything off the bottom layer.
    const base = fixture({
      tracks: [{ id: 'wall', layer: 'top', width: 0.25, net: 'OTHER', points: [[4.2, 5], [4.2, 9.4], [8.5, 9.4], [8.5, 0.6], [12.8, 0.6], [12.8, 5]] }],
      keepouts: [{ id: 'k', outline: [[0, 0], [20, 0], [20, 10], [0, 10]], layers: ['bottom'], tracks: true, vias: true, pours: false, parts: false }],
    });
    const project: Project = {
      ...base,
      ports: [...base.ports, { id: 'o1', kind: 'label', name: 'OTHER', x: -20, y: 0, rotation: 0 }, { id: 'o2', kind: 'label', name: 'OTHER', x: 120, y: 0, rotation: 0 }],
    };
    const before = buildBoard(project, project.pcb!);
    expect(pcbConnectivity(before, project.pcb!).unrouted.get('SIG')).toBe(1);
    expect(pcbConnectivity(before, project.pcb!).unrouted.get('OTHER')).toBeUndefined();

    useEditor.getState().loadProject(project);
    const report = autoroute();
    expect(report.failed).toEqual([]);
    const routed = useEditor.getState().project;
    const board = buildBoard(routed, routed.pcb!);
    const conn = pcbConnectivity(board, routed.pcb!);
    expect([...conn.unrouted.keys()]).toEqual([]);
    expect(runDrc(board, routed.pcb!, conn).filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
    // The wall was ripped up and OTHER routed again another way.
    expect(routed.pcb!.tracks.some((t) => t.id === 'wall')).toBe(false);
  });
});

describe('auto-routing widths', () => {
  const widths = () => [...new Set(useEditor.getState().project.pcb!.tracks.map((t) => t.width))];

  it('routes ordinary pads at the net width, or the width asked for', () => {
    useEditor.getState().loadProject(fixture());
    expect(autoroute('SIG').routed).toBe(1);
    expect(widths()).toEqual([0.25]);
    useEditor.getState().loadProject(fixture());
    autoroute('SIG', 0.6);
    expect(widths()).toEqual([0.6]);
  });

  it('narrows into a fine-pitch pin when the connection ends on a track inside it', () => {
    // R1 gets 0.3 mm pads at 0.5 mm pitch, and a SIG stub already leaves R1.2 from inside the pad
    // on the side facing R2, so the airwire ends on that track vertex rather than the pad centre.
    const pad = (n: string, x: number) => `["PAD","${n}",0,"",1,"${n}",${x},0,0,["ROUND",0,0],["RECT",11.811,39.37,0],[],0,0,0,1,0]`;
    const base = fixture();
    const project: Project = {
      ...base,
      pcb: {
        ...base.pcb!,
        footprints: { ...base.pcb!.footprints, fine: { title: 'FINE', dataStr: [pad('1', -9.8425), pad('2', 9.8425)].join('\n'), source: 'easyeda' } },
        footprintOf: { a: 'fine', b: 'builtin:0603' },
        tracks: [{ id: 'stub', layer: 'top', width: 0.25, points: [[5.375, 5], [5.375, 3]], net: 'SIG' }],
      },
    };
    const before = buildBoard(project, project.pcb!);
    const [aw] = pcbConnectivity(before, project.pcb!).airwires;
    expect([aw.a, aw.b]).toContainEqual([5.375, 5]);

    useEditor.getState().loadProject(project);
    autoroute('SIG', 1);
    const routed = useEditor.getState().project;
    const board = buildBoard(routed, routed.pcb!);
    const errors = runDrc(board, routed.pcb!, pcbConnectivity(board, routed.pcb!)).filter((i) => i.severity === 'error');
    expect(errors.map((i) => i.message)).toEqual([]);
    // Narrow at the pin, full width once clear of it.
    expect(widths().sort()).toEqual([0.25, 0.3, 1]);
  });

  it('necks down into pads narrower than the track', () => {
    useEditor.getState().loadProject(fixture());
    // 0.8 mm wide 0603 pads: a 1 mm track narrows to 0.8 at both ends and is 1 mm in between.
    autoroute('SIG', 1);
    expect(widths().sort()).toEqual([0.8, 1]);
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

describe('router hole spacing', () => {
  // A foreign top-layer track walls off R1 from R2, so the route has to drop to the bottom layer.
  const route = (holes: { center: [number, number]; net: string }[]) => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const [p, q] = board.pads.filter((x) => x.net === 'SIG');
    const wall = { key: 'w', type: 'track' as const, ref: 'w', layers: ['top' as const], net: 'OTHER', shape: { kind: 'capsule' as const, a: [8.5, 0.5] as [number, number], b: [8.5, 9.5] as [number, number], r: 0.15 }, box: { x1: 8.35, y1: 0.35, x2: 8.65, y2: 9.65 } };
    return routeConnection({ point: p.center, layers: ['top'] }, { point: q.center, layers: ['top'] }, {
      net: 'SIG',
      width: 0.25,
      rules: project.pcb!.rules,
      board: project.pcb!.board,
      items: [...board.items, wall],
      netOf: (it) => it.net,
      holes: holes.map((h) => ({ center: h.center, d: 0.3, len: 0, kind: 'via' as const, net: h.net, name: 'via' })),
    })!;
  };

  it('keeps new via holes 0.2 mm from existing ones of any net', () => {
    // Off the routing grid, so it can't be reused: new vias must keep their distance.
    const existing: [number, number] = [7.6, 5.1];
    const r = route([{ center: existing, net: 'SIG' }]);
    expect(r.vias.length).toBeGreaterThan(0);
    for (const v of r.vias) expect(Math.hypot(v[0] - existing[0], v[1] - existing[1])).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it('switches layers on existing on-grid vias of the net instead of stacking new ones', () => {
    const r = route([
      { center: [7.5, 5], net: 'SIG' },
      { center: [9.5, 5], net: 'SIG' },
    ]);
    expect(r.vias).toEqual([]);
    expect(r.tracks.some((t) => t.layer === 'bottom')).toBe(true);
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

describe('board shape, mounting holes and keepouts', () => {
  const sigPads = (project: Project) => buildBoard(project, project.pcb!).pads.filter((p) => p.net === 'SIG');
  const drc = (project: Project) => {
    const board = buildBoard(project, project.pcb!);
    return runDrc(board, project.pcb!, pcbConnectivity(board, project.pcb!)).map((i) => i.message);
  };
  // A strip across the board between the two resistors, open only at the top.
  const wall = { id: 'k', outline: [[8, 3], [9, 3], [9, 10], [8, 10]] as [number, number][], layers: ['top', 'bottom'] as const, tracks: true, vias: true, pours: true, parts: false };

  it('reports copper outside a custom outline', () => {
    // An L that leaves out the right half below y = 3, where R2 sits.
    const board = withOutline(fixture().pcb!.board, [[0, 0], [20, 0], [20, 3], [10, 3], [10, 10], [0, 10]]);
    const messages = drc(fixture({ board }));
    expect(messages.some((m) => /^R2\.\d is outside the board/.test(m))).toBe(true);
    expect(messages.some((m) => m.startsWith('R1.'))).toBe(false);
  });

  it('reports tracks, vias and parts inside keepouts and hole rings', () => {
    const [p, q] = sigPads(fixture());
    const messages = drc(
      fixture({
        keepouts: [{ ...wall, layers: ['top', 'bottom'] }],
        tracks: [{ id: 't', layer: 'top', width: 0.25, points: [p.center, q.center], net: 'SIG' }],
        vias: [{ id: 'v', x: 8.5, y: 8, diameter: 0.6, drill: 0.3, net: 'SIG' }],
        holes: [{ id: 'h', x: 14.5, y: 5, diameter: 2, keepout: 4 }],
      }),
    );
    expect(messages).toContain('SIG track crosses a keepout area');
    expect(messages).toContain('SIG via inside a keepout area');
    expect(messages).toContain('R2 is inside the mounting hole ring');
  });

  it('routes around a keepout', () => {
    const project = fixture({ keepouts: [{ ...wall, layers: ['top', 'bottom'] }] });
    const pcb = project.pcb!;
    const board = buildBoard(project, pcb);
    const [p, q] = sigPads(project);
    const r = routeConnection({ point: p.center, layers: ['top'] }, { point: q.center, layers: ['top'] }, {
      net: 'SIG',
      width: 0.25,
      rules: pcb.rules,
      board: pcb.board,
      items: board.items,
      netOf: (it) => it.net,
      edges: edgeField(pcb),
      keepouts: keepoutAreas(pcb),
    });
    expect(r).not.toBeNull();
    const area = { kind: 'poly' as const, points: wall.outline };
    for (const t of r!.tracks) for (let i = 1; i < t.points.length; i++) expect(shapeDistance({ kind: 'capsule', a: t.points[i - 1], b: t.points[i], r: 0.125 }, area)).toBeGreaterThan(0);
    for (const v of r!.vias) expect(shapeDistance({ kind: 'capsule', a: v, b: v, r: 0.3 }, area)).toBeGreaterThan(0);
  });

  it('keeps pours out of keepouts, cutouts and hole rings', () => {
    const project = fixture({
      keepouts: [{ ...wall, layers: ['top'] }],
      holes: [{ id: 'h', x: 17, y: 2.5, diameter: 2, keepout: 3 }],
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0, cutouts: [{ id: 'c', outline: [[1, 1], [3, 1], [3, 3], [1, 3]] }] },
      pours: [
        { id: 'top', net: 'SIG', layer: 'top', outline: null, clearance: 0.3, connection: 'solid', thermalGap: 0.3, spokeWidth: 0.35, minWidth: 0.2 },
        { id: 'bot', net: 'SIG', layer: 'bottom', outline: null, clearance: 0.3, connection: 'solid', thermalGap: 0.3, spokeWidth: 0.35, minWidth: 0.2 },
      ],
    });
    // SIG pads are on top only, so the bottom pour has no anchor; use the top one.
    const fill = buildBoard(project, project.pcb!).fills.find((f) => f.pour.id === 'top')!;
    const filled = (pt: [number, number]) => fill.areas.some((a) => pointInArea(pt, a));
    expect(filled([8.5, 6])).toBe(false);
    expect(filled([2, 2])).toBe(false);
    expect(filled([17, 2.5])).toBe(false);
    expect(filled([5, 8.5])).toBe(true);
  });

  it('lets a zone take priority over a whole-board pour of another net', () => {
    const pour = { clearance: 0.3, connection: 'solid' as const, thermalGap: 0.3, spokeWidth: 0.35, minWidth: 0.2, layer: 'top' as const };
    const project = fixture({
      // A PWR track anchors the zone in the top-right corner.
      tracks: [{ id: 'pwr', layer: 'top', width: 0.25, points: [[15, 1.5], [16, 1.5]], net: 'PWR' }],
      pours: [
        { ...pour, id: 'all', net: 'SIG', outline: null },
        { ...pour, id: 'zone', net: 'PWR', outline: [[14, 0.5], [19.5, 0.5], [19.5, 3.5], [14, 3.5]] },
      ],
    });
    const fills = buildBoard(project, project.pcb!).fills;
    const at = (id: string, pt: [number, number]) => fills.find((f) => f.pour.id === id)!.areas.some((a) => pointInArea(pt, a));
    expect(at('zone', [18.5, 3])).toBe(true);
    expect(at('all', [18.5, 3])).toBe(false);
    expect(at('all', [18.5, 6])).toBe(true);
  });

  it('moves and removes holes, keepouts, cutouts and zones', () => {
    const pcb = fixture({
      holes: [{ id: 'h', x: 2, y: 2, diameter: 3.2, keepout: 6.4 }],
      keepouts: [{ ...wall, layers: ['top'] }],
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0, cutouts: [{ id: 'c', outline: [[1, 1], [3, 1], [3, 3]] }] },
      pours: [{ id: 'z', net: 'SIG', layer: 'top', outline: [[0, 0], [1, 0], [1, 1]], clearance: 0.3, connection: 'solid', thermalGap: 0.3, spokeWidth: 0.35, minWidth: 0.2 }],
    }).pcb!;
    const moved = movePlacements(pcb, new Set(['h', 'k', 'c', 'z']), 1, 2);
    expect(moved.holes![0]).toMatchObject({ x: 3, y: 4 });
    expect(moved.keepouts![0].outline[0]).toEqual([9, 5]);
    expect(moved.board.cutouts![0].outline[0]).toEqual([2, 3]);
    expect(moved.pours![0].outline![0]).toEqual([1, 2]);

    useEditor.getState().loadProject(fixture({ ...pcb }));
    expect(removePcbItems(new Set(['h', 'c', 'nope']))).toBe(2);
    const after = useEditor.getState().project.pcb!;
    expect(after.holes).toEqual([]);
    expect(after.board.cutouts).toEqual([]);
    expect(after.keepouts).toHaveLength(1);
  });

  it('adds zones next to whole-board pours instead of replacing them', () => {
    useEditor.getState().loadProject(fixture());
    addPours('SIG', ['top']);
    addPours('SIG', ['top'], { outline: [[0, 0], [4, 0], [4, 4]] });
    expect(useEditor.getState().project.pcb!.pours).toHaveLength(2);
    addPours('SIG', ['top']);
    const pours = useEditor.getState().project.pcb!.pours!;
    expect(pours.map((p) => Boolean(p.outline)).sort()).toEqual([false, true]);
  });

  it('drills mounting holes in a separate NPTH file and mills cutouts on the outline layer', () => {
    const project = fixture({
      holes: [{ id: 'h', x: 3, y: 3, diameter: 3.2, keepout: 6.4 }],
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0, cutouts: [{ id: 'c', outline: [[14, 6], [18, 6], [18, 9], [14, 9]] }] },
    });
    const files = generateGerbers(project.pcb!, buildBoard(project, project.pcb!), 'demo');
    expect(files.map((f) => f.name)).toContain('demo-NPTH.drl');
    const npth = generateNpthDrill(project.pcb!);
    expect(npth).toContain('NonPlated');
    expect(npth).toContain('T1C3.200');
    expect(npth).toContain('X3.000Y7.000');
    const edge = files.find((f) => f.name.endsWith('Edge_Cuts.gm1'))!.content;
    expect(edge).toContain('X14000000Y4000000D02*');
    expect(edge).toContain('X18000000Y1000000D01*');
    // The plated drill file has no mounting hole.
    expect(files.find((f) => f.name === 'demo.drl')!.content).not.toContain('3.200');
  });
});
