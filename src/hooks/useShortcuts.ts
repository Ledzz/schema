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
import { startPassive } from '../lib/passives';
import type { PassiveKind } from '../shared/passives';

const PASSIVE_KEYS: Record<string, PassiveKind> = { r: 'resistor', c: 'capacitor', l: 'inductor', f: 'ferrite', d: 'diode', e: 'led' };

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
          s: saveProjectFile,
          o: () => (document.querySelector('input[type=file]') as HTMLInputElement | null)?.click(),
        };
        const command = commands[key];
        if (command) {
          e.preventDefault();
          command();
        }
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
