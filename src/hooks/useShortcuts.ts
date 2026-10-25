import { useEffect } from 'react';
import { useEditor } from '../store/editor';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  finishWireDraft,
  fitView,
  mirrorSelection,
  paste,
  rotateSelection,
  saveProjectFile,
  selectAll,
  zoomBy,
} from '../lib/editing';
import { moveItems } from '../lib/schematic/ops';
import { resolverFor } from '../lib/schematic/symbols';
import { focusLibrarySearch } from '../lib/libraryFocus';
import { saveDesign } from '../lib/designs';
import { startPassive } from '../lib/passives';
import type { PassiveKind } from '../shared/passives';
import { deleteSelectedCopper, finishDraft, flipSelected, rotateSelected, viaInDraft } from '../lib/pcb/actions';
import { fitPcbView, zoomPcbBy } from '../lib/pcb/view';

const PASSIVE_KEYS: Record<string, PassiveKind> = { r: 'resistor', c: 'capacitor', l: 'inductor', f: 'ferrite', d: 'diode', e: 'led' };

/** PCB editor keys; returns true when handled. */
function pcbKey(key: string, e: KeyboardEvent): boolean {
  const s = useEditor.getState();
  const draft = s.routeDraft;
  // The 3D view only toggles back; editing keys would change the hidden 2D board.
  if (s.pcb3d) {
    if (key === '3' || key === 'escape') s.setPcb3d(false);
    return key === '3' || key === 'escape';
  }
  switch (key) {
    case '3':
      s.setPcb3d(true);
      return true;
    case 'escape':
      if (draft) finishDraft();
      else if (s.pcbTool !== 'select') s.setPcbTool('select');
      else {
        s.setPcbSelection([]);
        s.setPcbHighlightNet(null);
      }
      return true;
    case 'w':
      s.setPcbTool('route');
      return true;
    case 'v':
      if (draft) viaInDraft();
      else s.setPcbTool('via');
      return true;
    case '1':
    case '2': {
      const layer = key === '1' ? 'top' : 'bottom';
      if (draft) viaInDraft(layer);
      else s.setActiveLayer(layer);
      return true;
    }
    case 'r':
      rotateSelected(e.shiftKey ? -90 : 90);
      return true;
    case 'x':
      flipSelected();
      return true;
    case 'backspace':
      if (draft) {
        if (draft.points.length > 1) s.setRouteDraft({ ...draft, points: draft.points.slice(0, -1) });
        else s.setRouteDraft(null);
        return true;
      }
      deleteSelectedCopper();
      return true;
    case 'delete':
      deleteSelectedCopper();
      return true;
    case 'f':
      fitPcbView();
      return true;
    case '=':
    case '+':
      zoomPcbBy(1.25);
      return true;
    case '-':
      zoomPcbBy(0.8);
      return true;
    default:
      return false;
  }
}

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod) {
        const commands: Record<string, () => void> = {
          z: () => (e.shiftKey ? s.redo() : s.undo()),
          y: () => s.redo(),
          d: duplicateSelection,
          a: selectAll,
          c: copySelection,
          v: paste,
          s: () => (s.sourceFile ? void saveDesign() : saveProjectFile()),
          o: () => (document.querySelector('input[type=file]') as HTMLInputElement | null)?.click(),
        };
        const command = commands[key];
        if (command) {
          e.preventDefault();
          command();
        }
        return;
      }

      if (s.mode === 'pcb') {
        if (pcbKey(key, e)) e.preventDefault();
        return;
      }

      if (e.shiftKey && PASSIVE_KEYS[key]) {
        e.preventDefault();
        startPassive(PASSIVE_KEYS[key]);
        return;
      }

      switch (key) {
        case 'enter': {
          const id = s.selection.length >= 1 ? s.selection.find((x) => s.project.components.find((c) => c.id === x)?.generic) : undefined;
          if (!id) return;
          s.setQuickEdit(id);
          break;
        }
        case 'escape':
          if (s.wireDraft) finishWireDraft();
          else if (s.tool !== 'select') s.setTool('select');
          else {
            s.setSelection([]);
            s.setHighlightNet(null);
          }
          break;
        case 'delete':
        case 'backspace':
          deleteSelection();
          break;
        case 'r':
          rotateSelection();
          break;
        case 'x':
        case 'm':
          mirrorSelection();
          break;
        case 'w':
          s.setTool('wire');
          break;
        case 'n':
          s.startPort('label');
          break;
        case 'p':
          s.startPort('power');
          break;
        case 'g':
          s.startPort('ground');
          break;
        case 'q':
          s.startPort('noconnect');
          break;
        case 'v':
          s.setTool('select');
          break;
        case 'f':
          fitView(s.selection.length ? s.selection : undefined);
          break;
        case 'l':
          s.setLibraryOpen(!s.libraryOpen);
          break;
        case '/':
          focusLibrarySearch();
          break;
        case '=':
        case '+':
          zoomBy(1.25);
          break;
        case '-':
          zoomBy(0.8);
          break;
        case 'arrowup':
        case 'arrowdown':
        case 'arrowleft':
        case 'arrowright': {
          if (!s.selection.length) return;
          const step = e.shiftKey ? 50 : 10;
          const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
          const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
          const ids = new Set(s.selection);
          s.commit((doc) => moveItems(doc, ids, dx, dy, resolverFor(s.project)));
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
