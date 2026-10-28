/*
 * Circuit blocks: proven sub-circuits (regulator, USB-C power input, crystal, LED…) inserted as
 * real parts with their wiring, taken from the schematic-design skill's recipes. A block places
 * its parts at fixed offsets, then connects them with the same actions agents use (wires between
 * pins, labels and power flags on pins), and the whole insertion is one undo step.
 */
import { useEditor } from '../store/editor';
import type { PassiveKind } from '../shared/passives';
import type { PartClass } from '../shared/parts';
import { attachPort, connectPins, markNoConnect, placePartAt } from './actions';
import { contentBounds, currentView } from './editing';
import { freeGroupName, groupItems } from './grouping';
import { placePassiveAt } from './passives';
import { nextDesignator } from './schematic/designators';
import { snap, worldPins, type WorldPin } from './schematic/geometry';
import { symbolFor } from './schematic/symbols';
import type { Component, Rotation, SchematicGroup, Vec } from './schematic/types';

const st = () => useEditor.getState();

export interface BlockParam {
  key: string;
  label: string;
  default: string;
}

export interface BlockPart {
  /** Name of the part inside the block, used by links ("U", "CIN"). */
  ref: string;
  /** Offset from the block's origin, in schematic units. */
  at: Vec;
  rotation?: Rotation;
  /** A generic passive matched to the cheapest JLCPCB part; `{KEY}` takes a parameter. */
  passive?: { kind: PassiveKind; value: string; size?: string };
  /** A library part, with its JLCPCB type when the block was written (for the fee note). */
  lcsc?: string;
  partClass?: PartClass;
  /** Designator prefix when the library's own is unhelpful (connectors get J). */
  prefix?: string;
  /** What it is, for the block's part list. */
  role: string;
}

/**
 * How parts connect. Pins are "REF.PIN" with a pin number or name, or REF.@top / @bottom /
 * @left / @right for the pin on that side (two-pin parts placed upright or flat). Net names take
 * `{KEY}` parameters and `$REF` designators, for nets private to one copy of the block.
 */
export type BlockLink =
  | { wire: [string, string] }
  | { power: string; pins: string[] }
  | { ground: string; pins: string[] }
  | { label: string; pins: string[] }
  | { nc: string[] };

export interface CircuitBlock {
  id: string;
  title: string;
  description: string;
  params: BlockParam[];
  parts: BlockPart[];
  links: BlockLink[];
}

const cap = (ref: string, at: Vec, value: string, role: string, size = '0603'): BlockPart => ({ ref, at, rotation: 90, passive: { kind: 'capacitor', value, size }, role });
const res = (ref: string, at: Vec, value: string, role: string, rotation: Rotation = 90): BlockPart => ({ ref, at, rotation, passive: { kind: 'resistor', value, size: '0603' }, role });

