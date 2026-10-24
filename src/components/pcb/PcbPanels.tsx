import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, CircleCheck, Download, FlipHorizontal2, Maximize, MousePointer2, RefreshCcw, RotateCcw, Route, Trash2, Wand2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEditor } from '../../store/editor';
import {
  autoroute,
  boardModel,
  checkPcb,
  currentPcb,
  deleteSelectedCopper,
  exportFabrication,
  flipSelected,
  pcbOutOfDate,
  rotateSelected,
  syncPcb,
  updateBoard,
  updatePlacement,
  updateRules,
  updateTrack,
} from '../../lib/pcb/actions';
import { fitPcbView, zoomPcbBy, zoomPcbTo } from '../../lib/pcb/view';
import type { CopperLayer } from '../../lib/pcb/types';
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
  const { conn } = useBoardModel();
  const outOfDate = pcbOutOfDate(project);
  const [busy, setBusy] = useState(false);

  const one = selection.length === 1 ? selection[0] : null;
  const placement = one ? pcb.placements.find((p) => p.componentId === one) : undefined;
  const track = one ? pcb.tracks.find((t) => t.id === one) : undefined;
  const via = one ? pcb.vias.find((v) => v.id === one) : undefined;
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
          className="col-span-2 inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-indigo-600 font-medium text-white hover:bg-indigo-500"
        >
          <Download className="h-4 w-4" /> Export Gerbers, BOM & CPL
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

      {!one && (
        <>
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Board</h3>
            <Field label="Width (mm)">
              <NumberInput label="Board width" step={1} min={5} value={pcb.board.width} onCommit={(width) => updateBoard({ width })} />
            </Field>
            <Field label="Height (mm)">
              <NumberInput label="Board height" step={1} min={5} value={pcb.board.height} onCommit={(height) => updateBoard({ height })} />
            </Field>
            <Field label="Corner radius">
              <NumberInput label="Corner radius" step={0.5} min={0} value={pcb.board.cornerRadius} onCommit={(cornerRadius) => updateBoard({ cornerRadius })} />
            </Field>
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

/* ---------- tool rail ---------- */

export function PcbToolRail() {
  const tool = useEditor((s) => s.pcbTool);
  const layer = useEditor((s) => s.activeLayer);
  const hasSelection = useEditor((s) => s.pcbSelection.length > 0);
  const s = useEditor.getState;
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2" role="toolbar" aria-orientation="vertical" aria-label="PCB tools">
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
      <div className="my-1 h-px w-6 bg-[var(--line)]" />
      <IconButton label="Rotate" shortcut="R" onClick={() => rotateSelected()} disabled={!hasSelection}>
        <RotateCcw className="h-4 w-4" />
      </IconButton>
      <IconButton label="Flip to other side" shortcut="X" onClick={flipSelected} disabled={!hasSelection}>
        <FlipHorizontal2 className="h-4 w-4" />
      </IconButton>
      <IconButton label="Delete track / via" shortcut="Del" onClick={deleteSelectedCopper} disabled={!hasSelection}>
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
