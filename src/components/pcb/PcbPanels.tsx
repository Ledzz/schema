import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Ban, Box, CircleAlert, CircleCheck, CircleDot, Download, Eye, EyeOff, FlipHorizontal2, Image as ImageIcon, Layers, Maximize, MousePointer2, PaintBucket, Pentagon, Plus, RefreshCcw, RotateCcw, Route, Scissors, ShoppingCart, Trash2, Type, Wand2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEditor } from '../../store/editor';
import {
  addLogo,
  addMountingHoles,
  addPours,
  autoroute,
  boardModel,
  boardNets,
  removePours,
  updatePour,
  checkPcb,
  currentPcb,
  deleteSelectedCopper,
  exportFabrication,
  flipSelected,
  pcbOutOfDate,
  removePcbItems,
  rotateSelected,
  setBoardOutline,
  syncPcb,
  updateBoard,
  updateLabel,
  updateLogo,
  updateMechanical,
  updatePlacement,
  updateRules,
  updateText,
  updateTrack,
} from '../../lib/pcb/actions';
import { DESIGNATOR_SIZE, designatorLabel, labelComponent } from '../../lib/pcb/silk';
import { rasterizeInBrowser, traceBitmap } from '../../lib/pcb/logo';
import { fitPcbView, zoomPcbBy, zoomPcbTo } from '../../lib/pcb/view';
import { DEFAULT_HOLE, type CopperLayer, type Cutout, type Keepout, type MountingHole, type Placement, type Pour, type SilkLogo, type SilkText } from '../../lib/pcb/types';
import { cornerHolePositions } from '../../lib/pcb/outline';
import type { PourFill } from '../../lib/pcb/pour';
import { Field, IconButton, Tabs, cx, inputClass } from '../ui';

function useBoardModel() {
  const project = useEditor((s) => s.project);
  return useMemo(() => boardModel(project), [project]);
}

