/*
 * Parts made in the project: symbols generated from a pin list or drawn in the symbol editor,
 * footprints generated from a package or edited pad by pad, and parts pairing a symbol with a
 * footprint and the fields placed copies carry. They live in the project file under "user:" keys,
 * so a design opens anywhere with them; placed parts share their symbol and footprint, so editing
 * one updates every copy.
 */
import { useEditor, type Placing } from '../store/editor';
import { fetchPartDetail } from './api';
import { connectivity, onPinGrid, nextFreePosition, placeComponent } from './actions';
import type { SymbolDef } from './easyeda/symbol';
import { footprintGeom } from './pcb/board';
import { builtinFootprintDoc, parsePcbFootprint, type FootprintGeom } from './pcb/footprint';
import { padNumbers } from './pcb/ipc';
import type { StoredFootprint } from './pcb/types';
import { followPins, newId, symbolPinMoves } from './schematic/ops';
import { pinProblems, withBounds } from './schematic/symbolgen';
import { resolverFor, symbolFor } from './schematic/symbols';
import type { Component, CustomPart, Project, Rotation, Vec } from './schematic/types';

const st = () => useEditor.getState();

const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.+]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

/** Project key for a symbol or footprint made in the app. */
export const userKey = (name: string) => `user:${slug(name)}`;

/** Symbols made in the project, by key. */
export const userSymbols = (project: Project = st().project) => Object.entries(project.symbols).filter(([, s]) => s.source === 'user');
export const userFootprints = (project: Project = st().project) => Object.entries(project.footprints ?? {});

/** Nets a change joined together, as "A and B", matching pins by number. */
function joinedNets(before: Project, after: Project): string[] {
  const was = new Map<string, string>();
  for (const n of connectivity(before).nets) for (const m of n.members) was.set(`${m.componentId}:${m.pinNumber}`, n.name);
  const out: string[] = [];
  for (const n of connectivity(after).nets) {
    const names = new Set(n.members.map((m) => was.get(`${m.componentId}:${m.pinNumber}`)).filter(Boolean));
    if (names.size > 1) out.push([...names].join(' and '));
  }
  return out;
}

/**
 * Saves a symbol under its name, replacing one of that name: every part using it is redrawn, its
 * wires staying on pins of the same number. Returns its key and any nets the redraw joined.
 */
export function saveSymbol(name: string, def: SymbolDef, key = userKey(name)): { key: string; joined: string[] } {
  const title = name.trim();
  if (!title) throw new Error('Give the symbol a name');
  if (!def.units.some((u) => u.pins.length)) throw new Error('A symbol needs at least one pin');
  const problems = pinProblems(def);
  if (problems.length) throw new Error(problems.join('; '));
  const stored = { title, dataStr: '', source: 'user' as const, def: withBounds({ ...def, title }) };
  const before = st().project;
  st().commit((doc) => {
    // Parts using the symbol keep their wires on pins of the same number.
    const symbols = { ...doc.symbols, [key]: stored };
    const users = new Set(doc.components.filter((c) => c.symbolKey === key).map((c) => c.id));
    return followPins({ ...doc, symbols }, symbolPinMoves(doc, users, resolverFor(doc), resolverFor({ symbols })));
  });
  return { key, joined: before.components.some((c) => c.symbolKey === key) ? joinedNets(before, st().project) : [] };
}

/** Saves a footprint under its name (replacing one of that name, also on the board); returns its key. */
export function saveFootprint(name: string, geom: FootprintGeom, key = userKey(name)): string {
  const title = name.trim();
  if (!title) throw new Error('Give the footprint a name');
  if (!geom.pads.length) throw new Error('A footprint needs at least one pad');
  if (geom.pads.some((p) => !p.number.trim())) throw new Error('Every pad needs a number');
  const stored: StoredFootprint = { title, dataStr: '', source: 'user', geom };
  st().commit((doc) => ({
    ...doc,
    footprints: { ...doc.footprints, [key]: stored },
    // Parts already on the board take the new pads at once.
    pcb: doc.pcb?.footprints[key] ? { ...doc.pcb, footprints: { ...doc.pcb.footprints, [key]: stored } } : doc.pcb,
  }));
  return key;
}

/** Pin numbers of a symbol (all units). */
export const symbolPinNumbers = (def: SymbolDef) => [...new Set(def.units.flatMap((u) => u.pins.map((p) => p.number)))];

