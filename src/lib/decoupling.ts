/*
 * Decoupling for an IC, following the schematic-design recipes: 100 nF on every supply pin,
 * 1 µF + 10 nF on analog supplies (VDDA, AVCC…) and a 10 µF bulk capacitor per rail. The
 * capacitors stand in a row under the part, each with its rail's flag above and GND below, so
 * they join the pins by net name; on the board they still need placing next to their pins.
 */
import { useEditor } from '../store/editor';
import { attachPort, connectivity, resolvedPin, type ResolvedPin } from './actions';
import { placePassiveAt } from './passives';
import { boxIntersects, componentBox, normBox, snap, worldPins } from './schematic/geometry';
import { portBox } from './schematic/hit';
import { symbolFor } from './schematic/symbols';
import { sheetOf, sheetView } from './schematic/sheets';
import { parsePassiveValue } from '../shared/passives';
import type { Box } from './easyeda/symbol';
import type { Component, Project, Vec } from './schematic/types';

const st = () => useEditor.getState();

const SUPPLY = /^(A|D)?V(CC|DD)\w*$|^V(BAT|IN|M|S|IO|BUS|OUT)$|^VDDIO\w*$/i;
const ANALOG = /^AV(CC|DD)\w*$|^V(CC|DD)A\w*$/i;
const GROUND = /^(A|D|P)?GND\w*$|^V(SS|EE)\w*$/i;

export interface SupplyPin {
  pin: ResolvedPin;
  /** "1 (VDD)", for messages. */
  label: string;
  /** Named net the pin is on, or null when it isn't connected to a named net yet. */
  rail: string | null;
  analog: boolean;
}

type Conn = ReturnType<typeof connectivity>;

/** Supply pins of a part, recognised by name (VDD, VCC, VDDA, AVCC, VBAT, VIN…), grounds excluded. */
export function supplyPins(c: Component, project: Project = st().project, conn: Conn = connectivity(project)): SupplyPin[] {
  const out: SupplyPin[] = [];
  for (const wp of worldPins(c, symbolFor(project, c.symbolKey))) {
    const name = wp.pin.name.trim();
    if (!SUPPLY.test(name) || GROUND.test(name)) continue;
    const net = conn.pinNet.get(`${c.id}:${wp.pin.id}`);
    const named = net && !conn.nets.find((n) => n.name === net)?.auto ? net : null;
    if (named && GROUND.test(named)) continue;
    out.push({ pin: resolvedPin(wp, c, project), label: name && name !== wp.pin.number ? `${wp.pin.number} (${name})` : wp.pin.number, rail: named, analog: ANALOG.test(name) });
  }
  return out;
}

export interface DecouplingOptions {
  /** Rail for supply pins not yet on a named net; they get its flag too. */
  rail?: string;
  /**
   * Leave out what the rails already have (default true): capacitors to ground count against
   * every supply pin on the rail, whichever part it belongs to, and one bulk capacitor is enough.
   */
  skipExisting?: boolean;
  /** Capacitor per supply pin (default 100n) and its size (default 0603). */
  value?: string;
  size?: string;
  /** A 10 µF bulk capacitor per rail (default true). */
  bulk?: boolean;
}

export interface PlannedCap {
  value: string;
  size: string;
  rail: string;
  /** The supply pin it serves; bulk capacitors serve the rail. */
  pin?: string;
}

/** Voltage in a rail name: +3V3 → 3.3, +12V → 12, VBUS → 5; null when the name doesn't say. */
export function railVoltage(rail: string): number | null {
  if (/^VBUS$/i.test(rail)) return 5;
  const m = /(\d+)V(\d*)/i.exec(rail);
  return m ? Number(`${m[1]}.${m[2] || 0}`) : null;
}

/** A capacitor value with a voltage rating added on rails above 5 V (ceramics lose capacitance under bias). */
function rated(value: string, rail: string): string {
  const v = railVoltage(rail);
  if (v === null || v <= 5 || /\dV\b/i.test(value)) return value;
  const rating = [10, 16, 25, 35, 50, 100].find((r) => r >= 2 * v) ?? 100;
  return `${value} ${rating}V`;
}

const SMALL = 2.2e-6;
const BULK = 4.7e-6;

/** Capacitors between each rail and a ground net: decoupling-sized (≤2.2 µF) and bulk (≥4.7 µF). */
function railCapacitors(project: Project, conn: Conn): Map<string, { small: number; bulk: number }> {
  const out = new Map<string, { small: number; bulk: number }>();
  for (const c of project.components) {
    if (c.generic ? c.generic.kind !== 'capacitor' : !/^C\d/.test(c.designator)) continue;
    const pins = worldPins(c, symbolFor(project, c.symbolKey));
    if (pins.length !== 2) continue;
    const nets = pins.map((p) => conn.pinNet.get(`${c.id}:${p.pin.id}`));
    const ground = nets.findIndex((n) => n && GROUND.test(n));
    const rail = nets[1 - ground];
    if (ground < 0 || !rail || GROUND.test(rail)) continue;
    const farads = parsePassiveValue('capacitor', c.value)?.si;
    if (farads === null || farads === undefined) continue;
    const entry = out.get(rail) ?? { small: 0, bulk: 0 };
    if (farads <= SMALL) entry.small++;
    else if (farads >= BULK) entry.bulk++;
    out.set(rail, entry);
  }
  return out;
}

/** Capacitors each supply pin calls for: two on analog supplies, one otherwise. */
const demand = (p: SupplyPin) => (p.analog ? 2 : 1);

/**
 * The capacitors addDecoupling would add, the supply pins it would connect to `rail`, and what
 * it left out because the rails already have it.
 */
