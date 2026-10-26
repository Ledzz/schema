import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditor } from '../../store/editor';
import { addPort, commitAttach, connectivity, disconnectPin, endByKey, findNoFeeAlternative, markNoConnect, nameNet, pinByKey, planAttach, renameNet, type PinEnd } from '../../lib/actions';
import { addDecoupling, supplyPins } from '../../lib/decoupling';
import { copySelection, deleteSelection, duplicateSelection, fitView, hasClipboard, mirrorSelection, openSheet, paste, rotateSelection, selectAll } from '../../lib/editing';
import { samePoint } from '../../lib/schematic/geometry';
import { sheetsOf, sheetView } from '../../lib/schematic/sheets';
import { connectionNear, hitTest, wireGrabAt } from '../../lib/schematic/hit';
import { deleteWireSegment } from '../../lib/schematic/ops';
import { portRotationFor } from '../../lib/schematic/route';
import { resolverFor } from '../../lib/schematic/symbols';
import type { PortKind, Project, Vec } from '../../lib/schematic/types';
import { cx } from '../ui';

/*
 * Right-click menu of the schematic canvas: what can be done with the part, pin, wire, label
 * or empty spot under the pointer. Items are plain actions or a one-line name field.
 */

export interface ContextItem {
  label: string;
  shortcut?: string;
  onSelect?: () => unknown;
  /** A name field instead of a plain item; Enter applies it. */
  input?: { initial: string; placeholder?: string; onSubmit: (value: string) => unknown };
  disabled?: boolean;
  separatorBefore?: boolean;
  danger?: boolean;
}

export interface ContextMenuState {
  /** Where it opens, in canvas pixels. */
  at: Vec;
  title?: string;
  items: ContextItem[];
}

const st = () => useEditor.getState();

/** Runs a menu action, reporting a refusal (no room for a label, say) instead of dropping it. */
async function run(fn: () => unknown) {
  try {
    await fn();
  } catch (err) {
    st().notify((err as Error).message, 'error');
  }
}