/** What doesn't match between a symbol's pins and a footprint's pads. */
export function pinPadMismatch(def: SymbolDef, fp: FootprintGeom): { pinsWithoutPad: string[]; padsWithoutPin: string[] } {
  const pins = symbolPinNumbers(def);
  const pads = padNumbers(fp);
  return { pinsWithoutPad: pins.filter((n) => !pads.includes(n)), padsWithoutPin: pads.filter((n) => !pins.includes(n)) };
}

/** Warnings for a part: pins that would have no pad, pads no pin connects. */
export function partWarnings(part: Pick<CustomPart, 'symbolKey' | 'footprintKey'>, project: Project = st().project): string[] {
  const fp = part.footprintKey ? footprintGeom(project.footprints?.[part.footprintKey]) : null;
  if (!fp) return ['No footprint: the part cannot go on the board'];
  const { pinsWithoutPad, padsWithoutPin } = pinPadMismatch(symbolFor(project, part.symbolKey), fp);
  const out: string[] = [];
  if (pinsWithoutPad.length) out.push(`Pins without a pad: ${pinsWithoutPad.join(', ')}`);
  if (padsWithoutPin.length) out.push(`Pads no pin connects: ${padsWithoutPin.join(', ')} (fine for mounting or thermal pads)`);
  return out;
}

/** Saves a part (replacing one of the same name); returns it. */
export function savePart(input: Omit<CustomPart, 'id'> & { id?: string }): CustomPart {
  const name = input.name.trim();
  if (!name) throw new Error('Give the part a name');
  const project = st().project;
  if (!project.symbols[input.symbolKey]) throw new Error(`No symbol ${input.symbolKey}`);
  if (input.footprintKey && !project.footprints?.[input.footprintKey]) throw new Error(`No footprint ${input.footprintKey}`);
  const existing = (project.parts ?? []).find((p) => p.id === input.id || p.name.toLowerCase() === name.toLowerCase());
  const part: CustomPart = {
    ...input,
    id: existing?.id ?? newId('part'),
    name,
    prefix: input.prefix.trim().replace(/[^A-Za-z_]/g, '') || 'U',
    value: input.value.trim() || name,
    lcsc: input.lcsc?.trim().toUpperCase() || undefined,
  };
  st().commit((doc) => ({ ...doc, parts: [...(doc.parts ?? []).filter((p) => p.id !== part.id), part] }));
  return part;
}

export function findCustomPart(name: string, project: Project = st().project): CustomPart {
  const parts = project.parts ?? [];
  const part = parts.find((p) => p.name.toLowerCase() === name.trim().toLowerCase() || p.id === name);
  if (!part) throw new Error(`No part "${name}" in this project.${parts.length ? ` Parts: ${parts.map((p) => p.name).join(', ')}` : ' Make one with create_part.'}`);
  return part;
}

/** A placement template for a part, as the place tool and placeComponent take. */
export function placingForPart(part: CustomPart, project: Project = st().project): Placing {
  const footprint = part.footprintKey ? project.footprints?.[part.footprintKey] : undefined;
  return {
    symbolKey: part.symbolKey,
    prefix: part.prefix,
    template: {
      symbolKey: part.symbolKey,
      unit: 0,
      value: part.value,
      rotation: 0,
      mirror: false,
      lcsc: part.lcsc,
      footprint: part.footprintKey ?? undefined,
      attrs: { ...part.attrs, ...(footprint ? { Footprint: footprint.title } : {}) },
    },
  };
}

/** Places a part made in the project (to the right of the drawing unless a position is given). */
export function placeCustomPart(name: string, opts: { x?: number; y?: number; rotation?: Rotation; designator?: string } = {}): Component {
  const placing = placingForPart(findCustomPart(name));
  const at: Vec = opts.x !== undefined && opts.y !== undefined ? [opts.x, opts.y] : nextFreePosition();
  const rotation = opts.rotation ?? 0;
  return placeComponent(placing, onPinGrid(placing, at, rotation), rotation, false, opts.designator);
}

/** Gives placed parts another footprint made in the project (null goes back to the library's). */
export function setFootprint(componentIds: string[], key: string | null) {
  const footprint = key ? st().project.footprints?.[key] : undefined;
  if (key && !footprint) throw new Error(`No footprint ${key}`);
  const ids = new Set(componentIds);
  st().commit((doc) => ({
    ...doc,
    components: doc.components.map((c) => {
      if (!ids.has(c.id)) return c;
      const next: Component = { ...c, attrs: { ...c.attrs } };
      if (key) {
        next.footprint = key;
        next.attrs['Footprint'] = footprint!.title;
      } else delete next.footprint;
      return next;
    }),
  }));
}

