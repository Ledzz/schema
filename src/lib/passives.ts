/*
 * Generic passives on the schematic: placing by value + size and matching JLCPCB parts.
 */
import { useEditor, type Placing } from '../store/editor';
import { PASSIVES, PASSIVE_SYMBOLS, parsePassiveValue, type PassiveKind } from '../shared/passives';
import type { PartSummary } from '../shared/parts';
import type { Component } from './schematic/types';
import { onPinGrid, placeComponent } from './actions';

export interface PassiveMatch {
  canonical: string | null;
  candidates: PartSummary[];
  error?: string;
}

const st = () => useEditor.getState();
const PREFS_KEY = 'schematics:passives';

export function passiveDefaults(kind: PassiveKind): { value: string; size: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')[kind];
    if (saved?.value && saved?.size) return saved;
  } catch {
    /* ignore */
  }
  return { value: PASSIVES[kind].defaultValue, size: PASSIVES[kind].defaultSize };
}

function rememberPassive(kind: PassiveKind, value: string, size: string) {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...all, [kind]: { value, size } }));
  } catch {
    /* ignore */
  }
}

export function passiveSymbolKey(kind: PassiveKind): string {
  const key = `builtin:${kind}`;
  if (!st().project.symbols[key]) {
    st().addSymbols({ [key]: { title: PASSIVES[kind].label, dataStr: PASSIVE_SYMBOLS[kind], source: 'builtin' } });
  }
  return key;
}

const matches = new Map<string, Promise<PassiveMatch>>();

