import { describe, expect, it } from 'vitest';
import { supportedChar, textSize, textStrokes } from '../src/lib/pcb/font';
import { traceBitmap, type Bitmap } from '../src/lib/pcb/logo';
import { designatorAnchor, designatorLabel, labelId, logoAreas, pinLabels, silkTextBox } from '../src/lib/pcb/silk';
import { buildBoard } from '../src/lib/pcb/board';
import { silkIssues } from '../src/lib/pcb/drc';
import { generateGerbers } from '../src/lib/pcb/gerber';
import { builtinFootprintDoc } from '../src/lib/pcb/footprint';
import { addText, movePlacements, removePcbItems, rotateSelected, updateLabel } from '../src/lib/pcb/actions';
import { emptyPcb, type Pcb, type SilkLogo } from '../src/lib/pcb/types';
import { useEditor } from '../src/store/editor';
import { TOOLS, runTool } from '../src/lib/webmcp';
import { PASSIVE_SYMBOLS } from '../src/shared/passives';
import type { Project, Vec } from '../src/lib/schematic/types';

/** Two 0603 resistors, R1 at (5, 5) and R2 at (12, 5), on a 20 × 10 board. */
function fixture(extra: Partial<Pcb> = {}): Project {
  const sym = { title: 'R', dataStr: PASSIVE_SYMBOLS.resistor, source: 'builtin' as const };
  return {
    version: 1,
    id: 'p',
    name: 'test',
    updatedAt: 0,
    symbols: { r: sym },
    components: [
      { id: 'a', symbolKey: 'r', unit: 0, designator: 'R1', value: '1k', x: 0, y: 0, rotation: 0, mirror: false, attrs: {} },
      { id: 'b', symbolKey: 'r', unit: 0, designator: 'R2', value: '1k', x: 100, y: 0, rotation: 0, mirror: false, attrs: {} },
    ],
    wires: [],
    ports: [],
    pcb: {
      ...emptyPcb(),
      board: { x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 },
      footprints: { 'builtin:0603': { title: '0603', dataStr: builtinFootprintDoc('0603', false)!, source: 'builtin' } },
      footprintOf: { a: 'builtin:0603', b: 'builtin:0603' },
      placements: [
        { componentId: 'a', x: 5, y: 5, rotation: 0, side: 'top' },
        { componentId: 'b', x: 12, y: 5, rotation: 0, side: 'top' },
      ],
      ...extra,
    },
  };
}

const xs = (strokes: Vec[][]) => strokes.flat().map((p) => p[0]);

describe('silkscreen font', () => {
  it('draws lowercase, symbols and several lines, with proportional spacing', () => {
    expect(textStrokes('a', [0, 0], 1)).not.toEqual(textStrokes('A', [0, 0], 1));
    expect(['µ', 'Ω', '°', ':', '(', 'z'].every(supportedChar)).toBe(true);
    expect(supportedChar('€')).toBe(false);
    expect(textSize('ii', 1).width).toBeLessThan(textSize('WW', 1).width);
    const two = textSize('AB\nC', 1.2);
    expect(two.height).toBeCloseTo(((9.5 + 6) * 1.2) / 6);
    // Centred on the anchor, mirrored for the bottom side.
    const top = xs(textStrokes('L1', [10, 0], 1));
    const bottom = xs(textStrokes('L1', [10, 0], 1, 0, true));
    expect((Math.min(...top) + Math.max(...top)) / 2).toBeCloseTo(10, 1);
    expect(Math.min(...bottom)).toBeCloseTo(20 - Math.max(...top));
  });
});

describe('logo tracing', () => {
  // 10 × 6 pixels: a 6 × 4 dark frame (2 px border on the sides, 1 px top and bottom) with a light hole.
  const bitmap = (dark: (x: number, y: number) => boolean): Bitmap => {
    const data = new Uint8Array(10 * 6 * 4);
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 10; x++) {
        const v = dark(x, y) ? 0 : 255;
        data.set([v, v, v, 255], (y * 10 + x) * 4);
      }
    return { width: 10, height: 6, data };
  };
  const frame = (x: number, y: number) => x >= 2 && x < 8 && y >= 1 && y < 5 && !(x >= 4 && x < 6 && y >= 2 && y < 3);

  it('traces dark pixels into shapes with holes, cropped to the artwork', () => {
    const { shapes, aspect } = traceBitmap(bitmap(frame));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].outer).toHaveLength(4);
    expect(shapes[0].holes).toHaveLength(1);
    expect(aspect).toBeCloseTo(4 / 6);
    const ox = shapes[0].outer.map((p) => p[0]);
    expect(Math.min(...ox)).toBeCloseTo(-0.5);
    expect(Math.max(...ox)).toBeCloseTo(0.5);
  });

  it('traces light pixels with invert and refuses a blank image', () => {
    const { shapes } = traceBitmap(bitmap(frame), { invert: true });
    // The light background (with the frame cut out) and the light island in the middle.
    expect(shapes.length).toBe(2);
    expect(() => traceBitmap(bitmap(() => false))).toThrow(/no dark pixels/);
  });

  it('places, scales and mirrors logos on the board', () => {
    const logo: SilkLogo = { id: 'l', name: 'x', x: 10, y: 5, width: 4, height: 2, rotation: 0, side: 'bottom', shapes: [{ outer: [[-0.5, -0.25], [0.5, -0.25], [0.5, 0], [-0.5, 0.25]], holes: [] }] };
    const [area] = logoAreas(logo);
    expect(area.outer[0]).toEqual([12, 4]);
    expect(area.outer[3][0]).toBeCloseTo(12);
    expect(area.outer[1]).toEqual([8, 4]);
  });
});