export const BLOCKS: CircuitBlock[] = [
  {
    id: 'ldo-3v3',
    title: '3.3 V regulator (AMS1117)',
    description: 'AMS1117-3.3 linear regulator, up to 1 A, with 10 µF in and 22 µF out (the datasheet asks for ≥22 µF for stability). Needs at least 4.5 V in, so it suits USB 5 V.',
    params: [
      { key: 'VIN', label: 'Input rail', default: '+5V' },
      { key: 'VOUT', label: 'Output rail', default: '+3V3' },
    ],
    parts: [
      { ref: 'U', at: [0, 0], lcsc: 'C6186', partClass: 'basic', role: 'AMS1117-3.3 regulator' },
      cap('CIN', [-110, 90], '10u', 'input capacitor', '0805'),
      cap('COUT', [110, 90], '22u', 'output capacitor', '0805'),
    ],
    links: [
      { power: '{VIN}', pins: ['U.VIN', 'CIN.@top'] },
      { power: '{VOUT}', pins: ['U.2', 'U.4', 'COUT.@top'] },
      { ground: 'GND', pins: ['U.GND', 'CIN.@bottom', 'COUT.@bottom'] },
    ],
  },
  {
    id: 'usb-c-power',
    title: 'USB-C power input (5 V)',
    description:
      'Power-only Type-C receptacle with a separate 5.1 kΩ from each CC pin to GND, so C-to-C chargers supply 5 V, and 10 µF on VBUS. The connector is an Extended part ($3 setup fee).',
    params: [{ key: 'RAIL', label: 'VBUS rail', default: '+5V' }],
    parts: [
      // Its pins all face left, so the rest of the block sits on that side.
      { ref: 'J', at: [0, 0], lcsc: 'C456012', partClass: 'extended', prefix: 'J', role: 'Type-C 6P receptacle' },
      // CC1 is the upper pin, so its resistor goes further out and the wires don't cross.
      res('RCC1', [-180, 110], '5.1k', 'CC1 pull-down'),
      res('RCC2', [-130, 110], '5.1k', 'CC2 pull-down'),
      cap('C', [-250, 110], '10u', 'VBUS bulk capacitor', '0805'),
    ],
    links: [
      { wire: ['J.A5', 'RCC1.@top'] },
      { wire: ['J.B5', 'RCC2.@top'] },
      { power: '{RAIL}', pins: ['J.A9', 'J.B9', 'C.@top'] },
      { ground: 'GND', pins: ['J.A12', 'J.B12', 'J.7', 'RCC1.@bottom', 'RCC2.@bottom', 'C.@bottom'] },
    ],
  },
  {
    id: 'led',
    title: 'Indicator LED',
    description: 'LED with a series resistor to GND, lit when the net goes high. 1 kΩ gives 1–3 mA for red or yellow on 3.3–5 V; green, blue and white need 5 V or about 100 Ω on 3.3 V.',
    params: [
      { key: 'NET', label: 'Driven by net', default: 'LED' },
      { key: 'COLOR', label: 'Colour', default: 'Red' },
      { key: 'R', label: 'Resistor', default: '1k' },
    ],
    parts: [res('R', [0, 0], '{R}', 'current-limiting resistor', 0), { ref: 'D', at: [80, 0], passive: { kind: 'led', value: '{COLOR}', size: '0603' }, role: 'LED' }],
    links: [
      { label: '{NET}', pins: ['R.@left'] },
      { wire: ['R.@right', 'D.A'] },
      { ground: 'GND', pins: ['D.K'] },
    ],
  },
  {
    id: 'i2c-pullups',
    title: 'I2C pull-ups',
    description: 'One 4.7 kΩ pull-up each on SDA and SCL, once per bus. Use 2.2 kΩ for 400 kHz or long, heavily loaded buses.',
    params: [
      { key: 'VDD', label: 'Bus voltage rail', default: '+3V3' },
      { key: 'SDA', label: 'SDA net', default: 'SDA' },
      { key: 'SCL', label: 'SCL net', default: 'SCL' },
      { key: 'R', label: 'Resistors', default: '4.7k' },
    ],
    parts: [res('RSDA', [0, 0], '{R}', 'SDA pull-up'), res('RSCL', [50, 0], '{R}', 'SCL pull-up')],
    links: [
      { power: '{VDD}', pins: ['RSDA.@top', 'RSCL.@top'] },
      { label: '{SDA}', pins: ['RSDA.@bottom'] },
      { label: '{SCL}', pins: ['RSCL.@bottom'] },
    ],
  },
  {
    id: 'button',
    title: 'Push button',
    description: 'Tact switch from the net to GND with a 10 kΩ pull-up and 100 nF across it for debouncing (leave out the capacitor if the firmware debounces). Reads low while pressed.',
    params: [
      { key: 'NET', label: 'Net', default: 'BTN' },
      { key: 'VDD', label: 'Pull-up rail', default: '+3V3' },
    ],
    parts: [
      { ref: 'SW', at: [0, 0], lcsc: 'C318884', partClass: 'basic', role: 'TS-1187A tact switch' },
      res('R', [-100, -10], '10k', 'pull-up'),
      cap('C', [100, 20], '100n', 'debounce capacitor'),
    ],
    links: [
      { label: '{NET}', pins: ['SW.1', 'R.@bottom', 'C.@top'] },
      { power: '{VDD}', pins: ['R.@top'] },
      { ground: 'GND', pins: ['SW.4', 'C.@bottom'] },
      // The pins join in pairs inside; diagonally opposite ones work whichever way the pairs run.
      { nc: ['SW.2', 'SW.3'] },
    ],
  },
  {
    id: 'reset-rc',
    title: 'Reset / enable RC',
    description: '10 kΩ pull-up and 100 nF to GND on a reset or enable pin, so the chip starts once its supply is stable. For Espressif modules use 1 µF on EN.',
    params: [
      { key: 'NET', label: 'Net', default: 'NRST' },
      { key: 'VDD', label: 'Pull-up rail', default: '+3V3' },
      { key: 'C', label: 'Capacitor', default: '100n' },
    ],
    parts: [res('R', [0, 0], '10k', 'pull-up'), cap('C', [60, 0], '{C}', 'delay capacitor')],
    links: [
      { power: '{VDD}', pins: ['R.@top'] },
      { label: '{NET}', pins: ['R.@bottom', 'C.@top'] },
      { ground: 'GND', pins: ['C.@bottom'] },
    ],
  },
  {
    id: 'crystal',
    title: 'Crystal with load capacitors',
    description: '8 MHz crystal (20 pF load) with a load capacitor from each side to GND: C ≈ 2 × (C_L − 4 pF) = 33 pF. Place it right next to the MCU’s oscillator pins on the board.',
    params: [
      { key: 'XIN', label: 'Oscillator in net', default: 'OSC_IN' },
      { key: 'XOUT', label: 'Oscillator out net', default: 'OSC_OUT' },
      { key: 'C', label: 'Load capacitors', default: '33p' },
    ],
    parts: [
      { ref: 'Y', at: [0, 0], lcsc: 'C115962', partClass: 'basic', prefix: 'Y', role: '8 MHz crystal, 20 pF load' },
      cap('C1', [-60, 70], '{C}', 'load capacitor'),
      cap('C2', [60, 70], '{C}', 'load capacitor'),
    ],
    links: [
      { wire: ['Y.OSC1', 'C1.@top'] },
      { wire: ['Y.OSC2', 'C2.@top'] },
      { label: '{XIN}', pins: ['Y.OSC1'] },
      { label: '{XOUT}', pins: ['Y.OSC2'] },
      { ground: 'GND', pins: ['C1.@bottom', 'C2.@bottom'] },
    ],
  },
  {
    id: 'ne555-astable',
    title: '555 timer, astable',
    description: 'NE555 oscillator: f ≈ 1.44 / ((RA + 2·RB)·C), 1 Hz with the defaults. Ceramic capacitors lose capacitance under bias, so expect it to run 10–20 % fast. Includes 10 nF on CONT and 100 nF + 10 µF across the supply.',
    params: [
      { key: 'VCC', label: 'Supply rail', default: '+5V' },
      { key: 'OUT', label: 'Output net', default: 'OUT' },
      { key: 'RA', label: 'RA', default: '10k' },
      { key: 'RB', label: 'RB', default: '68k' },
      { key: 'C', label: 'Timing capacitor', default: '10u' },
    ],
    parts: [
      { ref: 'U', at: [0, 0], lcsc: 'C7593', partClass: 'preferred', role: 'NE555DR timer' },
      res('RA', [-140, -70], '{RA}', 'RA, VCC to DISCH'),
      res('RB', [-140, 10], '{RB}', 'RB, DISCH to THRES'),
      cap('CT', [-140, 90], '{C}', 'timing capacitor', '0805'),
      cap('CC', [130, 70], '10n', 'CONT filter'),
      cap('CB', [180, 70], '100n', 'supply decoupling'),
      cap('CBULK', [230, 70], '10u', 'supply bulk', '0805'),
    ],
    links: [
      { power: '{VCC}', pins: ['U.VCC', 'U.RST', 'RA.@top', 'CB.@top', 'CBULK.@top'] },
      { label: '$U_DIS', pins: ['U.DISCH', 'RA.@bottom', 'RB.@top'] },
      { label: '$U_THR', pins: ['U.THRES', 'U.TRIG', 'RB.@bottom', 'CT.@top'] },
      { wire: ['U.CONT', 'CC.@top'] },
      { label: '{OUT}', pins: ['U.OUT'] },
      { ground: 'GND', pins: ['U.GND', 'CT.@bottom', 'CC.@bottom', 'CB.@bottom', 'CBULK.@bottom'] },
    ],
  },
  {
    id: 'swd-header',
    title: 'SWD programming header',
    description: '1×4 2.54 mm header with the supply, SWDIO, SWCLK and GND for an ST-Link or similar. Extended part ($3 setup fee) and through-hole: often left out of assembly and soldered by hand.',
    params: [
      { key: 'VDD', label: 'Supply rail', default: '+3V3' },
      { key: 'SWDIO', label: 'SWDIO net', default: 'SWDIO' },
      { key: 'SWCLK', label: 'SWCLK net', default: 'SWCLK' },
    ],
    parts: [{ ref: 'J', at: [0, 0], lcsc: 'C2691448', partClass: 'extended', prefix: 'J', role: '1×4 2.54 mm pin header' }],
    links: [
      { power: '{VDD}', pins: ['J.1'] },
      { label: '{SWDIO}', pins: ['J.2'] },
      { label: '{SWCLK}', pins: ['J.3'] },
      { ground: 'GND', pins: ['J.4'] },
    ],
  },
  {
    id: 'divider',
    title: 'Voltage divider',
    description: 'Two resistors scaling a voltage down for an ADC: OUT = IN × R2 / (R1 + R2). 100 kΩ / 10 kΩ turns 12 V into 1.09 V.',
    params: [
      { key: 'IN', label: 'Input net', default: '+12V' },
      { key: 'OUT', label: 'Output net', default: 'VSENSE' },
      { key: 'R1', label: 'R1 (top)', default: '100k' },
      { key: 'R2', label: 'R2 (bottom)', default: '10k' },
    ],
    parts: [res('R1', [0, 0], '{R1}', 'top resistor'), res('R2', [0, 80], '{R2}', 'bottom resistor')],
    links: [
      { power: '{IN}', pins: ['R1.@top'] },
      { wire: ['R1.@bottom', 'R2.@top'] },
      { label: '{OUT}', pins: ['R1.@bottom'] },
      { ground: 'GND', pins: ['R2.@bottom'] },
    ],
  },
];

