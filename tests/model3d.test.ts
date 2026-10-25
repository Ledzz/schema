import { describe, expect, it } from 'vitest';
import { MIL } from '../src/lib/pcb/footprint';
import { fallbackHeight, modelPlacement, parseEasyedaObj } from '../src/lib/pcb/model3d';

// EasyEDA's OBJ variant: materials inline, `d` usually 0 for opaque.
const OBJ = [
  'newmtl body',
  'Kd 0.1 0.1 0.1',
  'd 0.0',
  'endmtl',
  'newmtl pins',
  'Kd 0.8 0.8 0.8',
  'd 1.0',
  'endmtl',
  'newmtl lens',
  'Kd 1 0 0',
  'd 0.4',
  'endmtl',
  'v -2 -1 0',
  'v 2 -1 0',
  'v 2 1 0',
  'v -2 1 1.5',
  'usemtl body',
  'f 1// 2// 3// 4//',
  'usemtl pins',
  'f 1 2 3',
  'usemtl lens',
  'f 2/1/1 3/1/1 4/1/1',
].join('\n');

describe('EasyEDA 3D models', () => {
  it('parses inline materials, triangulates faces and measures the model', () => {
    const m = parseEasyedaObj(OBJ);
    expect(m.parts.map((p) => [p.color, p.opacity, p.positions.length / 9])).toEqual([
      [[0.1, 0.1, 0.1], 1, 2],
      [[0.8, 0.8, 0.8], 1, 1],
      [[1, 0, 0], 0.6, 1],
    ]);
    expect(m.min).toEqual([-2, -1, 0]);
    expect(m.max).toEqual([2, 1, 1.5]);
  });

  it('places a model by its transform: size, rotation about Z first, offset in mil', () => {
    const m = parseEasyedaObj(OBJ);
    // Target size 8 x 2 mm (twice as wide), rotated 180 about Z, offset 10 mil in x.
    const p = modelPlacement(m, [8 / MIL, 2 / MIL, 0, 180, 0, 0, 10, 0, 0]);
    expect(p.scale[0]).toBeCloseTo(2);
    expect(p.scale[1]).toBeCloseTo(1);
    expect(p.scale[2]).toBeCloseTo(1.5);
    expect(p.rotation).toEqual([0, 0, Math.PI]);
    expect(p.offset[0]).toBeCloseTo(10 * MIL);
    expect(p.center).toEqual([-0, -0, -0]);
  });

  it('guesses stand-in block heights from footprint names', () => {
    expect(fallbackHeight('R0603')).toBe(0.45);
    expect(fallbackHeight('CONN-TH_WAFER-XH2.54-4PZZ-H62')).toBe(6.2);
    expect(fallbackHeight('SW-SMD_H6.2')).toBe(6.2);
    expect(fallbackHeight('QFN-28_L5.0-W5.0')).toBe(1.5);
  });
});
