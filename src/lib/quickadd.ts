/*
 * Quick add: type what you want at the cursor ("10k 0603", "100n", "LED red", "+3V3", "GND",
 * "SDA", "AMS1117", a block or a part already in the design) and place it right there. This
 * module turns the typed text into ranked suggestions and places the chosen one; the box on the
 * canvas and its live JLCPCB search live in components/canvas/QuickAdd.tsx.
 */
import { useEditor, type Placing } from '../store/editor';
import { addPort, commitAttach, connectivity, endByKey, onPinGrid, placeComponent, placePartAt, planAttach } from './actions';
import { BLOCKS, insertBlock } from './blocks';
import { placeCustomPart } from './library';
import { passiveDefaults, placePassiveAt } from './passives';
import { splitDesignator } from './schematic/designators';
import { snapVec } from './schematic/geometry';
import { connectionNear } from './schematic/hit';
import { portRotationFor } from './schematic/route';
import { resolverFor } from './schematic/symbols';
import { sheetsOf, sheetView } from './schematic/sheets';
import type { Component, Project, Vec } from './schematic/types';
import { insertUserBlock, loadUserBlocks, type UserBlock } from './userBlocks';
import { PASSIVES, parsePassiveValue, type PassiveKind } from '../shared/passives';
import type { PartSummary } from '../shared/parts';

const st = () => useEditor.getState();

export type QuickItem =
  | { kind: 'passive'; passive: PassiveKind; value: string; size: string }
  | { kind: 'power' | 'ground' | 'label' | 'hier'; name: string }
  | { kind: 'noconnect' }
  | { kind: 'same'; componentId: string }
  | { kind: 'custom'; name: string }
  | { kind: 'block'; id: string }
  | { kind: 'userBlock'; id: string }
  | { kind: 'library'; part: PartSummary };

export interface Suggestion {
  item: QuickItem;
  title: string;
  detail: string;
  /** A rail or net already in the design. */
  known?: boolean;
}

/** Words that name a passive kind, as typed before or after the value ("R 10k", "100n cap"). */
const KIND_WORDS: Record<string, PassiveKind> = {
  r: 'resistor',
  res: 'resistor',
  resistor: 'resistor',
  c: 'capacitor',
  cap: 'capacitor',
  capacitor: 'capacitor',
  l: 'inductor',
  ind: 'inductor',
  inductor: 'inductor',
  fb: 'ferrite',
  bead: 'ferrite',
  ferrite: 'ferrite',
  led: 'led',
  d: 'diode',
  diode: 'diode',
};

const RAIL = /^\+?(\d+(?:\.\d+)?)V(\d*)$/i;
const NAMED_RAIL = /^V(CC|DD|BAT|BUS|IN|SYS|M|IO|REF)[A-Z0-9]*$/i;
const GROUND = /^(A|D|P|SGND|CHASSIS)?GND\w*$|^VSS\w*$|^0V$/i;
const NET_NAME = /^[A-Za-z_][\w./+\-[\]]*$/;

/** A rail as flags usually name it: "3v3" → "+3V3", "5v" → "+5V", "vcc" → "VCC". */
function railName(text: string): string | null {
  const m = RAIL.exec(text);
  if (m) return `+${m[1]}V${m[2]}`;
  return NAMED_RAIL.test(text) ? text.toUpperCase() : null;
}

/** Values in a range parts come in, so "10k" isn't offered as a 10 kF capacitor. */
const PLAUSIBLE: Partial<Record<PassiveKind, [number, number]>> = { resistor: [0, 1e9], capacitor: [1e-13, 1], inductor: [1e-9, 1], ferrite: [0, 1e4] };

/** Passives the text describes: a value, optionally with a kind word and a size. */
function passives(query: string): Suggestion[] {
  const words = query.split(/\s+/).filter(Boolean);
  const named = words.map((w) => KIND_WORDS[w.toLowerCase()]).find(Boolean);
  const rest = words.filter((w) => !KIND_WORDS[w.toLowerCase()]);
  // Without a kind word, try the kinds whose values can't be mistaken for each other.
  const kinds: PassiveKind[] = named ? [named] : ['resistor', 'capacitor', ...(/h\b/i.test(query) ? (['inductor'] as const) : []), ...(/@|mhz/i.test(query) ? (['ferrite'] as const) : [])];
  const out: Suggestion[] = [];
  for (const kind of kinds) {
    const spec = PASSIVES[kind];
    const sized = rest.find((w) => spec.sizes.some((s) => s.label.toLowerCase() === w.toLowerCase()));
    const size = sized ? spec.sizes.find((s) => s.label.toLowerCase() === sized.toLowerCase())!.label : passiveDefaults(kind).size;
    const valueText = rest.filter((w) => w !== sized).join(' ') || (named ? passiveDefaults(kind).value : '');
    if (!valueText) continue;
    // LEDs take a colour, diodes a part number; neither is guessed without the word.
    if ((kind === 'led' || kind === 'diode') && !named) continue;
    const parsed = parsePassiveValue(kind, valueText);
    const range = PLAUSIBLE[kind];
    if (!parsed || (range && parsed.si !== null && (parsed.si < range[0] || parsed.si > range[1]))) continue;
    out.push({ item: { kind: 'passive', passive: kind, value: parsed.canonical, size }, title: `${spec.label} ${parsed.canonical}`, detail: `${size} · cheapest JLCPCB part in stock` });
  }
  return out;
}

