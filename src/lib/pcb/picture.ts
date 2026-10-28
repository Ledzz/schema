/*
 * The board picture pcb_render draws, as a pure function of the project, so the worker can draw
 * it as well as the page and the command line.
 */
import type { Project } from '../schematic/types';
import { boardModel } from './actions';
import { runDrc } from './drc';
import { renderPcbSvg } from './render';

export interface PictureInput {
  layers?: 'both' | 'top' | 'inner1' | 'inner2' | 'bottom';
  highlight_net?: string;
  width_px?: number;
}

export type Picture = ReturnType<typeof renderPcbSvg>;

/** Renders the project's board with DRC markers; refuses an empty board or an unknown net. */
export function pcbPictureOf(project: Project, input: PictureInput): Picture {
  const { pcb, board, conn } = boardModel(project);
  if (!pcb.placements.length) throw new Error('The PCB is empty; run pcb_update first');
  const net = input.highlight_net === undefined ? null : String(input.highlight_net);
  if (net && !board.pads.some((p) => p.net === net)) throw new Error(`No pad is on net "${net}"`);
  return renderPcbSvg(pcb, board, conn, runDrc(board, pcb, conn), {
    layers: (input.layers as 'both' | 'top' | 'bottom' | undefined) ?? 'both',
    highlightNet: net,
    widthPx: input.width_px === undefined ? undefined : Number(input.width_px),
  });
}
