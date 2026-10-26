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
  ':': ['2,2.8 2,3.2', '2,5.6 2,6'],
  ';': ['2,2.8 2,3.2', '2.2,5.6 2.2,6 1.6,7'],
  ',': ['2.2,5.6 2.2,6 1.6,7'],
  '!': ['2,0 2,4.2', '2,5.6 2,6'],
  "'": ['2,0 2,1.5'],
  '"': ['1.3,0 1.3,1.5', '2.7,0 2.7,1.5'],
  '(': ['2.8,-0.2 1.5,1.5 1.5,4.5 2.8,6.2'],
  ')': ['1.2,-0.2 2.5,1.5 2.5,4.5 1.2,6.2'],
  '[': ['3,-0.2 1.5,-0.2 1.5,6.2 3,6.2'],
  ']': ['1,-0.2 2.5,-0.2 2.5,6.2 1,6.2'],
  '=': ['0.5,2.2 3.5,2.2', '0.5,3.8 3.5,3.8'],
  '<': ['3.5,0.8 0.5,3 3.5,5.2'],
  '>': ['0.5,0.8 3.5,3 0.5,5.2'],
  '*': ['2,1.5 2,4.5', '0.7,2.2 3.3,3.8', '3.3,2.2 0.7,3.8'],
  '#': ['1.2,0.5 1.2,5.5', '2.8,0.5 2.8,5.5', '0,2 4,2', '0,4 4,4'],
  '%': ['0,6 4,0', '0.4,0.4 1.4,0.4 1.4,1.6 0.4,1.6 0.4,0.4', '2.6,4.4 3.6,4.4 3.6,5.6 2.6,5.6 2.6,4.4'],
  '&': ['4,6 1,2 1,1 2,0 3,1 3,2 0,4.5 0,5 1,6 2.5,6 4,4'],
  '@': ['3,4 3,2 1.5,2 1,3 1.5,4 3,4 4,3 4,1 3,0 1,0 0,1 0,5 1,6 4,6'],
  '|': ['2,-0.2 2,6.2'],
  '\\': ['0,0 4,6'],
  '~': ['0,3.3 1,2.6 3,3.4 4,2.7'],
  '°': ['1.5,0 2.5,0 2.5,1 1.5,1 1.5,0'],
  'µ': ['0,2.5 0,8', '0,5 1,6 3,6 4,5', '4,2.5 4,6'],
  'Ω': ['0,6 1.5,6 1.5,5 0,3.5 0,1.5 1,0 3,0 4,1.5 4,3.5 2.5,5 2.5,6 4,6'],
  a: ['4,2.5 4,6', '4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5'],
  b: ['0,0 0,6', '0,3.5 1,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5'],
  c: ['4,3 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5.5'],
  d: ['4,0 4,6', '4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5'],
  e: ['0,4.25 4,4.25 4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5.5'],
  f: ['3.5,0 2.5,0 1.5,1 1.5,6', '0,2.5 3.5,2.5'],
  g: ['4,2.5 4,7 3,8 1,8 0,7.5', '4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5'],
  h: ['0,0 0,6', '0,3.5 1,2.5 3,2.5 4,3.5 4,6'],
  i: ['2,2.5 2,6', '2,0.8 2,1.2'],
  j: ['3,2.5 3,7 2,8 0.5,8', '3,0.8 3,1.2'],
  k: ['0,0 0,6', '4,2.5 0,4.5', '1.5,3.8 4,6'],
  l: ['1.5,0 1.5,5 2.5,6 3,6'],
  m: ['0,6 0,2.5', '0,3.5 1,2.5 2,3.5 2,6', '2,3.5 3,2.5 4,3.5 4,6'],
  n: ['0,6 0,2.5', '0,3.5 1,2.5 3,2.5 4,3.5 4,6'],
  o: ['1,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5 0,3.5 1,2.5'],
  p: ['0,2.5 0,8', '0,3.5 1,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5'],
  q: ['4,2.5 4,8', '4,3.5 3,2.5 1,2.5 0,3.5 0,5 1,6 3,6 4,5'],
  r: ['0,6 0,2.5', '0,4 1.5,2.5 3,2.5 4,3'],
  s: ['4,3 3,2.5 1,2.5 0,3 0,3.75 1,4.25 3,4.25 4,4.75 4,5.5 3,6 1,6 0,5.5'],
  t: ['1.5,0.5 1.5,5 2.5,6 3.5,6', '0,2.5 3.5,2.5'],
  u: ['0,2.5 0,5 1,6 3,6 4,5', '4,2.5 4,6'],
  v: ['0,2.5 2,6 4,2.5'],
  w: ['0,2.5 1,6 2,3.5 3,6 4,2.5'],
  x: ['0,2.5 4,6', '4,2.5 0,6'],
  y: ['0,2.5 2,6', '4,2.5 1,8'],
  z: ['0,2.5 4,2.5 0,6 4,6'],
};

