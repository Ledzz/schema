import { useEffect, useMemo, useRef } from 'react';
import {
  Blocks,
  Bot,
  Split,
  Cable,
  CircleOff,
  Columns2,
  FlipHorizontal2,
  Maximize,
  Moon,
  MousePointer2,
  PanelBottom,
  Redo2,
  RotateCcw,
  Sun,
  Tag,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ROUTE_MODE_NAMES, useEditor, type Tool } from '../store/editor';
import { useWebMcp } from '../store/webmcp';
import { addSheet, connectivity, downloadText, placeBlock, refreshStock, safeFileName } from '../lib/actions';
import {
  alignSelection,
  deleteSelection,
  duplicateSelection,
  exportSvg,
  fitView,
  mirrorSelection,
  newProject,
  openProjectFile,
  reannotate,
  rotateSelection,
  saveProjectFile,
  selectAll,
  zoomBy,
} from '../lib/editing';
import { formatNetlist } from '../lib/schematic/netlist';
import { crossProbe } from '../lib/crossprobe';
import { bomToJlcpcbCsv, buildBom } from '../lib/schematic/bom';
import { focusLibrarySearch } from '../lib/libraryFocus';
import { IconButton, MenuButton, cx } from './ui';
import { ALIGN_ACTIONS } from './align';
import { startPassive } from '../lib/passives';
import { detachDesign, openDesign, saveDesign } from '../lib/designs';
import { boardModel, changeRouteMode, enterPcb, exportStep } from '../lib/pcb/actions';
import { LAYER_NAMES } from '../lib/pcb/types';
import { PASSIVES, type PassiveKind } from '../shared/passives';

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M12 20V8M6 8h12" />
    </svg>
  );
}
function GroundIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M12 4v9M5 13h14M8 16.5h8M10.5 20h3" />
    </svg>
  );
}

/** Runs a menu action, reporting a refusal instead of dropping it. */
function runAction(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    useEditor.getState().notify((err as Error).message, 'error');
  }
}

/** A block for a new sheet in the middle of the view, selected. */
function placeBlockHere() {
  const s = useEditor.getState();
  const at: [number, number] = [(s.canvasSize.width / 2 - s.view.x) / s.view.zoom - 50, (s.canvasSize.height / 2 - s.view.y) / s.view.zoom - 20];
  const block = placeBlock(at);
  s.setSelection([block.id]);
  s.notify('Block placed: double-click it to open its sheet and add hierarchical ports (H), which become its pins');
}