describe('designators', () => {
  it('sits above the part by default and follows the part once moved', () => {
    const project = fixture();
    const [r1] = buildBoard(project, project.pcb!).parts;
    expect(designatorLabel(r1).at).toEqual(designatorAnchor(r1.box));

    useEditor.getState().loadProject(project);
    updateLabel('a', { at: [5, 8], size: 1.2 });
    const moved = useEditor.getState().project;
    expect(moved.pcb!.placements[0].label).toMatchObject({ x: 0, y: 3, size: 1.2 });
    // Turning the part carries the label around it; its rotation on the board stays.
    useEditor.getState().setPcbSelection(['a']);
    rotateSelected(90);
    const turned = useEditor.getState().project;
    const label = designatorLabel(buildBoard(turned, turned.pcb!).parts[0]);
    expect(label.at[0]).toBeCloseTo(8);
    expect(label.at[1]).toBeCloseTo(5);
    expect(label.rotation).toBe(0);
  });

  it('drags a designator on its own, but not twice when its part moves too', () => {
    const project = fixture();
    const board = buildBoard(project, project.pcb!);
    const pinned = pinLabels(project.pcb!, board, new Set(['a']));
    const start = designatorLabel(buildBoard({ ...project, pcb: pinned }, pinned).parts[0]).at;
    const after = (ids: string[]) => {
      const pcb = movePlacements(pinned, new Set(ids), 1, 2);
      return designatorLabel(buildBoard({ ...project, pcb }, pcb).parts[0]).at;
    };
    expect(after([labelId('a')])).toEqual([start[0] + 1, start[1] + 2]);
    expect(after(['a', labelId('a')])).toEqual([start[0] + 1, start[1] + 2]);
  });

  it('hides a designator on delete', () => {
    useEditor.getState().loadProject(fixture());
    expect(removePcbItems(new Set([labelId('b')]))).toBe(1);
    const pcb = useEditor.getState().project.pcb!;
    expect(pcb.placements[1].label?.hidden).toBe(true);
    expect(designatorLabel(buildBoard(useEditor.getState().project, pcb).parts[1]).hidden).toBe(true);
  });
});

describe('silkscreen output and checks', () => {
  it('writes text, logos (holes in clear polarity) and moved designators to the silkscreen Gerbers', () => {
    const logo: SilkLogo = {
      id: 'l',
      name: 'frame',
      x: 15,
      y: 8,
      width: 4,
      height: 2,
      rotation: 0,
      side: 'top',
      shapes: [{ outer: [[-0.5, -0.25], [0.5, -0.25], [0.5, 0.25], [-0.5, 0.25]], holes: [[[-0.2, -0.1], [0.2, -0.1], [0.2, 0.1], [-0.2, 0.1]]] }],
    };
    const project = fixture({ logos: [logo], texts: [{ id: 't', text: 'v1', x: 10, y: 9, size: 1, rotation: 0, side: 'bottom' }] });
    const files = generateGerbers(project.pcb!, buildBoard(project, project.pcb!), 'demo');
    const top = files.find((f) => f.name.endsWith('F_Silkscreen.gto'))!.content;
    const bottom = files.find((f) => f.name.endsWith('B_Silkscreen.gbo'))!.content;
    expect(top).toContain('G36*');
    expect(top.indexOf('%LPC*%')).toBeLessThan(top.indexOf('%LPD*%', top.indexOf('%LPC*%')));
    expect(top.indexOf('G36*')).toBeLessThan(top.indexOf('D01*', top.indexOf('G37*') + 1));
    expect(bottom).toContain('D01*');
  });

  it('warns about silkscreen on pads or off the board', () => {
    const project = fixture({ texts: [{ id: 't', text: 'ON PAD', x: 5, y: 5, size: 1, rotation: 0, side: 'top' }, { id: 'u', text: 'EDGE', x: 19.5, y: 9.5, size: 1.5, rotation: 0, side: 'top' }] });
    const messages = silkIssues(buildBoard(project, project.pcb!), project.pcb!).map((i) => i.message);
    expect(messages.some((m) => m.startsWith('Silkscreen text "ON PAD" lies on pad R1.'))).toBe(true);
    expect(messages).toContain('Silkscreen text "EDGE" runs off the board');
  });
});

describe('silkscreen tools', () => {
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

  it('adds text, reports unsupported characters and edits it', async () => {
    useEditor.getState().loadProject(fixture());
    const r = (await runTool(tool('pcb_add_text'), { text: 'Hi €', x: 10, y: 2, size: 1.2 })) as { id: string; warnings?: string[] };
    expect(r.warnings).toEqual(['These characters print as "?": €']);
    await runTool(tool('pcb_update_silkscreen'), { id: r.id, text: 'Hello', side: 'bottom' });
    expect(useEditor.getState().project.pcb!.texts![0]).toMatchObject({ text: 'Hello', side: 'bottom', size: 1.2 });
    expect(silkTextBox(addText('X', [1, 1])).x1).toBeLessThan(1);
  });

  it('moves, styles and resets a designator by name', async () => {
    useEditor.getState().loadProject(fixture());
    const moved = await runTool(tool('pcb_set_designator'), { designator: 'R2', x: 12, y: 8, rotation: 90, size: 1 });
    expect(moved).toMatchObject({ designator: 'R2', x: 12, y: 8, rotation: 90, size: 1, hidden: false });
    const reset = (await runTool(tool('pcb_set_designator'), { designator: 'R2', reset: true })) as { y: number; size: number };
    expect(reset.size).toBe(1);
    expect(reset.y).toBeLessThan(5);
    await expect(runTool(tool('pcb_set_designator'), { designator: 'R2', x: 3 })).rejects.toThrow('Give both x and y');
  });
});
