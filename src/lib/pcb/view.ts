import { useEditor } from '../../store/editor';
import type { Vec } from '../schematic/types';
import { buildBoard } from './board';
import { emptyPcb } from './types';

const st = () => useEditor.getState();

/** Bounds of the given parts and tracks (a designator label counts as its part), or of the board. */
function pcbBounds(ids?: string[]) {
  const { project } = st();
  const pcb = project.pcb ?? emptyPcb();
  const want = ids && new Set(ids.map((id) => (id.startsWith('label:') ? id.slice(6) : id)));
  const board = buildBoard(project, pcb);
  const boxes = [
    ...board.parts.filter((p) => !want || want.has(p.component.id)).map((p) => p.box),
    ...pcb.tracks.filter((t) => !want || want.has(t.id)).map((t) => ({
      x1: Math.min(...t.points.map((p) => p[0])),
      y1: Math.min(...t.points.map((p) => p[1])),
      x2: Math.max(...t.points.map((p) => p[0])),
      y2: Math.max(...t.points.map((p) => p[1])),
    })),
  ];
  if (want && !boxes.length) return null;
  let b = want ? boxes[0] : { x1: pcb.board.x, y1: pcb.board.y, x2: pcb.board.x + pcb.board.width, y2: pcb.board.y + pcb.board.height };
  for (const x of boxes) b = { x1: Math.min(b.x1, x.x1), y1: Math.min(b.y1, x.y1), x2: Math.max(b.x2, x.x2), y2: Math.max(b.y2, x.y2) };
  return b;
}

/**
 * Fits the board (or the given part / track ids) into the PCB view; `minSize` (mm) keeps some of
 * the board around a single small part.
 */
export function fitPcbView(size = st().pcbCanvasSize, ids?: string[], minSize = 2) {
  const b = pcbBounds(ids?.length ? ids : undefined);
  if (!b) return;
  const margin = 40;
  const w = Math.max(b.x2 - b.x1, minSize);
  const h = Math.max(b.y2 - b.y1, minSize);
  const zoom = Math.min(80, Math.max(1, Math.min((size.width - margin * 2) / w, (size.height - margin * 2) / h)));
  st().setPcbView({ zoom, x: size.width / 2 - ((b.x1 + b.x2) / 2) * zoom, y: size.height / 2 - ((b.y1 + b.y2) / 2) * zoom });
}

/** Zooms to parts with some of the board around them, so a single small part keeps its context. */
export function framePcb(ids: string[], size = st().pcbCanvasSize) {
  const board = (st().project.pcb ?? emptyPcb()).board;
  fitPcbView(size, ids, Math.max(15, Math.max(board.width, board.height) / 3));
}

/** Brings parts or tracks into the PCB view at the current zoom, or fits them when they don't fit. */
export function revealOnPcb(ids: string[]) {
  const b = pcbBounds(ids);
  const { pcbView: v, pcbCanvasSize: size } = st();
  if (!b || !size.width) return;
  const seen = { x1: -v.x / v.zoom, y1: -v.y / v.zoom, x2: (size.width - v.x) / v.zoom, y2: (size.height - v.y) / v.zoom };
  if (b.x1 >= seen.x1 && b.x2 <= seen.x2 && b.y1 >= seen.y1 && b.y2 <= seen.y2) return;
  if (b.x2 - b.x1 > (seen.x2 - seen.x1) * 0.9 || b.y2 - b.y1 > (seen.y2 - seen.y1) * 0.9) return fitPcbView(size, ids);
  st().setPcbView({ zoom: v.zoom, x: size.width / 2 - ((b.x1 + b.x2) / 2) * v.zoom, y: size.height / 2 - ((b.y1 + b.y2) / 2) * v.zoom });
}

export function zoomPcbBy(factor: number, at?: Vec) {
  const { pcbView: v, pcbCanvasSize: size } = st();
  const [sx, sy] = at ?? [size.width / 2, size.height / 2];
  const zoom = Math.min(200, Math.max(0.5, v.zoom * factor));
  const k = zoom / v.zoom;
  st().setPcbView({ zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k });
}

export function zoomPcbTo(at: Vec) {
  const { pcbView: v, pcbCanvasSize: size } = st();
  const zoom = Math.max(v.zoom, 25);
  st().setPcbView({ zoom, x: size.width / 2 - at[0] * zoom, y: size.height / 2 - at[1] * zoom });
}