export function TopBar({ svgRef }: { svgRef: React.RefObject<SVGSVGElement | null> }) {
  const name = useEditor((s) => s.project.name);
  const theme = useEditor((s) => s.theme);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const selectionCount = useEditor((s) => s.selection.length);
  const mode = useEditor((s) => s.mode);
  const split = useEditor((s) => s.split);
  const status = useWebMcp((s) => s.status);
  const sourceFile = useEditor((s) => s.sourceFile);
  const fileInput = useRef<HTMLInputElement>(null);
  const s = useEditor.getState;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
      <div className="flex items-center gap-2 pl-1 pr-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-white">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h4l2-5 4 10 2-5h6" />
          </svg>
        </div>
        <span className="text-sm font-semibold tracking-tight">Schematics</span>
      </div>
      <nav className="flex items-center">
        <MenuButton
          label="File"
          items={[
            { label: 'New schematic', onSelect: () => (s().project.components.length === 0 || confirm('Discard the current schematic?')) && newProject() },
            { label: 'Open…', shortcut: `${mod}O`, onSelect: () => fileInput.current?.click() },
            ...(sourceFile
              ? [
                  { label: `Save to designs/${sourceFile}`, shortcut: `${mod}S`, onSelect: () => void saveDesign() },
                  { label: `Reload designs/${sourceFile}`, onSelect: () => void openDesign(sourceFile) },
                  { label: 'Download a copy', onSelect: saveProjectFile },
                  { label: 'Stop syncing with file', onSelect: detachDesign },
                ]
              : [{ label: 'Save to file', shortcut: `${mod}S`, onSelect: saveProjectFile }]),
            {
              label: 'Export BOM (JLCPCB CSV)',
              separatorBefore: true,
              onSelect: () => downloadText(`${safeFileName(s().project.name)}-BOM-JLCPCB.csv`, bomToJlcpcbCsv(buildBom(s().project.components)), 'text/csv'),
            },
            { label: 'Export netlist', onSelect: () => downloadText(`${safeFileName(s().project.name)}.net.txt`, formatNetlist(connectivity())) },
            { label: 'Export SVG', onSelect: () => exportSvg(svgRef.current) },
            {
              label: 'Export 3D board (STEP)',
              onSelect: () => void exportStep().catch((err) => s().notify(`STEP export failed: ${(err as Error).message}`, 'error')),
            },
            { label: 'Order from JLCPCB…', separatorBefore: true, onSelect: () => s().setOrderOpen(true) },
          ]}
        />
        <MenuButton
          label="Edit"
          items={[
            { label: 'Undo', shortcut: `${mod}Z`, onSelect: () => s().undo(), disabled: !canUndo },
            { label: 'Redo', shortcut: `${mod}⇧Z`, onSelect: () => s().redo(), disabled: !canRedo },
            { label: 'Duplicate', shortcut: `${mod}D`, separatorBefore: true, onSelect: duplicateSelection },
            { label: 'Rotate', shortcut: 'R', onSelect: rotateSelection },
            { label: 'Mirror', shortcut: 'X', onSelect: mirrorSelection },
            { label: 'Delete', shortcut: 'Del', onSelect: deleteSelection },
            { label: 'Select all', shortcut: `${mod}A`, separatorBefore: true, onSelect: selectAll },
            { label: 'Find…', shortcut: `${mod}F`, onSelect: () => s().setFindOpen(true) },
            { label: 'Save selection as block…', disabled: selectionCount === 0 || mode !== 'schematic', onSelect: () => s().setSaveBlockOpen(true) },
            ...ALIGN_ACTIONS.map((a, i) => ({ label: a.label, separatorBefore: i === 0, disabled: selectionCount < a.min || mode !== 'schematic', onSelect: () => alignSelection(a.mode) })),
          ]}
        />
        <MenuButton
          label="Place"
          items={[
            { label: 'Part from library…', shortcut: '/', onSelect: focusLibrarySearch },
            { label: 'Circuit block…', shortcut: 'B', onSelect: () => s().setBlocksOpen(true) },
            { label: 'Custom part…', onSelect: () => s().setPartsEditor({ tab: 'part' }) },
            ...PASSIVE_TOOLS.map((t, i) => ({ label: PASSIVES[t.kind].label, shortcut: t.key, separatorBefore: i === 0, onSelect: () => startPassive(t.kind) })),
            { label: 'Wire', shortcut: 'W', separatorBefore: true, onSelect: () => s().setTool('wire') },
            { label: 'Net label', shortcut: 'N', onSelect: () => s().startPort('label') },
            { label: 'Power flag', shortcut: 'P', onSelect: () => s().startPort('power') },
            { label: 'Ground flag', shortcut: 'G', onSelect: () => s().startPort('ground') },
            { label: 'No-connect flag', shortcut: 'Q', onSelect: () => s().startPort('noconnect') },
            { label: 'Sheet', separatorBefore: true, onSelect: () => runAction(() => addSheet()) },
            { label: 'Hierarchical block (new sheet)', onSelect: () => runAction(() => placeBlockHere()) },
            { label: 'Hierarchical port', shortcut: 'H', onSelect: () => s().startPort('hier') },
          ]}
        />
        <MenuButton
          label="View"
          items={[
            { label: 'Zoom to fit', shortcut: 'F', onSelect: () => fitView() },
            { label: 'Zoom in', shortcut: '+', onSelect: () => zoomBy(1.25) },
            { label: 'Zoom out', shortcut: '−', onSelect: () => zoomBy(0.8) },
            { label: split ? 'One editor at a time' : 'Schematic and PCB side by side', separatorBefore: true, onSelect: () => s().setSplit(!split) },
            { label: mode === 'pcb' ? 'Show in schematic' : 'Show on PCB', shortcut: '⇧X', onSelect: () => void crossProbe() },
            { label: 'Toggle library', shortcut: 'L', separatorBefore: true, onSelect: () => s().setLibraryOpen(!s().libraryOpen) },
            { label: theme === 'dark' ? 'Light theme' : 'Dark theme', onSelect: () => s().toggleTheme() },
          ]}
        />
        <MenuButton
          label="Tools"
          items={[
            { label: 'Re-annotate designators', onSelect: reannotate },
            { label: 'Refresh stock & part types', onSelect: () => refreshStock().then((n) => s().notify(`Updated ${n} parts`)) },
            { label: 'Design check', onSelect: () => s().setLeftTab('check') },
            { label: 'Agent tools (WebMCP)', separatorBefore: true, onSelect: () => s().setRightTab('agent') },
          ]}
        />
      </nav>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openProjectFile(f);
          e.target.value = '';
        }}
      />
      <div className="mx-auto flex min-w-0 items-center gap-3">
        <ModeSwitch />
        <input
          value={name}
          onChange={(e) => s().renameProject(e.target.value)}
          aria-label="Project name"
          className="w-56 truncate rounded-md bg-transparent px-2 py-1 text-center text-[13px] font-medium outline-none hover:bg-black/5 focus:bg-panel-2 focus:ring-2 focus:ring-indigo-500/30 dark:hover:bg-white/5"
          title={sourceFile ? `Synced with designs/${sourceFile}` : undefined}
        />
        {sourceFile && <span className="hidden font-mono text-[10px] text-muted xl:inline">designs/{sourceFile}</span>}
      </div>
      <div className="flex items-center gap-1">
        <IconButton label="Undo" shortcut={`${mod}Z`} onClick={() => s().undo()} disabled={!canUndo}>
          <Undo2 className="h-4 w-4" />
        </IconButton>
        <IconButton label="Redo" shortcut={`${mod}⇧Z`} onClick={() => s().redo()} disabled={!canRedo}>
          <Redo2 className="h-4 w-4" />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-[var(--line)]" />
        <button
          onClick={() => s().setRightTab('agent')}
          data-tip={status?.api ? `WebMCP: ${status.registered.length} tools registered via ${status.api}` : 'WebMCP not detected in this browser'}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs',
            status?.api ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-300' : 'border-line text-muted',
          )}
        >
          <Bot className="h-3.5 w-3.5" />
          WebMCP
          <span className={cx('h-1.5 w-1.5 rounded-full', status?.api ? 'bg-emerald-500' : 'bg-zinc-400')} />
        </button>
        <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => s().toggleTheme()}>
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </IconButton>
      </div>
    </header>
  );
}