const mostUsedRail = (project: Project) => {
  const counts = new Map<string, number>();
  for (const p of project.ports) if (p.kind === 'power' && p.name.trim()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '+3V3';
};

/** A label or flag on a pin, on a stub leading away from the part when there is room. */
function flagPin(pin: PinEnd, kind: Exclude<PortKind, 'noconnect'>, name: string) {
  const value = name.trim();
  if (!value) return;
  const plan = planAttach(st().project, pin, kind, value);
  if (plan) commitAttach(plan);
  else addPort(kind, value, pin.at, portRotationFor(kind, [-pin.dir[0], -pin.dir[1]]));
}

/** The menu for a point of the drawing (world coordinates), selecting what is under it. */
export function schematicMenu(w: Vec, tol: number): Omit<ContextMenuState, 'at'> {
  const s = st();
  // What is under the pointer comes from this sheet; nets from the whole project.
  const project = sheetView(s.project, s.currentSheet);
  const symbols = resolverFor(project);
  const conn = connectivity(s.project);
  const id = hitTest(project, symbols, w, tol);
  const port = project.ports.find((p) => p.id === id);
  const near = !port || port.kind === 'noconnect' ? connectionNear(project, symbols, w, tol) : null;
  const highlight = (net: string | undefined): ContextItem[] => (net ? [{ label: 'Highlight net', onSelect: () => s.setHighlightNet(net) }] : []);

  // A pin.
  const pin = near?.kind === 'pin' && near.ref ? pinByKey(near.ref, project) : null;
  if (pin) {
    const ref = `${pin.component.designator}.${pin.pin.number}`;
    const net = conn.pinNet.get(near!.ref!);
    const named = net && !conn.nets.find((n) => n.name === net)?.auto ? net : '';
    const marker = project.ports.find((p) => p.kind === 'noconnect' && samePoint([p.x, p.y], pin.at));
    const wired = project.wires.some((wire) => samePoint(wire.points[0], pin.at) || samePoint(wire.points[wire.points.length - 1], pin.at));
    return {
      title: `${near!.label}${net ? ` · ${net}` : ''}`,
      items: [
        { label: 'Draw a wire from here', onSelect: () => s.startWire(pin.at) },
        { label: 'Net label', input: { initial: named, placeholder: 'Net name, e.g. SDA', onSubmit: (v) => flagPin(pin, 'label', v) } },
        { label: 'Power flag', input: { initial: mostUsedRail(project), onSubmit: (v) => flagPin(pin, 'power', v) } },
        { label: 'Connect to GND', onSelect: () => flagPin(pin, 'ground', 'GND') },
        marker
          ? { label: 'Remove no-connect marker', separatorBefore: true, onSelect: () => s.commit((doc) => ({ ...doc, ports: doc.ports.filter((p) => p.id !== marker.id) })) }
          : { label: 'Mark as not connected', separatorBefore: true, disabled: !!net && wired, onSelect: () => markNoConnect(ref) },
        { label: 'Disconnect', disabled: !wired, onSelect: () => disconnectPin(ref) },
        ...highlight(net),
      ],
    };
  }

  // A block's pin.
  const blockPin = near?.kind === 'block' && near.ref ? endByKey(near.ref, project) : null;
  const block = blockPin && project.blocks?.find((b) => near!.ref!.startsWith(`${b.id}:`));
  if (blockPin && block) {
    const port = near!.ref!.slice(block.id.length + 1);
    const ref = `${sheetsOf(s.project).find((sh) => sh.id === block.child)?.name}.${port}`;
    const net = conn.pinNet.get(near!.ref!);
    const named = net && !conn.nets.find((n) => n.name === net)?.auto && !net.includes('/') ? net : '';
    const wired = project.wires.some((wire) => samePoint(wire.points[0], blockPin.at) || samePoint(wire.points[wire.points.length - 1], blockPin.at));
    return {
      title: `${near!.label}${net ? ` · ${net}` : ''}`,
      items: [
        { label: 'Draw a wire from here', onSelect: () => s.startWire(blockPin.at) },
        { label: 'Net label', input: { initial: named, placeholder: 'Net name, e.g. SDA', onSubmit: (v) => flagPin(blockPin, 'label', v) } },
        { label: 'Power flag', input: { initial: mostUsedRail(project), onSubmit: (v) => flagPin(blockPin, 'power', v) } },
        { label: 'Connect to GND', onSelect: () => flagPin(blockPin, 'ground', 'GND') },
        { label: 'Disconnect', separatorBefore: true, disabled: !wired, onSelect: () => disconnectPin(ref) },
        ...highlight(net),
      ],
    };
  }

  // Empty space.
  if (!id) {
    s.setSelection([]);
    return {
      items: [
        { label: 'Paste here', shortcut: '⌘V', disabled: !hasClipboard(), onSelect: () => paste(w) },
        { label: 'Select all', shortcut: '⌘A', onSelect: selectAll },
        { label: 'Circuit block…', shortcut: 'B', separatorBefore: true, onSelect: () => s.setBlocksOpen(true) },
        { label: 'Zoom to fit', shortcut: 'F', onSelect: () => fitView() },
      ],
    };
  }

  // Right-clicking outside the selection selects what was clicked; inside it keeps the selection.
  if (!s.selection.includes(id)) s.setSelection([id]);
  const count = st().selection.length;
  const common: ContextItem[] = [
    { label: 'Rotate', shortcut: 'R', onSelect: rotateSelection },
    { label: 'Mirror', shortcut: 'X', onSelect: mirrorSelection },
    { label: 'Duplicate', shortcut: '⌘D', onSelect: duplicateSelection },
    { label: 'Copy', shortcut: '⌘C', onSelect: copySelection },
  ];
  const remove: ContextItem = { label: 'Delete', shortcut: 'Del', danger: true, separatorBefore: true, onSelect: deleteSelection };
  const saveBlock: ContextItem = { label: 'Save as block…', onSelect: () => s.setSaveBlockOpen(true) };
  if (count > 1) return { title: `${count} items`, items: [...common, saveBlock, remove] };

  const component = project.components.find((c) => c.id === id);
  if (component) {
    const datasheet = component.attrs['Datasheet'];
    const hasSupply = !component.generic && supplyPins(component, project, conn).length > 0;
    return {
      title: `${component.designator} · ${component.value}`,
      items: [
        ...common,
        ...(component.generic ? [{ label: 'Edit value…', shortcut: '↵', separatorBefore: true, onSelect: () => s.setQuickEdit(component.id) }] : []),
        { label: 'Replace part…', separatorBefore: !component.generic, onSelect: () => s.requestLibrary(component.attrs['Manufacturer Part'] ?? component.value, component.id) },
        ...(component.partClass === 'extended' ? [{ label: 'Find a no-fee alternative…', onSelect: () => findNoFeeAlternative(component) }] : []),
        ...(hasSupply ? [{ label: 'Add decoupling', onSelect: () => addDecoupling(component.id, { rail: mostUsedRail(project) }).then((r) => s.notify(`Added ${r.caps.length} capacitors`)) }] : []),
        ...(datasheet && /^https?:\/\//.test(datasheet) ? [{ label: 'Open datasheet', onSelect: () => window.open(datasheet, '_blank', 'noopener') }] : []),
        saveBlock,
        remove,
      ],
    };
  }

  if (port) {
    const net = conn.itemNet.get(port.id);
    const title = { label: 'Net label', power: 'Power flag', ground: 'Ground flag', noconnect: 'No-connect marker', hier: 'Hierarchical port' }[port.kind];
    return {
      title: port.kind === 'noconnect' ? title : `${title} ${port.name}`,
      items: [
        ...(port.kind !== 'noconnect' ? [{ label: 'Rename net', input: { initial: port.name, onSubmit: (v: string) => v.trim() && v.trim() !== port.name && renameNet(port.name, v) } }] : []),
        ...highlight(net),
        { label: 'Rotate', shortcut: 'R', separatorBefore: true, onSelect: rotateSelection },
        remove,
      ],
    };
  }

  const sheetBlock = project.blocks?.find((b) => b.id === id);
  if (sheetBlock) {
    const name = sheetsOf(s.project).find((sh) => sh.id === sheetBlock.child)?.name ?? 'sheet';
    return {
      title: `Block · ${name}`,
      items: [{ label: `Open ${name}`, shortcut: 'Double-click', onSelect: () => openSheet(sheetBlock.child) }, remove],
    };
  }

  const wire = project.wires.find((x) => x.id === id);
  if (wire) {
    const net = conn.itemNet.get(wire.id);
    const named = net && !conn.nets.find((n) => n.name === net)?.auto ? net : '';
    const grab = wireGrabAt(project, w, tol);
    const segment = grab && 'segment' in grab.grab ? grab.grab.segment : null;
    return {
      title: `Wire${net ? ` · ${net}` : ''}`,
      items: [
        { label: named ? 'Rename net' : 'Name net', input: { initial: named, placeholder: 'Net name', onSubmit: (v) => v.trim() && v.trim() !== named && nameNet(wire.id, v) } },
        ...highlight(net),
        ...(segment !== null && wire.points.length > 2
          ? [{ label: 'Delete this segment', separatorBefore: true, onSelect: () => s.commit((doc) => deleteWireSegment(doc, wire.id, segment)) }]
          : []),
        { ...remove, label: 'Delete wire', separatorBefore: segment === null || wire.points.length <= 2 },
      ],
    };
  }
  return { items: [] };
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Vec>(menu.at);

  // Keep it inside the canvas.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const x = Math.max(8, Math.min(menu.at[0], parent.clientWidth - el.offsetWidth - 8));
    const y = Math.max(8, Math.min(menu.at[1], parent.clientHeight - el.offsetHeight - 8));
    setPos([x, y]);
  }, [menu]);

  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  const choose = (fn: () => unknown) => {
    onClose();
    void run(fn);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.title ?? 'Canvas'}
      style={{ left: pos[0], top: pos[1] }}
      className="absolute z-30 min-w-56 rounded-lg border border-line bg-panel p-1 text-[13px] shadow-xl shadow-black/20"
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.title && <div className="truncate px-2.5 pb-1 pt-1 text-[11px] font-semibold text-muted">{menu.title}</div>}
      {menu.items.map((item) => (
        <div key={item.label}>
          {item.separatorBefore && <div className="my-1 h-px bg-[var(--line)]" />}
          {item.input ? (
            <MenuInput item={item} onSubmit={(v) => choose(() => item.input!.onSubmit(v))} />
          ) : (
            <button
              role="menuitem"
              disabled={item.disabled}
              onClick={() => item.onSelect && choose(item.onSelect)}
              className={cx(
                'flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left hover:bg-indigo-500/10 disabled:opacity-40 disabled:hover:bg-transparent',
                item.danger && 'text-rose-600 dark:text-rose-400',
              )}
            >
              <span>{item.label}</span>
              {item.shortcut && <span className="font-mono text-[11px] text-muted">{item.shortcut}</span>}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function MenuInput({ item, onSubmit }: { item: ContextItem; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState(item.input!.initial);
  return (
    <label className="flex items-center gap-2 rounded-md px-2.5 py-1 hover:bg-indigo-500/5">
      <span className="shrink-0">{item.label}</span>
      <input
        aria-label={item.label}
        value={value}
        placeholder={item.input!.placeholder}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onSubmit(value);
        }}
        className="h-6 min-w-0 flex-1 rounded border border-line bg-panel-2 px-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-indigo-500/30"
      />
    </label>
  );
}