export function fetchMatch(kind: PassiveKind, value: string, size: string): Promise<PassiveMatch> {
  const key = `${kind}|${value}|${size}`;
  let hit = matches.get(key);
  if (!hit) {
    hit = fetch(`/api/parts/match?${new URLSearchParams({ kind, value, size })}`).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Match failed (${res.status})`);
      return body as PassiveMatch;
    });
    hit.catch(() => matches.delete(key));
    matches.set(key, hit);
  }
  return hit;
}

const PART_ATTRS = ['Manufacturer', 'Manufacturer Part', 'Datasheet', 'Description', 'Supplier', 'Supplier Part', 'Footprint'];

/** Component fields for a chosen JLCPCB part. */
export function partFields(part: PartSummary, size: string): Pick<Component, 'lcsc' | 'partClass' | 'stock' | 'prices' | 'attrs'> {
  const attrs: Record<string, string> = {
    Package: part.package || size,
    Manufacturer: part.manufacturer,
    'Manufacturer Part': part.mpn,
    Description: part.description,
    Supplier: 'LCSC',
    'Supplier Part': part.lcsc,
  };
  if (part.datasheet) attrs.Datasheet = part.datasheet;
  return { lcsc: part.lcsc, partClass: part.partClass, stock: part.stock, prices: part.prices, attrs };
}

function withoutPart(c: Component, value: string, size: string): Component {
  const attrs = Object.fromEntries(Object.entries(c.attrs).filter(([k]) => !PART_ATTRS.includes(k)));
  return { ...c, value, attrs: { ...attrs, Package: size }, generic: { kind: c.generic!.kind, size }, lcsc: undefined, partClass: undefined, stock: undefined, prices: undefined };
}

function canonical(kind: PassiveKind, value: string): string {
  return parsePassiveValue(kind, value)?.canonical ?? value.trim();
}

/* ---------- placing ---------- */

function passivePlacing(kind: PassiveKind, value: string, size: string): Placing {
  const symbolKey = passiveSymbolKey(kind);
  return {
    symbolKey,
    prefix: PASSIVES[kind].prefix,
    template: { symbolKey, unit: 0, value, rotation: 0, mirror: false, attrs: { Package: size }, generic: { kind, size } },
  };
}

/** Starts placing a generic passive with the last-used value and size. */
export function startPassive(kind: PassiveKind) {
  const { value, size } = passiveDefaults(kind);
  st().startPlacing(passivePlacing(kind, value, size));
  resolvePlacingMatch();
}

/** Changes value/size of the passive being placed. */
export function updatePlacingPassive(patch: { value?: string; size?: string }) {
  const placing = st().placing;
  const g = placing?.template.generic;
  if (!placing || !g) return;
  const value = patch.value !== undefined ? canonical(g.kind, patch.value) : placing.template.value;
  const size = patch.size ?? g.size;
  useEditor.setState({ placing: { ...passivePlacing(g.kind, value, size) } });
  rememberPassive(g.kind, value, size);
  resolvePlacingMatch();
}

/** Picks a specific part for the passive being placed. */
export function pickPlacingPart(part: PartSummary) {
  const placing = st().placing;
  const g = placing?.template.generic;
  if (!placing || !g) return;
  useEditor.setState({ placing: { ...placing, template: { ...placing.template, ...partFields(part, g.size) } } });
}

function resolvePlacingMatch() {
  const placing = st().placing;
  const g = placing?.template.generic;
  if (!placing || !g) return;
  const { value } = placing.template;
  fetchMatch(g.kind, value, g.size)
    .then((m) => {
      const now = st().placing;
      const best = m.candidates[0];
      // Ignore stale answers.
      if (!best || now?.template.value !== value || now.template.generic?.size !== g.size || now.template.lcsc) return;
      useEditor.setState({ placing: { ...now, template: { ...now.template, ...partFields(best, g.size) } } });
    })
    .catch(() => {});
}

/* ---------- editing placed passives ---------- */

/**
 * Sets value and/or size of generic passives and re-matches their LCSC part. The automatic match
 * is folded into the same undo step as the edit.
 */
export async function assignPassive(ids: string[], patch: { value?: string; size?: string }): Promise<void> {
  const targets = st().project.components.filter((c) => ids.includes(c.id) && c.generic);
  if (targets.length === 0) return;
  const next = new Map<string, { value: string; size: string }>();
  for (const c of targets) {
    next.set(c.id, {
      value: patch.value !== undefined ? canonical(c.generic!.kind, patch.value) : c.value,
      size: patch.size ?? c.generic!.size,
    });
  }
  st().commit((doc) => ({
    ...doc,
    components: doc.components.map((c) => {
      const n = next.get(c.id);
      return n ? withoutPart(c, n.value, n.size) : c;
    }),
  }));
  const kind = targets[0].generic!.kind;
  const first = next.get(targets[0].id)!;
  rememberPassive(kind, first.value, first.size);

  await Promise.all(
    [...new Set([...next.values()].map((n) => `${n.value}|${n.size}`))].map(async (key) => {
      const [value, size] = key.split('|');
      const m = await fetchMatch(kind, value, size).catch(() => null);
      const best = m?.candidates[0];
      if (!best) return;
      st().amend((doc) => ({
        ...doc,
        components: doc.components.map((c) =>
          next.has(c.id) && c.value === value && c.generic?.size === size && !c.lcsc ? { ...c, ...partFields(best, size), attrs: { ...c.attrs, ...partFields(best, size).attrs } } : c,
        ),
      }));
    }),
  );
}

/** Uses a specific part for the given passives. */
export function pickPart(ids: string[], part: PartSummary) {
  st().commit((doc) => ({
    ...doc,
    components: doc.components.map((c) => (ids.includes(c.id) && c.generic ? { ...c, ...partFields(part, c.generic.size), attrs: { ...c.attrs, ...partFields(part, c.generic.size).attrs } } : c)),
  }));
}

/** Places a generic passive directly (used by agent tools). */
export async function placePassiveAt(kind: PassiveKind, value: string, size: string, at: [number, number], rotation: Component['rotation'] = 0, designator?: string) {
  const placing = passivePlacing(kind, canonical(kind, value), size);
  const m = await fetchMatch(kind, placing.template.value, size).catch(() => null);
  if (m?.candidates[0]) placing.template = { ...placing.template, ...partFields(m.candidates[0], size) };
  return { component: placeComponent(placing, onPinGrid(placing, at, rotation), rotation, false, designator), match: m };
}

/** Other sizes in which a basic or preferred part exists for this value. */
export async function noFeeSizes(kind: PassiveKind, value: string, except: string): Promise<{ size: string; lcsc: string }[]> {
  const sizes = PASSIVES[kind].sizes.map((s) => s.label).filter((s) => s !== except);
  const found = await Promise.all(
    sizes.map(async (size) => {
      const best = (await fetchMatch(kind, value, size).catch(() => null))?.candidates[0];
      return best && best.partClass !== 'extended' ? { size, lcsc: best.lcsc } : null;
    }),
  );
  return found.filter((f): f is { size: string; lcsc: string } => f !== null);
}
