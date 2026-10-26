import { useMemo, useRef, useState } from 'react';
import { Circle, ListOrdered, Maximize, MousePointer2, PenLine, Redo2, Square, Trash2, Type, Undo2, Pin } from 'lucide-react';
import { useEditor } from '../../store/editor';
import type { SymbolDef, SymbolShape, SymbolUnit } from '../../lib/easyeda/symbol';
import { snap } from '../../lib/schematic/geometry';
import {
  icSymbol,
  moveSymbolItem,
  newPin,
  parsePinList,
  pinProblems,
  removeSymbolItem,
  sideOf,
  SIDE_DIR,
  symbolItemAt,
  withBounds,
  type PinSide,
  type SymbolItem,
} from '../../lib/schematic/symbolgen';
import type { Component, Vec } from '../../lib/schematic/types';
import { ComponentGraphic } from '../canvas/graphics';
import { Button, Field, IconButton, cx, inputClass } from '../ui';
import { useEditorView } from './useEditorView';

type Tool = 'select' | 'pin' | 'rect' | 'line' | 'circle' | 'text';

const TOOLS: { tool: Tool; label: string; key: string; icon: typeof Pin }[] = [
  { tool: 'select', label: 'Select and move', key: 'V', icon: MousePointer2 },
  { tool: 'pin', label: 'Pin', key: 'P', icon: Pin },
  { tool: 'rect', label: 'Rectangle', key: 'R', icon: Square },
  { tool: 'line', label: 'Line (double-click to finish)', key: 'L', icon: PenLine },
  { tool: 'circle', label: 'Circle', key: 'C', icon: Circle },
  { tool: 'text', label: 'Text', key: 'T', icon: Type },
];
const PIN_TYPES = ['', 'Input', 'Output', 'Bidirectional', 'Power', 'Passive', 'Open Collector'];

/** Lines for the pin list: "number name side", in the symbol's order. */
const pinListText = (unit: SymbolUnit) => unit.pins.map((p) => [p.number, p.name !== p.number ? p.name : '', sideOf(p)].filter(Boolean).join(' ')).join('\n');

const NEW_SYMBOL_PINS = '1 IN left\n2 GND bottom\n3 OUT right\n4 VCC top';

/**
 * Draws or edits a schematic symbol: pins on the 10-unit grid, body shapes on half of it, or the
 * whole symbol rebuilt from a pin list. Saving is left to the caller.
 */
