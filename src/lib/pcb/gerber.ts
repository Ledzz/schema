/*
 * Fabrication outputs: Gerber RS-274X (X2 attributes), Excellon drill and JLCPCB pick-and-place.
 * Gerber coordinates are mm with y up and the board's bottom-left corner at the origin.
 */
import type { Vec } from '../schematic/types';
import type { BoardModel } from './board';
import { boardOutline, padOutline, rotateDeg, type WorldPad } from './geometry';
import { textStrokes } from './font';
import type { Board, CopperLayer, Pcb } from './types';

export interface FabFile {
  name: string;
  content: string;
}

const fmt = (v: number) => String(Math.round(v * 1e6));

class Gerber {
  private apertures = new Map<string, number>();
  private body: string[] = [];
  private current = -1;

  constructor(
    private readonly fileFunction: string,
    private readonly polarity: 'Positive' | 'Negative',
    private readonly board: Board,
  ) {}

  private xy([x, y]: Vec) {
    return `X${fmt(x - this.board.x)}Y${fmt(this.board.y + this.board.height - y)}`;
  }

  private use(def: string) {
    let d = this.apertures.get(def);
    if (d === undefined) {
      d = 10 + this.apertures.size;
      this.apertures.set(def, d);
    }
    if (this.current !== d) {
      this.body.push(`D${d}*`);
      this.current = d;
    }
  }

  circle(dia: number, at: Vec) {
    this.use(`C,${dia.toFixed(6)}`);
    this.body.push(`${this.xy(at)}D03*`);
  }

  flash(def: string, at: Vec) {
    this.use(def);
    this.body.push(`${this.xy(at)}D03*`);
  }

  stroke(width: number, points: Vec[]) {
    if (points.length < 2) return;
    this.use(`C,${Math.max(width, 0.01).toFixed(6)}`);
    this.body.push(`${this.xy(points[0])}D02*`);
    for (const p of points.slice(1)) this.body.push(`${this.xy(p)}D01*`);
  }

  /** Switches between dark (adds copper) and clear (removes) polarity. */
  setPolarity(dark: boolean) {
    this.body.push(dark ? '%LPD*%' : '%LPC*%');
  }

  region(points: Vec[]) {
    if (points.length < 3) return;
    this.body.push('G36*', `${this.xy(points[0])}D02*`);
    for (const p of points.slice(1)) this.body.push(`${this.xy(p)}D01*`);
    this.body.push(`${this.xy(points[0])}D01*`, 'G37*');
  }

  toString() {
    const head = [
      '%TF.GenerationSoftware,Schematics,web,0.1*%',
      `%TF.FileFunction,${this.fileFunction}*%`,
      `%TF.FilePolarity,${this.polarity}*%`,
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%LPD*%',
      'G01*',
      ...[...this.apertures].map(([def, d]) => `%ADD${d}${def}*%`),
    ];
    return [...head, ...this.body, 'M02*', ''].join('\n');
  }
}

/** Flashes a pad (standard aperture when axis-aligned, region otherwise). */
function emitPad(g: Gerber, pad: WorldPad, grow: number, pcbPlacement: Parameters<typeof padOutline>[0]) {
  const p = pad.pad;
  const rot = ((pad.rotation % 180) + 180) % 180;
  const axisAligned = rot === 0 || rot === 90;
  const swap = rot === 90;
  const w = (swap ? p.h : p.w) + grow * 2;
  const h = (swap ? p.w : p.h) + grow * 2;
  if (p.shape === 'circle') return g.flash(`C,${w.toFixed(6)}`, pad.center);
  if (axisAligned && p.shape === 'rect' && p.radius === 0) return g.flash(`R,${w.toFixed(6)}X${h.toFixed(6)}`, pad.center);
  if (axisAligned && p.shape === 'oval') return g.flash(`O,${w.toFixed(6)}X${h.toFixed(6)}`, pad.center);
  g.region(padOutline(pcbPlacement, p, grow));
}


/** Designator position: above the part's bounding box. */
export function designatorAnchor(box: { x1: number; y1: number; x2: number; y2: number }): Vec {
  return [(box.x1 + box.x2) / 2, box.y1 - 0.8];
}

