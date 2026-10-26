import { describe, expect, it } from 'vitest';
import { dragCorner, dragSegment, firstCollision, moveTrack, shove, trackMovers, applyShove } from '../src/lib/pcb/shove';
import { shapeDistance, viaItem, type CopperItem } from '../src/lib/pcb/geometry';
import { emptyPcb, type Pcb, type Track, type Via } from '../src/lib/pcb/types';
import type { Vec } from '../src/lib/schematic/types';

describe('dragging a segment', () => {
  it('slides corners along their neighbours, keeping 45° and 90° angles', () => {
    expect(dragSegment([[0, 0], [2, 2], [8, 2], [10, 0]], 1, 1)).toEqual([[0, 0], [1, 1], [9, 1], [10, 0]]);
    expect(dragSegment([[0, 0], [10, 0], [10, 10]], 1, -2)).toEqual([[0, 0], [8, 0], [8, 8], [10, 10]]);
  });

  it('keeps track ends in place with a 45° jog', () => {
    expect(dragSegment([[0, 0], [10, 0]], 0, 1)).toEqual([[0, 0], [1, -1], [9, -1], [10, 0]]);
  });

  it('refuses moves that fold a segment back', () => {
    expect(dragSegment([[0, 0], [2, 0]], 0, 1.5)).toBeNull();
    expect(dragSegment([[0, 0], [0, 2], [2, 4], [8, 4], [10, 2], [10, 0]], 2, 5)).toBeNull();
  });

  it('replaces a short stub at a track end with a jog from the end', () => {
    // The router's tiny stubs into pads: the long segment can still move past them.
    // Stubs on the side the segment moves away from just get longer…
    expect(dragSegment([[0, 0.0001], [0, 0], [10, 0], [10, 0.0001]], 1, 2)).toEqual([[0, 0.0001], [0, -2], [10, -2], [10, 0.0001]]);
    // …stubs on the side it moves towards would fold, so the ends jog up at 45° instead.
    expect(dragSegment([[0, -0.0001], [0, 0], [10, 0], [10, -0.0001]], 1, 2)).toEqual([[0, -0.0001], [1.9999, -2], [8.0001, -2], [10, -0.0001]]);
    expect(dragSegment([[0, 0], [2, 2], [8, 2], [10, 0]], 1, 5)).toEqual([[0, 0], [3, -3], [7, -3], [10, 0]]);
    // A stub turning almost straight back would put the corner far off the board.
    const pts = dragSegment([[0, 0], [5, 0], [4.95, -0.0001]], 0, 0.1)!;
    for (const p of pts) expect(Math.abs(p[0])).toBeLessThan(6);
  });
});

const track = (id: string, net: string, points: Vec[], width = 0.25): Track => ({ id, layer: 'top', width, points, net });
const board = (tracks: Track[]): Pcb => ({ ...emptyPcb(), board: { x: 0, y: 0, width: 30, height: 12, cornerRadius: 0 }, tracks });
const opts = (pcb: Pcb, items: CopperItem[] = []) => ({ pcb, items, netOf: (it: CopperItem) => it.net, trackNet: (t: Track) => t.net });
const gap = (a: Track, pts: Vec[], b: Track, qts: Vec[]) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++)
    for (let j = 1; j < qts.length; j++)
      best = Math.min(best, shapeDistance({ kind: 'capsule', a: pts[i - 1], b: pts[i], r: a.width / 2 }, { kind: 'capsule', a: qts[j - 1], b: qts[j], r: b.width / 2 }));
  return best;
};

