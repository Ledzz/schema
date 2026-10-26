/*
 * Sheets: a schematic's pages. Items carry the id of the sheet they are drawn on (the first sheet
 * when they have none, so single-sheet projects need nothing). Geometry — what touches what, where
 * a wire may run — only ever looks at one sheet; nets join across sheets through labels and power
 * flags of the same name, and through hierarchical blocks.
 */
import type { Component, NetPort, Project, Sheet, SheetBlock, Vec, Wire } from './types';

export const FIRST_SHEET = 's1';

type SheetDoc = Pick<Project, 'components' | 'wires' | 'ports' | 'sheets' | 'blocks'>;
type Placed = { sheet?: string };

/** The project's sheets, in order (one when it has never had more). */
export function sheetsOf(doc: Pick<Project, 'sheets'>): Sheet[] {
  return doc.sheets?.length ? doc.sheets : [{ id: FIRST_SHEET, name: 'Sheet 1' }];
}

/** The sheet an item is on. */
export const sheetOf = (item: Placed, doc: Pick<Project, 'sheets'>): string => item.sheet ?? sheetsOf(doc)[0].id;

/** The document as seen on one sheet: only that sheet's parts, wires, labels and blocks. */
export function sheetView<T extends SheetDoc>(doc: T, sheet: string): T {
  const on = (item: Placed) => sheetOf(item, doc) === sheet;
  return { ...doc, components: doc.components.filter(on), wires: doc.wires.filter(on), ports: doc.ports.filter(on), blocks: (doc.blocks ?? []).filter(on) };
}

/** Puts a sheet view (after an edit) back into the whole document; new items land on that sheet. */
export function mergeSheet<T extends SheetDoc>(doc: T, sheet: string, view: T): T {
  const other = (item: Placed) => sheetOf(item, doc) !== sheet;
  // Everything in the view belongs to its sheet, including items pasted from another one.
  const tag = <I extends Placed>(item: I): I => (item.sheet === sheet ? item : { ...item, sheet });
  // Keep tags off on the first sheet of a one-sheet project, as it was saved.
  const keep = !doc.sheets?.length && sheet === FIRST_SHEET ? <I extends Placed>(item: I) => item : tag;
  return {
    ...view,
    components: [...doc.components.filter(other), ...view.components.map(keep)],
    wires: [...doc.wires.filter(other), ...view.wires.map(keep)],
    ports: [...doc.ports.filter(other), ...view.ports.map(keep)],
    blocks: [...(doc.blocks ?? []).filter(other), ...(view.blocks ?? []).map(keep)],
  };
}

/** Applies an edit to one sheet only. */
export const onSheet = <T extends SheetDoc>(doc: T, sheet: string, edit: (view: T) => T): T => mergeSheet(doc, sheet, edit(sheetView(doc, sheet)));

/** Spacing of a block's pins and the room above the first one (for its name). */
export const BLOCK_PITCH = 10;
const BLOCK_HEAD = 20;

/** Where a block's `i`-th pin slot is, down its left edge. */
export const blockSlot = (block: SheetBlock, i: number): Vec => [block.x, block.y + BLOCK_HEAD + i * BLOCK_PITCH];

/** A block's pins down its left edge, one per hierarchical port name of its child sheet. */
export function blockPins(block: SheetBlock): { name: string; at: Vec }[] {
  return block.pins.flatMap((name, i) => (name ? [{ name, at: blockSlot(block, i) }] : []));
}

/** A block's outline. */
export function blockBox(block: SheetBlock) {
  return { x1: block.x, y1: block.y, x2: block.x + block.width, y2: block.y + Math.max(40, BLOCK_HEAD + block.pins.length * BLOCK_PITCH) };
}

/** The hierarchical port names on a sheet, in pin order. */
export const hierNames = (doc: Pick<Project, 'ports' | 'sheets'>, sheet: string): string[] =>
  [...new Set(doc.ports.filter((p) => p.kind === 'hier' && p.name.trim() && sheetOf(p, doc) === sheet).map((p) => p.name.trim()))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/** Everything on a sheet, for counting and deleting. */
export const itemsOnSheet = (doc: SheetDoc, sheet: string): (Component | Wire | NetPort | SheetBlock)[] => {
  const v = sheetView(doc, sheet);
  return [...v.components, ...v.wires, ...v.ports, ...(v.blocks ?? [])];
};
