/*
 * Group actions shared by the canvas, the menus, the inspector and the agent tools: frame a
 * selection or a box as a named group, rename, recolour, refit or remove a frame, and find
 * what is in one. Every edit is one undo step on the sheet being drawn on.
 */
import { useEditor } from '../store/editor';
import { boundsOfItems, commitSheet, currentView } from './editing';
import { componentBox } from './schematic/geometry';
import { frameAround, groupMembers, groupOf, nextGroupColor } from './schematic/groups';
import { newId } from './schematic/ops';
import { sheetOf } from './schematic/sheets';
import { resolverFor } from './schematic/symbols';
import type { Component, GroupColor, SchematicGroup } from './schematic/types';

const st = () => useEditor.getState();

export type GroupFrame = Pick<SchematicGroup, 'x' | 'y' | 'width' | 'height'>;

/** A group by id or name on the sheet shown. */
export function findGroup(ref: string): SchematicGroup {
  const groups = currentView().groups ?? [];
  const hit = groups.find((g) => g.id === ref) ?? groups.find((g) => g.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw new Error(groups.length ? `No group "${ref}". Groups on this sheet: ${groups.map((g) => g.name).join(', ')}` : 'There are no groups on this sheet yet (add_group makes one)');
  return hit;
}

/** A new group name that no group on the sheet has yet. */
export function freeGroupName(base = 'Group'): string {
  const names = new Set((st().project.groups ?? []).map((g) => g.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Adds a named frame on the sheet being drawn on; the colour comes from the palette unless given. */
export function addGroup(name: string, frame: GroupFrame, color?: GroupColor): SchematicGroup {
  const title = name.trim();
  if (!title) throw new Error('Give the group a name');
  const group: SchematicGroup = { id: newId('g'), name: title, ...frame, color: color ?? nextGroupColor(st().project.groups ?? []) };
  commitSheet((doc) => ({ ...doc, groups: [...(doc.groups ?? []), group] }));
  return group;
}

/** Frames the given items (default: the selection) as a group; the frame is selected afterwards. */
export function groupItems(ids: string[], name?: string, color?: GroupColor): SchematicGroup {
  const bounds = boundsOfItems(ids);
  if (!bounds) throw new Error('Select the parts to group first');
  const frame = frameAround([bounds])!;
  const group = addGroup(name ?? freeGroupName(), frame, color);
  st().setSelection([group.id]);
  return group;
}

export const groupSelection = (name?: string) => groupItems(st().selection, name);

export function updateGroup(id: string, patch: Partial<Omit<SchematicGroup, 'id' | 'sheet'>>) {
  if (patch.name !== undefined && !patch.name.trim()) throw new Error('Give the group a name');
  commitSheet((doc) => ({ ...doc, groups: (doc.groups ?? []).map((g) => (g.id === id ? { ...g, ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) } : g)) }));
}

/** Shrinks or grows a frame to fit what is inside it now. */
export function fitGroup(id: string) {
  const view = currentView();
  const group = (view.groups ?? []).find((g) => g.id === id);
  if (!group) return;
  const members = groupMembers(view, group, resolverFor(view));
  const bounds = members.length ? boundsOfItems(members) : null;
  if (!bounds) throw new Error(`${group.name} has nothing inside it to fit around`);
  updateGroup(id, frameAround([bounds])!);
}

/** Removes the frame; what was inside stays. */
export function removeGroup(id: string) {
  commitSheet((doc) => ({ ...doc, groups: (doc.groups ?? []).filter((g) => g.id !== id) }));
  st().setSelection(st().selection.filter((x) => x !== id));
}

/** Selects what a group contains. */
export function selectGroupContents(id: string): string[] {
  const view = currentView();
  const group = (view.groups ?? []).find((g) => g.id === id);
  if (!group) return [];
  const ids = groupMembers(view, group, resolverFor(view));
  st().setSelection(ids);
  return ids;
}

/** The parts inside a group, in designator order. */
export function partsInGroup(group: SchematicGroup): Component[] {
  const view = currentView();
  const ids = new Set(groupMembers(view, group, resolverFor(view)));
  return view.components.filter((c) => ids.has(c.id)).sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
}

/** The group a part sits in, if any (among its own sheet's groups). */
export function groupOfComponent(c: Component): SchematicGroup | undefined {
  const project = st().project;
  const groups = (project.groups ?? []).filter((g) => sheetOf(g, project) === sheetOf(c, project));
  return groups.length ? groupOf(groups, componentBox(c, resolverFor(project)(c.symbolKey))) : undefined;
}

/** The frame as the agent tools report it. */
export const describeGroup = (g: SchematicGroup) => ({
  name: g.name,
  color: g.color ?? 'indigo',
  x: g.x,
  y: g.y,
  width: g.width,
  height: g.height,
  parts: partsInGroup(g).map((c) => c.designator),
});
