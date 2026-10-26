import { describe, expect, it } from 'vitest';
import { boardStep, boardOpenings, modelPlacementStep, parseStep, BOARD_THICKNESS } from '../src/lib/pcb/step';
import { buildBoard } from '../src/lib/pcb/board';
import { builtinFootprintDoc } from '../src/lib/pcb/footprint';
import { emptyPcb, type Pcb } from '../src/lib/pcb/types';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';
import type { Project } from '../src/lib/schematic/types';
import type { PartStep } from '../src/shared/parts';

/** R1 at (5, 5) and R2 at (12, 5), 0603, on a 20 × 10 board. */
function fixture(extra: Partial<Pcb> = {}): Project {
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
    wires: [],
    ports: [],
    pcb: {
      ...emptyPcb(),
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 1 },
      footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
      footprintOf: { a: 'builtin:0603', b: 'builtin:0603' },
      placements: [
        { componentId: 'a', x: 5, y: 5, rotation: 0, side: 'top' },
        { componentId: 'b', x: 12, y: 5, rotation: 90, side: 'bottom' },
      ],
      ...extra,
    },
  };
}

const entities = (step: string) => new Map([...step.matchAll(/^#(\d+)=(.*);$/gm)].map((m) => [Number(m[1]), m[2]]));
const refs = (body: string) => [...body.replace(/'(?:[^']|'')*'/g, '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/** Every edge of a solid's shell used once in each direction: the shell is closed. */
function closed(step: string, name: string): boolean {
  const e = entities(step);
  const solid = [...e.entries()].find(([, b]) => b.startsWith(`MANIFOLD_SOLID_BREP('${name}'`))!;
  const use = new Map<string, number>();
  for (const face of refs(e.get(refs(solid[1])[0])!)) {
    for (const bound of refs(e.get(face)!).slice(0, -1)) {
      for (const oe of refs(e.get(refs(e.get(bound)!)[0])!)) {
        const body = e.get(oe)!;
        const key = `${refs(body)[0]}${body.endsWith('.T.)') ? '+' : '-'}`;
        use.set(key, (use.get(key) ?? 0) + 1);
      }
    }
  }
  const edges = new Set([...use.keys()].map((k) => k.slice(0, -1)));
  return [...edges].every((id) => use.get(`${id}+`) === 1 && use.get(`${id}-`) === 1);
}

function build(project: Project, models = new Map<string, PartStep>()) {
  return boardStep({ pcb: project.pcb!, board: buildBoard(project, project.pcb!), name: 'test', models });
}

describe('STEP export', () => {
  it('writes a valid exchange file whose references all resolve', () => {
    const { step, blocks } = build(fixture());
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
    expect(step.trim().endsWith('END-ISO-10303-21;')).toBe(true);
    const e = entities(step);
    for (const body of e.values()) for (const r of refs(body)) expect(e.has(r)).toBe(true);
    // Reals always carry a decimal point.
    const coords = [...step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].flatMap((m) => m[1].split(','));
    expect(coords.length).toBeGreaterThan(0);
    expect(coords.filter((v) => /^-?\d+$/.test(v))).toEqual([]);
    expect(blocks).toEqual(['R1', 'R2']);
    // The board, a group per copper and silkscreen layer (a piece per pad or designator letter),
    // and two parts, each placed in the top assembly.
    const placed = [...step.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']*)'/g)].map((m) => m[1]);
    expect(placed.filter((p) => !/ \d+$/.test(p))).toEqual(['PCB', 'Top copper', 'Top silkscreen', 'Bottom copper', 'Bottom silkscreen', 'R1', 'R2']);
    expect(placed.filter((p) => p.startsWith('Top copper '))).toEqual(['Top copper 1', 'Top copper 2']);
  });

  it('makes the board a closed solid with round holes, slots and cutouts', () => {
    const project = fixture({
      holes: [{ id: 'h', x: 17, y: 2.5, diameter: 3.2, keepout: 6.4 }],
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 1, cutouts: [{ id: 'c', outline: [[2, 7], [6, 7], [6, 9], [2, 9]] }] },
    });
    const openings = boardOpenings(project.pcb!, buildBoard(project, project.pcb!));
    expect(openings.map((o) => o.kind)).toEqual(['circle', 'poly']);
    const { step } = build(project);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(1);
    expect(closed(step, 'PCB')).toBe(true);
    expect(closed(step, 'R1')).toBe(true);
    // Each pad is a copper solid on its face, the designators silkscreen solids.
    expect(closed(step, 'Top copper 1')).toBe(true);
    expect(closed(step, 'Bottom silkscreen 1')).toBe(true);
    expect(step.match(/MANIFOLD_SOLID_BREP\('Top copper \d+'/g)).toHaveLength(2);
  });

  it('places a model centred on its footprint, on the right side of the board', () => {
    const board = buildBoard(fixture(), fixture().pcb!);
    const box = { min: [-1, -0.5, 0] as [number, number, number], max: [1, 0.5, 0.5] as [number, number, number] };
    const top = modelPlacementStep(board.parts[0], [0, 0, 0, 0, 0, 0, 0, 0, 0], box);
    expect(top.translation).toEqual([5, -5, BOARD_THICKNESS]);
    // R2 is on the bottom at 90°: turned over (z down) and rotated.
    const bottom = modelPlacementStep(board.parts[1], [0, 0, 0, 0, 0, 0, 0, 0, 0], box);
    expect(bottom.translation.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([12, -5, 0]);
    expect(bottom.rotation[2].map((v) => Math.round(v) + 0)).toEqual([0, 0, -1]);
    // EasyEDA's Z rotation turns the model before it is placed.
    const turned = modelPlacementStep(board.parts[0], [0, 0, 0, 90, 0, 0, 0, 0, 0], box);
    expect(turned.rotation.map((row) => row.map((v) => Math.round(v) + 0))).toEqual([[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
  });

  it('merges each model file once and places it for every part that uses it', () => {
    // Any STEP file works as a model; use an exported board (itself an assembly).
    const model = build(fixture()).step;
    const parsed = parseStep(model);
    // Its lowest point is the underside of the bottom silkscreen.
    expect(parsed.min[2]).toBeCloseTo(-0.05);
    const part: PartStep = { lcsc: 'C1', title: 'board', transform: [0, 0, 0, 0, 0, 0, 0, 0, 0], file: 'f1', step: model };
    const { step, models, blocks } = build(fixture(), new Map([['a', part], ['b', part]]));
    expect(models).toBe(1);
    expect(blocks).toEqual([]);
    // The model's top product appears once although two parts use it.
    expect(step.match(/PRODUCT\('test','test'/g)).toHaveLength(2);
    const e = entities(step);
    for (const body of e.values()) for (const r of refs(body)) expect(e.has(r)).toBe(true);
    expect(new Set([...step.matchAll(/^#(\d+)=/gm)].map((m) => m[1])).size).toBe(e.size);
  });
});
