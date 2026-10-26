/*
 * Find: parts by designator, value, manufacturer part or LCSC number, and nets by name, best
 * matches first, for the ⌘F box in both editors.
 */
import type { Connectivity } from './schematic/netlist';
import type { Project } from './schematic/types';

export interface FindResult {
  kind: 'part' | 'net';
  /** Designator or net name. */
  label: string;
  /** Value and part number, or the pins on the net. */
  detail: string;
  /** The part's id, or the wires and labels of the net. */
  ids: string[];
  net?: string;
}

/** 0 for an exact match, then prefix, word start and anywhere; null when it doesn't match. */
function rank(text: string | undefined, q: string): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[\s_\-/.]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 3 : null;
}

export function findItems(project: Pick<Project, 'components' | 'wires' | 'ports'>, conn: Connectivity, query: string, limit = 12): FindResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { score: number; result: FindResult }[] = [];
  for (const c of project.components) {
    const fields = [c.designator, c.value, c.attrs['Manufacturer Part'], c.lcsc];
    const ranks = fields.map((f, i) => {
      const r = rank(f, q);
      // A designator match beats the same kind of match in another field.
      return r === null ? null : r * 2 + (i === 0 ? 0 : 1);
    });
    const best = Math.min(...ranks.filter((r): r is number => r !== null));
    if (!Number.isFinite(best)) continue;
    const detail = [c.value, c.attrs['Manufacturer Part'] !== c.value ? c.attrs['Manufacturer Part'] : null, c.lcsc].filter(Boolean).join(' · ');
    scored.push({ score: best, result: { kind: 'part', label: c.designator, detail, ids: [c.id] } });
  }
  for (const n of conn.nets) {
    const r = rank(n.name, q);
    if (r === null) continue;
    const ids = [...project.wires, ...project.ports].filter((i) => conn.itemNet.get(i.id) === n.name).map((i) => i.id);
    const pins = n.members.map((m) => `${m.designator}.${m.pinNumber}`);
    const detail = `${pins.length} pin${pins.length === 1 ? '' : 's'}: ${pins.slice(0, 6).join(' ')}${pins.length > 6 ? ' …' : ''}`;
    // Nets rank just after parts with the same kind of match.
    scored.push({ score: r * 2 + 1.5, result: { kind: 'net', label: n.name, detail, ids, net: n.name } });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.result.label.localeCompare(b.result.label, undefined, { numeric: true }))
    .slice(0, limit)
    .map((s) => s.result);
}