export interface InsertedBlock {
  /** Designator of each part, by its name in the block. */
  parts: Record<string, string>;
  nets: string[];
  /** Ids of everything the block added, to select it. */
  ids: string[];
  /** The frame drawn around it, when one was asked for. */
  group?: SchematicGroup;
}

/** Where a block goes when no position is given: right of the whole drawing, top-aligned with it. */
function freeOrigin(block: CircuitBlock): Vec {
  const bounds = contentBounds(currentView());
  if (!bounds) return [0, 0];
  // Offsets are part centres: leave room for half a part and its flags as well.
  const minX = Math.min(...block.parts.map((p) => p.at[0]));
  const minY = Math.min(...block.parts.map((p) => p.at[1]));
  return [snap(bounds.x2 + 140 - minX, 10), snap(bounds.y1 + 60 - minY, 10)];
}

const SIDES: Record<string, (a: WorldPin, b: WorldPin) => number> = {
  '@top': (a, b) => a.at[1] - b.at[1],
  '@bottom': (a, b) => b.at[1] - a.at[1],
  '@left': (a, b) => a.at[0] - b.at[0],
  '@right': (a, b) => b.at[0] - a.at[0],
};

/**
 * Inserts a block at `at` (default: right of the drawing). Parameters left out take their
 * defaults; unknown ones are refused. With `group`, a frame of that name is drawn around what
 * was inserted. If any step fails, nothing of the block is kept.
 */
