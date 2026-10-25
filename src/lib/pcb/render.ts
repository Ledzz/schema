/*
 * Static SVG picture of the board, for agents and exports (the editor draws its own canvas).
 * Everything is in millimetres, text included (vector strokes), so the SVG needs no fonts and
 * rasterises the same everywhere. Rulers along the top and left edges give board coordinates.
 */
import type { Vec } from '../schematic/types';
import type { BoardModel, PcbConnectivity } from './board';
import type { DrcIssue } from './drc';
import { shellAreas } from './drc';
import { textStrokes } from './font';
import { boardOutline } from './geometry';
import { designatorAnchor } from './gerber';
import { areasToSvgPath } from './pour';
import type { CopperLayer, Pcb } from './types';

export interface RenderOptions {
  /** Copper layers to draw: both (top over bottom, the default), or one side alone. */
  layers?: 'both' | CopperLayer;
  /** Draw this net bright and fade everything else. */
  highlightNet?: string | null;
  /** Width of the picture in pixels (default 1400). */
  widthPx?: number;
}

const COLORS = {
  background: '#e7e9e4',
  board: '#14301f',
  edge: '#facc15',
  top: '#e5483d',
  bottom: '#3d7bf0',
  tht: '#c9a33f',
  hole: '#0b0d10',
  silkTop: '#f8e36b',
  silkBottom: '#9fd38a',
  ratsnest: '#f4f4f5',
  highlight: '#ffffff',
  shell: '#fb923c',
  ruler: '#52525b',
  error: '#ef4444',
  warning: '#f59e0b',
};

