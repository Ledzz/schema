import { useEditor } from '../../store/editor';
import type { Vec } from '../schematic/types';
import { buildBoard } from './board';
import { emptyPcb } from './types';

const st = () => useEditor.getState();

/** Fits the board (or the given part / track / via ids) into the PCB view. */
export function fitPcbView(size = st().pcbCanvasSize, ids?: string[]) {
  const { project } = st();
  const pcb = project.pcb ?? emptyPcb();
  let b = { x1: pcb.board.x, y1: pcb.board.y, x2: pcb.board.x + pcb.board.width, y2: pcb.board.y + pcb.board.height };
  const board = buildBoard(project, pcb);
  const boxes = [
    ...board.parts.filter((p) => !ids || ids.includes(p.component.id)).map((p) => p.box),
    ...pcb.tracks.filter((t) => !ids || ids.includes(t.id)).map((t) => ({
      x1: Math.min(...t.points.map((p) => p[0])),
      y1: Math.min(...t.points.map((p) => p[1])),
      x2: Math.max(...t.points.map((p) => p[0])),
      y2: Math.max(...t.points.map((p) => p[1])),
    })),
  ];
  if (ids?.length && boxes.length) b = boxes[0];
  for (const x of boxes) b = { x1: Math.min(b.x1, x.x1), y1: Math.min(b.y1, x.y1), x2: Math.max(b.x2, x.x2), y2: Math.max(b.y2, x.y2) };
  const margin = 40;
  const w = Math.max(b.x2 - b.x1, 2);
  const h = Math.max(b.y2 - b.y1, 2);
  const zoom = Math.min(80, Math.max(1, Math.min((size.width - margin * 2) / w, (size.height - margin * 2) / h)));
  st().setPcbView({ zoom, x: size.width / 2 - ((b.x1 + b.x2) / 2) * zoom, y: size.height / 2 - ((b.y1 + b.y2) / 2) * zoom });
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
