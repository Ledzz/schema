/*
 * Silkscreen besides footprint graphics: part designators (movable, resizable, hideable), free
 * text and traced logos. Gerbers, board pictures, the 3D textures and the editor all take their
 * shapes from here, so what is drawn on screen is what gets printed.
 */
import type { Vec } from '../schematic/types';
import type { BoardModel, BoardPart } from './board';
import { textSize, textStrokes } from './font';
import { placementToWorld, rotateDeg, worldToPlacement, type Box } from './geometry';
import type { FillArea } from './pour';
import type { CopperLayer, Pcb, SilkLogo, SilkText } from './types';

/** Default designator height: JLCPCB's minimum for legible text. */
export const DESIGNATOR_SIZE = 1;
/** Default height of free text: JLCPCB asks for 1 mm or more. */
export const TEXT_SIZE = 1.5;

/** Line width for text of a given height: 15% of it, and never under JLCPCB's 0.15 mm minimum. */
export const strokeFor = (size: number) => Math.max(0.15, Math.round(size * 0.15 * 1000) / 1000);

/** Default designator position: centred just above the part's bounding box. */
export function designatorAnchor(box: Box, size = DESIGNATOR_SIZE): Vec {
  return [(box.x1 + box.x2) / 2, box.y1 - size];
}

export interface Label {
  text: string;
  at: Vec;
  size: number;
  rotation: number;
  side: CopperLayer;
  hidden: boolean;
}

/** Where a part's designator is printed, with its overrides applied. */
export function designatorLabel(part: BoardPart): Label {
  const l = part.placement.label ?? {};
  const size = l.size ?? DESIGNATOR_SIZE;
  const at = l.x !== undefined && l.y !== undefined ? placementToWorld(part.placement, [l.x, l.y]) : designatorAnchor(part.box, size);
  return { text: part.component.designator, at, size, rotation: l.rotation ?? 0, side: part.placement.side, hidden: !!l.hidden };
}

export function labelStrokes(l: Label): Vec[][] {
  return l.hidden ? [] : textStrokes(l.text, l.at, l.size, l.rotation, l.side === 'bottom');
}

export const textItemStrokes = (t: SilkText): Vec[][] => textStrokes(t.text, [t.x, t.y], t.size, t.rotation, t.side === 'bottom');
export const textStroke = (t: SilkText) => t.stroke ?? strokeFor(t.size);

/** A logo's shapes on the board: scaled, mirrored on the bottom side, rotated and placed. */
export function logoAreas(l: SilkLogo): FillArea[] {
  const place = ([u, v]: Vec): Vec => {
    const [x, y] = rotateDeg([(l.side === 'bottom' ? -u : u) * l.width, v * l.width], l.rotation);
    return [l.x + x, l.y + y];
  };
  return l.shapes.map((s) => ({ outer: s.outer.map(place), holes: s.holes.map((h) => h.map(place)) }));
}

const boxOf = (points: Vec[], grow = 0): Box => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x1: Math.min(...xs) - grow, y1: Math.min(...ys) - grow, x2: Math.max(...xs) + grow, y2: Math.max(...ys) + grow };
};

/** Bounding box of a text block, from its size rather than its strokes so blank text still has one. */
export function textBox(at: Vec, text: string, size: number, rotation: number, stroke = strokeFor(size)): Box {
  const { width, height } = textSize(text || ' ', size);
  const corners: Vec[] = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([x, y]) => {
    const [rx, ry] = rotateDeg([x, y], rotation);
    return [at[0] + rx, at[1] + ry] as Vec;
  });
  return boxOf(corners, stroke / 2);
}

export const labelBox = (l: Label) => textBox(l.at, l.text, l.size, l.rotation);
export const silkTextBox = (t: SilkText) => textBox([t.x, t.y], t.text, t.size, t.rotation, textStroke(t));
export const logoBox = (l: SilkLogo) => boxOf(logoAreas(l).flatMap((a) => a.outer));

/** Selection id of a part's designator label. */
export const labelId = (componentId: string) => `label:${componentId}`;
export const labelComponent = (id: string) => (id.startsWith('label:') ? id.slice(6) : null);

/**
 * Gives the designators of `componentIds` an explicit position (where they are drawn now), so a
 * drag can move them from their default spot.
 */
export function pinLabels(pcb: Pcb, board: BoardModel, componentIds: ReadonlySet<string>): Pcb {
  if (!componentIds.size) return pcb;
  const parts = new Map(board.parts.map((p) => [p.component.id, p]));
  return {
    ...pcb,
    placements: pcb.placements.map((p) => {
      const part = parts.get(p.componentId);
      if (!componentIds.has(p.componentId) || !part || (p.label?.x !== undefined && p.label?.y !== undefined)) return p;
      const [x, y] = worldToPlacement(p, designatorLabel(part).at);
      return { ...p, label: { ...p.label, x, y } };
    }),
  };
}