export function planDecoupling(
  c: Component,
  opts: DecouplingOptions = {},
  project: Project = st().project,
): { caps: PlannedCap[]; connect: SupplyPin[]; skipped: string[] } {
  const conn = connectivity(project);
  const pins = supplyPins(c, project, conn);
  if (pins.length === 0) throw new Error(`Found no supply pins (VDD, VCC, VIN…) on ${c.designator}`);
  const loose = pins.filter((p) => !p.rail);
  if (loose.length && !opts.rail?.trim()) {
    throw new Error(`${c.designator} pins ${loose.map((p) => p.label).join(', ')} aren't on a named supply net; give the rail to connect them to (e.g. "+3V3")`);
  }
  const railOf = (p: SupplyPin) => p.rail ?? opts.rail!.trim();
  const size = opts.size ?? '0603';
  const caps: PlannedCap[] = [];
  const skipped: string[] = [];
  const skip = opts.skipExisting !== false;
  const existing = skip ? railCapacitors(project, conn) : new Map<string, { small: number; bulk: number }>();
  // Every part's supply pins, for how many capacitors each rail calls for in all.
  const allPins = skip ? project.components.filter((o) => o.id !== c.id).flatMap((o) => supplyPins(o, project, conn)) : [];
  const rails = [...new Set(pins.map(railOf))];
  for (const rail of rails) {
    const mine = pins.filter((q) => railOf(q) === rail);
    const have = existing.get(rail) ?? { small: 0, bulk: 0 };
    const needed = [...mine, ...allPins.filter((p) => p.rail === rail)].reduce((n, p) => n + demand(p), 0);
    let missing = skip ? needed - have.small : Infinity;
    if (skip && have.small > 0) skipped.push(`${rail} has ${have.small} capacitor${have.small === 1 ? '' : 's'} for ${needed} on its supply pins`);
    for (const p of mine) {
      if (missing < demand(p)) continue;
      missing -= demand(p);
      const pin = `${c.designator}.${p.pin.pin.number}`;
      if (p.analog) caps.push({ value: rated('1u', rail), size, rail, pin }, { value: rated('10n', rail), size, rail, pin });
      else caps.push({ value: rated(opts.value ?? '100n', rail), size, rail, pin });
    }
    if (opts.bulk === false) continue;
    if (skip && have.bulk > 0) skipped.push(`${rail} already has a bulk capacitor`);
    else caps.push({ value: rated('10u', rail), size: '0805', rail });
  }
  return { caps, connect: loose, skipped };
}

const PITCH = 40;

/** Top-left of a free row for `n` upright capacitors below the part (with room for their flags). */
function freeRow(c: Component, n: number, project: Project): Vec {
  const body = componentBox(c, symbolFor(project, c.symbolKey));
  const others: Box[] = [
    ...project.components.filter((o) => o.id !== c.id).map((o) => componentBox(o, symbolFor(project, o.symbolKey))),
    ...project.ports.map(portBox),
    ...project.wires.flatMap((w) => w.points.slice(1).map((p, i) => normBox(w.points[i], p))),
  ];
  const x = snap(body.x1, 10);
  for (let y = snap(body.y2 + 80, 10); y < body.y2 + 1000; y += 40) {
    const row: Box = { x1: x - 25, y1: y - 70, x2: x + (n - 1) * PITCH + 25, y2: y + 70 };
    if (!others.some((b) => boxIntersects(b, row))) return [x, y];
  }
  return [x, snap(body.y2 + 1000, 10)];
}

/**
 * Adds the planned decoupling capacitors for a part as one undo step and connects supply pins
 * that weren't on a named net to `opts.rail`.
 */
export async function addDecoupling(componentId: string, opts: DecouplingOptions = {}): Promise<{ caps: (PlannedCap & { designator: string })[]; connected: string[]; skipped: string[]; ids: string[] }> {
  const project = st().project;
  const c = project.components.find((x) => x.id === componentId);
  if (!c) throw new Error('No such component');
  const plan = planDecoupling(c, opts, project);
  if (plan.caps.length === 0) throw new Error(`Nothing to add for ${c.designator}: ${plan.skipped.join('; ')}`);
  // The capacitors go on the IC's own sheet.
  const sheet = sheetOf(c, project);
  if (st().currentSheet !== sheet) st().setCurrentSheet(sheet);
  const [x0, y0] = freeRow(c, plan.caps.length, sheetView(project, sheet));
  const mark = st().historyMark();
  const before = new Set([...mark.components, ...mark.wires, ...mark.ports].map((i) => i.id));
  try {
    const caps: (PlannedCap & { designator: string })[] = [];
    for (const [i, cap] of plan.caps.entries()) {
      const { component } = await placePassiveAt('capacitor', cap.value, cap.size, [x0 + i * PITCH, y0], 90);
      // Upright, pin 2 is on top.
      attachPort(`${component.designator}.2`, 'power', cap.rail);
      attachPort(`${component.designator}.1`, 'ground', 'GND');
      caps.push({ ...cap, designator: component.designator });
    }
    const connected: string[] = [];
    for (const p of plan.connect) {
      const ref = `${c.designator}.${p.pin.pin.number}`;
      attachPort(ref, 'power', opts.rail!.trim());
      connected.push(ref);
    }
    st().squashHistory(mark);
    const after = st().project;
    const ids = [...after.components, ...after.wires, ...after.ports].map((i) => i.id).filter((i) => !before.has(i));
    return { caps, connected, skipped: plan.skipped, ids };
  } catch (err) {
    st().revertHistory(mark);
    throw err;
  }
}
