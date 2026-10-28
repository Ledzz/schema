/*
 * The page's way to route, check and draw the board: the work runs in the PCB worker (see
 * offload.ts) and the result comes back into the store, so the editor keeps responding while a
 * dense board routes for tens of seconds. The command line and tests use the synchronous
 * functions in actions.ts directly.
 */
import { useEditor } from '../../store/editor';
import type { AutorouteReport } from './actions';
import type { DrcIssue } from './drc';
import { offload } from './offload';
import type { Picture, PictureInput } from './picture';
import { emptyPcb } from './types';

const st = () => useEditor.getState();

/** Routes the board in the worker and commits the result as one undo step. */
export async function autorouteAsync(net?: string, width?: number): Promise<AutorouteReport> {
  const snapshot = st().project;
  const { pcb, report } = await offload('autoroute', snapshot, net, width);
  if (pcb) {
    // Edits made while the router ran keep their placement; the new tracks and vias go on top.
    st().commit((doc) => (doc.pcb === snapshot.pcb ? { ...doc, pcb } : { ...doc, pcb: { ...(doc.pcb ?? emptyPcb()), tracks: pcb.tracks, vias: pcb.vias } }));
  }
  return report;
}

/** Runs the design rule check in the worker and shows the issues in the DRC panel. */
export async function checkBoardAsync(): Promise<DrcIssue[]> {
  const issues = await offload('check', st().project);
  st().setPcbIssues(issues);
  return issues;
}

/** Draws the board picture in the worker. */
export const renderPictureAsync = (input: PictureInput): Promise<Picture> => offload('render', st().project, input);