/** Copies of parts already in the design that the text matches, one per distinct part. */
function sameParts(query: string, project: Project): Suggestion[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const c of [...project.components].reverse()) {
    const key = c.lcsc ?? `${c.symbolKey}|${c.value}|${c.generic?.size ?? ''}`;
    if (seen.has(key)) continue;
    const text = [c.value, c.attrs['Manufacturer Part'], c.lcsc].filter(Boolean).join(' ').toLowerCase();
    if (q && !text.includes(q)) continue;
    seen.add(key);
    out.push({ item: { kind: 'same', componentId: c.id }, title: `Another ${c.value}`, detail: `like ${c.designator}${c.generic ? ` · ${c.generic.size}` : ''}${c.lcsc ? ` · ${c.lcsc}` : ''}` });
  }
  return out.slice(0, 3);
}

/** Every word of the query appears in the text. */
const allWords = (query: string, text: string) => query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));

/**
 * Suggestions for what was typed, best first. Over a pin (`onPin`) names become labels or flags
 * on that pin. JLCPCB search results are not included: the box fetches and appends them.
 */
export function quickSuggestions(query: string, project: Project, opts: { onPin?: boolean; userBlocks?: UserBlock[] } = {}): Suggestion[] {
  const q = query.trim();
  const conn = connectivity(project);
  const rails = [...new Set(project.ports.filter((p) => p.kind === 'power' && p.name.trim()).map((p) => p.name))];
  const flags: Suggestion[] = [];
  const where = opts.onPin ? ' on this pin' : '';
  if (!q) {
    // Nothing typed yet: the design's rails and ground, and the parts placed last.
    for (const r of rails.slice(0, 4)) flags.push({ item: { kind: 'power', name: r }, title: `Power flag ${r}`, detail: `rail in this design${where}`, known: true });
    flags.push({ item: { kind: 'ground', name: 'GND' }, title: 'Ground', detail: `GND${where}` });
    return [...flags, ...sameParts('', project)];
  }

  const rail = railName(q);
  const existingRail = rails.find((r) => r.toLowerCase() === (rail ?? q).toLowerCase() || r.replace(/^\+/, '').toLowerCase() === q.replace(/^\+/, '').toLowerCase());
  if (existingRail || rail) flags.push({ item: { kind: 'power', name: existingRail ?? rail! }, title: `Power flag ${existingRail ?? rail}`, detail: existingRail ? `rail in this design${where}` : `new rail${where}`, known: !!existingRail });
  if (GROUND.test(q)) flags.push({ item: { kind: 'ground', name: q.toUpperCase() }, title: `Ground ${q.toUpperCase()}`, detail: `ground flag${where}` });
  if (opts.onPin && /^(nc|no.?connect)$/i.test(q)) flags.push({ item: { kind: 'noconnect' }, title: 'No-connect', detail: 'mark this pin as unused' });

  const labels: Suggestion[] = [];
  // A rail-like name can still be meant as a label (VBUS on a connector, say): offer both.
  if (NET_NAME.test(q) && !GROUND.test(q) && !RAIL.test(q)) {
    const nets = conn.nets.filter((n) => !n.auto && n.name.toLowerCase().startsWith(q.toLowerCase()) && !rails.includes(n.name)).map((n) => n.name);
    const exact = nets.find((n) => n.toLowerCase() === q.toLowerCase());
    for (const n of [...new Set([exact ?? q, ...nets])].slice(0, 4)) {
      labels.push({ item: { kind: 'label', name: n }, title: `Net label ${n}`, detail: `${nets.includes(n) ? 'joins the existing net' : 'new net'}${where}`, known: nets.includes(n) || undefined });
    }
    if (sheetsOf(project).length > 1) labels.push({ item: { kind: 'hier', name: exact ?? q }, title: `Hierarchical port ${exact ?? q}`, detail: `a pin of this sheet’s block${where}` });
  }

  const custom: Suggestion[] = (project.parts ?? [])
    .filter((p) => allWords(q, `${p.name} ${p.value} ${p.attrs['Manufacturer Part'] ?? ''}`))
    .map((p) => ({ item: { kind: 'custom', name: p.name }, title: p.name, detail: `custom part${p.lcsc ? ` · ${p.lcsc}` : ''}` }));
  const blocks: Suggestion[] = BLOCKS.filter((b) => allWords(q, `${b.id} ${b.title}`)).map((b) => ({ item: { kind: 'block', id: b.id }, title: b.title, detail: 'circuit block with default rails and values' }));
  const saved: Suggestion[] = (opts.userBlocks ?? []).filter((b) => allWords(q, b.title)).map((b) => ({ item: { kind: 'userBlock', id: b.id }, title: b.title, detail: 'your block' }));
  const parts = passives(q);

  // On a pin, naming it comes first; elsewhere what is placed is more likely a part.
  return opts.onPin ? [...flags, ...labels, ...parts, ...sameParts(q, project), ...custom, ...blocks, ...saved] : [...parts, ...flags, ...sameParts(q, project), ...custom, ...blocks, ...saved, ...labels];
}

