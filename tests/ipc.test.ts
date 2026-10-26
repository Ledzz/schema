import { describe, expect, it } from 'vitest';
import { generateFootprint, packageSpec, padNumbers } from '../src/lib/pcb/ipc';
import { icSymbol, parsePinList, pinProblems, sideOf } from '../src/lib/schematic/symbolgen';

const pad = (fp: ReturnType<typeof generateFootprint>, n: string) => fp.pads.find((p) => p.number === n)!;
/** Closest copper gap between any two pads (axis-aligned boxes). */
function minGap(fp: ReturnType<typeof generateFootprint>) {
  let best = Infinity;
  for (const a of fp.pads)
    for (const b of fp.pads) {
      if (a === b) continue;
      const dx = Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2);
      const dy = Math.max(0, Math.abs(a.y - b.y) - (a.h + b.h) / 2);
      best = Math.min(best, Math.hypot(dx, dy));
    }
  return best;
}

describe('IPC-7351 footprints', () => {
  it('matches the usual land patterns', () => {
    // SOIC-8: 1.95 × 0.6 mm pads, rows 4.95 mm apart (as in IPC's calculator and KiCad).
    const soic = generateFootprint(packageSpec('SOIC-8'));
    expect(pad(soic, '1')).toMatchObject({ x: -2.475, y: -1.905, w: 1.95, h: 0.6 });
    expect(pad(soic, '8')).toMatchObject({ x: 2.475, y: -1.905 });
    expect(pad(soic, '5')).toMatchObject({ x: 2.475, y: 1.905 });
    // SOT-23: 1.475 mm long pads at ±0.94, pin 3 alone on the right.
    const sot = generateFootprint(packageSpec('SOT-23'));
    expect(pad(sot, '1')).toMatchObject({ x: -0.938, y: -0.475, w: 1.475 });
    expect(pad(sot, '3')).toMatchObject({ x: 0.938, y: 0 });
  });

  it('numbers quad packages counter-clockwise from the top left, with the exposed pad last', () => {
    const qfn = generateFootprint(packageSpec('QFN-32-5x5-0.5-EP3.45'));
    expect(padNumbers(qfn)).toHaveLength(33);
    const [p1, p8, p9, p17, p25, ep] = ['1', '8', '9', '17', '25', '33'].map((n) => pad(qfn, n));
    expect(p1.x).toBeLessThan(0);
    expect(p1.y).toBeLessThan(0);
    expect(p8.y).toBeGreaterThan(0);
    // Bottom row, left to right; right column bottom to top; top row right to left.
    expect(p9.y).toBeGreaterThan(2);
    expect(p9.x).toBeLessThan(0);
    expect(p17.x).toBeGreaterThan(2);
    expect(p17.y).toBeGreaterThan(0);
    expect(p25.y).toBeLessThan(-2);
    expect(p25.x).toBeGreaterThan(0);
    expect(ep).toMatchObject({ x: 0, y: 0, w: 3.45, h: 3.45 });
    // Pads end a little outside the 5 mm body, and are turned along their side.
    expect(p1.x - p1.w / 2).toBeLessThan(-2.5);
    expect(p9.h).toBeGreaterThan(p9.w);
    // Neighbouring pads keep 0.2 mm (an exposed pad too big for that shrinks); QFN corner pads
    // come closer diagonally, as in KiCad's.
    const tight = generateFootprint(packageSpec('DFN-6-2x2-0.65-EP1.0x1.6'));
    expect(pad(tight, '7').w).toBeLessThan(1);
    for (const name of ['QFN-32', 'LQFP-48', 'LQFP-100', 'TSSOP-20', 'MSOP-10', 'SOT-23-6', 'SOIC-16W', 'DFN-8', 'DFN-6-2x2-0.65-EP1.0x1.6', 'QFN-16-3x3-0.5-EP2']) {
      expect(minGap(generateFootprint(packageSpec(name))), name).toBeGreaterThanOrEqual(name.startsWith('QFN') ? 0.15 : 0.19);
    }
  });

  it('keeps silkscreen off the pads', () => {
    for (const name of ['SOIC-8', 'QFN-16', 'LQFP-48', 'SOT-23-5', '1206', 'SOT-223']) {
      const fp = generateFootprint(packageSpec(name));
      const silk = fp.graphics.filter((g) => g.layer === 'silkTop' && !g.filled);
      expect(silk.length, name).toBeGreaterThan(0);
      for (const g of silk)
        for (const [x, y] of g.points)
          for (const p of fp.pads) {
            const inside = Math.abs(x - p.x) < p.w / 2 + 0.2 && Math.abs(y - p.y) < p.h / 2 + 0.2;
            expect(inside, `${name} silk at ${x},${y} near pad ${p.number}`).toBe(false);
          }
    }
  });

  it('makes through-hole headers and DIPs', () => {
    const hdr = generateFootprint(packageSpec('HDR-2x05'));
    expect(hdr.pads).toHaveLength(10);
    expect(pad(hdr, '1')).toMatchObject({ shape: 'rect', layer: 'through', hole: { w: 1 } });
    expect(pad(hdr, '2').x).toBeCloseTo(1.27);
    expect(pad(hdr, '3').y - pad(hdr, '1').y).toBeCloseTo(2.54);
    const dip = generateFootprint(packageSpec('DIP-8'));
    expect(pad(dip, '1')).toMatchObject({ x: -3.81, shape: 'rect' });
    expect(pad(dip, '8')).toMatchObject({ x: 3.81, y: pad(dip, '1').y });
  });

  it('says which names it understands', () => {
    expect(() => packageSpec('BGA-256')).toThrow(/Unknown package "BGA-256". Known forms: 0603, SOT-23/);
    expect(packageSpec('lqfp-64-10x10-0.5')).toMatchObject({ family: 'quad', pins: 64, pitch: 0.5, bodyWidth: 10 });
  });
});

describe('generated symbols', () => {
  it('puts pins on the grid around a body that fits their names', () => {
    const def = icSymbol('TMP117', 'U', parsePinList('1 SCL\n2 GND bottom\n3 ALERT\n4 ADD0\n5 V+ top\n6 SDA'));
    const unit = def.units[0];
    expect(unit.pins.map((p) => `${p.number}:${sideOf(p)}`)).toEqual(['1:left', '3:left', '4:right', '6:right', '5:top', '2:bottom']);
    for (const p of unit.pins) expect(Number.isInteger(p.x / 10) && Number.isInteger(p.y / 10), `pin ${p.number}`).toBe(true);
    const body = unit.shapes[0];
    expect(body.kind).toBe('rect');
    // Pin ends meet the body's edges.
    const v = unit.pins.find((p) => p.number === '5')!;
    expect(v.y + v.dir[1] * v.length).toBe(body.kind === 'rect' ? body.y : NaN);
    expect(pinProblems(def)).toEqual([]);
    expect(() => icSymbol('X', 'U', [{ number: '1' }, { number: '1' }])).toThrow(/used twice/);
  });
});
