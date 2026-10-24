/*
 * Generic passives: placed as a value + size, then matched to a JLCPCB part.
 *
 * JLCPCB's search only matches canonical value spellings ("4.7kΩ", "100nF", "1uF", "22uH";
 * "47p" or "1u" return nothing), so typed values are normalized before searching and the
 * results are filtered on the parsed value attribute.
 */

export type PassiveKind = 'resistor' | 'capacitor' | 'inductor' | 'ferrite' | 'led' | 'diode';

export interface PassiveSize {
  label: string;
  /** Package spellings used by JLCPCB for this size. */
  packages: string[];
}

export interface PassiveSpec {
  kind: PassiveKind;
  label: string;
  prefix: string;
  category: string;
  subcategory?: string;
  /** Attribute holding the value, e.g. "Resistance". */
  valueAttr: RegExp | null;
  sizes: PassiveSize[];
  defaultSize: string;
  defaultValue: string;
  quickValues: string[];
  placeholder: string;
}

const chip = (...labels: string[]): PassiveSize[] => labels.map((l) => ({ label: l, packages: [l] }));

export const PASSIVES: Record<PassiveKind, PassiveSpec> = {
  resistor: {
    kind: 'resistor',
    label: 'Resistor',
    prefix: 'R',
    category: 'Resistors',
    subcategory: 'Chip Resistor - Surface Mount',
    valueAttr: /^Resistance$/,
    sizes: chip('0201', '0402', '0603', '0805', '1206'),
    defaultSize: '0603',
    defaultValue: '10kΩ',
    quickValues: ['0Ω', '22Ω', '100Ω', '330Ω', '1kΩ', '2.2kΩ', '4.7kΩ', '5.1kΩ', '10kΩ', '47kΩ', '100kΩ', '1MΩ'],
    placeholder: '10k, 4k7, 100R',
  },
  capacitor: {
    kind: 'capacitor',
    label: 'Capacitor',
    prefix: 'C',
    category: 'Capacitors',
    subcategory: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT',
    valueAttr: /^Capacitance$/,
    sizes: chip('0201', '0402', '0603', '0805', '1206', '1210'),
    defaultSize: '0603',
    defaultValue: '100nF',
    quickValues: ['10pF', '22pF', '100pF', '1nF', '10nF', '100nF', '1uF', '4.7uF', '10uF', '22uF'],
    placeholder: '100n, 4.7u, 10u 16V',
  },
  inductor: {
    kind: 'inductor',
    label: 'Inductor',
    prefix: 'L',
    category: 'Inductors, Coils, Chokes',
    valueAttr: /^Inductance$/,
    sizes: chip('0402', '0603', '0805', '1206'),
    defaultSize: '0805',
    defaultValue: '10uH',
    quickValues: ['1uH', '2.2uH', '4.7uH', '10uH', '22uH', '47uH', '100uH'],
    placeholder: '10u, 4.7uH',
  },
  ferrite: {
    kind: 'ferrite',
    label: 'Ferrite bead',
    prefix: 'FB',
    category: 'Filters',
    subcategory: 'Ferrite Beads',
    valueAttr: /^Impedance/,
    sizes: chip('0402', '0603', '0805', '1206'),
    defaultSize: '0603',
    defaultValue: '600Ω',
    quickValues: ['120Ω', '220Ω', '600Ω', '1kΩ'],
    placeholder: '600R @100MHz',
  },
  led: {
    kind: 'led',
    label: 'LED',
    prefix: 'LED',
    category: 'Optoelectronics',
    subcategory: 'LED Indication - Discrete',
    valueAttr: /^(Illumination|Emitted|Emitting) Colou?r/,
    sizes: chip('0402', '0603', '0805', '1206'),
    defaultSize: '0603',
    defaultValue: 'Red',
    quickValues: ['Red', 'Green', 'Blue', 'Yellow', 'White', 'Orange'],
    placeholder: 'Red, Green…',
  },
  diode: {
    kind: 'diode',
    label: 'Diode',
    prefix: 'D',
    category: 'Diodes',
    valueAttr: null,
    sizes: [
      { label: 'SOD-123', packages: ['SOD-123'] },
      { label: 'SOD-123FL', packages: ['SOD-123FL', 'SOD-123F'] },
      { label: 'SOD-323', packages: ['SOD-323'] },
      { label: 'SOD-523', packages: ['SOD-523'] },
      { label: 'SMA', packages: ['SMA', 'SMA(DO-214AC)', 'DO-214AC(SMA)'] },
      { label: 'SMB', packages: ['SMB', 'SMB(DO-214AA)'] },
    ],
    defaultSize: 'SOD-123',
    defaultValue: '1N4148W',
    quickValues: ['1N4148W', 'BAT54', 'B5819W', 'SS14', 'SS34', '1N4007'],
    placeholder: 'part number, e.g. SS34',
  },
};

