import { EXTENDED_SETUP_FEE, priceAt, type PartClass } from '../../shared/parts';
import type { Component } from './types';

export interface BomLine {
  key: string;
  value: string;
  designators: string[];
  footprint: string;
  lcsc: string;
  mpn: string;
  manufacturer: string;
  partClass: PartClass | null;
  quantity: number;
  stock: number | null;
  unitPrice: number | null;
  componentIds: string[];
}

export interface BomSummary {
  lines: BomLine[];
  uniqueParts: number;
  totalParts: number;
  byClass: Record<PartClass | 'unassigned', number>;
  /** Estimated JLCPCB feeder setup fees for unique extended parts. */
  setupFee: number;
  /** Component cost for `boards` boards at the matching price breaks. */
  partsCost: number;
  lowStock: BomLine[];
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function buildBom(components: Component[], boards = 1): BomSummary {
  const groups = new Map<string, BomLine>();
  for (const c of components) {
    if (c.attrs['Add into BOM'] === 'no') continue;
    const footprint = c.attrs['Footprint'] || c.attrs['Package'] || '';
    const key = c.lcsc ? `lcsc:${c.lcsc}` : `vf:${c.value}|${footprint}`;
    let line = groups.get(key);
    if (!line) {
      line = {
        key,
        value: c.value,
        designators: [],
        footprint,
        lcsc: c.lcsc ?? '',
        mpn: c.attrs['Manufacturer Part'] ?? '',
        manufacturer: c.attrs['Manufacturer'] ?? '',
        partClass: c.partClass ?? null,
        quantity: 0,
        stock: c.stock ?? null,
        unitPrice: null,
        componentIds: [],
      };
      groups.set(key, line);
    }
    line.designators.push(c.designator);
    line.componentIds.push(c.id);
    line.quantity++;
  }

  const byClass: BomSummary['byClass'] = { basic: 0, preferred: 0, extended: 0, unassigned: 0 };
  let partsCost = 0;
  const lines = [...groups.values()];
  for (const line of lines) {
    line.designators.sort(natural);
    byClass[line.partClass ?? 'unassigned']++;
    const comp = components.find((c) => c.id === line.componentIds[0]);
    if (comp?.prices?.length) {
      line.unitPrice = priceAt(comp.prices, line.quantity * boards);
      partsCost += (line.unitPrice ?? 0) * line.quantity * boards;
    }
  }
  lines.sort((a, b) => natural(a.designators[0] ?? '', b.designators[0] ?? ''));

  return {
    lines,
    uniqueParts: lines.length,
    totalParts: lines.reduce((n, l) => n + l.quantity, 0),
    byClass,
    setupFee: byClass.extended * EXTENDED_SETUP_FEE,
    partsCost,
    lowStock: lines.filter((l) => l.lcsc && l.stock !== null && l.stock < l.quantity * boards),
  };
}

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** BOM in the column layout JLCPCB's assembly upload expects. */
export function bomToJlcpcbCsv(bom: BomSummary): string {
  const rows = [['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity', 'JLCPCB Part Type']];
  for (const l of bom.lines) {
    rows.push([l.value, l.designators.join(','), l.footprint, l.lcsc, String(l.quantity), l.partClass ?? '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
