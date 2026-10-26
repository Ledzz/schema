import { memo, useRef, useState } from 'react';
import { Maximize, MousePointer2, PenLine, Redo2, Square, Trash2, Undo2, Wand2 } from 'lucide-react';
import { useEditor } from '../../store/editor';
import type { FootprintGeom, Graphic, PadGeom } from '../../lib/pcb/footprint';
import { padOutline } from '../../lib/pcb/geometry';
import { dim, generateFootprint, packageSpec, PACKAGE_EXAMPLES, padNumbers } from '../../lib/pcb/ipc';
import type { Placement } from '../../lib/pcb/types';
import type { Vec } from '../../lib/schematic/types';
import { Button, Field, IconButton, cx, inputClass } from '../ui';
import { useEditorView } from './useEditorView';

type Tool = 'select' | 'pad' | 'silk';
type Sel = { kind: 'pad' | 'graphic'; index: number } | null;

const ORIGIN: Placement = { componentId: '', x: 0, y: 0, rotation: 0, side: 'top' };
const GRIDS = [0.05, 0.1, 0.25, 0.5, 0.635, 1.27];
const PAD_COLOR: Record<PadGeom['layer'], string> = { top: 'var(--pcb-top)', bottom: 'var(--pcb-bottom)', through: 'var(--pcb-tht)' };
const GRAPHIC_COLOR: Record<Graphic['layer'], string> = { silkTop: 'var(--pcb-silk-top)', silkBottom: 'var(--pcb-silk-bottom)', outline: 'var(--muted)' };

/** Bounds of pads and graphics. */
export function footprintBounds(g: Pick<FootprintGeom, 'pads' | 'graphics'>): FootprintGeom['bbox'] {
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const p of g.pads)
    for (const [x, y] of padOutline(ORIGIN, p)) {
      b.x1 = Math.min(b.x1, x);
      b.y1 = Math.min(b.y1, y);
      b.x2 = Math.max(b.x2, x);
      b.y2 = Math.max(b.y2, y);
    }
  for (const gr of g.graphics)
    if (gr.layer === 'outline')
      for (const [x, y] of gr.points) {
        b.x1 = Math.min(b.x1, x);
        b.y1 = Math.min(b.y1, y);
        b.x2 = Math.max(b.x2, x);
        b.y2 = Math.max(b.y2, y);
      }
  return Number.isFinite(b.x1) ? b : { x1: -1, y1: -1, x2: 1, y2: 1 };
}