function ModeSwitch() {
  const mode = useEditor((s) => s.mode);
  const split = useEditor((s) => s.split);
  return (
    <div className="flex items-center gap-1">
    <div className="flex items-center rounded-lg border border-line bg-panel-2 p-0.5" role="tablist" aria-label="Editor">
      {(['schematic', 'pcb'] as const).map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          onClick={() => (m === 'pcb' ? enterPcb() : useEditor.getState().setMode('schematic'))}
          className={cx('h-6 rounded-md px-2.5 text-xs font-medium', mode === m ? 'bg-panel text-[var(--text)] shadow-sm' : 'text-muted hover:text-[var(--text)]')}
        >
          {m === 'pcb' ? 'PCB' : 'Schematic'}
        </button>
      ))}
    </div>
      <IconButton label={split ? 'One editor at a time' : 'Schematic and PCB side by side'} active={split} className="h-7 w-7" onClick={() => useEditor.getState().setSplit(!split)}>
        <Columns2 className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

const TOOLS: { tool: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { tool: 'select', label: 'Select', key: 'Esc', icon: <MousePointer2 className="h-4 w-4" /> },
  { tool: 'wire', label: 'Wire', key: 'W', icon: <Cable className="h-4 w-4" /> },
  { tool: 'label', label: 'Net label', key: 'N', icon: <Tag className="h-4 w-4" /> },
  { tool: 'power', label: 'Power flag', key: 'P', icon: <PowerIcon /> },
  { tool: 'ground', label: 'Ground flag', key: 'G', icon: <GroundIcon /> },
  { tool: 'noconnect', label: 'No-connect flag', key: 'Q', icon: <CircleOff className="h-4 w-4" /> },
  { tool: 'hier', label: 'Hierarchical port (a pin of this sheet’s block)', key: 'H', icon: <Split className="h-4 w-4" /> },
];

