import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { autoroute, boardModel, checkPcb } from '../src/lib/pcb/actions';
import { chamferCorners, detectPairs, diffImpedance, meanderGain, meanderPath, offsetPolyline, outerDielectric, polylineLength, widthForImpedance } from '../src/lib/pcb/diffpair';
import { builtinFootprintDoc } from '../src/lib/pcb/footprint';
import { addDiffPair, findPair, lengthsOf, matchPair, pairLengthsOf, routeDiffPair, suggestedPairs, tuneLength } from '../src/lib/pcb/tuning';
import { emptyPcb, type Pcb } from '../src/lib/pcb/types';
import type { Project, Vec } from '../src/lib/schematic/types';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';

const st = () => useEditor.getState();

/**
 * Four 0603 resistors: R1 and R2 on the left, R3 and R4 on the right (at `farX`), with nets
 * USB_DP (R1.2 to R3.1) and USB_DN (R2.2 to R4.1) running between them.
 */
function board(farX = 15): Project {
  const sym = { title: 'R', dataStr: PASSIVE_SYMBOLS.resistor, source: 'builtin' as const };
  const r = (id: string, d: string, x: number, y: number) => ({ id, symbolKey: 'r', unit: 0, designator: d, value: '0R', x, y, rotation: 0 as const, mirror: false, attrs: {} });
  const label = (id: string, name: string, x: number, y: number) => ({ id, kind: 'label' as const, name, x, y, rotation: 0 as const });
  const pcb: Pcb = {
    ...emptyPcb(),
    board: { x: 0, y: 0, width: 25, height: 12, cornerRadius: 0 },
    footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
    footprintOf: { a: 'builtin:0603', b: 'builtin:0603', c: 'builtin:0603', d: 'builtin:0603' },
    placements: [
      { componentId: 'a', x: 5, y: 5, rotation: 0, side: 'top' },
      { componentId: 'b', x: 5, y: 7, rotation: 0, side: 'top' },
      { componentId: 'c', x: farX, y: 5, rotation: 0, side: 'top' },
      { componentId: 'd', x: farX, y: 7, rotation: 0, side: 'top' },
    ],
  };
  return {
    version: 1,
    id: 'p',
    name: 'pair',
    updatedAt: 0,
    symbols: { r: sym },
    components: [r('a', 'R1', 0, 0), r('b', 'R2', 0, 100), r('c', 'R3', 100, 0), r('d', 'R4', 100, 100)],
    wires: [],
    // Labels on the pins: R1.2 and R3.1 on USB_DP, R2.2 and R4.1 on USB_DN.
    ports: [label('l1', 'USB_DP', 20, 0), label('l2', 'USB_DP', 80, 0), label('l3', 'USB_DN', 20, 100), label('l4', 'USB_DN', 80, 100)],
    pcb,
  };
}

const errors = () => checkPcb().issues.filter((i) => i.severity === 'error').map((i) => i.message);

describe('pair geometry', () => {
  it('finds pairs by name', () => {
    expect(detectPairs(['USB_DP', 'USB_DN', 'D+', 'D-', 'CLK_P', 'CLK_N', 'HS_DP', 'HS_DM', 'LVDS0P', 'LVDS0N', 'GND', 'EN', 'MOT_A1', 'MOT_A2'])).toEqual([
      { name: 'CLK', positive: 'CLK_P', negative: 'CLK_N' },
      { name: 'D', positive: 'D+', negative: 'D-' },
      { name: 'HS_D', positive: 'HS_DP', negative: 'HS_DM' },
      { name: 'LVDS0', positive: 'LVDS0P', negative: 'LVDS0N' },
      { name: 'USB_D', positive: 'USB_DP', negative: 'USB_DN' },
    ]);
  });

  it('estimates impedance and the width for a target', () => {
    const four = outerDielectric(4);
    // 0.2 mm tracks 0.2 mm apart over 0.21 mm of prepreg: about 109 Ω.
    expect(diffImpedance(0.2, 0.2, four.height, four.er)).toBeCloseTo(108.7, 0);
    const w = widthForImpedance(90, 0.2, four.height, four.er)!;
    expect(diffImpedance(w, 0.2, four.height, four.er)).toBeCloseTo(90, 0);
    expect(w).toBeGreaterThan(0.2);
  });

  it('splits a centreline into two tracks that keep their spacing round corners', () => {
    const centre = chamferCorners([[0, 0], [10, 0], [10, 10]], 1);
    // The 90° turn became two 45° turns.
    expect(centre).toHaveLength(4);
    const left = offsetPolyline(centre, 0.5);
    const right = offsetPolyline(centre, -0.5);
    expect(left[0]).toEqual([0, -0.5]);
    expect(right[0]).toEqual([0, 0.5]);
    for (let i = 0; i < left.length; i++) expect(Math.hypot(left[i][0] - right[i][0], left[i][1] - right[i][1])).toBeGreaterThanOrEqual(1 - 1e-3);
  });

  it('adds the length it promises with meanders', () => {
    const a: Vec = [0, 0];
    const b: Vec = [20, 0];
    const pts = meanderPath(a, b, 3, 1, 0.75, 1, 4);
    expect(polylineLength(pts) - 20).toBeCloseTo(meanderGain(3, 1, 0.75), 2);
    // Bumps go to the left of the direction (y down: negative y).
    expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(-1, 3);
  });
});