export function generateGerbers(pcb: Pcb, board: BoardModel, baseName: string): FabFile[] {
  const b = pcb.board;
  const layers: Record<string, Gerber> = {
    'F_Cu.gtl': new Gerber('Copper,L1,Top', 'Positive', b),
    'B_Cu.gbl': new Gerber('Copper,L2,Bot', 'Positive', b),
    'F_Mask.gts': new Gerber('Soldermask,Top', 'Negative', b),
    'B_Mask.gbs': new Gerber('Soldermask,Bot', 'Negative', b),
    'F_Paste.gtp': new Gerber('Paste,Top', 'Positive', b),
    'B_Paste.gbp': new Gerber('Paste,Bot', 'Positive', b),
    'F_Silkscreen.gto': new Gerber('Legend,Top', 'Positive', b),
    'B_Silkscreen.gbo': new Gerber('Legend,Bot', 'Positive', b),
    'Edge_Cuts.gm1': new Gerber('Profile,NP', 'Positive', b),
  };
  const copper = (l: CopperLayer) => layers[l === 'top' ? 'F_Cu.gtl' : 'B_Cu.gbl'];
  const mask = (l: CopperLayer) => layers[l === 'top' ? 'F_Mask.gts' : 'B_Mask.gbs'];
  const paste = (l: CopperLayer) => layers[l === 'top' ? 'F_Paste.gtp' : 'B_Paste.gbp'];

  // Pours first: each area dark, its holes cleared, so pads and tracks drawn later stay intact.
  for (const f of board.fills) {
    const g = copper(f.pour.layer);
    for (const area of f.areas) {
      g.region(area.outer);
      if (area.holes.length) {
        g.setPolarity(false);
        for (const h of area.holes) g.region(h);
        g.setPolarity(true);
      }
    }
  }

  for (const part of board.parts) {
    for (const pad of part.pads) {
      for (const l of pad.layers) {
        emitPad(copper(l), pad, 0, part.placement);
        emitPad(mask(l), pad, pcb.rules.maskExpansion, part.placement);
        if (pad.pad.layer !== 'through') emitPad(paste(l), pad, 0, part.placement);
      }
    }
    for (const gfx of part.graphics) {
      if (gfx.layer === 'outline') continue;
      const silk = layers[gfx.layer === 'silkTop' ? 'F_Silkscreen.gto' : 'B_Silkscreen.gbo'];
      if (gfx.filled) silk.region(gfx.points);
      else silk.stroke(gfx.width, gfx.points);
    }
    if (part.fp) {
      const bottom = part.placement.side === 'bottom';
      const silk = layers[bottom ? 'B_Silkscreen.gbo' : 'F_Silkscreen.gto'];
      for (const s of textStrokes(part.component.designator, designatorAnchor(part.box), 0.8, 0, bottom)) silk.stroke(0.12, s);
    }
  }
  for (const t of pcb.tracks) copper(t.layer).stroke(t.width, t.points);
  for (const v of pcb.vias) {
    copper('top').circle(v.diameter, [v.x, v.y]);
    copper('bottom').circle(v.diameter, [v.x, v.y]);
  }
  layers['Edge_Cuts.gm1'].stroke(0.1, boardOutline(b));

  return [
    ...Object.entries(layers).map(([suffix, g]) => ({ name: `${baseName}-${suffix}`, content: g.toString() })),
    { name: `${baseName}.drl`, content: generateDrill(pcb, board) },
  ];
}

export function generateDrill(pcb: Pcb, board: BoardModel): string {
  const b = pcb.board;
  const xy = ([x, y]: Vec) => `X${(x - b.x).toFixed(3)}Y${(b.y + b.height - y).toFixed(3)}`;
  const holes: { dia: number; at: Vec; to?: Vec }[] = [];
  for (const v of pcb.vias) holes.push({ dia: v.drill, at: [v.x, v.y] });
  for (const pad of board.pads) {
    const h = pad.hole;
    if (!h) continue;
    const dia = Math.min(h.w, h.h);
    if (Math.abs(h.w - h.h) < 1e-6) holes.push({ dia, at: h.center });
    else {
      const half = (Math.max(h.w, h.h) - dia) / 2;
      const axis = rotateDeg(h.w >= h.h ? [half, 0] : [0, half], h.rotation);
      holes.push({ dia, at: [h.center[0] - axis[0], h.center[1] - axis[1]], to: [h.center[0] + axis[0], h.center[1] + axis[1]] });
    }
  }
  const tools = [...new Set(holes.map((h) => h.dia.toFixed(3)))].sort((a, c) => Number(a) - Number(c));
  const lines = ['M48', '; DRILL file {Schematics} plated holes', 'FMAT,2', 'METRIC,TZ'];
  tools.forEach((d, i) => lines.push(`T${i + 1}C${d}`));
  lines.push('%', 'G90', 'G05');
  tools.forEach((d, i) => {
    lines.push(`T${i + 1}`);
    for (const h of holes.filter((x) => x.dia.toFixed(3) === d)) lines.push(h.to ? `${xy(h.at)}G85${xy(h.to)}` : xy(h.at));
  });
  lines.push('T0', 'M30', '');
  return lines.join('\n');
}

/** Pick-and-place file in JLCPCB's CPL layout. */
/** Pick-and-place file; parts whose component id is in `skip` are left out (hand-soldered). */
export function generateCpl(pcb: Pcb, board: BoardModel, skip: ReadonlySet<string> = new Set()): string {
  const b = pcb.board;
  const rows = [['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']];
  for (const part of board.parts) {
    if (!part.fp || part.component.attrs['Add into BOM'] === 'no' || skip.has(part.component.id)) continue;
    const { x, y, rotation, side } = part.placement;
    const rot = ((Math.round(rotation) % 360) + 360) % 360;
    rows.push([part.component.designator, `${(x - b.x).toFixed(3)}mm`, `${(b.y + b.height - y).toFixed(3)}mm`, side === 'top' ? 'Top' : 'Bottom', String(rot)]);
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