function NumberInput({ value, onCommit, step = 0.05, min, label }: { value: number; onCommit: (v: number) => void; step?: number; min?: number; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Math.round(value * 1000) / 1000)), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && (min === undefined || v >= min) && v !== value) onCommit(v);
    else setText(String(Math.round(value * 1000) / 1000));
  };
  return (
    <input
      aria-label={label}
      className={inputClass}
      type="number"
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/* ---------- left panel ---------- */

export function PcbLeftPanel() {
  const tab = useEditor((s) => s.pcbLeftTab);
  const setTab = useEditor((s) => s.setPcbLeftTab);
  const { conn, board, pcb } = useBoardModel();
  const unrouted = [...conn.unrouted.values()].reduce((a, b) => a + b, 0);
  const issues = useEditor((s) => s.pcbIssues);
  return (
    <aside className="flex min-h-0 w-64 flex-col border-r border-line bg-panel" aria-label="PCB">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'parts', label: `Parts · ${pcb.placements.length}` },
          { value: 'nets', label: <span className="inline-flex items-center gap-1">Nets{unrouted > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-600 dark:text-amber-300">{unrouted}</span>}</span> },
          { value: 'drc', label: <span className="inline-flex items-center gap-1">DRC{issues.length > 0 && <span className="rounded-full bg-rose-500/20 px-1.5 text-[10px] text-rose-500">{issues.length}</span>}</span> },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto text-xs">
        {tab === 'parts' && <PartsList board={board} />}
        {tab === 'nets' && <NetsList conn={conn} board={board} />}
        {tab === 'drc' && <DrcList />}
      </div>
    </aside>
  );
}

function PartsList({ board }: { board: ReturnType<typeof boardModel>['board'] }) {
  const selection = useEditor((s) => s.pcbSelection);
  const pcb = currentPcb(useEditor((s) => s.project));
  const parts = [...board.parts].sort((a, b) => a.component.designator.localeCompare(b.component.designator, undefined, { numeric: true }));
  return (
    <div className="py-1">
      {parts.map((p) => {
        const key = pcb.footprintOf[p.component.id];
        return (
          <button
            key={p.component.id}
            onClick={() => {
              useEditor.getState().setPcbSelection([p.component.id]);
              zoomPcbTo([p.placement.x, p.placement.y]);
            }}
            className={cx('flex w-full items-center gap-2 px-3 py-1 text-left', selection.includes(p.component.id) ? 'bg-indigo-500/12' : 'hover:bg-black/5 dark:hover:bg-white/5')}
          >
            <span className="w-10 shrink-0 font-medium">{p.component.designator}</span>
            <span className={cx('min-w-0 flex-1 truncate', p.fp ? 'text-muted' : 'text-rose-500')}>{p.fp ? (key ? pcb.footprints[key]?.title : '') : 'no footprint'}</span>
            <span className="shrink-0 text-[10px] text-muted">{p.placement.side === 'bottom' ? 'B' : 'T'}</span>
          </button>
        );
      })}
      {parts.length === 0 && <p className="px-3 py-2 text-muted">Use “Update from schematic” to bring parts onto the board.</p>}
    </div>
  );
}

function NetsList({ conn, board }: { conn: ReturnType<typeof boardModel>['conn']; board: ReturnType<typeof boardModel>['board'] }) {
  const highlight = useEditor((s) => s.pcbHighlightNet);
  const nets = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of board.pads) if (p.net) count.set(p.net, (count.get(p.net) ?? 0) + 1);
    return [...count].filter(([, n]) => n > 1).sort((a, b) => (conn.unrouted.get(b[0]) ?? 0) - (conn.unrouted.get(a[0]) ?? 0) || a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [board, conn]);
  return (
    <div className="py-1">
      {nets.map(([net, pads]) => {
        const open = conn.unrouted.get(net) ?? 0;
        return (
          <div key={net} className={cx('group flex items-center gap-2 px-3 py-1', highlight === net ? 'bg-pink-500/12' : 'hover:bg-black/5 dark:hover:bg-white/5')}>
            <button onClick={() => useEditor.getState().setPcbHighlightNet(highlight === net ? null : net)} className="min-w-0 flex-1 truncate text-left">
              {net}
            </button>
            <span className="shrink-0 text-[10px] text-muted">{pads} pads</span>
            {open > 0 ? (
              <button
                title={`Auto-route ${open} connection${open > 1 ? 's' : ''}`}
                onClick={() => {
                  const r = autoroute(net);
                  useEditor.getState().notify(r.failed.length ? `Routed ${r.routed}; ${r.failed.length} could not be routed` : `Routed ${r.routed} connection${r.routed === 1 ? '' : 's'}`);
                }}
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 hover:bg-amber-500/25 dark:text-amber-300"
              >
                {open} <Route className="h-3 w-3" />
              </button>
            ) : (
              <CircleCheck className="h-3 w-3 shrink-0 text-emerald-500" />
            )}
          </div>
        );
      })}
      {nets.length === 0 && <p className="px-3 py-2 text-muted">No multi-pad nets yet. Wire the schematic first.</p>}
    </div>
  );
}

function DrcList() {
  const issues = useEditor((s) => s.pcbIssues);
  const [ran, setRan] = useState(false);
  const run = () => {
    useEditor.getState().setPcbIssues(checkPcb().issues);
    setRan(true);
  };
  useEffect(() => {
    run();
  }, []);
  return (
    <div className="p-2">
      <button onClick={run} className="mb-2 inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5">
        <RefreshCcw className="h-3.5 w-3.5" /> Run design rule check
      </button>
      {ran && issues.length === 0 && (
        <div className="flex flex-col items-center gap-2 p-4 text-center text-muted">
          <CircleCheck className="h-6 w-6 text-emerald-500" />
          No DRC problems.
        </div>
      )}
      <ul>
        {issues.map((i, k) => (
          <li key={k}>
            <button
              onClick={() => {
                if (i.at) zoomPcbTo(i.at);
                if (i.refs.length) useEditor.getState().setPcbSelection(i.refs);
              }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5"
            >
              {i.severity === 'error' ? <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-rose-500" /> : <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />}
              <span>{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- inspector ---------- */

export function PcbInspector() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.pcbSelection);
  const pcb = currentPcb(project);
  const { conn, board } = useBoardModel();
  const outOfDate = pcbOutOfDate(project);
  const [busy, setBusy] = useState(false);

  const one = selection.length === 1 ? selection[0] : null;
  // A selected designator shows its part.
  const labelOf = one ? labelComponent(one) : null;
  const placement = one ? pcb.placements.find((p) => p.componentId === (labelOf ?? one)) : undefined;
  const track = one ? pcb.tracks.find((t) => t.id === one) : undefined;
  const via = one ? pcb.vias.find((v) => v.id === one) : undefined;
  const pour = one ? pcb.pours?.find((z) => z.id === one) : undefined;
  const hole = one ? pcb.holes?.find((h) => h.id === one) : undefined;
  const keepout = one ? pcb.keepouts?.find((k) => k.id === one) : undefined;
  const cutout = one ? pcb.board.cutouts?.find((c) => c.id === one) : undefined;
  const text = one ? pcb.texts?.find((t) => t.id === one) : undefined;
  const logo = one ? pcb.logos?.find((l) => l.id === one) : undefined;
  const part = placement ? board.parts.find((p) => p.component.id === placement.componentId) : undefined;
  const component = placement ? project.components.find((c) => c.id === placement.componentId) : undefined;
  const unrouted = [...conn.unrouted.values()].reduce((a, b) => a + b, 0);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await syncPcb();
      useEditor.getState().notify(`PCB updated: ${r.added.length} added, ${r.removed} removed${r.missing.length ? `; no footprint for ${r.missing.join(', ')}` : ''}`);
    } catch (err) {
      useEditor.getState().notify(`Update failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-3 text-xs">
      {outOfDate && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
          <div className="font-medium text-amber-600 dark:text-amber-300">Schematic has changed</div>
          <p className="mt-0.5 text-[11px] text-muted">Parts were added, removed or re-assigned since the last update.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <button disabled={busy} onClick={sync} className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5">
          <RefreshCcw className={cx('h-3.5 w-3.5', busy && 'animate-spin')} /> Update
        </button>
        <button
          disabled={unrouted === 0}
          onClick={() => {
            const r = autoroute();
            useEditor.getState().notify(r.failed.length ? `Routed ${r.routed}; ${r.failed.length} connections need manual routing` : `Routed ${r.routed} connections`);
            useEditor.getState().setPcbIssues(checkPcb().issues);
          }}
          className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
          title="Experimental grid router"
        >
          <Wand2 className="h-3.5 w-3.5" /> Auto-route
        </button>
        <button
          onClick={() => {
            const issues = checkPcb().issues;
            useEditor.getState().setPcbIssues(issues);
            const errors = issues.filter((i) => i.severity === 'error').length;
            if (errors && !confirm(`DRC reports ${errors} error${errors > 1 ? 's' : ''}. Export anyway?`)) return;
            exportFabrication();
          }}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5"
          title="Download the Gerber zip, BOM and pick-and-place files"
        >
          <Download className="h-3.5 w-3.5" /> Export files
        </button>
        <button
          onClick={() => useEditor.getState().setOrderOpen(true)}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-indigo-600 font-medium text-white hover:bg-indigo-500"
          title="Check the board, download the files and open JLCPCB's order page"
        >
          <ShoppingCart className="h-3.5 w-3.5" /> Order from JLCPCB
        </button>
      </div>
      <div className="flex justify-between rounded-lg border border-line bg-panel-2 p-2 text-[11px]">
        <span>{pcb.placements.length} parts</span>
        <span>{pcb.tracks.length} tracks</span>
        <span>{pcb.vias.length} vias</span>
        <span className={unrouted ? 'text-amber-500' : 'text-emerald-500'}>{unrouted} unrouted</span>
      </div>

      {placement && component && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">
            {component.designator} <span className="font-normal text-muted">{component.value}</span>
          </h3>
          <Field label="X (mm)">
            <NumberInput label="X" value={placement.x} onCommit={(x) => updatePlacement(placement.componentId, { x })} />
          </Field>
          <Field label="Y (mm)">
            <NumberInput label="Y" value={placement.y} onCommit={(y) => updatePlacement(placement.componentId, { y })} />
          </Field>
          <Field label="Rotation">
            <NumberInput label="Rotation" step={90} value={placement.rotation} onCommit={(rotation) => updatePlacement(placement.componentId, { rotation: ((rotation % 360) + 360) % 360 })} />
          </Field>
          <Field label="Side">
            <div className="flex gap-1">
              {(['top', 'bottom'] as CopperLayer[]).map((side) => (
                <button key={side} onClick={() => updatePlacement(placement.componentId, { side })} className={cx('h-7 flex-1 rounded-md border capitalize', placement.side === side ? 'border-indigo-500 bg-indigo-500/10' : 'border-line')}>
                  {side}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Footprint">
            <span className="truncate" title={pcb.footprints[pcb.footprintOf[component.id] ?? '']?.title}>
              {pcb.footprints[pcb.footprintOf[component.id] ?? '']?.title ?? 'none'}
            </span>
          </Field>
          {part?.fp && <LabelEditor placement={placement} at={designatorLabel(part).at} />}
        </section>
      )}
      {track && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Track</h3>
          <Field label="Net">
            <span>{conn.itemNet.get(track.id) ?? track.net ?? '—'}</span>
          </Field>
          <Field label="Width (mm)">
            <NumberInput label="Track width" value={track.width} min={0.1} onCommit={(width) => updateTrack(track.id, { width })} />
          </Field>
          <Field label="Layer">
            <div className="flex gap-1">
              {(['top', 'bottom'] as CopperLayer[]).map((layer) => (
                <button key={layer} onClick={() => updateTrack(track.id, { layer })} className={cx('h-7 flex-1 rounded-md border capitalize', track.layer === layer ? 'border-indigo-500 bg-indigo-500/10' : 'border-line')}>
                  {layer}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Length">
            <span>{track.points.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - track.points[i][0], p[1] - track.points[i][1]), 0).toFixed(2)} mm</span>
          </Field>
        </section>
      )}
      {via && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">Via</h3>
          <Field label="Net">
            <span>{conn.itemNet.get(via.id) ?? via.net ?? '—'}</span>
          </Field>
          <Field label="Size">
            <span>
              {via.diameter} / {via.drill} mm
            </span>
          </Field>
        </section>
      )}

      {pour && <PourEditor pour={pour} fill={board.fills.find((f) => f.pour.id === pour.id)} />}
      {hole && <HoleEditor hole={hole} />}
      {keepout && <KeepoutEditor keepout={keepout} />}
      {cutout && <CutoutEditor cutout={cutout} />}
      {text && <TextEditor text={text} />}
      {logo && <LogoEditor logo={logo} />}

      {!one && (
        <>
          <PoursSection fills={board.fills} />
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Board</h3>
            {pcb.board.outline ? (
              <Field label="Outline">
                <span className="flex items-center gap-2">
                  Custom, {Math.round(pcb.board.width * 10) / 10} × {Math.round(pcb.board.height * 10) / 10} mm
                  <button onClick={() => setBoardOutline(null)} className="text-indigo-500 hover:underline">
                    Make rectangle
                  </button>
                </span>
              </Field>
            ) : (
              <>
                <Field label="Width (mm)">
                  <NumberInput label="Board width" step={1} min={5} value={pcb.board.width} onCommit={(width) => updateBoard({ width })} />
                </Field>
                <Field label="Height (mm)">
                  <NumberInput label="Board height" step={1} min={5} value={pcb.board.height} onCommit={(height) => updateBoard({ height })} />
                </Field>
              </>
            )}
            <Field label="Corner radius">
              <NumberInput label="Corner radius" step={0.5} min={0} value={pcb.board.cornerRadius} onCommit={(cornerRadius) => updateBoard({ cornerRadius })} />
            </Field>
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5 text-[11px] text-muted">
              <span>{pcb.holes?.length ?? 0} mounting holes</span>
              <span>{pcb.keepouts?.length ?? 0} keepouts</span>
              <span>{pcb.board.cutouts?.length ?? 0} cutouts</span>
            </div>
            <button
              onClick={() => {
                const inset = DEFAULT_HOLE.keepout / 2 + 0.5;
                const free = cornerHolePositions(pcb.board, inset).filter((p) => !(pcb.holes ?? []).some((h) => Math.hypot(h.x - p[0], h.y - p[1]) < 1));
                if (!free.length) return useEditor.getState().notify('Every corner already has a mounting hole');
                const added = addMountingHoles(free);
                useEditor.getState().setPcbIssues(checkPcb().issues);
                useEditor.getState().notify(`Added ${added.length} M3 mounting holes ${inset} mm from the edges`);
              }}
              className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5"
            >
              <CircleDot className="h-3.5 w-3.5" /> Mounting holes in the corners
            </button>
            <p className="text-[10px] leading-snug text-muted">Draw an outline, keepouts, cutouts and pour zones, or add text and logos, with the tools on the left.</p>
          </section>
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Design rules</h3>
            <Field label="Clearance">
              <NumberInput label="Clearance" min={0.09} value={pcb.rules.clearance} onCommit={(clearance) => updateRules({ clearance })} />
            </Field>
            <Field label="Track">
              <NumberInput label="Track width" min={0.09} value={pcb.rules.trackWidth} onCommit={(trackWidth) => updateRules({ trackWidth })} />
            </Field>
            <Field label="Power track">
              <NumberInput label="Power track width" min={0.09} value={pcb.rules.powerTrackWidth} onCommit={(powerTrackWidth) => updateRules({ powerTrackWidth })} />
            </Field>
            <Field label="Via">
              <NumberInput label="Via diameter" min={0.3} value={pcb.rules.viaDiameter} onCommit={(viaDiameter) => updateRules({ viaDiameter })} />
            </Field>
            <Field label="Via drill">
              <NumberInput label="Via drill" min={0.2} value={pcb.rules.viaDrill} onCommit={(viaDrill) => updateRules({ viaDrill })} />
            </Field>
            <p className="text-[10px] leading-snug text-muted">JLCPCB 2-layer minimums: 0.127 mm track/clearance, 0.3 mm via drill (0.2 mm at extra cost).</p>
          </section>
        </>
      )}
    </div>
  );
}

/* ---------- copper pours ---------- */

function PoursSection({ fills }: { fills: PourFill[] }) {
  const project = useEditor((s) => s.project);
  const nets = useMemo(() => boardNets(project), [project]);
  const [net, setNet] = useState('');
  const [layers, setLayers] = useState<'both' | CopperLayer>('both');
  const chosen = net || nets[0] || '';
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Copper pours</h3>
      {fills.map((f) => {
        const starved = f.thermals.filter((t) => t.spokes < 2).length;
        return (
          <button
            key={f.pour.id}
            onClick={() => useEditor.getState().setPcbSelection([f.pour.id])}
            className="flex w-full items-center gap-2 rounded-md border border-line px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span className="h-2 w-2 rounded-full" style={{ background: f.pour.layer === 'top' ? 'var(--pcb-top)' : 'var(--pcb-bottom)' }} />
            <span className="font-medium">{f.pour.net}</span>
            <span className="text-muted">{f.pour.layer}</span>
            <span className={cx('ml-auto text-[10px]', f.areas.length ? 'text-muted' : 'text-amber-500')}>
              {f.areas.length} area{f.areas.length === 1 ? '' : 's'}
              {starved > 0 && <span className="text-amber-500"> · {starved} weak</span>}
            </span>
          </button>
        );
      })}
      {nets.length > 0 ? (
        <div className="flex gap-1">
          <select aria-label="Pour net" className={inputClass} value={chosen} onChange={(e) => setNet(e.target.value)}>
            {nets.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select aria-label="Pour layers" className={cx(inputClass, 'w-24')} value={layers} onChange={(e) => setLayers(e.target.value as 'both' | CopperLayer)}>
            <option value="both">Both</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
          <button
            aria-label="Add copper pour"
            title="Add a pour on the chosen net (replaces existing pours of that net on those layers)"
            onClick={() => {
              const created = addPours(chosen, layers === 'both' ? ['top', 'bottom'] : [layers]);
              useEditor.getState().setPcbSelection(created.length === 1 ? [created[0].id] : []);
              useEditor.getState().notify(`Added ${chosen} pour${created.length > 1 ? 's on both layers' : ` on ${created[0].layer}`}`);
            }}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-indigo-600 px-2 text-white hover:bg-indigo-500"
          >
            <Plus className="h-3.5 w-3.5" /> Pour
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-muted">Wire the schematic first; pours fill a net.</p>
      )}
    </section>
  );
}

function PourEditor({ pour, fill }: { pour: Pour; fill?: PourFill }) {
  const nets = boardNets(useEditor((s) => s.project));
  const set = (patch: Partial<Pour>) => updatePour(pour.id, patch);
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Copper pour</h3>
        <button
          onClick={() => {
            removePours([pour.id]);
            useEditor.getState().setPcbSelection([]);
          }}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-rose-500 hover:bg-rose-500/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
      <Field label="Area">
        {pour.outline ? (
          <span className="flex items-center gap-2">
            Zone
            <button onClick={() => set({ outline: null })} className="text-indigo-500 hover:underline">
              Fill whole board
            </button>
          </span>
        ) : (
          <span>Whole board</span>
        )}
      </Field>
      <Field label="Net">
        <select className={inputClass} value={pour.net} onChange={(e) => set({ net: e.target.value })}>
          {[...new Set([pour.net, ...nets])].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Layer">
        <div className="flex gap-1">
          {(['top', 'bottom'] as CopperLayer[]).map((layer) => (
            <button key={layer} onClick={() => set({ layer })} className={cx('h-7 flex-1 rounded-md border capitalize', pour.layer === layer ? 'border-indigo-500 bg-indigo-500/10' : 'border-line')}>
              {layer}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Clearance">
        <NumberInput label="Pour clearance" min={0.1} value={pour.clearance} onCommit={(clearance) => set({ clearance })} />
      </Field>
      <Field label="Pads">
        <div className="flex gap-1">
          {(['thermal', 'solid'] as const).map((connection) => (
            <button key={connection} onClick={() => set({ connection })} className={cx('h-7 flex-1 rounded-md border capitalize', pour.connection === connection ? 'border-indigo-500 bg-indigo-500/10' : 'border-line')}>
              {connection}
            </button>
          ))}
        </div>
      </Field>
      {pour.connection === 'thermal' && (
        <>
          <Field label="Thermal gap">
            <NumberInput label="Thermal gap" min={0.1} value={pour.thermalGap} onCommit={(thermalGap) => set({ thermalGap })} />
          </Field>
          <Field label="Spoke width">
            <NumberInput label="Spoke width" min={0.15} value={pour.spokeWidth} onCommit={(spokeWidth) => set({ spokeWidth })} />
          </Field>
        </>
      )}
      <Field label="Min width">
        <NumberInput label="Minimum copper width" min={0} value={pour.minWidth} onCommit={(minWidth) => set({ minWidth })} />
      </Field>
      {fill && (
        <p className="text-[11px] text-muted">
          {fill.areas.length} copper area{fill.areas.length === 1 ? '' : 's'}
          {pour.connection === 'thermal' && ` · ${fill.thermals.length} thermal pads${fill.thermals.some((t) => t.spokes < 2) ? `, ${fill.thermals.filter((t) => t.spokes < 2).length} with fewer than 2 spokes` : ''}`}
        </p>
      )}
    </section>
  );
}

/* ---------- mechanical ---------- */

function DeleteButton({ id, what }: { id: string; what: string }) {
  return (
    <button
      onClick={() => {
        removePcbItems(new Set([id]));
        useEditor.getState().setPcbSelection([]);
      }}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/5"
      title={`Delete ${what}`}
    >
      <Trash2 className="h-3.5 w-3.5" /> Delete
    </button>
  );
}

function HoleEditor({ hole }: { hole: MountingHole }) {
  const set = (patch: Partial<MountingHole>) => updateMechanical(hole.id, patch);
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center justify-between text-sm font-semibold">
        Mounting hole <DeleteButton id={hole.id} what="mounting hole" />
      </h3>
      <Field label="X (mm)">
        <NumberInput label="Hole X" value={hole.x} onCommit={(x) => set({ x })} />
      </Field>
      <Field label="Y (mm)">
        <NumberInput label="Hole Y" value={hole.y} onCommit={(y) => set({ y })} />
      </Field>
      <Field label="Drill (mm)">
        <NumberInput label="Hole diameter" step={0.1} min={0.5} value={hole.diameter} onCommit={(diameter) => set({ diameter, keepout: Math.max(hole.keepout, diameter) })} />
      </Field>
      <Field label="Free ring (mm)">
        <NumberInput label="Keepout diameter" step={0.1} min={hole.diameter} value={hole.keepout} onCommit={(keepout) => set({ keepout })} />
      </Field>
      <p className="text-[10px] leading-snug text-muted">Non-plated, drilled by JLCPCB. No copper or parts inside the ring; 3.2 mm with a 6.4 mm ring suits M3 screws.</p>
    </section>
  );
}

function KeepoutEditor({ keepout }: { keepout: Keepout }) {
  const set = (patch: Partial<Keepout>) => updateMechanical(keepout.id, patch);
  const toggleLayer = (layer: CopperLayer) => {
    const layers = keepout.layers.includes(layer) ? keepout.layers.filter((l) => l !== layer) : [...keepout.layers, layer];
    if (layers.length) set({ layers });
  };
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center justify-between text-sm font-semibold">
        Keepout area <DeleteButton id={keepout.id} what="keepout" />
      </h3>
      <Field label="Layers">
        <div className="flex gap-1">
          {(['top', 'bottom'] as CopperLayer[]).map((layer) => (
            <button key={layer} onClick={() => toggleLayer(layer)} className={cx('h-7 flex-1 rounded-md border capitalize', keepout.layers.includes(layer) ? 'border-indigo-500 bg-indigo-500/10' : 'border-line')}>
              {layer}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Keep out">
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {(['tracks', 'vias', 'pours', 'parts'] as const).map((k) => (
            <label key={k} className="inline-flex items-center gap-1.5 capitalize">
              <input type="checkbox" checked={keepout[k]} onChange={(e) => set({ [k]: e.target.checked })} /> {k}
            </label>
          ))}
        </div>
      </Field>
      <p className="text-[10px] leading-snug text-muted">The auto-router avoids it, pours leave it empty and the design check reports anything inside.</p>
    </section>
  );
}

function CutoutEditor({ cutout }: { cutout: Cutout }) {
  const xs = cutout.outline.map((p) => p[0]);
  const ys = cutout.outline.map((p) => p[1]);
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center justify-between text-sm font-semibold">
        Cutout <DeleteButton id={cutout.id} what="cutout" />
      </h3>
      <Field label="Size">
        <span>
          {(Math.max(...xs) - Math.min(...xs)).toFixed(2)} × {(Math.max(...ys) - Math.min(...ys)).toFixed(2)} mm · {cutout.outline.length} corners
        </span>
      </Field>
      <p className="text-[10px] leading-snug text-muted">Milled through the board along the outline layer. Drag it to move.</p>
    </section>
  );
}

/* ---------- silkscreen ---------- */

function SideButtons({ side, onChange }: { side: CopperLayer; onChange: (side: CopperLayer) => void }) {
  return (
    <div className="flex gap-1">
      {(['top', 'bottom'] as CopperLayer[]).map((l) => (
        <button key={l} onClick={() => onChange(l)} className={cx('h-7 flex-1 rounded-md border capitalize', side === l ? 'border-indigo-500 bg-indigo-500/10' : 'border-line')}>
          {l}
        </button>
      ))}
    </div>
  );
}

function LabelEditor({ placement, at }: { placement: Placement; at: [number, number] }) {
  const l = placement.label ?? {};
  const set = (patch: Parameters<typeof updateLabel>[1]) => updateLabel(placement.componentId, patch);
  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      <h4 className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
        Designator
        <span className="flex items-center gap-1 normal-case tracking-normal">
          <button onClick={() => set({ hidden: !l.hidden })} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-black/5 dark:hover:bg-white/5" title={l.hidden ? 'Show on the board' : 'Hide from the board'}>
            {l.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {l.hidden ? 'Hidden' : 'Shown'}
          </button>
          {placement.label && (
            <button onClick={() => set(null)} className="text-indigo-500 hover:underline">
              Reset
            </button>
          )}
        </span>
      </h4>
      <Field label="Text height">
        <NumberInput label="Designator height" step={0.1} min={0.5} value={l.size ?? DESIGNATOR_SIZE} onCommit={(size) => set({ size })} />
      </Field>
      <Field label="Rotation">
        <NumberInput label="Designator rotation" step={90} value={l.rotation ?? 0} onCommit={(rotation) => set({ rotation: ((rotation % 360) + 360) % 360 })} />
      </Field>
      <Field label="Position">
        <span className="tabular text-muted">
          {at[0].toFixed(2)}, {at[1].toFixed(2)} mm · drag it on the board
        </span>
      </Field>
    </div>
  );
}

function TextEditor({ text }: { text: SilkText }) {
  const set = (patch: Partial<SilkText>) => updateText(text.id, patch);
  const [draft, setDraft] = useState(text.text);
  useEffect(() => setDraft(text.text), [text.text]);
  const commit = () => draft !== text.text && set({ text: draft || ' ' });
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center justify-between text-sm font-semibold">
        Text <DeleteButton id={text.id} what="text" />
      </h3>
      <textarea
        aria-label="Text"
        autoFocus={text.text === 'TEXT'}
        onFocus={(e) => e.target.select()}
        className={cx(inputClass, 'h-auto min-h-[52px] resize-y py-1 font-mono')}
        rows={Math.min(4, draft.split('\n').length + 1)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      <Field label="Height (mm)">
        <NumberInput label="Text height" step={0.1} min={0.5} value={text.size} onCommit={(size) => set({ size })} />
      </Field>
      <Field label="Line width">
        <NumberInput label="Line width" step={0.01} min={0.1} value={text.stroke ?? Math.max(0.12, text.size * 0.15)} onCommit={(stroke) => set({ stroke })} />
      </Field>
      <Field label="Rotation">
        <NumberInput label="Text rotation" step={90} value={text.rotation} onCommit={(rotation) => set({ rotation: ((rotation % 360) + 360) % 360 })} />
      </Field>
      <Field label="Side">
        <SideButtons side={text.side} onChange={(side) => set({ side })} />
      </Field>
      <p className="text-[10px] leading-snug text-muted">Shift+Enter starts a new line. JLCPCB prints text 1 mm or taller with 0.15 mm lines reliably.</p>
    </section>
  );
}

function LogoEditor({ logo }: { logo: SilkLogo }) {
  const set = (patch: Parameters<typeof updateLogo>[1]) => updateLogo(logo.id, patch);
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center justify-between text-sm font-semibold">
        <span className="truncate">Logo · {logo.name}</span> <DeleteButton id={logo.id} what="logo" />
      </h3>
      <Field label="Width (mm)">
        <NumberInput label="Logo width" step={0.5} min={1} value={logo.width} onCommit={(width) => set({ width })} />
      </Field>
      <Field label="Height">
        <span className="text-muted">{logo.height.toFixed(2)} mm</span>
      </Field>
      <Field label="Rotation">
        <NumberInput label="Logo rotation" step={90} value={logo.rotation} onCommit={(rotation) => set({ rotation: ((rotation % 360) + 360) % 360 })} />
      </Field>
      <Field label="Side">
        <SideButtons side={logo.side} onChange={(side) => set({ side })} />
      </Field>
      <p className="text-[10px] leading-snug text-muted">Traced from the image's dark areas. Very thin lines (under 0.15 mm on the board) may not print.</p>
    </section>
  );
}

/** Traces an image file into a logo in the middle of the board and selects it. */
async function importLogo(file: File) {
  const s = useEditor.getState();
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('Could not read the file'));
      r.readAsDataURL(file);
    });
    const { shapes, aspect } = traceBitmap(await rasterizeInBrowser(url));
    const b = currentPcb().board;
    const width = Math.round(Math.min(15, b.width / 3, (b.height / 3) / aspect) * 10) / 10;
    const logo = addLogo({ name: file.name.replace(/\.[^.]+$/, ''), x: b.x + b.width / 2, y: b.y + b.height / 2, width, height: width * aspect, rotation: 0, side: s.activeLayer, shapes });
    s.setPcbTool('select');
    s.setPcbSelection([logo.id]);
    s.notify(`Logo traced (${shapes.length} shape${shapes.length === 1 ? '' : 's'}); drag it into place and set its width on the right`);
  } catch (err) {
    s.notify(`Logo import failed: ${(err as Error).message}`, 'error');
  }
}

/* ---------- tool rail ---------- */

export function PcbToolRail() {
  const tool = useEditor((s) => s.pcbTool);
  const layer = useEditor((s) => s.activeLayer);
  const hasSelection = useEditor((s) => s.pcbSelection.length > 0);
  const showPours = useEditor((s) => s.showPours);
  const pcb3d = useEditor((s) => s.pcb3d);
  const logoInput = useRef<HTMLInputElement>(null);
  const s = useEditor.getState;
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel py-2" role="toolbar" aria-orientation="vertical" aria-label="PCB tools">
      <IconButton label="Select" shortcut="Esc" active={tool === 'select'} onClick={() => s().setPcbTool('select')}>
        <MousePointer2 className="h-4 w-4" />
      </IconButton>
      <IconButton label="Route track" shortcut="W" active={tool === 'route'} onClick={() => s().setPcbTool('route')}>
        <Route className="h-4 w-4" />
      </IconButton>
      <IconButton label="Place via" shortcut="V" active={tool === 'via'} onClick={() => s().setPcbTool('via')}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      </IconButton>
      <div className="my-1 h-px w-6 bg-[var(--line)]" />
      <IconButton label="Board outline" active={tool === 'outline'} onClick={() => s().setPcbTool('outline')}>
        <Pentagon className="h-4 w-4" />
      </IconButton>
      <IconButton label="Mounting hole" active={tool === 'hole'} onClick={() => s().setPcbTool('hole')}>
        <CircleDot className="h-4 w-4" />
      </IconButton>
      <IconButton label="Keepout area" active={tool === 'keepout'} onClick={() => s().setPcbTool('keepout')}>
        <Ban className="h-4 w-4" />
      </IconButton>
      <IconButton label="Board cutout" active={tool === 'cutout'} onClick={() => s().setPcbTool('cutout')}>
        <Scissors className="h-4 w-4" />
      </IconButton>
      <IconButton label="Pour zone" active={tool === 'zone'} onClick={() => s().setPcbTool('zone')}>
        <PaintBucket className="h-4 w-4" />
      </IconButton>
      <IconButton label="Silkscreen text" active={tool === 'text'} onClick={() => s().setPcbTool('text')}>
        <Type className="h-4 w-4" />
      </IconButton>
      <IconButton label="Logo from an image (PNG, JPEG, SVG)" onClick={() => logoInput.current?.click()}>
        <ImageIcon className="h-4 w-4" />
      </IconButton>
      <input
        ref={logoInput}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importLogo(f);
          e.target.value = '';
        }}
      />
      <div className="my-1 h-px w-6 bg-[var(--line)]" />
      {(['top', 'bottom'] as CopperLayer[]).map((l, i) => (
        <button
          key={l}
          title={`${l === 'top' ? 'Top' : 'Bottom'} layer (${i + 1})`}
          aria-pressed={layer === l}
          onClick={() => s().setActiveLayer(l)}
          className={cx('flex h-7 w-8 items-center justify-center rounded-md text-[10px] font-semibold', layer === l ? 'ring-2 ring-[var(--select)]' : 'opacity-60 hover:opacity-100')}
          style={{ background: l === 'top' ? 'var(--pcb-top)' : 'var(--pcb-bottom)', color: 'white' }}
        >
          {l === 'top' ? 'TOP' : 'BOT'}
        </button>
      ))}
      <IconButton label={showPours ? 'Hide copper pours' : 'Show copper pours'} active={showPours} onClick={() => s().setShowPours(!showPours)}>
        <Layers className="h-4 w-4" />
      </IconButton>
      <IconButton label="3D view" shortcut="3" active={pcb3d} onClick={() => s().setPcb3d(!pcb3d)}>
        <Box className="h-4 w-4" />
      </IconButton>
      <div className="my-1 h-px w-6 bg-[var(--line)]" />
      <IconButton label="Rotate part, text, logo or designator" shortcut="R" onClick={() => rotateSelected()} disabled={!hasSelection}>
        <RotateCcw className="h-4 w-4" />
      </IconButton>
      <IconButton label="Flip to other side" shortcut="X" onClick={flipSelected} disabled={!hasSelection}>
        <FlipHorizontal2 className="h-4 w-4" />
      </IconButton>
      <IconButton label="Delete track, via, hole, keepout, cutout, text or logo (hides a designator)" shortcut="Del" onClick={deleteSelectedCopper} disabled={!hasSelection}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
      <div className="mt-auto flex flex-col items-center gap-1">
        <IconButton label="Zoom in" shortcut="+" onClick={() => zoomPcbBy(1.25)}>
          <ZoomIn className="h-4 w-4" />
        </IconButton>
        <IconButton label="Zoom out" shortcut="−" onClick={() => zoomPcbBy(0.8)}>
          <ZoomOut className="h-4 w-4" />
        </IconButton>
        <IconButton label="Zoom to fit" shortcut="F" onClick={() => fitPcbView()}>
          <Maximize className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}
