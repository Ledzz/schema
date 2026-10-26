import { describe, expect, it } from 'vitest';
import { dragSegment, firstCollision, shove, trackMovers, applyShove } from '../src/lib/pcb/shove';
import { shapeDistance, type CopperItem } from '../src/lib/pcb/geometry';
import { emptyPcb, type Pcb, type Track } from '../src/lib/pcb/types';
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
    expect(dragSegment([[0, 0], [2, 2], [8, 2], [10, 0]], 1, 5)).toBeNull();
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
