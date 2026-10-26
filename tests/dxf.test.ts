import { describe, expect, it } from 'vitest';
import { parseDxfOutline } from '../src/lib/pcb/dxf';
import { arcPoints, boardOutline, bulgeThrough, flattenOutline } from '../src/lib/pcb/geometry';
import { withOutline } from '../src/lib/pcb/outline';
import { emptyPcb } from '../src/lib/pcb/types';
import type { Vec } from '../src/lib/schematic/types';

/** An ASCII DXF with a header and the given entities (each a list of [code, value] pairs). */
function dxf(entities: (string | number)[][][], insunits?: number): string {
  const lines: (string | number)[] = [];
  if (insunits !== undefined) lines.push(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, insunits, 0, 'ENDSEC');
  lines.push(0, 'SECTION', 2, 'ENTITIES');
  for (const e of entities) for (const [code, value] of e) lines.push(code, value);
  lines.push(0, 'ENDSEC', 0, 'EOF');
  return lines.join('\n');
}
const line = (a: Vec, b: Vec) => [[0, 'LINE'], [8, '0'], [10, a[0]], [20, a[1]], [11, b[0]], [21, b[1]]];
const arc = (c: Vec, r: number, from: number, to: number) => [[0, 'ARC'], [8, '0'], [10, c[0]], [20, c[1]], [40, r], [50, from], [51, to]];
const circle = (c: Vec, r: number) => [[0, 'CIRCLE'], [8, '0'], [10, c[0]], [20, c[1]], [40, r]];

describe('arcs in outlines', () => {
  it('turns a bulge into points on the arc', () => {
    // A half circle of radius 5 from (0, 0) to (10, 0); positive turns clockwise on screen (y down),
    // so it bows up, towards -y.
    const pts = arcPoints([0, 0], [10, 0], 1);
    expect(pts.at(-1)).toEqual([10, 0]);
    for (const p of pts) expect(Math.hypot(p[0] - 5, p[1])).toBeCloseTo(5, 6);
    expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(-5, 1);
    expect(bulgeThrough([0, 0], [10, 0], [5, -5])).toBeCloseTo(1);
    expect(bulgeThrough([0, 0], [10, 0], [5, 2.5])).toBeCloseTo(-0.5);
  });

  it('keeps arcs exact and rounds only straight corners', () => {
    // A 20 × 10 rectangle whose right edge is a half circle out to x = 25.
    const board = withOutline({ x: 0, y: 0, width: 1, height: 1, cornerRadius: 1 }, [[0, 0], [20, 0], [20, 10], [0, 10]], [0, 1, 0, 0]);
    expect(board.width).toBeCloseTo(25, 1);
    const outline = boardOutline(board);
    expect(Math.max(...outline.map((p) => p[0]))).toBeCloseTo(25, 1);
    // The corners next to the arc stay sharp; the left ones are rounded.
    expect(outline.some((p) => p[0] === 20 && p[1] === 0)).toBe(true);
    expect(outline.some((p) => p[0] === 0 && p[1] === 0)).toBe(false);
    const flat = flattenOutline([[0, 0], [10, 0], [10, 10]], [0, 0, 0]);
    expect(flat.points).toHaveLength(4);
  });
});

describe('DXF outlines', () => {
  it('chains lines and arcs into an outline with holes and cutouts', () => {
    // A 40 × 30 rounded rectangle (r 5) drawn in pieces, out of order and some reversed.
    const text = dxf([
      line([5, 0], [35, 0]),
      line([40, 25], [40, 5]),
      arc([35, 5], 5, 270, 360),
      line([35, 30], [5, 30]),
      arc([35, 25], 5, 0, 90),
      line([0, 5], [0, 25]),
      arc([5, 25], 5, 90, 180),
      arc([5, 5], 5, 180, 270),
      circle([5, 5], 1.6),
      // A slot-shaped cutout from two lines and two arcs.
      line([15, 15], [25, 15]),
      arc([25, 17], 2, 270, 90),
      line([25, 19], [15, 19]),
      arc([15, 17], 2, 90, 270),
      // Something beside the board.
      circle([100, 100], 2),
      [[0, 'TEXT'], [1, 'title']],
    ]);
    const r = parseDxfOutline(text);
    expect(r.units).toBe('mm');
    expect([r.width, r.height]).toEqual([40, 30]);
    expect(r.outline).toHaveLength(8);
    expect(r.bulges.filter((b) => b !== 0)).toHaveLength(4);
    // Flipped to y down with the top-left corner at the origin: the hole at (5, 25).
    expect(r.holes).toEqual([{ x: 5, y: 25, diameter: 3.2 }]);
    expect(r.cutouts).toHaveLength(1);
    expect(Math.min(...r.cutouts[0].map((p) => p[1]))).toBeCloseTo(11, 3);
    expect(r.warnings).toEqual(['Ignored 1 TEXT', '1 shape outside the board left out']);
    // The outline set on a board has the arcs' true extent.
    const board = withOutline(emptyPcb().board, r.outline, r.bulges);
    expect(board.width).toBeCloseTo(40, 2);
    expect(board.height).toBeCloseTo(30, 2);
  });

  it('reads a round board, polylines with bulges, and inches', () => {
    const round = parseDxfOutline(dxf([circle([50, 50], 20)]));
    expect([round.width, round.height]).toEqual([40, 40]);
    expect(round.bulges.map(Math.abs)).toEqual([1, 1]);
    // A closed LWPOLYLINE in inches: a 2 × 1 rectangle with its top edge bulging up by a half circle.
    const poly = [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1], [10, 0], [20, 0], [10, 2], [20, 0], [10, 2], [20, 1], [42, 1], [10, 0], [20, 1]];
    const r = parseDxfOutline(dxf([poly], 1));
    expect(r.units).toBe('inch');
    expect(r.width).toBeCloseTo(50.8, 3);
    expect(r.height).toBeCloseTo(25.4 * 2, 3);
    expect(r.bulges).toEqual([0, 0, -1, 0]);
  });

  it('says what is wrong with a drawing it cannot use', () => {
    expect(() => parseDxfOutline(dxf([line([0, 0], [10, 0])]))).toThrow(/No closed outline/);
    expect(() => parseDxfOutline('AutoCAD Binary DXF\r\n\u001a\u0000')).toThrow(/Not a DXF file/);
  });
});