/** A footprint's pads, silkscreen and outline in its own frame (mm). */
export const FootprintGraphic = memo(function FootprintGraphic({ geom, selected }: { geom: FootprintGeom; selected?: Sel }) {
  const size = Math.max(0.25, Math.min(1, ...geom.pads.map((p) => Math.min(p.w, p.h) * 0.6)));
  return (
    <g>
      {geom.graphics.map((g, i) =>
        g.layer === 'outline' ? (
          <polyline key={`g${i}`} points={g.points.join(' ')} fill="none" stroke={GRAPHIC_COLOR.outline} strokeWidth={0.05} strokeDasharray="0.2 0.15" />
        ) : null,
      )}
      {geom.pads.map((p, i) => (
        <g key={`p${i}`}>
          <polygon points={padOutline(ORIGIN, p).join(' ')} fill={PAD_COLOR[p.layer]} fillOpacity={0.9} stroke={selected?.kind === 'pad' && selected.index === i ? 'var(--select)' : 'none'} strokeWidth={0.08} />
          {p.hole && <ellipse cx={p.x + p.hole.dx} cy={p.y + p.hole.dy} rx={p.hole.w / 2} ry={p.hole.h / 2} fill="var(--pcb-hole)" />}
          <text x={p.x} y={p.y} fontSize={Math.min(size, p.w * 0.7, p.h * 0.9)} textAnchor="middle" dominantBaseline="central" fill="#fff" className="canvas-text">
            {p.number}
          </text>
        </g>
      ))}
      {geom.graphics.map((g, i) =>
        g.layer === 'outline' ? null : g.filled ? (
          <polygon key={`s${i}`} points={g.points.join(' ')} fill={GRAPHIC_COLOR[g.layer]} />
        ) : (
          <polyline
            key={`s${i}`}
            points={g.points.join(' ')}
            fill="none"
            stroke={selected?.kind === 'graphic' && selected.index === i ? 'var(--select)' : GRAPHIC_COLOR[g.layer]}
            strokeWidth={g.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </g>
  );
});

/** A read-only footprint picture, fitted to its box. */
export function FootprintPicture({ geom, className }: { geom: FootprintGeom; className?: string }) {
  const b = footprintBounds(geom);
  const pad = Math.max(b.x2 - b.x1, b.y2 - b.y1) * 0.12 + 0.3;
  return (
    <svg viewBox={`${b.x1 - pad} ${b.y1 - pad} ${b.x2 - b.x1 + pad * 2} ${b.y2 - b.y1 + pad * 2}`} className={cx('bg-[var(--pcb-board)]', className)}>
      <FootprintGraphic geom={geom} />
    </svg>
  );
}

const snapTo = (v: number, step: number) => Math.round(Math.round(v / step) * step * 1e4) / 1e4 || 0;
const segmentDistance = (p: Vec, a: Vec, b: Vec) => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const withBox = (g: Pick<FootprintGeom, 'pads' | 'graphics'>): FootprintGeom => ({ ...g, bbox: footprintBounds(g) });
const nextNumber = (pads: PadGeom[]) => {
  const nums = pads.map((p) => Number(p.number)).filter(Number.isFinite);
  return String(nums.length ? Math.max(...nums) + 1 : pads.length + 1);
};

/**
 * Generates a footprint from a package (IPC-7351) or edits one pad by pad, with silkscreen lines.
 * Millimetres, y down, origin at the part's centre. Saving is left to the caller.
 */
export function FootprintEditor({
  initialName,
  initial,
  onSave,
  footer,
}: {
  initialName: string;
  initial: FootprintGeom | null;
  onSave: (name: string, geom: FootprintGeom) => void;
  footer?: React.ReactNode;
}) {
  const [name, setName] = useState(initialName);
  const [geom, setGeom] = useState<FootprintGeom>(() => initial ?? generateFootprint(packageSpec('SOIC-8')));
  const [past, setPast] = useState<FootprintGeom[]>([]);
  const [future, setFuture] = useState<FootprintGeom[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [grid, setGrid] = useState(0.05);
  const [sel, setSel] = useState<Sel>(null);
  const [line, setLine] = useState<{ points: Vec[]; at: Vec } | null>(null);
  const [pkg, setPkg] = useState(initial ? '' : 'SOIC-8');
  const [leads, setLeads] = useState({ span: ['', ''], length: ['', ''], width: ['', ''] });
  const drag = useRef<{ index: number; from: Vec; base: FootprintGeom; moved: boolean } | null>(null);
  const view = useEditorView(() => geom.bbox, 1.5);
  const k = view.perPixel();

  const change = (next: Pick<FootprintGeom, 'pads' | 'graphics'>, base: FootprintGeom = geom) => {
    setPast((p) => [...p.slice(-80), base]);
    setFuture([]);
    setGeom(withBox(next));
  };
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [geom, ...f]);
    setGeom(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setSel(null);
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, geom]);
    setGeom(future[0]);
    setFuture((f) => f.slice(1));
  };
  const remove = () => {
    if (!sel) return;
    if (sel.kind === 'pad') change({ ...geom, pads: geom.pads.filter((_, i) => i !== sel.index) });
    else change({ ...geom, graphics: geom.graphics.filter((_, i) => i !== sel.index) });
    setSel(null);
  };

  const hit = (w: Vec): Sel => {
    for (let i = geom.pads.length - 1; i >= 0; i--) {
      const p = geom.pads[i];
      if (Math.abs(w[0] - p.x) <= p.w / 2 + 2 * k && Math.abs(w[1] - p.y) <= p.h / 2 + 2 * k) return { kind: 'pad', index: i };
    }
    for (let i = geom.graphics.length - 1; i >= 0; i--) {
      const g = geom.graphics[i];
      if (g.points.slice(1).some((q, j) => segmentDistance(w, g.points[j], q) <= g.width / 2 + 4 * k)) return { kind: 'graphic', index: i };
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 1) return view.startPan(e);
    if (e.button !== 0) return;
    const w = view.toWorld(e);
    const at: Vec = [snapTo(w[0], grid), snapTo(w[1], grid)];
    if (tool === 'select') {
      const h = hit(w);
      setSel(h);
      if (h?.kind === 'pad') drag.current = { index: h.index, from: w, base: geom, moved: false };
      else if (!h) view.startPan(e);
    } else if (tool === 'pad') {
      const like = (sel?.kind === 'pad' && geom.pads[sel.index]) || geom.pads[geom.pads.length - 1];
      const pad: PadGeom = like
        ? { ...structuredClone(like), number: nextNumber(geom.pads), x: at[0], y: at[1] }
        : { number: '1', x: at[0], y: at[1], rotation: 0, shape: 'rect', w: 1, h: 1.5, radius: 0, points: [], layer: 'top', hole: null };
      change({ ...geom, pads: [...geom.pads, pad] });
      setSel({ kind: 'pad', index: geom.pads.length });
    } else setLine((l) => (l ? { ...l, points: [...l.points, at] } : { points: [at], at }));
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (view.movePan(e)) return;
    const w = view.toWorld(e);
    const d = drag.current;
    if (d) {
      const base = d.base.pads[d.index];
      const x = snapTo(base.x + w[0] - d.from[0], grid);
      const y = snapTo(base.y + w[1] - d.from[1], grid);
      if (!d.moved && x === base.x && y === base.y) return;
      d.moved = true;
      setGeom(withBox({ ...d.base, pads: d.base.pads.map((p, i) => (i === d.index ? { ...p, x, y } : p)) }));
      return;
    }
    if (line) setLine({ ...line, at: [snapTo(w[0], grid), snapTo(w[1], grid)] });
  };
  const onPointerUp = () => {
    if (view.endPan()) return;
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      setPast((p) => [...p.slice(-80), d.base]);
      setFuture([]);
    }
  };
  const finishLine = () => {
    if (!line) return;
    if (line.points.length >= 2) {
      change({ ...geom, graphics: [...geom.graphics, { layer: 'silkTop', points: line.points, width: 0.15, filled: false }] });
      setSel({ kind: 'graphic', index: geom.graphics.length });
    }
    setLine(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    } else if (e.key === 'Enter') finishLine();
    else if (e.key === 'Escape' && (line || sel || tool !== 'select')) {
      e.stopPropagation();
      setLine(null);
      setSel(null);
      setTool('select');
    } else if (sel?.kind === 'pad' && e.key.startsWith('Arrow')) {
      // Arrow keys nudge the selected pad by one grid step.
      e.preventDefault();
      const [dx, dy] = { ArrowLeft: [-grid, 0], ArrowRight: [grid, 0], ArrowUp: [0, -grid], ArrowDown: [0, grid] }[e.key] ?? [0, 0];
      change({ ...geom, pads: geom.pads.map((p, i) => (i === sel.index ? { ...p, x: snapTo(p.x + dx, 1e-4), y: snapTo(p.y + dy, 1e-4) } : p)) });
    } else if (!mod) {
      const t = ({ v: 'select', p: 'pad', l: 'silk' } as Record<string, Tool>)[e.key.toLowerCase()];
      if (t) setTool(t);
    }
  };

  const generate = () => {
    try {
      const spec = packageSpec(pkg);
      const range = (r: string[]) => (r[0] && r[1] ? dim(Number(r[0]), Number(r[1])) : undefined);
      change(generateFootprint({ ...spec, span: range(leads.span) ?? spec.span, leadLength: range(leads.length) ?? spec.leadLength, leadWidth: range(leads.width) ?? spec.leadWidth }));
      if (!name.trim()) setName(pkg.trim().toUpperCase());
      setSel(null);
      requestAnimationFrame(view.refit);
    } catch (err) {
      useEditor.getState().notify((err as Error).message, 'error');
    }
  };

  const pad = sel?.kind === 'pad' ? geom.pads[sel.index] : undefined;
  const graphic = sel?.kind === 'graphic' ? geom.graphics[sel.index] : undefined;
  const updatePad = (patch: Partial<PadGeom>) => sel && change({ ...geom, pads: geom.pads.map((p, i) => (i === sel.index ? { ...p, ...patch } : p)) });
  const updateGraphic = (patch: Partial<Graphic>) => sel && change({ ...geom, graphics: geom.graphics.map((g, i) => (i === sel.index ? { ...g, ...patch } : g)) });
  const num = (v: string, min = -Infinity) => Math.max(min, Number.isFinite(Number(v)) ? Number(v) : 0);
  const numbers = padNumbers(geom);
  const duplicates = numbers.filter((n) => geom.pads.filter((p) => p.number === n).length > 1);
  const b = geom.bbox;

  return (
    <div className="flex min-h-0 flex-1" onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-0.5 border-b border-line px-2 py-1">
          <IconButton label="Select and move" shortcut="V" active={tool === 'select'} onClick={() => setTool('select')}>
            <MousePointer2 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Pad (copies the selected one)" shortcut="P" active={tool === 'pad'} onClick={() => setTool('pad')}>
            <Square className="h-4 w-4" />
          </IconButton>
          <IconButton label="Silkscreen line (double-click to finish)" shortcut="L" active={tool === 'silk'} onClick={() => setTool('silk')}>
            <PenLine className="h-4 w-4" />
          </IconButton>
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
          <label className="ml-2 flex items-center gap-1.5 text-xs text-muted">
            Grid
            <select aria-label="Grid" className={cx(inputClass, 'h-7 w-20')} value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
              {GRIDS.map((g) => (
                <option key={g} value={g}>
                  {g} mm
                </option>
              ))}
            </select>
          </label>
          <div className="flex-1" />
          <span className="tabular text-[11px] text-muted">
            {geom.pads.length} pads · {(b.x2 - b.x1).toFixed(2)} × {(b.y2 - b.y1).toFixed(2)} mm
          </span>
        </div>
        <svg
          ref={view.ref}
          aria-label="Footprint editor canvas"
          viewBox={view.viewBox}
          className={cx('min-h-0 flex-1 touch-none bg-[var(--pcb-board)] outline-none', tool !== 'select' && 'cursor-crosshair')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={finishLine}
        >
          <defs>
            <pattern id="fp-grid" width={1} height={1} patternUnits="userSpaceOnUse" x={-0.5} y={-0.5}>
              <circle cx={0.5} cy={0.5} r={0.02} fill="#ffffff" fillOpacity={0.25} />
            </pattern>
          </defs>
          <rect x={-200} y={-200} width={400} height={400} fill="url(#fp-grid)" />
          <path d="M-0.5 0H0.5M0 -0.5V0.5" stroke="#ffffff" strokeOpacity={0.5} strokeWidth={0.03} />
          <FootprintGraphic geom={geom} selected={sel} />
          {line && <polyline points={[...line.points, line.at].join(' ')} fill="none" stroke="var(--select)" strokeWidth={0.15} strokeDasharray="0.3 0.2" />}
        </svg>
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-muted">
          {tool === 'select' && 'Click to select, drag a pad to move it (arrow keys nudge); drag empty space to pan, scroll to zoom. Millimetres, y down, origin at the part’s centre.'}
          {tool === 'pad' && 'Click to add a pad like the selected one, numbered next.'}
          {tool === 'silk' && 'Click to add points of a silkscreen line; double-click or Enter to finish.'}
        </div>
      </div>

      <div className="flex w-72 shrink-0 flex-col border-l border-line">
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          <Field label="Name">
            <input aria-label="Footprint name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SOIC-8" />
          </Field>

          <div className="space-y-2 rounded-md border border-line p-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Wand2 className="h-3.5 w-3.5 text-indigo-500" /> Generate (IPC-7351)
            </div>
            <Field label="Package">
              <input aria-label="Package" list="ipc-packages" className={inputClass} value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="SOIC-8, QFN-32…" onKeyDown={(e) => e.key === 'Enter' && generate()} />
            </Field>
            <datalist id="ipc-packages">
              {PACKAGE_EXAMPLES.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <p className="text-[11px] text-muted">Sizes in the name override the usual ones: QFN-24-4x4-0.5-EP2.6, LQFP-64-10x10-0.5, HDR-2x05-2.54. For a closer fit, give the datasheet’s lead sizes:</p>
            {(
              [
                ['span', 'Lead span'],
                ['length', 'Foot length'],
                ['width', 'Lead width'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <div className="flex gap-1">
                  {[0, 1].map((i) => (
                    <input
                      key={i}
                      aria-label={`${label} ${i ? 'max' : 'min'}`}
                      className={inputClass}
                      placeholder={i ? 'max' : 'min'}
                      inputMode="decimal"
                      value={leads[key][i]}
                      onChange={(e) => setLeads({ ...leads, [key]: leads[key].map((v, j) => (j === i ? e.target.value : v)) })}
                    />
                  ))}
                </div>
              </Field>
            ))}
            <Button size="sm" variant="outline" className="w-full" disabled={!pkg.trim()} onClick={generate}>
              Generate footprint
            </Button>
          </div>

          {pad && (
            <div className="space-y-2 rounded-md border border-line p-2">
              <div className="text-xs font-medium">Pad</div>
              <Field label="Number">
                <input aria-label="Pad number" className={inputClass} value={pad.number} onChange={(e) => updatePad({ number: e.target.value })} />
              </Field>
              <Field label="Shape">
                <select aria-label="Pad shape" className={inputClass} value={pad.shape} onChange={(e) => updatePad({ shape: e.target.value as PadGeom['shape'], points: [] })}>
                  <option value="rect">Rectangle</option>
                  <option value="oval">Oval</option>
                  <option value="circle">Circle</option>
                  {pad.shape === 'polygon' && <option value="polygon">Polygon</option>}
                </select>
              </Field>
              <Field label="Layer">
                <select
                  aria-label="Pad layer"
                  className={inputClass}
                  value={pad.layer}
                  onChange={(e) => {
                    const layer = e.target.value as PadGeom['layer'];
                    const drill = Math.round(Math.min(pad.w, pad.h) * 0.55 * 100) / 100;
                    updatePad({ layer, hole: layer === 'through' ? (pad.hole ?? { w: drill, h: drill, rotation: 0, dx: 0, dy: 0 }) : null });
                  }}
                >
                  <option value="top">Top (SMD)</option>
                  <option value="bottom">Bottom (SMD)</option>
                  <option value="through">Through-hole</option>
                </select>
              </Field>
              {(['x', 'y', 'w', 'h'] as const).map((key) => (
                <Field key={key} label={{ x: 'X (mm)', y: 'Y (mm)', w: 'Width', h: 'Height' }[key]}>
                  <input type="number" step={grid} className={inputClass} value={pad[key]} onChange={(e) => updatePad({ [key]: num(e.target.value, key === 'w' || key === 'h' ? 0.05 : -Infinity) })} />
                </Field>
              ))}
              <Field label="Rotation">
                <input type="number" step={90} className={inputClass} value={pad.rotation} onChange={(e) => updatePad({ rotation: num(e.target.value) })} />
              </Field>
              {pad.shape === 'rect' && (
                <Field label="Corner radius">
                  <input type="number" step={0.05} min={0} className={inputClass} value={pad.radius} onChange={(e) => updatePad({ radius: num(e.target.value, 0) })} />
                </Field>
              )}
              {pad.hole && (
                <Field label="Drill">
                  <input type="number" step={0.05} min={0.2} className={inputClass} value={pad.hole.w} onChange={(e) => updatePad({ hole: { ...pad.hole!, w: num(e.target.value, 0.2), h: num(e.target.value, 0.2) } })} />
                </Field>
              )}
            </div>
          )}
          {graphic && (
            <div className="space-y-2 rounded-md border border-line p-2">
              <div className="text-xs font-medium">Line</div>
              <Field label="Layer">
                <select className={inputClass} value={graphic.layer} onChange={(e) => updateGraphic({ layer: e.target.value as Graphic['layer'] })}>
                  <option value="silkTop">Silkscreen</option>
                  <option value="silkBottom">Silkscreen (bottom)</option>
                  <option value="outline">Body outline</option>
                </select>
              </Field>
              <Field label="Width">
                <input type="number" step={0.01} min={0.05} className={inputClass} value={graphic.width} onChange={(e) => updateGraphic({ width: num(e.target.value, 0.05) })} />
              </Field>
            </div>
          )}
          {duplicates.length > 0 && <div className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">Pads sharing a number join on the board: {duplicates.join(', ')}</div>}
        </div>
        <div className="space-y-2 border-t border-line p-3">
          {footer}
          <Button variant="primary" className="w-full" disabled={!name.trim() || !geom.pads.length} onClick={() => onSave(name.trim(), geom)}>
            Save footprint
          </Button>
        </div>
      </div>
    </div>
  );
}