export const PASSIVE_KINDS = Object.keys(PASSIVES) as PassiveKind[];

export interface ParsedValue {
  /** Value in base SI units (Ω, F, H); null for LEDs and diodes. */
  si: number | null;
  /** Canonical display / search text, e.g. "4.7kΩ". */
  canonical: string;
  voltage?: number;
  tolerance?: number;
}

const UNIT: Partial<Record<PassiveKind, string>> = { resistor: 'Ω', capacitor: 'F', inductor: 'H', ferrite: 'Ω' };
const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1 };

function trimNumber(n: number): string {
  return String(Number(n.toPrecision(3)));
}

export function formatSi(kind: PassiveKind, si: number): string {
  const unit = UNIT[kind] ?? '';
  if (kind === 'resistor' || kind === 'ferrite') {
    if (si === 0) return '0Ω';
    if (si >= 1e6) return `${trimNumber(si / 1e6)}MΩ`;
    if (si >= 1e3) return `${trimNumber(si / 1e3)}kΩ`;
    if (si < 1) return `${trimNumber(si * 1e3)}mΩ`;
    return `${trimNumber(si)}Ω`;
  }
  const steps: [number, string][] =
    kind === 'capacitor'
      ? [[1e-12, 'p'], [1e-9, 'n'], [1e-6, 'u'], [1e-3, 'm']]
      : [[1e-9, 'n'], [1e-6, 'u'], [1e-3, 'm'], [1, '']];
  let chosen = steps[0];
  for (const s of steps) if (si >= s[0] * 0.9999) chosen = s;
  return `${trimNumber(si / chosen[0])}${chosen[1]}${unit}`;
}

/**
 * Parses values such as "10k", "4k7", "100R", "0R", "4.7kΩ", "100n", "0.1uF", "4u7", "10uF 16V",
 * "22uH". Returns null when the text cannot be read as a value of this kind.
 */
export function parsePassiveValue(kind: PassiveKind, text: string): ParsedValue | null {
  const raw = text
    .trim()
    .replace(/µ/g, 'u')
    .replace(/ohms?/gi, 'Ω')
    // "2.2 k", "10 uF" -> "2.2k", "10uF"
    .replace(/(\d)\s+(?=[pnumkKMGRrΩFH](?![a-z]))/g, '$1');
  if (!raw) return null;
  if (kind === 'led') {
    const color = raw.split(/\s+/)[0];
    return { si: null, canonical: color.charAt(0).toUpperCase() + color.slice(1).toLowerCase() };
  }
  if (kind === 'diode') return { si: null, canonical: raw.toUpperCase() };

  const extras: Omit<ParsedValue, 'si' | 'canonical'> = {};
  const voltage = /(\d+(?:\.\d+)?)\s*V\b/i.exec(raw);
  if (voltage) extras.voltage = Number(voltage[1]);
  const tolerance = /(\d+(?:\.\d+)?)\s*%/.exec(raw);
  if (tolerance) extras.tolerance = Number(tolerance[1]);
  const main = raw.split(/[\s@]/)[0];

  let si: number | null = null;
  if (kind === 'resistor' || kind === 'ferrite') {
    // 10k, 4k7, 4.7k, 100R, 0R, 4R7, 100, 100Ω, 1M, 10mΩ
    const m = /^(\d+(?:\.\d+)?)([RrkKMmG]?)(\d*)Ω?$/.exec(main);
    if (!m) return null;
    const mult = m[2] ? PREFIX[m[2] === 'r' ? 'R' : m[2]] : 1;
    si = Number(m[3] ? `${m[1]}.${m[3]}` : m[1]) * mult;
  } else {
    // 100n, 100nF, 0.1u, 4u7, 22uH, 10p
    const unit = UNIT[kind]!;
    const m = new RegExp(`^(\\d+(?:\\.\\d+)?)([pnumk]?)(\\d*)${unit}?$`, 'i').exec(main);
    if (!m || !m[2] && !new RegExp(`${unit}$`, 'i').test(main)) return null;
    const p = m[2] === 'M' ? 'm' : m[2].toLowerCase() === 'k' ? 'k' : m[2].toLowerCase();
    si = Number(m[3] ? `${m[1]}.${m[3]}` : m[1]) * (p ? PREFIX[p] : 1);
  }
  if (!Number.isFinite(si)) return null;
  const canonical = formatSi(kind, si) + (extras.voltage ? ` ${trimNumber(extras.voltage)}V` : '') + (extras.tolerance ? ` ${extras.tolerance}%` : '');
  return { si, canonical, ...extras };
}