/** Whether the text is worth a JLCPCB keyword search: not a value, a rail, a net of the design, or too short. */
export function searchesLibrary(query: string, suggestions: Suggestion[]): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return false;
  const top = suggestions[0];
  if (top && (top.item.kind === 'passive' || top.item.kind === 'power' || top.item.kind === 'ground' || top.item.kind === 'noconnect')) return false;
  return !suggestions.some((s) => s.known && 'name' in s.item && s.item.name.toLowerCase() === q);
}

/** A placement template copying a part already in the design. */
function placingLike(c: Component): Placing {
  const template: Placing['template'] = { ...c, rotation: 0, mirror: false, attrs: { ...c.attrs } };
  for (const key of ['id', 'x', 'y', 'designator', 'sheet'] as const) delete (template as Partial<Component>)[key];
  return { symbolKey: c.symbolKey, prefix: splitDesignator(c.designator).prefix || 'U', template };
}

/**
 * Places a suggestion at `at` (world, on the current sheet), or names the pin `pinKey` with a
 * label or flag. Returns the ids of what was added, to select.
 */
export async function placeQuickItem(item: QuickItem, at: Vec, pinKey?: string | null): Promise<string[]> {
  const pin = pinKey ? endByKey(pinKey) : null;
  switch (item.kind) {
    case 'power':
    case 'ground':
    case 'label':
    case 'hier': {
      if (pin) {
        const plan = planAttach(st().project, pin, item.kind, item.name);
        if (plan) return [commitAttach(plan).id];
        return [addPort(item.kind, item.name, pin.at, portRotationFor(item.kind, [-pin.dir[0], -pin.dir[1]]), pin.sheet).id];
      }
      return [addPort(item.kind, item.name, at).id];
    }
    case 'noconnect':
      return pin ? [addPort('noconnect', '', pin.at, 0, pin.sheet).id] : [];
    case 'passive':
      return [(await placePassiveAt(item.passive, item.value, item.size, at)).component.id];
    case 'same': {
      const c = st().project.components.find((x) => x.id === item.componentId);
      if (!c) throw new Error('That part is no longer in the design');
      const placing = placingLike(c);
      return [placeComponent(placing, onPinGrid(placing, at, 0)).id];
    }
    case 'custom':
      return [placeCustomPart(item.name, { x: at[0], y: at[1] }).id];
    case 'block':
      return (await insertBlock(item.id, {}, at)).ids;
    case 'userBlock': {
      const block = loadUserBlocks().find((b) => b.id === item.id);
      if (!block) throw new Error('That block was deleted');
      return insertUserBlock(block, {}, at);
    }
    case 'library':
      return [(await placePartAt(item.part.lcsc, { x: at[0], y: at[1] })).id];
  }
}

/**
 * Opens the quick add box at `at` (world), or at the cursor when it is over the canvas, else in
 * the middle of the view. Over a pin, the box names that pin.
 */
export function openQuickAdd(at?: Vec) {
  const s = st();
  const { view, canvasSize: size, cursor } = s;
  const onScreen = ([x, y]: Vec) => {
    const [sx, sy] = [x * view.zoom + view.x, y * view.zoom + view.y];
    return sx >= 0 && sy >= 0 && sx <= size.width && sy <= size.height;
  };
  const middle: Vec = [(size.width / 2 - view.x) / view.zoom, (size.height / 2 - view.y) / view.zoom];
  const point = at ?? (onScreen(cursor) ? cursor : snapVec(middle));
  const project = sheetView(s.project, s.currentSheet);
  const hit = connectionNear(project, resolverFor(project), point, 6 / view.zoom);
  const pin = hit && (hit.kind === 'pin' || hit.kind === 'block') && hit.ref ? hit : null;
  if (s.tool !== 'select') s.setTool('select');
  s.setQuickAdd({ at: pin ? pin.at : snapVec(point), pin: pin?.ref ?? null, pinLabel: pin?.label });
}