export function SymbolEditor({
  initialName,
  initial,
  onSave,
  saveLabel = 'Save symbol',
  footer,
}: {
  initialName: string;
  initial: SymbolDef | null;
  onSave: (name: string, def: SymbolDef) => void;
  saveLabel?: string;
  footer?: React.ReactNode;
}) {
  const [name, setName] = useState(initialName);
  const [def, setDef] = useState<SymbolDef>(() => initial ?? icSymbol(initialName || 'New symbol', 'U', parsePinList(NEW_SYMBOL_PINS)));
  const [past, setPast] = useState<SymbolDef[]>([]);
  const [future, setFuture] = useState<SymbolDef[]>([]);
  const [unitIndex, setUnitIndex] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<SymbolItem | null>(null);
  const [pinList, setPinList] = useState<string | null>(initial ? null : NEW_SYMBOL_PINS);
  const [draft, setDraft] = useState<{ kind: 'rect' | 'circle'; a: Vec; b: Vec } | { kind: 'line'; points: Vec[]; at: Vec } | null>(null);
  const drag = useRef<{ item: SymbolItem; from: Vec; base: SymbolDef; moved: boolean } | null>(null);
  const unit = def.units[Math.min(unitIndex, def.units.length - 1)];
  const view = useEditorView(() => def.units[0].bbox, 40);

  /** Records the current symbol for undo and switches to `next`. */
  const change = (next: SymbolDef, base: SymbolDef = def) => {
    setPast((p) => [...p.slice(-80), base]);
    setFuture([]);
    setDef(withBounds(next));
  };
  const setUnit = (u: SymbolUnit, base?: SymbolDef) => change({ ...def, units: def.units.map((x) => (x === unit ? u : x)) }, base);
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [def, ...f]);
    setDef(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setSel(null);
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, def]);
    setDef(future[0]);
    setFuture((f) => f.slice(1));
  };
  const remove = () => {
    if (!sel) return;
    setUnit(removeSymbolItem(unit, sel));
    setSel(null);
  };

  const preview: Component = useMemo(
    () => ({ id: 'edit', symbolKey: 'edit', unit: unitIndex, designator: `${def.prefix || 'U'}?`, value: name || def.title, x: 0, y: 0, rotation: 0, mirror: false, attrs: {} }),
    [unitIndex, def.prefix, def.title, name],
  );
  const selectedPin = sel?.kind === 'pin' ? unit.pins.find((p) => p.id === sel.id) : undefined;
  const selectedShape = sel?.kind === 'shape' ? unit.shapes[sel.index] : undefined;
  const problems = pinProblems(def);
  const k = view.perPixel();

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const w = view.toWorld(e);
    if (e.button === 1) return view.startPan(e);
    if (e.button !== 0) return;
    const grid: Vec = [snap(w[0], 5), snap(w[1], 5)];
    switch (tool) {
      case 'select': {
        const hit = symbolItemAt(unit, w, 4 * k + 1);
        setSel(hit);
        if (hit) drag.current = { item: hit, from: w, base: def, moved: false };
        else view.startPan(e);
        return;
      }
      case 'pin': {
        const pin = newPin(unit, [snap(w[0], 10), snap(w[1], 10)]);
        setUnit({ ...unit, pins: [...unit.pins, pin] });
        setSel({ kind: 'pin', id: pin.id });
        return;
      }
      case 'rect':
      case 'circle':
        setDraft({ kind: tool, a: grid, b: grid });
        return;
      case 'line':
        setDraft((d) => (d?.kind === 'line' ? { ...d, points: [...d.points, grid] } : { kind: 'line', points: [grid], at: grid }));
        return;
      case 'text': {
        setUnit({ ...unit, shapes: [...unit.shapes, { kind: 'text', x: grid[0], y: grid[1], text: 'Text', size: 6, rotation: 0 }] });
        setSel({ kind: 'shape', index: unit.shapes.length });
        setTool('select');
        return;
      }
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (view.movePan(e)) return;
    const w = view.toWorld(e);
    const d = drag.current;
    if (d) {
      const step = d.item.kind === 'pin' ? 10 : 5;
      const delta: Vec = [snap(w[0] - d.from[0], step), snap(w[1] - d.from[1], step)];
      if (!delta[0] && !delta[1] && !d.moved) return;
      d.moved = true;
      const baseUnit = d.base.units[def.units.indexOf(unit)] ?? unit;
      setDef(withBounds({ ...d.base, units: d.base.units.map((x) => (x === baseUnit ? moveSymbolItem(baseUnit, d.item, delta) : x)) }));
      return;
    }
    const grid: Vec = [snap(w[0], 5), snap(w[1], 5)];
    setDraft((dr) => (!dr ? dr : dr.kind === 'line' ? { ...dr, at: grid } : { ...dr, b: grid }));
  };
  const onPointerUp = () => {
    if (view.endPan()) return;
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      setPast((p) => [...p.slice(-80), d.base]);
      setFuture([]);
    }
    if (draft && draft.kind !== 'line') {
      const [a, b] = [draft.a, draft.b];
      const shape: SymbolShape | null =
        draft.kind === 'rect'
          ? a[0] !== b[0] && a[1] !== b[1]
            ? { kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), r: 0 }
            : null
          : Math.hypot(b[0] - a[0], b[1] - a[1]) > 0
            ? { kind: 'ellipse', cx: a[0], cy: a[1], rx: Math.hypot(b[0] - a[0], b[1] - a[1]), ry: Math.hypot(b[0] - a[0], b[1] - a[1]) }
            : null;
      if (shape) {
        setUnit({ ...unit, shapes: [...unit.shapes, shape] });
        setSel({ kind: 'shape', index: unit.shapes.length });
      }
      setDraft(null);
    }
  };
  const finishLine = () => {
    if (draft?.kind !== 'line') return;
    const pts = draft.points.filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    if (pts.length >= 2) {
      setUnit({ ...unit, shapes: [...unit.shapes, { kind: 'poly', points: pts.flat(), closed: false }] });
      setSel({ kind: 'shape', index: unit.shapes.length });
    }
    setDraft(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = (e.target as HTMLElement).closest('input, textarea, select');
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    } else if (e.key === 'Enter') finishLine();
    else if (e.key === 'Escape' && (draft || sel || tool !== 'select')) {
      // Leave the dialog open: Escape first drops what is in progress.
      e.stopPropagation();
      setDraft(null);
      setSel(null);
      setTool('select');
    } else if (!mod) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        setTool(t.tool);
        setDraft(null);
      }
    }
  };

  const updatePin = (patch: Partial<SymbolUnit['pins'][number]>) => selectedPin && setUnit({ ...unit, pins: unit.pins.map((p) => (p === selectedPin ? { ...p, ...patch } : p)) });
  const updateShape = (patch: Partial<SymbolShape>) => sel?.kind === 'shape' && setUnit({ ...unit, shapes: unit.shapes.map((s, i) => (i === sel.index ? ({ ...s, ...patch } as SymbolShape) : s)) });
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const rebuild = () => {
    if (pinList === null) return;
    try {
      const next = icSymbol(name || def.title, def.prefix, parsePinList(pinList));
      change({ ...next, attrs: def.attrs });
      setSel(null);
      setUnitIndex(0);
      requestAnimationFrame(view.refit);
    } catch (err) {
      useEditor.getState().notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="flex min-h-0 flex-1" onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-0.5 border-b border-line px-2 py-1">
          {TOOLS.map((t) => (
            <IconButton key={t.tool} label={t.label} shortcut={t.key} active={tool === t.tool} onClick={() => (setTool(t.tool), setDraft(null))}>
              <t.icon className="h-4 w-4" />
            </IconButton>
          ))}
          <div className="mx-1 h-5 w-px bg-[var(--line)]" />
          <IconButton label="Undo" shortcut="⌘Z" disabled={!past.length} onClick={undo}>
            <Undo2 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Redo" shortcut="⇧⌘Z" disabled={!future.length} onClick={redo}>
            <Redo2 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Delete selected" shortcut="Del" disabled={!sel} onClick={remove}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Zoom to fit" onClick={view.refit}>
            <Maximize className="h-4 w-4" />
          </IconButton>
          <div className="flex-1" />
          <Button size="sm" variant={pinList !== null ? 'primary' : 'outline'} onClick={() => setPinList(pinList === null ? pinListText(unit) : null)}>
            <ListOrdered className="h-3.5 w-3.5" /> Pin list
          </Button>
        </div>
        <svg
          ref={view.ref}
          aria-label="Symbol editor canvas"
          viewBox={view.viewBox}
          className={cx('min-h-0 flex-1 touch-none bg-[var(--canvas-bg)] outline-none', tool !== 'select' && 'cursor-crosshair')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={finishLine}
        >
          <defs>
            <pattern id="sym-grid" width={10} height={10} patternUnits="userSpaceOnUse">
              <circle cx={0} cy={0} r={0.6} fill="var(--grid-dot)" />
            </pattern>
          </defs>
          <rect x={-5000} y={-5000} width={10000} height={10000} fill="url(#sym-grid)" />
          <path d="M-4 0H4M0 -4V4" stroke="var(--muted)" strokeWidth={0.4} />
          <ComponentGraphic component={preview} symbol={def} />
          {selectedPin && (
            <line
              x1={selectedPin.x}
              y1={selectedPin.y}
              x2={selectedPin.x + selectedPin.dir[0] * selectedPin.length}
              y2={selectedPin.y + selectedPin.dir[1] * selectedPin.length}
              stroke="var(--select)"
              strokeWidth={2.2}
              strokeLinecap="round"
              opacity={0.7}
            />
          )}
          {selectedPin && <circle cx={selectedPin.x} cy={selectedPin.y} r={1.6} fill="var(--select)" />}
          {selectedShape && <SelectionBox shape={selectedShape} />}
          {draft?.kind === 'rect' && <rect x={Math.min(draft.a[0], draft.b[0])} y={Math.min(draft.a[1], draft.b[1])} width={Math.abs(draft.b[0] - draft.a[0])} height={Math.abs(draft.b[1] - draft.a[1])} fill="none" stroke="var(--select)" strokeDasharray="2 2" />}
          {draft?.kind === 'circle' && <circle cx={draft.a[0]} cy={draft.a[1]} r={Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1])} fill="none" stroke="var(--select)" strokeDasharray="2 2" />}
          {draft?.kind === 'line' && <polyline points={[...draft.points, draft.at].join(' ')} fill="none" stroke="var(--select)" strokeDasharray="2 2" />}
        </svg>
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-muted">
          {tool === 'select' && 'Click to select, drag to move; drag empty space to pan, scroll to zoom.'}
          {tool === 'pin' && 'Click where the pin’s end goes; it points into the body from the nearest side.'}
          {tool === 'rect' && 'Drag to draw a rectangle.'}
          {tool === 'circle' && 'Drag from the centre to draw a circle.'}
          {tool === 'line' && 'Click to add points; double-click or Enter to finish.'}
          {tool === 'text' && 'Click to place text, then edit it on the right.'}
        </div>
      </div>

      <div className="flex w-72 shrink-0 flex-col border-l border-line">
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          <Field label="Name">
            <input aria-label="Symbol name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TMP117" />
          </Field>
          <Field label="Prefix">
            <input aria-label="Designator prefix" className={inputClass} value={def.prefix} onChange={(e) => setDef({ ...def, prefix: e.target.value.replace(/[^A-Za-z_]/g, '') })} />
          </Field>
          {def.units.length > 1 && (
            <Field label="Unit">
              <select className={inputClass} value={unitIndex} onChange={(e) => (setUnitIndex(Number(e.target.value)), setSel(null))}>
                {def.units.map((u, i) => (
                  <option key={i} value={i}>
                    {u.name || `Unit ${i + 1}`}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {pinList !== null && (
            <div className="space-y-1.5 rounded-md border border-line p-2">
              <div className="text-xs font-medium">Pin list</div>
              <p className="text-[11px] text-muted">One pin per line: number, name and optionally left, right, top or bottom. Rebuilding draws a new box around them.</p>
              <textarea aria-label="Pin list" className={cx(inputClass, 'h-40 py-1 font-mono')} value={pinList} onChange={(e) => setPinList(e.target.value)} spellCheck={false} />
              <Button size="sm" variant="primary" className="w-full" onClick={rebuild}>
                Rebuild symbol
              </Button>
            </div>
          )}

          {selectedPin && (
            <div className="space-y-2 rounded-md border border-line p-2">
              <div className="text-xs font-medium">Pin</div>
              <Field label="Number">
                <input aria-label="Pin number" className={inputClass} value={selectedPin.number} onChange={(e) => updatePin({ number: e.target.value })} />
              </Field>
              <Field label="Name">
                <input aria-label="Pin name" className={inputClass} value={selectedPin.name} onChange={(e) => updatePin({ name: e.target.value, showName: e.target.value !== selectedPin.number && !!e.target.value })} />
              </Field>
              <Field label="Side">
                <select aria-label="Pin side" className={inputClass} value={sideOf(selectedPin)} onChange={(e) => updatePin({ dir: SIDE_DIR[e.target.value as PinSide] })}>
                  {(['left', 'right', 'top', 'bottom'] as const).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Length">
                <input type="number" step={5} className={inputClass} value={selectedPin.length} onChange={(e) => updatePin({ length: Math.max(0, num(e.target.value)) })} />
              </Field>
              <Field label="Type">
                <select className={inputClass} value={selectedPin.electrical} onChange={(e) => updatePin({ electrical: e.target.value })}>
                  {PIN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t || '—'}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={selectedPin.showName} onChange={(e) => updatePin({ showName: e.target.checked })} /> Show name
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={selectedPin.showNumber} onChange={(e) => updatePin({ showNumber: e.target.checked })} /> Show number
              </label>
            </div>
          )}
          {selectedShape && <ShapeFields shape={selectedShape} update={updateShape} num={num} />}
          {!sel && pinList === null && <p className="text-[11px] text-muted">{unit.pins.length} pins. Select a pin or shape to edit it, or open the pin list to rebuild the symbol from a list.</p>}
          {problems.length > 0 && <div className="rounded-md bg-rose-500/10 p-2 text-[11px] text-rose-600 dark:text-rose-300">{problems.join('; ')}</div>}
        </div>
        <div className="space-y-2 border-t border-line p-3">
          {footer}
          <Button variant="primary" className="w-full" disabled={!name.trim() || problems.length > 0} onClick={() => onSave(name.trim(), { ...def, title: name.trim() })}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShapeFields({ shape, update, num }: { shape: SymbolShape; update: (patch: Partial<SymbolShape>) => void; num: (v: string) => number }) {
  const field = (label: string, key: string, value: number) => (
    <Field label={label} key={key}>
      <input type="number" step={5} className={inputClass} value={value} onChange={(e) => update({ [key]: num(e.target.value) } as Partial<SymbolShape>)} />
    </Field>
  );
  return (
    <div className="space-y-2 rounded-md border border-line p-2">
      <div className="text-xs font-medium">{{ rect: 'Rectangle', ellipse: 'Circle', poly: 'Line', text: 'Text', path: 'Arc' }[shape.kind]}</div>
      {shape.kind === 'rect' && [field('X', 'x', shape.x), field('Y', 'y', shape.y), field('Width', 'w', shape.w), field('Height', 'h', shape.h)]}
      {shape.kind === 'ellipse' && [field('Centre x', 'cx', shape.cx), field('Centre y', 'cy', shape.cy), field('Radius x', 'rx', shape.rx), field('Radius y', 'ry', shape.ry)]}
      {shape.kind === 'poly' && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={shape.closed} onChange={(e) => update({ closed: e.target.checked })} /> Closed
        </label>
      )}
      {shape.kind === 'text' && (
        <>
          <Field label="Text">
            <input aria-label="Text" className={inputClass} value={shape.text} onChange={(e) => update({ text: e.target.value })} />
          </Field>
          {field('Size', 'size', shape.size)}
        </>
      )}
    </div>
  );
}

function SelectionBox({ shape }: { shape: SymbolShape }) {
  let b: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (shape.kind === 'rect') b = { x1: shape.x, y1: shape.y, x2: shape.x + shape.w, y2: shape.y + shape.h };
  else if (shape.kind === 'ellipse') b = { x1: shape.cx - shape.rx, y1: shape.cy - shape.ry, x2: shape.cx + shape.rx, y2: shape.cy + shape.ry };
  else if (shape.kind === 'poly') {
    const xs = shape.points.filter((_, i) => i % 2 === 0);
    const ys = shape.points.filter((_, i) => i % 2 === 1);
    b = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  } else if (shape.kind === 'text') b = { x1: shape.x, y1: shape.y - shape.size, x2: shape.x + shape.text.length * shape.size * 0.6, y2: shape.y };
  if (!b) return null;
  return <rect x={b.x1 - 2} y={b.y1 - 2} width={b.x2 - b.x1 + 4} height={b.y2 - b.y1 + 4} fill="var(--select)" fillOpacity={0.06} stroke="var(--select)" strokeWidth={0.6} strokeDasharray="2 2" />;
}