export async function insertBlock(id: string, params: Record<string, string> = {}, at?: Vec, group?: string): Promise<InsertedBlock> {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No block "${id}". Blocks: ${BLOCKS.map((b) => b.id).join(', ')}`);
  const unknown = Object.keys(params).filter((k) => !block.params.some((p) => p.key === k));
  if (unknown.length) throw new Error(`${block.id} has no parameter ${unknown.join(', ')}. Parameters: ${block.params.map((p) => p.key).join(', ')}`);
  const values = Object.fromEntries(block.params.map((p) => [p.key, params[p.key]?.trim() || p.default]));
  const placed = new Map<string, Component>();
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m).replace(/\$([A-Z][A-Z0-9]*)/g, (m, ref: string) => placed.get(ref)?.designator ?? m);

  const origin = at ?? freeOrigin(block);
  const mark = st().historyMark();
  const before = new Set([...mark.components, ...mark.wires, ...mark.ports].map((i) => i.id));
  try {
    for (const part of block.parts) {
      const pos: Vec = [origin[0] + part.at[0], origin[1] + part.at[1]];
      const rotation = part.rotation ?? 0;
      const c = part.passive
        ? (await placePassiveAt(part.passive.kind, fill(part.passive.value), part.passive.size ?? '0603', pos, rotation)).component
        : await placePartAt(part.lcsc!, { x: pos[0], y: pos[1], rotation, designator: part.prefix ? nextDesignator(part.prefix, st().project.components) : undefined });
      placed.set(part.ref, c);
    }

    // "REF.PIN" → a pin reference the actions understand ("R3.2").
    const pinRef = (ref: string): string => {
      const dot = ref.indexOf('.');
      const c = placed.get(ref.slice(0, dot));
      if (!c) throw new Error(`Block ${block.id}: no part ${ref.slice(0, dot)}`);
      const pin = ref.slice(dot + 1);
      const side = SIDES[pin];
      if (!side) return `${c.designator}.${pin}`;
      const pins = worldPins(c, symbolFor(st().project, c.symbolKey));
      return `${c.designator}.${pins.sort(side)[0].pin.number}`;
    };

    const nets = new Set<string>();
    for (const link of block.links) {
      if ('wire' in link) {
        const [a, b] = link.wire.map(pinRef);
        try {
          connectPins(a, b);
        } catch {
          // No clear path in a crowded spot: join them by a label instead.
          const name = `${a.replace('.', '_')}`;
          attachPort(a, 'label', name);
          attachPort(b, 'label', name);
          nets.add(name);
        }
      } else if ('nc' in link) {
        for (const p of link.nc) markNoConnect(pinRef(p));
      } else {
        const kind = 'power' in link ? 'power' : 'ground' in link ? 'ground' : 'label';
        const name = fill('power' in link ? link.power : 'ground' in link ? link.ground : link.label);
        for (const p of link.pins) attachPort(pinRef(p), kind, name);
        nets.add(name);
      }
    }
    const project = st().project;
    const ids = [...project.components, ...project.wires, ...project.ports].map((i) => i.id).filter((i) => !before.has(i));
    const frame = group?.trim() ? groupItems(ids, freeGroupName(group.trim())) : undefined;
    st().squashHistory(mark);
    return { parts: Object.fromEntries([...placed].map(([ref, c]) => [ref, c.designator])), nets: [...nets], ids, group: frame };
  } catch (err) {
    st().revertHistory(mark);
    throw err;
  }
}