const MARGIN = 4;
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const pts = (points: Vec[]) => points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
const strokes = (lines: Vec[][], color: string, width: number) =>
  lines.map((l) => `<polyline points="${pts(l)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');

function hole(h: { center: Vec; w: number; h: number; rotation: number }): string {
  const d = Math.min(h.w, h.h);
  if (Math.abs(h.w - h.h) < 1e-6) return `<circle cx="${n(h.center[0])}" cy="${n(h.center[1])}" r="${n(d / 2)}" fill="${COLORS.hole}"/>`;
  const half = (Math.max(h.w, h.h) - d) / 2;
  const r = (h.rotation * Math.PI) / 180;
  const [ax, ay] = h.w >= h.h ? [half, 0] : [0, half];
  const dx = ax * Math.cos(r) + ay * Math.sin(r);
  const dy = -ax * Math.sin(r) + ay * Math.cos(r);
  return `<line x1="${n(h.center[0] - dx)}" y1="${n(h.center[1] - dy)}" x2="${n(h.center[0] + dx)}" y2="${n(h.center[1] + dy)}" stroke="${COLORS.hole}" stroke-width="${n(d)}" stroke-linecap="round"/>`;
}

/** Colours of a finished JLCPCB board: green mask, HASL pads, white silkscreen. */
const FINISH = {
  mask: '#14532d',
  copperUnderMask: '#1f7a3f',
  pad: '#cfd2d6',
  silk: '#f4f4f5',
};

/**
 * One face of the finished board as seen from above (the bottom face is not mirrored), sized to
 * the board outline, for texturing the 3D view. Vias are tented, so they show as copper under mask.
 */
export function renderBoardFace(pcb: Pcb, board: BoardModel, side: CopperLayer, widthPx = 2048): { svg: string; widthPx: number; heightPx: number } {
  const b = pcb.board;
  const out: string[] = [`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" fill="${FINISH.mask}"/>`];
  for (const f of board.fills.filter((f) => f.pour.layer === side)) out.push(`<path d="${areasToSvgPath(f.areas)}" fill-rule="evenodd" fill="${FINISH.copperUnderMask}"/>`);
  for (const t of pcb.tracks.filter((t) => t.layer === side)) {
    out.push(`<polyline points="${pts(t.points)}" fill="none" stroke="${FINISH.copperUnderMask}" stroke-width="${n(t.width)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const v of pcb.vias) out.push(`<circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.diameter / 2)}" fill="${FINISH.copperUnderMask}"/>`);
  for (const p of board.pads.filter((p) => p.layers.includes(side))) out.push(`<polygon points="${pts(p.outline)}" fill="${FINISH.pad}"/>`);
  for (const part of board.parts.filter((p) => p.placement.side === side)) {
    for (const gr of part.graphics) {
      if (gr.layer === 'outline') continue;
      out.push(
        gr.filled
          ? `<polygon points="${pts(gr.points)}" fill="${FINISH.silk}"/>`
          : `<polyline points="${pts(gr.points)}" fill="none" stroke="${FINISH.silk}" stroke-width="${n(gr.width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
    out.push(strokes(textStrokes(part.component.designator, designatorAnchor(part.box), 0.8, 0, side === 'bottom'), FINISH.silk, 0.12));
  }
  const heightPx = Math.round((widthPx * b.height) / b.width);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="${n(b.x)} ${n(b.y)} ${n(b.width)} ${n(b.height)}">${out.join('')}</svg>`;
  return { svg, widthPx, heightPx };
}

export function renderPcbSvg(
  pcb: Pcb,
  board: BoardModel,
  conn: PcbConnectivity,
  issues: DrcIssue[],
  opts: RenderOptions = {},
): { svg: string; widthPx: number; heightPx: number } {
  const b = pcb.board;
  const layers: CopperLayer[] = opts.layers === 'top' ? ['top'] : opts.layers === 'bottom' ? ['bottom'] : ['bottom', 'top'];
  const hi = opts.highlightNet ?? null;
  const netOf = (id: string, fallback: string | null) => conn.itemNet.get(id) ?? fallback;
  // With a highlighted net, everything else fades.
  const look = (net: string | null, color: string) => (!hi ? { color, opacity: 1 } : net === hi ? { color: COLORS.highlight, opacity: 1 } : { color, opacity: 0.3 });

  const x0 = b.x - MARGIN;
  const y0 = b.y - MARGIN;
  const w = b.width + MARGIN * 2;
  const h = b.height + MARGIN * 2;
  const widthPx = Math.round(opts.widthPx ?? 1400);
  const heightPx = Math.round((widthPx * h) / w);
  const out: string[] = [];
  out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}" fill="${COLORS.background}"/>`);

  // Rulers: a tick every millimetre, longer and labelled every 5 mm.
  const ticks: Vec[][] = [];
  const labels: Vec[][] = [];
  for (let x = Math.ceil(b.x); x <= b.x + b.width + 1e-9; x++) {
    const major = x % 5 === 0;
    ticks.push([[x, b.y - 0.4], [x, b.y - (major ? 1.4 : 0.9)]]);
    if (major) labels.push(...textStrokes(String(x), [x, b.y - 2.4], 1));
  }
  for (let y = Math.ceil(b.y); y <= b.y + b.height + 1e-9; y++) {
    const major = y % 5 === 0;
    ticks.push([[b.x - 0.4, y], [b.x - (major ? 1.4 : 0.9), y]]);
    if (major) labels.push(...textStrokes(String(y), [b.x - 2.6, y], 1));
  }
  out.push(strokes(ticks, COLORS.ruler, 0.08), strokes(labels, COLORS.ruler, 0.12));

  out.push(`<polygon points="${pts(boardOutline(b))}" fill="${COLORS.board}" stroke="${COLORS.edge}" stroke-width="0.1"/>`);

  for (const layer of layers) {
    const color = COLORS[layer];
    const g: string[] = [];
    for (const f of board.fills.filter((f) => f.pour.layer === layer)) {
      const s = look(f.pour.net, color);
      g.push(`<path d="${areasToSvgPath(f.areas)}" fill-rule="evenodd" fill="${s.color}" opacity="${0.35 * s.opacity}"/>`);
    }
    for (const t of pcb.tracks.filter((t) => t.layer === layer)) {
      const s = look(netOf(t.id, t.net), color);
      g.push(`<polyline points="${pts(t.points)}" fill="none" stroke="${s.color}" stroke-width="${n(t.width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${s.opacity}"/>`);
    }
    for (const p of board.pads.filter((p) => p.pad.layer !== 'through' && p.layers.includes(layer))) {
      const s = look(p.net, color);
      g.push(`<polygon points="${pts(p.outline)}" fill="${s.color}" opacity="${s.opacity}"/>`);
    }
    // The upper layer stays opaque; a lower one shows through less.
    out.push(`<g opacity="${layers.length > 1 && layer === layers[0] ? 0.7 : 0.95}">${g.join('')}</g>`);
  }

  for (const p of board.pads.filter((p) => p.pad.layer === 'through')) {
    const s = look(p.net, COLORS.tht);
    out.push(`<polygon points="${pts(p.outline)}" fill="${s.color}" opacity="${s.opacity}"/>`);
    if (p.hole) out.push(hole(p.hole));
  }
  for (const v of pcb.vias) {
    const s = look(netOf(v.id, v.net), COLORS.tht);
    out.push(`<circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.diameter / 2)}" fill="${s.color}" opacity="${s.opacity}"/>`);
    out.push(`<circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.drill / 2)}" fill="${COLORS.hole}"/>`);
  }

  // Silkscreen and designators of the visible sides; metal connector bodies dashed in orange.
  const shells = new Set(shellAreas(board).map((a) => a.part.component.id));
  for (const part of board.parts) {
    const side = part.placement.side;
    const silk = side === 'top' ? COLORS.silkTop : COLORS.silkBottom;
    const label = textStrokes(part.component.designator, designatorAnchor(part.box), 0.8, 0, side === 'bottom');
    if (!layers.includes(side)) {
      // Parts on the hidden side keep a faint label for orientation.
      out.push(`<g opacity="0.35">${strokes(label, silk, 0.12)}</g>`);
      continue;
    }
    for (const gr of part.graphics) {
      if (gr.layer === 'outline') {
        if (shells.has(part.component.id))
          out.push(`<polyline points="${pts(gr.points)}" fill="none" stroke="${COLORS.shell}" stroke-width="0.12" stroke-dasharray="0.4 0.25"/>`);
        continue;
      }
      out.push(
        gr.filled
          ? `<polygon points="${pts(gr.points)}" fill="${silk}"/>`
          : `<polyline points="${pts(gr.points)}" fill="none" stroke="${silk}" stroke-width="${n(gr.width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
    out.push(strokes(label, silk, 0.12));
  }

  for (const a of conn.airwires) {
    if (hi && a.net !== hi) continue;
    out.push(`<line x1="${n(a.a[0])}" y1="${n(a.a[1])}" x2="${n(a.b[0])}" y2="${n(a.b[1])}" stroke="${COLORS.ratsnest}" stroke-width="0.08" stroke-dasharray="0.3 0.2"/>`);
  }
  for (const i of issues) {
    if (!i.at) continue;
    out.push(`<circle cx="${n(i.at[0])}" cy="${n(i.at[1])}" r="0.8" fill="none" stroke="${i.severity === 'error' ? COLORS.error : COLORS.warning}" stroke-width="0.15"/>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">${out.join('')}</svg>`;
  return { svg, widthPx, heightPx };
}