const svgIcon = (d: string) => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const PASSIVE_TOOLS: { kind: PassiveKind; key: string; icon: React.ReactNode }[] = [
  { kind: 'resistor', key: '⇧R', icon: svgIcon('M2 12h4M18 12h4M6 9h12v6H6z') },
  { kind: 'capacitor', key: '⇧C', icon: svgIcon('M2 12h8M14 12h8M10 6v12M14 6v12') },
  { kind: 'inductor', key: '⇧L', icon: svgIcon('M2 14h2a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0h3') },
  { kind: 'ferrite', key: '⇧F', icon: svgIcon('M2 12h5M17 12h5M7 15l3-6h7l-3 6z') },
  { kind: 'diode', key: '⇧D', icon: svgIcon('M2 12h6M16 12h6M8 7v10l8-5zM16 7v10') },
  { kind: 'led', key: '⇧E', icon: svgIcon('M2 13h5M15 13h7M7 8v10l8-5zM15 8v10M14 6l3-3M17 7l3-3') },
];

/** Schematic tools, floating centred over the top of the canvas. */
export function SchematicToolbar() {
  const tool = useEditor((s) => s.tool);
  const placingKind = useEditor((s) => s.placing?.template.generic?.kind);
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const s = useEditor.getState;
  const separator = <div className="mx-1 h-5 w-px shrink-0 bg-[var(--line)]" />;
  return (
    <div
      className="absolute left-1/2 top-3 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-panel/95 p-1 shadow-lg backdrop-blur"
      role="toolbar"
      aria-orientation="horizontal"
      aria-label="Tools"
    >
      {TOOLS.map((t) => (
        <IconButton
          key={t.tool}
          label={t.label}
          shortcut={t.key}
          active={tool === t.tool}
          className="shrink-0"
          onClick={() => (t.tool === 'select' || t.tool === 'wire' ? s().setTool(t.tool) : s().startPort(t.tool as 'label'))}
        >
          {t.icon}
        </IconButton>
      ))}
      {separator}
      {PASSIVE_TOOLS.map((t) => (
        <IconButton key={t.kind} label={PASSIVES[t.kind].label} shortcut={t.key} active={tool === 'place' && placingKind === t.kind} className="shrink-0" onClick={() => startPassive(t.kind)}>
          {t.icon}
        </IconButton>
      ))}
      <IconButton label="Circuit block" shortcut="B" className="shrink-0" onClick={() => s().setBlocksOpen(true)}>
        <Blocks className="h-4 w-4" />
      </IconButton>
      {separator}
      <IconButton label="Rotate" shortcut="R" className="shrink-0" onClick={rotateSelection} disabled={!hasSelection && tool === 'select'}>
        <RotateCcw className="h-4 w-4" />
      </IconButton>
      <IconButton label="Mirror" shortcut="X" className="shrink-0" onClick={mirrorSelection} disabled={!hasSelection && tool !== 'place'}>
        <FlipHorizontal2 className="h-4 w-4" />
      </IconButton>
      <IconButton label="Delete" shortcut="Del" className="shrink-0" onClick={deleteSelection} disabled={!hasSelection}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
      {separator}
      <IconButton label="Zoom in" shortcut="+" className="shrink-0" onClick={() => zoomBy(1.25)}>
        <ZoomIn className="h-4 w-4" />
      </IconButton>
      <IconButton label="Zoom out" shortcut="−" className="shrink-0" onClick={() => zoomBy(0.8)}>
        <ZoomOut className="h-4 w-4" />
      </IconButton>
      <IconButton label="Zoom to fit" shortcut="F" className="shrink-0" onClick={() => fitView()}>
        <Maximize className="h-4 w-4" />
      </IconButton>
      <IconButton label="Parts library" shortcut="L" className="shrink-0" active={libraryOpen} onClick={() => s().setLibraryOpen(!libraryOpen)}>
        <PanelBottom className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

const TOOL_HINT: Record<Tool, string> = {
  select: 'Click to select · drag to move · drag from a pin end to draw a wire · drag empty space to box-select',
  wire: 'Click to add corners · click a pin or wire to finish · / flips the bend · Backspace removes a corner · double-click / right-click ends',
  label: 'Click a pin or wire to drop the label · Tab renames · R rotates',
  power: 'Click a pin or wire to place a power flag · Tab renames · R rotates',
  ground: 'Click a pin or wire to place a ground flag · Tab renames · R rotates',
  noconnect: 'Click a pin to mark it as not connected',
  hier: 'Click a pin or wire to drop the hierarchical port (a pin of this sheet’s blocks) · Tab renames · R rotates',
  place: 'Click to place · R rotate · X mirror · Esc to stop',
};

function PcbStatusBar() {
  const cursor = useEditor((s) => s.pcbCursor);
  const zoom = useEditor((s) => s.pcbView.zoom);
  const layer = useEditor((s) => s.activeLayer);
  const routeMode = useEditor((s) => s.routeMode);
  const tool = useEditor((s) => s.pcbTool);
  const project = useEditor((s) => s.project);
  const unrouted = useMemo(() => [...boardModel(project).conn.unrouted.values()].reduce((a, b) => a + b, 0), [project]);
  const area = 'drag a rectangle, or click corners and click the first one (or Enter) to close · Esc cancels';
  const hint = {
    select: 'Click to select · drag parts to move, a track sideways or by a corner · Alt-drag moves a whole track · R rotate · X flip side',
    route: 'Click a pad to start · click to add corners · V via · M routing mode · Esc finish',
    via: 'Click to place a via',
    hole: 'Click to drill a 3.2 mm mounting hole with a copper-free ring',
    keepout: `Keepout: ${area}`,
    cutout: `Cutout: ${area}`,
    zone: `Pour zone on the active layer: ${area}`,
    outline: `Board outline: ${area}`,
    text: 'Click to place silkscreen text on the active side, then type it in the panel on the right',
  }[tool];
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted">
      <span className="tabular w-36">
        X {cursor[0].toFixed(2)} · Y {cursor[1].toFixed(2)} mm
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-2 rounded-full" style={{ background: `var(--pcb-${layer})` }} />
        {LAYER_NAMES[layer]} layer
      </span>
      <span className="tabular w-14">{Math.round(zoom * 10)}%</span>
      <span className="truncate">{hint}</span>
      <button
        className="ml-auto shrink-0 rounded px-1.5 hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/5"
        data-tip="How routing and dragging treat other tracks: Push moves them aside, Walk around avoids them, Ignore lets copper overlap"
        data-tip-key="M"
        data-tip-side="top"
        onClick={() => changeRouteMode()}
      >
        {ROUTE_MODE_NAMES[routeMode]}
      </button>
      <button className="shrink-0 hover:text-[var(--text)]" onClick={() => useEditor.getState().setPcbLeftTab('nets')}>
        <span className={unrouted ? 'text-amber-500' : 'text-emerald-500'}>{unrouted} unrouted</span>
      </button>
    </footer>
  );
}

export function StatusBar() {
  const mode = useEditor((s) => s.mode);
  return mode === 'pcb' ? <PcbStatusBar /> : <SchematicStatusBar />;
}

function SchematicStatusBar() {
  const cursor = useEditor((s) => s.cursor);
  const zoom = useEditor((s) => s.view.zoom);
  const tool = useEditor((s) => s.tool);
  const project = useEditor((s) => s.project);
  const conn = useMemo(() => connectivity(project), [project]);
  const errors = conn.issues.filter((i) => i.severity === 'error').length;
  const warnings = conn.issues.length - errors;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted">
      <span className="tabular w-28">
        X {cursor[0]} · Y {cursor[1]}
      </span>
      <span className="tabular w-12">{Math.round(zoom * 40)}%</span>
      <span className="truncate">{TOOL_HINT[tool]}</span>
      <button className="ml-auto hover:text-[var(--text)]" onClick={() => useEditor.getState().setLeftTab('check')}>
        {errors > 0 && <span className="text-rose-500">{errors} errors · </span>}
        {warnings} warnings
      </button>
      <span>
        {project.components.length} parts · {conn.nets.length} nets
      </span>
    </footer>
  );
}

export function Toast() {
  const toast = useEditor((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useEditor.setState({ toast: null }), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      key={toast.id}
      role="status"
      className={cx(
        'toast-in pointer-events-none fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-3 py-2 text-xs shadow-xl',
        toast.tone === 'error' ? 'border-rose-500/40 bg-rose-950 text-rose-100' : 'border-line bg-panel',
      )}
    >
      {toast.message}
    </div>
  );
}