/** Gives placed parts another symbol, wires staying on pins with the same numbers; returns nets that joined. */
export function setSymbol(componentIds: string[], key: string): string[] {
  if (!st().project.symbols[key]) throw new Error(`No symbol ${key}`);
  const ids = new Set(componentIds);
  const before = st().project;
  st().commit((doc) => {
    const resolve = resolverFor(doc);
    const moved = followPins(doc, symbolPinMoves(doc, ids, resolve, resolve, key));
    return { ...moved, components: doc.components.map((c) => (ids.has(c.id) ? { ...c, symbolKey: key, unit: 0 } : c)) };
  });
  return joinedNets(before, st().project);
}

/** Deletes a part; its symbol and footprint stay (placed copies may use them). */
export function deletePart(id: string) {
  st().commit((doc) => ({ ...doc, parts: (doc.parts ?? []).filter((p) => p.id !== id) }));
}

/** Deletes a symbol or footprint made in the project, unless something still uses it. */
export function deleteLibraryItem(kind: 'symbol' | 'footprint', key: string) {
  const project = st().project;
  const usedBy = [
    ...project.components.filter((c) => (kind === 'symbol' ? c.symbolKey === key : c.footprint === key)).map((c) => c.designator),
    ...(project.parts ?? []).filter((p) => (kind === 'symbol' ? p.symbolKey === key : p.footprintKey === key)).map((p) => `part ${p.name}`),
  ];
  if (usedBy.length) throw new Error(`Still used by ${usedBy.slice(0, 6).join(', ')}${usedBy.length > 6 ? '…' : ''}`);
  st().commit((doc) => {
    if (kind === 'symbol') {
      const symbols = { ...doc.symbols };
      delete symbols[key];
      return { ...doc, symbols };
    }
    const footprints = { ...doc.footprints };
    delete footprints[key];
    return { ...doc, footprints };
  });
}

/** An editable copy of a placed part's symbol. */
export function symbolCopy(c: Component, project: Project = st().project): SymbolDef {
  return structuredClone(symbolFor(project, c.symbolKey));
}

/**
 * An editable copy of a placed part's footprint: its own, the one on the board, the library's
 * (fetched by LCSC number) or the built-in one of a generic passive. Null when it has none.
 */
export async function footprintCopy(c: Component, project: Project = st().project): Promise<FootprintGeom | null> {
  const own = c.footprint ? footprintGeom(project.footprints?.[c.footprint]) : null;
  if (own) return structuredClone(own);
  const onBoard = project.pcb?.footprintOf[c.id];
  const board = onBoard ? footprintGeom(project.pcb?.footprints[onBoard]) : null;
  if (board) return structuredClone(board);
  if (c.lcsc) {
    const d = await fetchPartDetail(c.lcsc);
    if (d.device?.footprint?.dataStr) return parsePcbFootprint(d.device.footprint.dataStr);
  }
  if (c.generic) {
    const doc = builtinFootprintDoc(c.generic.size, c.generic.kind === 'diode' || c.generic.kind === 'led');
    if (doc) return parsePcbFootprint(doc);
  }
  return null;
}

/** Opens the symbol editor on a placed part's symbol: its own one, or a copy of the library's. */
export function editSymbolOf(c: Component) {
  const stored = st().project.symbols[c.symbolKey];
  if (stored?.source === 'user') st().setPartsEditor({ tab: 'symbol', key: c.symbolKey, componentId: c.id });
  else st().setPartsEditor({ tab: 'symbol', draft: { name: `${stored?.title || c.value} (edited)`, symbol: symbolCopy(c) }, componentId: c.id });
}

/** Opens the footprint editor on a placed part's footprint: its own one, or a copy of the library's. */
export async function editFootprintOf(c: Component) {
  const project = st().project;
  if (c.footprint && project.footprints?.[c.footprint]) {
    st().setPartsEditor({ tab: 'footprint', key: c.footprint, componentId: c.id });
    return;
  }
  const geom = await footprintCopy(c, project);
  if (!geom) throw new Error(`${c.designator} has no footprint to start from; generate one from its package in the footprint editor`);
  const name = c.attrs['Footprint'] || c.attrs['Package'] || c.value;
  st().setPartsEditor({ tab: 'footprint', draft: { name: `${name} (edited)`, footprint: geom }, componentId: c.id });
}
