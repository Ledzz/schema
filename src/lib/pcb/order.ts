/*
 * Ordering from JLCPCB. JLCPCB has no public API for starting an order with files attached
 * (EasyEDA's one-click order relies on JLC's own internal upload service), so the app does
 * everything up to that point: it checks the board, writes the upload files, opens the quote
 * page and spells out the settings to pick there.
 */
import { useEditor } from '../../store/editor';
import { buildBom, type BomSummary } from '../schematic/bom';
import type { Component, Project } from '../schematic/types';
import { checkPcb, exportFabrication, throughHoleParts } from './actions';
import { checklistReady, jlcpcbChecklist, type CheckItem } from './jlcpcb';

export const JLCPCB_QUOTE_URL = 'https://cart.jlcpcb.com/quote';
export const ORDER_QUANTITIES = [5, 10, 15, 20, 30, 50, 100];

export interface OrderOptions {
  quantity: number;
  /** Order PCB assembly (otherwise bare boards only). */
  assembly: boolean;
  /** Leave through-hole parts out of the assembly files and solder them yourself. */
  handSolderThroughHole: boolean;
}

export interface OrderSummary {
  ready: boolean;
  width: number;
  height: number;
  /** Copper layers. */
  layers: number;
  errors: string[];
  warnings: string[];
  partCount: number;
  throughHole: Component[];
  /** Parts JLCPCB would assemble with these options. */
  assembled: Component[];
  bom: BomSummary;
  bottomSide: boolean;
  viasInPads: boolean;
  /** Parts whose orientation is worth a look in JLCPCB's placement preview. */
  checkOrientation: string[];
  /** The JLCPCB manufacturing checklist for these options; failures block the order. */
  checklist: CheckItem[];
}

const POLARIZED_FOOTPRINT = /(^|[-_])(BD\d|CASE|ELEC|TANT|SOD|SMA|SMB|LED)/i;

export function orderSummary(project: Project, opts: OrderOptions): OrderSummary {
  const pcb = project.pcb;
  if (!pcb?.placements.length) {
    return {
      ready: false,
      width: 0,
      height: 0,
      layers: 2,
      errors: ['The board is empty: switch to the PCB editor and update it from the schematic first.'],
      warnings: [],
      partCount: 0,
      throughHole: [],
      assembled: [],
      bom: buildBom([], opts.quantity),
      bottomSide: false,
      viasInPads: false,
      checkOrientation: [],
      checklist: [],
    };
  }
  const { issues, board } = checkPcb(project);
  const throughHole = throughHoleParts(board);
  const skipped = new Set(opts.handSolderThroughHole ? throughHole.map((c) => c.id) : []);
  const placed = board.parts.map((p) => p.component);
  const assembled = opts.assembly ? placed.filter((c) => !skipped.has(c.id)) : [];
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const checklist = jlcpcbChecklist(project, { assembly: opts.assembly, skip: skipped, quantity: opts.quantity });
  return {
    ready: checklistReady(checklist),
    checklist,
    width: pcb.board.width,
    height: pcb.board.height,
    layers: pcb.board.layers ?? 2,
    errors,
    warnings: issues.filter((i) => i.severity === 'warning').map((i) => i.message),
    partCount: placed.length,
    throughHole,
    assembled,
    bom: buildBom(assembled, opts.quantity),
    bottomSide: board.parts.some((p) => p.placement.side === 'bottom' && assembled.includes(p.component)),
    viasInPads: issues.some((i) => /vias? in SMD pad/i.test(i.message)),
    checkOrientation: board.parts
      .filter((p) => assembled.includes(p.component))
      .filter((p) => /^(U|Q|D|LED|IC)\d/i.test(p.component.designator) || POLARIZED_FOOTPRINT.test(pcb.footprints[pcb.footprintOf[p.component.id] ?? '']?.title ?? ''))
      .map((p) => p.component.designator),
  };
}

/** Downloads the upload files for these options and opens JLCPCB's quote page. */
export function startJlcpcbOrder(project: Project, opts: OrderOptions): string[] {
  const summary = orderSummary(project, opts);
  const assembledIds = new Set(summary.assembled.map((c) => c.id));
  const skip = new Set(project.components.filter((c) => !assembledIds.has(c.id)).map((c) => c.id));
  const { files } = exportFabrication(skip, opts.assembly);
  window.open(JLCPCB_QUOTE_URL, '_blank', 'noopener');
  useEditor.getState().notify(`Downloaded ${files.join(', ')} and opened JLCPCB`);
  return files;
}
