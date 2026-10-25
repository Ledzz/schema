/*
 * 3D part models without three.js: EasyEDA's OBJ variant (materials inline between `newmtl` and
 * `endmtl`, millimetres, Z up) parsed into flat triangle lists per material, and the rules that
 * place a model on its footprint.
 */
import { MIL } from './footprint';

export interface MeshPart {
  color: [number, number, number];
  opacity: number;
  /** Triangles as x, y, z triples. */
  positions: Float32Array;
}

export interface ParsedModel {
  parts: MeshPart[];
  min: [number, number, number];
  max: [number, number, number];
}

export function parseEasyedaObj(text: string): ParsedModel {
  const verts: number[][] = [];
  const materials = new Map<string, { color: [number, number, number]; opacity: number }>();
  const tris = new Map<string, number[]>();
  let current = '';
  let defining: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const [tag, ...rest] = line.split(/\s+/);
    if (tag === 'newmtl') {
      defining = rest.join(' ');
      materials.set(defining, { color: [0.6, 0.6, 0.6], opacity: 1 });
    } else if (tag === 'endmtl') {
      defining = null;
    } else if (defining && tag === 'Kd') {
      materials.get(defining)!.color = [Number(rest[0]), Number(rest[1]), Number(rest[2])];
    } else if (defining && tag === 'd') {
      // Library models disagree on this field: most write 0 for opaque (transparency, the reverse
      // of the MTL standard), some write 1. Only a fraction means see-through (an LED lens).
      const d = Number(rest[0]) || 0;
      materials.get(defining)!.opacity = d > 0 && d < 1 ? 1 - d : 1;
    } else if (tag === 'v') {
      verts.push([Number(rest[0]), Number(rest[1]), Number(rest[2])]);
    } else if (tag === 'usemtl') {
      current = rest.join(' ');
    } else if (tag === 'f') {
      const idx = rest.map((r) => {
        const n = parseInt(r.split('/')[0], 10);
        return n < 0 ? verts.length + n : n - 1;
      });
      const list = tris.get(current) ?? [];
      for (let i = 1; i + 1 < idx.length; i++) for (const k of [idx[0], idx[i], idx[i + 1]]) list.push(...(verts[k] ?? [0, 0, 0]));
      tris.set(current, list);
    }
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], v[k]);
    max[k] = Math.max(max[k], v[k]);
  }
  const parts = [...tris].map(([name, list]) => ({ ...(materials.get(name) ?? { color: [0.6, 0.6, 0.6] as [number, number, number], opacity: 1 }), positions: new Float32Array(list) }));
  return { parts, min, max };
}

/** How a model sits in its footprint's frame (millimetres, y up, Z up from the board surface). */
export interface ModelPlacement {
  /** Move the model so its box is centred in x/y with its bottom at z = 0 (before scaling). */
  center: [number, number, number];
  scale: [number, number, number];
  /** Radians, applied in X, Y, Z order after scaling. */
  rotation: [number, number, number];
  offset: [number, number, number];
}

/**
 * EasyEDA's "3D Model Transform" (sizes and offsets in mil): scale the model to the given size,
 * centre its box on the footprint origin with its bottom on the board, rotate, then offset.
 * The first rotation field turns the model about Z (the board normal): a SOT-89 model with its
 * leads at -x gets 180 to match a footprint with leads at +x. The two after it are taken as X
 * and Y; library models leave them at 0.
 */
export function modelPlacement(model: Pick<ParsedModel, 'min' | 'max'>, transform: number[]): ModelPlacement {
  const [sx, sy, sz, rz, rx, ry, ox, oy, oz] = transform;
  const size = [0, 1, 2].map((k) => model.max[k] - model.min[k]);
  const fit = (target: number, k: number) => (target > 0 && size[k] > 1e-9 ? (target * MIL) / size[k] : 0);
  const kx = fit(sx, 0) || 1;
  const ky = fit(sy, 1) || 1;
  const kz = fit(sz, 2) || (kx + ky) / 2;
  const rad = (d: number) => ((d || 0) * Math.PI) / 180;
  return {
    center: [-(model.min[0] + model.max[0]) / 2, -(model.min[1] + model.max[1]) / 2, -model.min[2]],
    scale: [kx, ky, kz],
    rotation: [rad(rx), rad(ry), rad(rz)],
    offset: [(ox || 0) * MIL, (oy || 0) * MIL, (oz || 0) * MIL],
  };
}

const CHIP_HEIGHT: Record<string, number> = { '0201': 0.3, '0402': 0.35, '0603': 0.45, '0805': 0.6, '1206': 0.65, '1210': 0.65 };

/** Height of the stand-in block drawn for parts without a model, guessed from the footprint name. */
export function fallbackHeight(footprintTitle: string): number {
  const chip = /(?:^|[^\d])(0201|0402|0603|0805|1206|1210)(?:[^\d]|$)/.exec(footprintTitle);
  if (chip) return CHIP_HEIGHT[chip[1]];
  const h = /[-_]H(\d+(?:\.\d+)?)(?=$|[-_])/i.exec(footprintTitle);
  if (h) {
    const value = Number(h[1]);
    // Titles write 6.2 mm as "H62" or "H6.2".
    return value > 20 && !h[1].includes('.') ? value / 10 : value;
  }
  return 1.5;
}
