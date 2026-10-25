import { describe, expect, it } from 'vitest';
import { boardOutline, filletPolygon, pointInPolygon } from '../src/lib/pcb/geometry';
import { boardEdges, edgeDistance, insideBoard, keepoutAreas, selfIntersects, withOutline } from '../src/lib/pcb/outline';
import type { Vec } from '../src/lib/schematic/types';
import type { Board } from '../src/lib/pcb/types';

// An L: 10 × 10 with the bottom-right 6 × 6 quarter missing.
const L: Vec[] = [
  [0, 0],
  [10, 0],
  [10, 4],
  [4, 4],
  [4, 10],
  [0, 10],
];
const rect: Board = { x: 0, y: 0, width: 30, height: 20, cornerRadius: 0 };

describe('board outline', () => {
  it('stores a custom outline with its bounding box and drops it again', () => {
    const b = withOutline({ ...rect, x: 5 }, L);
    expect(b).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(b.outline).toHaveLength(6);
    // A repeated closing point is dropped.
    expect(withOutline(rect, [...L, L[0]]).outline).toHaveLength(6);
    expect('outline' in withOutline(b, null)).toBe(false);
  });

  it('uses the custom shape everywhere, rounding its corners', () => {
    const b = withOutline(rect, L);
    expect(boardOutline(b)).toHaveLength(7);
    const round = filletPolygon(L, 1);
    expect(pointInPolygon([2, 7], round)).toBe(true);
    expect(pointInPolygon([7, 7], round)).toBe(false);
    // Convex corners are cut, the concave one at (4, 4) is filled in.
    expect(pointInPolygon([0.05, 0.05], round)).toBe(false);
    expect(pointInPolygon([4.1, 4.1], round)).toBe(true);
  });

  it('finds points inside the shape and their distance to the nearest edge', () => {
    const edges = boardEdges({ board: withOutline(rect, L) });
    expect(insideBoard([2, 7], edges)).toBe(true);
    expect(insideBoard([7, 7], edges)).toBe(false);
    expect(edgeDistance([2, 2], edges)).toBeCloseTo(2);
    expect(edgeDistance([5, 5], edges)).toBeCloseTo(1);
  });

  it('treats cutouts and mounting holes as openings', () => {
    const edges = boardEdges({
      board: { ...rect, cutouts: [{ id: 'c', outline: [[10, 5], [14, 5], [14, 9], [10, 9]] }] },
      holes: [{ id: 'h', x: 25, y: 10, diameter: 3, keepout: 6 }],
    });
    expect(insideBoard([12, 7], edges)).toBe(false);
    expect(insideBoard([25, 10.5], edges)).toBe(false);
    expect(insideBoard([20, 10], edges)).toBe(true);
    expect(edgeDistance([12, 3], edges)).toBeCloseTo(2);
    expect(edgeDistance([25, 13], edges)).toBeCloseTo(1.5);
  });

  it('spots outlines that cross themselves', () => {
    expect(selfIntersects(L)).toBe(false);
    expect(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true);
  });

  it('turns each mounting hole into a copper-free ring', () => {
    const [ring] = keepoutAreas({ holes: [{ id: 'h', x: 5, y: 5, diameter: 3.2, keepout: 6.4 }] });
    expect(ring).toMatchObject({ id: 'h', tracks: true, vias: true, pours: true, parts: true, layers: ['top', 'bottom'] });
    expect(Math.max(...ring.outline.map((p) => p[0]))).toBeCloseTo(8.2);
  });
});
