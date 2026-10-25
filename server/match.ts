import type { PartClass, PartSummary } from '../src/shared/parts';
import { PASSIVES, attributeMatches, parsePassiveValue, sameColour, searchKeyword, sizeOf, type PassiveKind } from '../src/shared/passives';
import { searchParts } from './jlcpcb';

export interface PassiveMatch {
  canonical: string | null;
  candidates: PartSummary[];
  error?: string;
}

const CLASS_RANK: Record<PartClass, number> = { basic: 0, preferred: 1, extended: 2 };

function voltageOf(p: PartSummary): number | null {
  const a = p.attributes.find((x) => /^Voltage Rating/.test(x.name));
  const m = a && /(\d+(?:\.\d+)?)\s*V/.exec(a.value);
  return m ? Number(m[1]) : null;
}

/**
 * Finds JLCPCB parts for a generic passive. Basic parts come first, then preferred, then
 * extended; within a class, higher stock wins.
 */
export async function matchPassive(kind: PassiveKind, value: string, size: string): Promise<PassiveMatch> {
  const spec = PASSIVES[kind];
  const parsed = parsePassiveValue(kind, value);
  if (!parsed) return { canonical: null, candidates: [], error: `Cannot read "${value}" as a ${spec.label.toLowerCase()} value` };
  const packages = sizeOf(kind, size)?.packages ?? (size ? [size] : []);
  const base = {
    q: searchKeyword(kind, parsed),
    inStock: true,
    sort: 'stock' as const,
    category: spec.category,
    subcategory: spec.subcategory,
    packages,
    page: 1,
    pageSize: kind === 'led' ? 100 : 50,
  };
  // No-fee parts are searched separately so they are not crowded out of the first page.
  const [noFee, any] = await Promise.all([
    searchParts({ ...base, types: ['basic', 'preferred'] }),
    searchParts({ ...base, types: [] }),
  ]);
  const seen = new Set<string>();
  const parts = [...noFee.parts, ...any.parts].filter((p) => !seen.has(p.lcsc) && seen.add(p.lcsc));

  const matches = parts.filter((p) => {
    if (kind === 'diode') return p.mpn.toUpperCase().startsWith(parsed.canonical) || p.mpn.toUpperCase().includes(parsed.canonical);
    const attr = p.attributes.find((a) => spec.valueAttr?.test(a.name));
    if (!attr || !attributeMatches(kind, parsed, attr.value)) return false;
    if (parsed.voltage) {
      const v = voltageOf(p);
      if (v !== null && v < parsed.voltage) return false;
    }
    return true;
  });
  const exactness = (p: PartSummary) => {
    if (kind === 'diode') return Number(p.mpn.toUpperCase().startsWith(parsed.canonical));
    if (kind === 'led') return Number(p.attributes.some((a) => spec.valueAttr?.test(a.name) && sameColour(a.value, parsed.canonical)));
    return 1;
  };
  matches.sort((a, b) => {
    const exact = exactness(b) - exactness(a);
    if (exact) return exact;
    return CLASS_RANK[a.partClass] - CLASS_RANK[b.partClass] || b.stock - a.stock;
  });
  return { canonical: parsed.canonical, candidates: matches.slice(0, 12) };
}
