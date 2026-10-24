/*
 * Parser for EasyEDA Pro footprint documents (preview only).
 *
 *   ["PAD","e7",0,"",1,"2",29.66,0,0,null,["RECT",31.75,34.0,0],...]   id, locked, net, layer, number, x, y, rot, hole, shape
 *   ["POLY","e9",0,"",3,6,[16.7,-26,"L",54.5,-26],0]                   id, locked, net, layer, width, path
 *   ["FILL","e1",0,"",49,0.2,0,[["CIRCLE",-433,-433,2.3]],0]            id, locked, net, layer, width, style, paths
 * Paths are [x, y, "L", x, y, …, "ARC", sweepDeg, x, y, …] or ["CIRCLE", cx, cy, r] / ["R", x, y, w, h, …].
 * Units are mil, y-up; output is y-down.
 */

import type { Box } from './symbol';

export type FootprintLayer = 'copper' | 'silk' | 'outline';

export interface FootprintPad {
  number: string;
  x: number;
  y: number;
  rotation: number;
  shape: 'rect' | 'oval' | 'ellipse' | 'polygon';
  w: number;
  h: number;
  radius: number;
  points: number[];
  hole: { w: number; h: number } | null;
  throughHole: boolean;
}

export interface FootprintShape {
  layer: FootprintLayer;
  d: string;
  width: number;
  fill: boolean;
}

export interface FootprintDef {
  pads: FootprintPad[];
  shapes: FootprintShape[];
  bbox: Box;
}

const LAYERS: Record<number, FootprintLayer> = {
  1: 'copper',
  12: 'copper',
  3: 'silk',
  13: 'outline',
  48: 'outline',
  49: 'outline',
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function pathToSvg(path: unknown[], box: Box): string {
  const grow = (x: number, y: number) => {
    box.x1 = Math.min(box.x1, x);
    box.y1 = Math.min(box.y1, y);
    box.x2 = Math.max(box.x2, x);
    box.y2 = Math.max(box.y2, y);
  };
  if (path[0] === 'CIRCLE') {
    const [cx, cy, r] = [num(path[1]), -num(path[2]), num(path[3])];
    grow(cx - r, cy - r);
    grow(cx + r, cy + r);
    return `M${r3(cx - r)} ${r3(cy)}a${r} ${r} 0 1 0 ${r3(2 * r)} 0a${r} ${r} 0 1 0 ${r3(-2 * r)} 0Z`;
  }
  if (path[0] === 'R') {
    const [x, y, w, h] = [num(path[1]), -num(path[2]), num(path[3]), num(path[4])];
    grow(x, y);
    grow(x + w, y + h);
    return `M${x} ${y}h${w}v${h}h${-w}Z`;
  }
  let i = 2;
  let cx = num(path[0]);
  let cy = -num(path[1]);
  grow(cx, cy);
  let d = `M${r3(cx)} ${r3(cy)}`;
  let mode = 'L';
  while (i < path.length) {
    const tok = path[i];
    if (typeof tok === 'string') {
      mode = tok;
      i++;
      continue;
    }
    if (mode === 'ARC' || mode === 'CARC') {
      const angle = num(path[i]);
      const x = num(path[i + 1]);
      const y = -num(path[i + 2]);
      i += 3;
      const chord = Math.hypot(x - cx, y - cy);
      const sin = Math.sin((Math.abs(angle) * Math.PI) / 360);
      const r = sin > 1e-6 ? chord / (2 * sin) : chord;
      d += `A${r3(r)} ${r3(r)} 0 ${Math.abs(angle) > 180 ? 1 : 0} ${angle > 0 ? 0 : 1} ${r3(x)} ${r3(y)}`;
      cx = x;
      cy = y;
    } else {
      cx = num(path[i]);
      cy = -num(path[i + 1]);
      i += 2;
      d += `L${r3(cx)} ${r3(cy)}`;
    }
    grow(cx, cy);
  }
  return d;
}

export function parseFootprint(dataStr: string): FootprintDef {
  const pads: FootprintPad[] = [];
  const shapes: FootprintShape[] = [];
  const bbox: Box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };

  for (const line of dataStr.split(/\r?\n/)) {
    if (!line.startsWith('[')) continue;
    let rec: unknown[];
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(rec)) continue;
    if (rec[0] === 'PAD') {
      const layer = num(rec[4]);
      if (layer !== 1 && layer !== 12) continue;
      const shape = Array.isArray(rec[10]) ? (rec[10] as unknown[]) : ['RECT', 10, 10, 0];
      const hole = Array.isArray(rec[9]) ? (rec[9] as unknown[]) : null;
      const kind = String(shape[0]).toUpperCase();
      const pad: FootprintPad = {
        number: String(rec[5] ?? ''),
        x: num(rec[6]),
        y: -num(rec[7]),
        rotation: num(rec[8]),
        shape: kind === 'OVAL' ? 'oval' : kind === 'ELLIPSE' ? 'ellipse' : kind === 'POLYGON' ? 'polygon' : 'rect',
        w: num(shape[1]),
        h: num(shape[2]),
        radius: kind === 'RECT' ? num(shape[3]) : 0,
        points: kind === 'POLYGON' && Array.isArray(shape[1]) ? (shape[1] as unknown[]).filter((v) => typeof v === 'number').map((v, k) => (k % 2 ? -(v as number) : (v as number))) : [],
        hole: hole ? { w: num(hole[1]), h: num(hole[2] ?? hole[1]) } : null,
        throughHole: layer === 12,
      };
      if (pad.shape === 'polygon' && pad.points.length >= 6) {
        const xs = pad.points.filter((_, k) => k % 2 === 0);
        const ys = pad.points.filter((_, k) => k % 2 === 1);
        pad.w = Math.max(...xs) - Math.min(...xs);
        pad.h = Math.max(...ys) - Math.min(...ys);
      }
      const half = Math.max(pad.w, pad.h) / 2;
      bbox.x1 = Math.min(bbox.x1, pad.x - half);
      bbox.y1 = Math.min(bbox.y1, pad.y - half);
      bbox.x2 = Math.max(bbox.x2, pad.x + half);
      bbox.y2 = Math.max(bbox.y2, pad.y + half);
      pads.push(pad);
    } else if (rec[0] === 'POLY' || rec[0] === 'FILL') {
      const layer = LAYERS[num(rec[4])];
      if (!layer) continue;
      const fill = rec[0] === 'FILL';
      const paths: unknown[][] = fill
        ? (Array.isArray(rec[7]) ? (rec[7] as unknown[][]) : [])
        : Array.isArray(rec[6])
          ? [rec[6] as unknown[]]
          : [];
      for (const p of paths) {
        if (!Array.isArray(p) || p.length < 3) continue;
        shapes.push({ layer, d: pathToSvg(p, bbox), width: num(rec[5]) || 5, fill });
      }
    }
  }
  if (!Number.isFinite(bbox.x1)) Object.assign(bbox, { x1: -50, y1: -50, x2: 50, y2: 50 });
  return { pads, shapes, bbox };
}