describe('differential pairs and tuning on the board', () => {
  beforeEach(() => st().loadProject(board()));

  it('routes a pair side by side at its gap, and DRC allows the gap', () => {
    expect(suggestedPairs().map((p) => p.name)).toEqual(['USB_D']);
    addDiffPair('USB_DP', 'USB_DN', { width: 0.25, gap: 0.15 });
    expect(suggestedPairs()).toEqual([]);
    const r = routeDiffPair('USB_D');
    expect(r).toEqual({ routed: 2, failed: [] });
    const { pcb, conn } = boardModel();
    expect(conn.airwires).toEqual([]);
    const [dp, dn] = ['USB_DP', 'USB_DN'].map((n) => pcb.tracks.find((t) => t.net === n)!);
    // Parallel along most of their length, 0.25 + 0.15 mm apart centre to centre (and 2 µm, so
    // rounding never takes them below the gap).
    const run = (t: typeof dp) => t.points.slice(1).map((q, i) => [t.points[i], q]).sort((x, y) => Math.abs(y[1][0] - y[0][0]) - Math.abs(x[1][0] - x[0][0]))[0];
    expect(run(dn)[0][1] - run(dp)[0][1]).toBeCloseTo(0.402, 3);
    expect(Math.abs(run(dp)[1][0] - run(dp)[0][0])).toBeGreaterThan(5);
    expect(dp.width).toBe(0.25);
    // 0.15 mm is below the 0.2 mm clearance, but it is the pair's gap.
    expect(errors()).toEqual([]);
    expect(Math.abs((lengthsOf().get('USB_DP')?.length ?? 0) - (lengthsOf().get('USB_DN')?.length ?? 0))).toBeLessThan(0.01);
    // A branch of one net (a connector's second D+ pad, say) doesn't count towards the pair's skew.
    st().commit((doc) => ({ ...doc, pcb: { ...doc.pcb!, tracks: [...doc.pcb!.tracks, { id: 'stub', layer: 'top', width: 0.25, points: [dp.points[0], [dp.points[0][0], 2]], net: 'USB_DP' }] } }));
    const pair = findPair('USB_D');
    expect(pairLengthsOf(pair)).toMatchObject({ coupled: true });
    expect(Math.abs(pairLengthsOf(pair).positive - pairLengthsOf(pair).negative)).toBeLessThan(0.01);
    expect(checkPcb().issues.some((i) => i.message.startsWith('Pair'))).toBe(false);
  });

  it('tunes a net to a length with meanders that keep clear of everything', () => {
    autoroute();
    const before = lengthsOf().get('USB_DP')!.length;
    const r = tuneLength('USB_DP', before + 4);
    expect(r.after).toBeCloseTo(before + 4, 1);
    expect(r.short).toBeLessThan(0.1);
    expect(lengthsOf().get('USB_DP')!.length).toBeCloseTo(before + 4, 1);
    expect(errors()).toEqual([]);
    // More than there is room for: as much as fits, and the rest is reported.
    const big = tuneLength('USB_DP', before + 400);
    expect(big.short).toBeGreaterThan(300);
  });

  it('matches a pair whose nets differ in length, and DRC warns until then', () => {
    st().loadProject(board());
    addDiffPair('USB_DP', 'USB_DN', { width: 0.25, gap: 0.2, tolerance: 0.1 });
    autoroute();
    // Lengthen DN by hand so the pair is skewed.
    tuneLength('USB_DN', lengthsOf().get('USB_DN')!.length + 1.5, { amplitude: 0.6 });
    expect(checkPcb().issues.some((i) => /Pair USB_D: USB_DN is 1\.\d+ mm longer than USB_DP/.test(i.message))).toBe(true);
    const r = matchPair('USB_D');
    expect(r.net).toBe('USB_DP');
    const l = lengthsOf();
    expect(Math.abs(l.get('USB_DP')!.length - l.get('USB_DN')!.length)).toBeLessThan(0.1);
    expect(checkPcb().issues.some((i) => i.message.startsWith('Pair USB_D'))).toBe(false);
    expect(errors()).toEqual([]);
  });
});
