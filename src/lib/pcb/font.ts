import type { Vec } from '../schematic/types';

/*
 * Minimal single-stroke font for silkscreen text, so on-screen text matches the Gerber output.
 * Glyphs live on a 4 x 6 grid (y down, baseline at 6).
 */
const GLYPHS: Record<string, string[]> = {
  '0': ['0,0 4,0 4,6 0,6 0,0', '4,0 0,6'],
  '1': ['1,1 2,0 2,6', '1,6 3,6'],
  '2': ['0,1 1,0 3,0 4,1 4,2 0,6 4,6'],
  '3': ['0,0 4,0 2,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5'],
  '4': ['3,6 3,0 0,4 4,4'],
  '5': ['4,0 0,0 0,2.5 3,2.5 4,3.5 4,5 3,6 0,6'],
  '6': ['3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 3,2.5 0,2.5'],
  '7': ['0,0 4,0 1.5,6'],
  '8': ['1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0', '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3'],
  '9': ['4,3.5 1,3.5 0,2.5 0,1 1,0 3,0 4,1 4,5 3,6 1,6'],
  A: ['0,6 0,2 2,0 4,2 4,6', '0,3.5 4,3.5'],
  B: ['0,0 0,6 3,6 4,5 4,4 3,3 0,3', '0,0 3,0 4,1 4,2 3,3'],
  C: ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5'],
  D: ['0,0 0,6 2.5,6 4,4.5 4,1.5 2.5,0 0,0'],
  E: ['4,0 0,0 0,6 4,6', '0,3 3,3'],
  F: ['4,0 0,0 0,6', '0,3 3,3'],
  G: ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3'],
  H: ['0,0 0,6', '4,0 4,6', '0,3 4,3'],
  I: ['1,0 3,0', '2,0 2,6', '1,6 3,6'],
  J: ['4,0 4,5 3,6 1,6 0,5'],
  K: ['0,0 0,6', '4,0 0,3.5', '1.5,2.5 4,6'],
  L: ['0,0 0,6 4,6'],
  M: ['0,6 0,0 2,3 4,0 4,6'],
  N: ['0,6 0,0 4,6 4,0'],
  O: ['1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0'],
  P: ['0,6 0,0 3,0 4,1 4,2 3,3 0,3'],
  Q: ['1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0', '2.5,4.5 4,6'],
  R: ['0,6 0,0 3,0 4,1 4,2 3,3 0,3', '2,3 4,6'],
  S: ['4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5'],
  T: ['0,0 4,0', '2,0 2,6'],
  U: ['0,0 0,5 1,6 3,6 4,5 4,0'],
  V: ['0,0 2,6 4,0'],
  W: ['0,0 1,6 2,3 3,6 4,0'],
  X: ['0,0 4,6', '4,0 0,6'],
  Y: ['0,0 2,3 4,0', '2,3 2,6'],
  Z: ['0,0 4,0 0,6 4,6'],
  '+': ['2,1.5 2,4.5', '0.5,3 3.5,3'],
  '-': ['0.5,3 3.5,3'],
  '.': ['1.8,5.6 2.2,6'],
  _: ['0,6 4,6'],
  '/': ['4,0 0,6'],
  '?': ['0,1 1,0 3,0 4,1 4,2 2,3.5 2,4.5', '2,5.6 2,6'],
};

const ADVANCE = 5.5;

/**
 * Strokes for `text` with cap height `size`, anchored at `at` (centre), rotated CCW `rotation`
 * degrees and optionally mirrored (bottom silkscreen).
 */
export function textStrokes(text: string, at: Vec, size: number, rotation = 0, mirror = false): Vec[][] {
  const scale = size / 6;
  const chars = [...text.toUpperCase()];
  const width = (chars.length * ADVANCE - (ADVANCE - 4)) * scale;
  const strokes: Vec[][] = [];
  const r = (rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  chars.forEach((ch, i) => {
    for (const stroke of GLYPHS[ch] ?? (ch === ' ' ? [] : GLYPHS['?'])) {
      strokes.push(
        stroke.split(' ').map((pair) => {
          const [gx, gy] = pair.split(',').map(Number);
          let x = (i * ADVANCE + gx) * scale - width / 2;
          const y = gy * scale - size / 2;
          if (mirror) x = -x;
          return [at[0] + x * cos + y * sin, at[1] - x * sin + y * cos] as Vec;
        }),
      );
    }
  });
  return strokes;
}