/** Characters the silkscreen font can draw (others print as "?"). */
export const supportedChar = (ch: string) => ch === ' ' || ch === '\n' || ch in GLYPHS || ch.toUpperCase() in GLYPHS;

/** Gap between glyphs and the width of a space, in glyph units. */
const GAP = 1.5;
const SPACE = 3.5;
/** Line pitch in glyph units (cap height 6, room for descenders). */
const LINE = 9.5;

type Glyph = { strokes: Vec[][]; left: number; width: number };
const glyphCache = new Map<string, Glyph>();

/** A character's strokes and horizontal extent (proportional spacing). */
function glyph(ch: string): Glyph {
  let g = glyphCache.get(ch);
  if (!g) {
    const source = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? (ch === ' ' ? [] : GLYPHS['?']);
    const strokes = source.map((stroke) => stroke.split(' ').map((pair) => pair.split(',').map(Number) as Vec));
    const xs = strokes.flat().map((p) => p[0]);
    g = xs.length ? { strokes, left: Math.min(...xs), width: Math.max(...xs) - Math.min(...xs) } : { strokes, left: 0, width: SPACE - GAP };
    glyphCache.set(ch, g);
  }
  return g;
}

/** Width of one line in glyph units. */
const lineWidth = (chars: string[]) => (chars.length ? chars.reduce((w, ch) => w + glyph(ch).width + GAP, -GAP) : 0);

/** Width and height of `text` in mm at cap height `size` (lines stacked). */
export function textSize(text: string, size: number): { width: number; height: number } {
  const lines = text.split('\n');
  return { width: Math.max(...lines.map((l) => lineWidth([...l]))) * (size / 6), height: ((lines.length - 1) * LINE + 6) * (size / 6) };
}

/**
 * Strokes for `text` with cap height `size`, centred on `at`, rotated CCW `rotation` degrees and
 * optionally mirrored (bottom silkscreen). Lines split on "\n" are centred under each other.
 */
export function textStrokes(text: string, at: Vec, size: number, rotation = 0, mirror = false): Vec[][] {
  const scale = size / 6;
  const lines = text.split('\n');
  const block = textSize(text, size);
  const strokes: Vec[][] = [];
  const r = (rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  lines.forEach((line, row) => {
    const chars = [...line];
    let cursor = -lineWidth(chars) / 2;
    for (const ch of chars) {
      const g = glyph(ch);
      for (const stroke of g.strokes) {
        strokes.push(
          stroke.map(([gx, gy]) => {
            let x = (cursor + gx - g.left) * scale;
            const y = (row * LINE + gy) * scale - block.height / 2;
            if (mirror) x = -x;
            return [at[0] + x * cos + y * sin, at[1] - x * sin + y * cos] as Vec;
          }),
        );
      }
      cursor += g.width + GAP;
    }
  });
  return strokes;
}