/** Text to send to JLCPCB's keyword search. */
export function searchKeyword(kind: PassiveKind, parsed: ParsedValue): string {
  // Colors are not in JLCPCB's keyword index; LEDs are filtered on the color attribute instead.
  if (kind === 'led') return 'LED';
  if (parsed.si === null) return parsed.canonical;
  return formatSi(kind, parsed.si);
}

/** Whether a part's attribute value equals the requested value. */
export function attributeMatches(kind: PassiveKind, parsed: ParsedValue, attrValue: string): boolean {
  if (kind === 'led') return attrValue.toLowerCase().includes(parsed.canonical.toLowerCase());
  if (parsed.si === null) return false;
  const v = parsePassiveValue(kind, attrValue.split('@')[0].replace(/\s+/g, ''));
  if (!v || v.si === null) return false;
  return Math.abs(v.si - parsed.si) <= Math.max(Math.abs(parsed.si) * 0.005, 1e-15);
}

export function sizeOf(kind: PassiveKind, label: string): PassiveSize | undefined {
  return PASSIVES[kind].sizes.find((s) => s.label === label);
}

/*
 * Built-in schematic symbols (EasyEDA Pro document format, y-up). Pin 1 of diodes and LEDs is
 * the cathode, matching LCSC footprints.
 */
const head = (name: string, bbox: number[]) => [`["DOCTYPE","SYMBOL","1.1"]`, `["PART","${name}.1",{"BBOX":${JSON.stringify(bbox)}}]`];
const pin = (id: string, n: string, x: number, y: number, len: number, rot: number) => [
  `["PIN","${id}",1,null,${x},${y},${len},${rot},null,0,0,1]`,
  `["ATTR","${id}n","${id}","NAME","${n}",false,false,0,0,0,"st1",0]`,
  `["ATTR","${id}u","${id}","NUMBER","${n}",false,false,0,0,0,"st1",0]`,
];
const poly = (id: string, pts: number[], closed = false) => `["POLY","${id}",${JSON.stringify(pts)},${closed ? 1 : 0},"st1",0]`;

export const PASSIVE_SYMBOLS: Record<PassiveKind, string> = {
  resistor: [...head('R', [-20, 4, 20, -4]), `["RECT","b",-10,4,10,-4,0,0,0,"st1",0]`, ...pin('p1', '1', -20, 0, 10, 0), ...pin('p2', '2', 20, 0, 10, 180)].join('\n'),
  capacitor: [...head('C', [-20, 6, 20, -6]), poly('a', [-2, 6, -2, -6]), poly('b', [2, 6, 2, -6]), ...pin('p1', '1', -20, 0, 18, 0), ...pin('p2', '2', 20, 0, 18, 180)].join('\n'),
  inductor: [
    ...head('L', [-20, 5, 20, -1]),
    `["ARC","a1",-10,0,-7.5,2.5,-5,0,"st1",0]`,
    `["ARC","a2",-5,0,-2.5,2.5,0,0,"st1",0]`,
    `["ARC","a3",0,0,2.5,2.5,5,0,"st1",0]`,
    `["ARC","a4",5,0,7.5,2.5,10,0,"st1",0]`,
    ...pin('p1', '1', -20, 0, 10, 0),
    ...pin('p2', '2', 20, 0, 10, 180),
  ].join('\n'),
  ferrite: [...head('FB', [-20, 5, 20, -5]), poly('b', [-10, -2, -6, 4, 10, 2, 6, -4, -10, -2], true), ...pin('p1', '1', -20, 0, 10, 0), ...pin('p2', '2', 20, 0, 10, 180)].join('\n'),
  diode: [...head('D', [-20, 5, 20, -5]), poly('t', [-5, 5, -5, -5, 5, 0, -5, 5], true), poly('k', [5, 5, 5, -5]), ...pin('p2', '2', -20, 0, 15, 0), ...pin('p1', '1', 20, 0, 15, 180)].join('\n'),
  led: [
    ...head('LED', [-20, 13, 20, -5]),
    poly('t', [-5, 5, -5, -5, 5, 0, -5, 5], true),
    poly('k', [5, 5, 5, -5]),
    poly('r1', [0, 6, 4, 10]),
    poly('h1', [4, 10, 1.5, 9.5, 3.5, 7.5, 4, 10], true),
    poly('r2', [3.5, 4.5, 7.5, 8.5]),
    poly('h2', [7.5, 8.5, 5, 8, 7, 6, 7.5, 8.5], true),
    ...pin('p2', '2', -20, 0, 15, 0),
    ...pin('p1', '1', 20, 0, 15, 180),
  ].join('\n'),
};
