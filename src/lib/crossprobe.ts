/*
 * Cross-probing between the schematic and the PCB. The store keeps the two editors' part
 * selections and highlighted net in step; this module shows them in the other editor (Shift+X)
 * and, with the editors side by side, keeps what one selects in view in the other.
 */
import { partsIn, useEditor } from '../store/editor';
import { connectivity } from './actions';
import { fitView, revealItems } from './editing';
import { enterPcb } from './pcb/actions';
import { framePcb, revealOnPcb } from './pcb/view';

const st = () => useEditor.getState();

/** The parts on a net. */
export function partsOnNet(net: string): string[] {
  const found = connectivity(st().project).nets.find((n) => n.name === net);
  return found ? [...new Set(found.members.map((m) => m.componentId))] : [];
}

/** What to show in the other editor: the selected parts, or else the parts on the highlighted net. */
export function probeTarget(): { ids: string[]; net: string | null } {
  const s = st();
  const ids = partsIn(s.mode === 'pcb' ? s.pcbSelection : s.selection, s.project);
  if (ids.length) return { ids, net: null };
  const net = s.mode === 'pcb' ? s.pcbHighlightNet : s.highlightNet;
  return { ids: net ? partsOnNet(net) : [], net };
}

/** Shows parts in the schematic: switches to it and zooms to them (on their sheet). */
export async function showInSchematic(ids: string[]) {
  // A canvas about to appear frames them itself once it knows its size.
  if (st().mode !== 'schematic' && !st().split) {
    st().setPendingFrame({ editor: 'schematic', ids });
    st().setMode('schematic');
    return;
  }
  st().setMode('schematic');
  fitView(ids);
}

/** Shows parts on the PCB: switches to it (bringing it up to date) and zooms to them with some board around. */
export async function showOnPcb(ids: string[]) {
  const appears = (st().mode !== 'pcb' && !st().split) || st().pcb3d;
  if (appears) st().setPendingFrame({ editor: 'pcb', ids });
  st().setPcb3d(false);
  await enterPcb();
  if (!appears) framePcb(ids);
}

/** Shows the selection, or the highlighted net, in the other editor. */
export async function crossProbe() {
  const { ids, net } = probeTarget();
  if (!ids.length) {
    st().notify(net ? `No parts on ${net}` : 'Select a part or highlight a net to find it in the other editor', 'error');
    return;
  }
  if (st().mode === 'pcb') await showInSchematic(ids);
  else await showOnPcb(ids);
}

/**
 * With the editors side by side, keeps the parts selected in the active one in view in the other:
 * it pans (or changes sheet) only when they are out of view.
 */
export function followSelection() {
  return useEditor.subscribe((s, prev) => {
    if (!s.split || (s.selection === prev.selection && s.pcbSelection === prev.pcbSelection)) return;
    const ids = partsIn(s.mode === 'pcb' ? s.pcbSelection : s.selection, s.project);
    if (!ids.length) return;
    if (s.mode === 'pcb') revealItems(ids);
    else revealOnPcb(ids);
  });
}
