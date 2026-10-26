/*
 * Logo import: an image becomes filled silkscreen shapes. Dark, opaque pixels (or light ones with
 * `invert`) are traced along their pixel edges into outlines and holes, then scaled to a unit frame
 * (centred, 1 wide) that SilkLogo stores. Rasterising the image is up to the caller: a canvas in
 * the browser, resvg on the command line.
 */
import type { Vec } from '../schematic/types';
import { pointInPolygon } from './geometry';
import type { SilkLogo } from './types';

/** RGBA pixels, row by row. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface TraceOptions {
  /** Luminance (0–255) below which a pixel is ink; default 128. */
  threshold?: number;
  /** Trace light pixels instead (for light artwork on a dark background). */
  invert?: boolean;
}

/** Longest side, in pixels, images are rasterised to before tracing. */
export const TRACE_RESOLUTION = 400;

/**
 * Traced shapes in the unit frame and the artwork's height/width ratio (cropped to the ink).
 *
 * Every ink pixel side that borders background becomes an edge, directed clockwise around the
 * pixel (y down), so ink is always on the right. Following edges end to end gives closed loops:
 * outlines run clockwise (positive area), holes anticlockwise. Where two ink pixels touch only at
 * a corner the walk turns right, which keeps them apart, so every loop is simple.
 */
export function traceBitmap(bmp: Bitmap, opt: TraceOptions = {}): { shapes: SilkLogo['shapes']; aspect: number } {
  const { width: W, height: H, data } = bmp;
  const threshold = opt.threshold ?? 128;
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * 4;
    if (data[i + 3] < 128) return false;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return opt.invert ? lum >= threshold : lum < threshold;
  };

  // Edges as start/end grid corners; corners are indexed y * (W + 1) + x.
  const key = (x: number, y: number) => y * (W + 1) + x;
  const from: number[] = [];
  const to: number[] = [];
  const outgoing = new Map<number, number[]>();
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const id = from.length;
    from.push(key(ax, ay));
    to.push(key(bx, by));
    const list = outgoing.get(key(ax, ay));
    if (list) list.push(id);
    else outgoing.set(key(ax, ay), [id]);
  };
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!ink(x, y)) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
      if (!ink(x, y - 1)) edge(x, y, x + 1, y);
      if (!ink(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
      if (!ink(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
      if (!ink(x - 1, y)) edge(x, y + 1, x, y);
    }
  if (!from.length) throw new Error(opt.invert ? 'The image has no light pixels to trace' : 'The image has no dark pixels to trace; try invert for light artwork');

  const at = (k: number): Vec => [k % (W + 1), Math.floor(k / (W + 1))];
  const dir = (id: number): Vec => {
    const [a, b] = [at(from[id]), at(to[id])];
    return [b[0] - a[0], b[1] - a[1]];
  };
  const used = new Uint8Array(from.length);
  const loops: Vec[][] = [];
  // Start loops away from diagonal corners so the turn-right rule decides every branch.
  const starts = [...from.keys()].sort((a, b) => outgoing.get(from[a])!.length - outgoing.get(from[b])!.length);
  for (const first of starts) {
    if (used[first]) continue;
    const loop: Vec[] = [];
    let id = first;
    while (!used[id]) {
      used[id] = 1;
      loop.push(at(from[id]));
      const next = outgoing.get(to[id])!;
      if (next.length === 1) id = next[0];
      else {
        // A corner shared by two diagonal ink pixels: turn right, staying with this pixel.
        const [dx, dy] = dir(id);
        id = next.find((n) => dir(n)[0] === -dy && dir(n)[1] === dx) ?? next.find((n) => !used[n]) ?? next[0];
      }
    }
    loops.push(dropCollinear(loop));
  }

  const area = (poly: Vec[]) => poly.reduce((sum, p, i) => sum + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0) / 2;
  const outlines = loops.filter((l) => area(l) > 0).map((l) => ({ loop: l, area: area(l), holes: [] as Vec[][] }));
  for (const hole of loops.filter((l) => area(l) < 0)) {
    // A point inside the hole: the background pixel left of its first edge.
    const [a, b] = [hole[0], hole[1]];
    const [dx, dy] = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
    const inside: Vec = [a[0] + dx * 0.5 + dy * 0.5, a[1] + dy * 0.5 - dx * 0.5];
    const owner = outlines.filter((o) => pointInPolygon(inside, o.loop)).sort((p, q) => p.area - q.area)[0];
    owner?.holes.push(hole);
  }

  // Unit frame: the ink's bounding box centred on 0 and scaled to width 1.
  const w = x1 - x0;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const unit = (poly: Vec[]): Vec[] => poly.map(([x, y]) => [round((x - cx) / w), round((y - cy) / w)] as Vec);
  return { shapes: outlines.map((o) => ({ outer: unit(o.loop), holes: o.holes.map(unit) })), aspect: (y1 - y0) / w };
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;

/** Pixel loops have a corner at every pixel step; keep only the real corners. */
function dropCollinear(loop: Vec[]): Vec[] {
  const n = loop.length;
  return loop.filter((q, i) => {
    const a = loop[(i + n - 1) % n];
    const b = loop[(i + 1) % n];
    return (q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0]) !== 0;
  });
}

/** SVG markup or a URL as something an <img> can load. */
export const imageSource = (image: string) => (image.trimStart().startsWith('<') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image)}` : image);

/** Browser only: loads an image (URL, data: URL or SVG markup) and rasterises it for tracing. */
export async function rasterizeInBrowser(image: string, maxSide = TRACE_RESOLUTION): Promise<Bitmap> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not load the image (is it a PNG, JPEG or SVG the browser can open?)'));
    img.src = imageSource(image);
  });
  const w0 = img.naturalWidth || 512;
  const h0 = img.naturalHeight || 512;
  const k = maxSide / Math.max(w0, h0);
  const width = Math.max(1, Math.round(w0 * k));
  const height = Math.max(1, Math.round(h0 * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}