describe('shoving', () => {
  // A new A track drawn 0.3 mm above B (0.05 mm edge gap, clearance 0.2).
  const mover = trackMovers('top', 'A', 0.25, [[8, 4.7], [22, 4.7]]);
  const moverTrack = track('m', 'A', [[8, 4.7], [22, 4.7]]);

  it('pushes a track clear and keeps its ends', () => {
    const b = track('b', 'B', [[2, 5], [28, 5]]);
    const r = shove(mover, opts(board([b])));
    expect(r.ok).toBe(true);
    const pts = r.moved.get('b')!;
    expect(pts[0]).toEqual([2, 5]);
    expect(pts[pts.length - 1]).toEqual([28, 5]);
    expect(gap(moverTrack, moverTrack.points, b, pts)).toBeGreaterThanOrEqual(0.2 - 1e-6);
    expect(applyShove(board([b]), r.moved).tracks[0].points).toEqual(pts);
  });

  it('ripples on to the next track', () => {
    const b = track('b', 'B', [[2, 5], [28, 5]]);
    const c = track('c', 'C', [[0.5, 5.5], [29.5, 5.5]]);
    const r = shove(mover, opts(board([b, c])));
    expect(r.ok).toBe(true);
    expect(r.moved.has('c')).toBe(true);
    expect(gap(b, r.moved.get('b')!, c, r.moved.get('c')!)).toBeGreaterThanOrEqual(0.2 - 1e-6);
  });

  it('fails rather than push a track into a pad', () => {
    const b = track('b', 'B', [[2, 5], [28, 5]]);
    const pad: CopperItem = { key: 'p', type: 'pad', ref: 'x:0', layers: ['top'], net: 'D', shape: { kind: 'poly', points: [[14, 5.3], [16, 5.3], [16, 6], [14, 6]] }, box: { x1: 14, y1: 5.3, x2: 16, y2: 6 } };
    const r = shove(mover, opts(board([b]), [pad]));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pad/);
  });

  it('leaves tracks of the same net alone', () => {
    const own = track('o', 'A', [[2, 5], [28, 5]]);
    expect(shove(mover, opts(board([own]))).moved.size).toBe(0);
  });

  it('reports what a walk-around move would touch', () => {
    const b = track('b', 'B', [[2, 5], [28, 5]]);
    const items: CopperItem[] = [{ key: 't', type: 'track', ref: 'b', layers: ['top'], net: 'B', shape: { kind: 'capsule', a: [2, 5], b: [28, 5], r: 0.125 }, box: { x1: 2, y1: 4.8, x2: 28, y2: 5.2 } }];
    expect(firstCollision(mover, opts(board([b]), items))).toBe('too close to B track');
    expect(firstCollision(trackMovers('top', 'A', 0.25, [[8, 3], [22, 3]]), opts(board([b]), items))).toBeNull();
  });
});

describe('dragging corners and whole tracks', () => {
  it('moves a corner with 45° bends on both sides', () => {
    expect(dragCorner([[0, 0], [10, 0], [10, 10]], 1, [12, 3])).toEqual([[0, 0], [9, 0], [12, 3], [10, 5], [10, 10]]);
    // Ends are not corners.
    expect(dragCorner([[0, 0], [10, 0]], 0, [3, 3])).toEqual([[0, 0], [10, 0]]);
  });

  it('moves a whole track, keeping ends that sit on pads', () => {
    expect(moveTrack([[0, 0], [10, 0]], [0, 2], [true, true])).toEqual([[0, 0], [0, 2], [10, 2], [10, 0]]);
    expect(moveTrack([[0, 0], [10, 0]], [1, 2])).toEqual([[1, 2], [11, 2]]);
  });
});

describe('pushing vias', () => {
  const mover = trackMovers('top', 'A', 0.25, [[8, 4.7], [22, 4.7]]);
  const via: Via = { id: 'v', x: 15, y: 5.3, diameter: 0.6, drill: 0.3, net: 'B' };
  const tail = track('tb', 'B', [[15, 5.3], [15, 9]]);
  const withVia = (): Pcb => ({ ...board([tail]), vias: [via] });

  it('moves a via of another net out of the way, with its track', () => {
    const r = shove(mover, opts(withVia(), [viaItem(via)]));
    expect(r.ok).toBe(true);
    const c = r.vias.get('v')!;
    expect(c[0]).toBeCloseTo(15);
    expect(c[1]).toBeGreaterThan(5.3);
    expect(shapeDistance(mover[0].shape, { kind: 'capsule', a: c, b: c, r: 0.3 })).toBeGreaterThanOrEqual(0.2 - 1e-6);
    expect(r.moved.get('tb')![0]).toEqual(c);
    expect(applyShove(withVia(), r.moved, r.vias).vias[0]).toMatchObject({ x: c[0], y: c[1] });
  });

  it('leaves a via in a pad of its own net where it is', () => {
    const pad: CopperItem = { key: 'p', type: 'pad', ref: 'u:0', layers: ['top', 'bottom'], net: 'B', shape: { kind: 'poly', points: [[14, 5], [16, 5], [16, 6], [14, 6]] }, box: { x1: 14, y1: 5, x2: 16, y2: 6 } };
    const r = shove(mover, opts(withVia(), [viaItem(via), pad]));
    expect(r.vias.size).toBe(0);
  });
});
