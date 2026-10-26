import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { crossProbe, followSelection, partsOnNet } from '../src/lib/crossprobe';
import { revealItems } from '../src/lib/editing';
import { generateFootprint, packageSpec } from '../src/lib/pcb/ipc';
import { emptyPcb, type Pcb } from '../src/lib/pcb/types';
import { framePcb, revealOnPcb } from '../src/lib/pcb/view';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();

/** R1 and R2 on a net named SIG, both on the board: R1 at (10, 10) mm, R2 at (40, 30) mm. */
function board(): Pcb {
  const fp = { title: '0603', dataStr: '', source: 'user' as const, geom: generateFootprint(packageSpec('0603')) };
  return {
    ...emptyPcb(),
    board: { x: 0, y: 0, width: 50, height: 40, cornerRadius: 1 },
    footprints: { 'user:0603': fp },
    footprintOf: { a: 'user:0603', b: 'user:0603' },
    signatures: { a: '|', b: '|' },
    placements: [
      { componentId: 'a', x: 10, y: 10, rotation: 0, side: 'top' },
      { componentId: 'b', x: 40, y: 30, rotation: 0, side: 'top' },
    ],
  };
}

beforeEach(() => {
  st().loadProject(
    project({
      sheets: [
        { id: 's1', name: 'Main' },
        { id: 's2', name: 'Other' },
      ],
      components: [comp('a', 'res', 'R1', 0, 0, { sheet: 's1' }), comp('b', 'res', 'R2', 400, 300, { sheet: 's1' }), comp('c', 'res', 'R3', 0, 0, { sheet: 's2' })],
      wires: [{ id: 'w', points: [[20, 0], [380, 300]], sheet: 's1' }],
      ports: [{ id: 'l', kind: 'label', name: 'SIG', x: 20, y: 0, rotation: 0, sheet: 's1' }],
      pcb: board(),
    }),
  );
  st().setSplit(false);
  st().setMode('schematic');
  st().setCanvasSize({ width: 800, height: 600 });
  st().setPcbCanvasSize({ width: 400, height: 300 });
});

describe('cross-probing', () => {
  it('keeps the part selection and the highlighted net in step', () => {
    st().setSelection(['a', 'w']);
    expect(st().pcbSelection).toEqual(['a']);
    // A designator label on the board stands for its part; tracks have no counterpart.
    st().setPcbSelection(['label:b', 'track-1']);
    expect(st().selection).toEqual(['b']);
    st().setHighlightNet('SIG');
    expect(st().pcbHighlightNet).toBe('SIG');
    st().setPcbHighlightNet(null);
    expect(st().highlightNet).toBeNull();
  });

  it('brings parts into view without zooming, switching sheet when needed', () => {
    st().setView({ x: 100, y: 100, zoom: 2 });
    // R1 is in view: nothing moves.
    revealItems(['a']);
    expect(st().view).toEqual({ x: 100, y: 100, zoom: 2 });
    // R2 at (400, 300) is not: it is centred below the toolbar at the same zoom.
    revealItems(['b']);
    expect(st().view).toEqual({ x: 400 - 400 * 2, y: (600 + 56) / 2 - 300 * 2, zoom: 2 });
    revealItems(['c']);
    expect(st().currentSheet).toBe('s2');
  });

  it('brings parts into view on the board', () => {
    st().setPcbView({ x: 0, y: 0, zoom: 10 });
    revealOnPcb(['a']);
    expect(st().pcbView).toEqual({ x: 0, y: 0, zoom: 10 });
    revealOnPcb(['b']);
    expect(st().pcbView).toEqual({ x: 200 - 400, y: 150 - 300, zoom: 10 });
  });

  it('follows the selection into the other editor side by side', () => {
    const stop = followSelection();
    try {
      st().setPcbView({ x: 0, y: 0, zoom: 10 });
      st().setView({ x: 100, y: 100, zoom: 2 });
      // Not side by side: nothing follows.
      st().setSelection(['b']);
      expect(st().pcbView.x).toBe(0);
      st().setSplit(true);
      st().setSelection(['a']);
      st().setSelection(['b']);
      expect(st().pcbView).toEqual({ x: -200, y: -150, zoom: 10 });
      // Selecting on the board while it is the active editor reveals the part in the schematic.
      st().setMode('pcb');
      st().setPcbSelection(['c']);
      expect(st().currentSheet).toBe('s2');
    } finally {
      stop();
    }
  });

  it('shows the highlighted net’s parts on the board with Shift+X', async () => {
    expect(partsOnNet('SIG').sort()).toEqual(['a', 'b']);
    st().setHighlightNet('SIG');
    await crossProbe();
    // The board canvas appears and frames them itself once it knows its size.
    expect(st().mode).toBe('pcb');
    expect(st().pendingFrame).toEqual({ editor: 'pcb', ids: expect.arrayContaining(['a', 'b']) });
    // A single small part is framed with at least a third of the 50 mm board around it.
    framePcb(['a']);
    expect(st().pcbView.zoom).toBeCloseTo((300 - 80) / (50 / 3), 5);
  });
});

afterEach(() => st().setSplit(false));
