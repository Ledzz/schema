import { Suspense, lazy, useEffect, useRef, useState, type RefObject } from 'react';
import { useEditor } from './store/editor';
import { useWebMcp } from './store/webmcp';
import { ensureWebMcp } from './lib/webmcp';
import { bootWorkspace, openDropped } from './lib/projects';
import { useShortcuts } from './hooks/useShortcuts';
import { StartScreen } from './components/StartScreen';
import { SchematicCanvas } from './components/canvas/SchematicCanvas';
import { LibraryPanel } from './components/library/LibraryPanel';
import { LeftPanel } from './components/panels/LeftPanel';
import { RightPanel } from './components/panels/RightPanel';
import { SchematicToolbar, StatusBar, Toast, TopBar } from './components/Chrome';
import { TooltipLayer } from './components/Tooltip';
import { PcbCanvas } from './components/pcb/PcbCanvas';
import { OrderDialog } from './components/pcb/OrderDialog';
import { BlocksDialog, SaveBlockDialog } from './components/BlocksDialog';
import { PartsEditor } from './components/library/PartsEditor';
import { FindBox } from './components/FindBox';
import { PcbLeftPanel, PcbToolRail } from './components/pcb/PcbPanels';
import { followSelection } from './lib/crossprobe';
import { enterPcb } from './lib/pcb/actions';
import { cx } from './components/ui';

// three.js only loads when the 3D view is opened.
const Board3D = lazy(() => import('./components/pcb/Board3D'));

function LibraryResizer() {
  const onPointerDown = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = useEditor.getState().libraryHeight;
    const move = (ev: PointerEvent) => useEditor.getState().setLibraryHeight(startH + startY - ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize parts library"
      onPointerDown={onPointerDown}
      className="h-1 shrink-0 cursor-row-resize border-t border-line bg-panel transition-colors hover:bg-indigo-500/40"
    />
  );
}

function PcbView() {
  const pcb3d = useEditor((s) => s.pcb3d);
  return pcb3d ? (
    <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted">Loading 3D view…</div>}>
      <Board3D />
    </Suspense>
  ) : (
    <PcbCanvas />
  );
}

/**
 * Schematic and PCB side by side. Both stay live; the one clicked into becomes the active editor
 * (its panels, tools and keys), and each keeps the parts selected in the other in view.
 */
function SplitView({ svgRef }: { svgRef: RefObject<SVGSVGElement | null> }) {
  const mode = useEditor((s) => s.mode);
  const [ratio, setRatio] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => followSelection(), []);
  const activate = (pane: 'schematic' | 'pcb') => () => {
    if (useEditor.getState().mode === pane) return;
    if (pane === 'pcb') void enterPcb();
    else useEditor.getState().setMode('schematic');
  };
  const resize = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - r.left) / r.width)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };
  const label = (pane: 'schematic' | 'pcb') => (
    <div
      className={cx(
        'pointer-events-none absolute bottom-3 right-3 z-10 rounded-md border px-2 py-0.5 text-[11px] font-medium shadow-sm',
        mode === pane ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-600 dark:text-indigo-300' : 'border-line bg-panel/90 text-muted',
      )}
    >
      {pane === 'pcb' ? 'PCB' : 'Schematic'}
      {mode !== pane && ' · click to edit'}
    </div>
  );
  return (
    <div ref={box} className="flex h-full w-full">
      <div className="relative min-w-0" style={{ flexBasis: `${ratio * 100}%` }} onPointerDownCapture={activate('schematic')}>
        <SchematicCanvas svgRef={svgRef} />
        <SchematicToolbar />
        {label('schematic')}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize schematic and PCB"
        onPointerDown={resize}
        className="w-1 shrink-0 cursor-col-resize border-l border-line bg-panel transition-colors hover:bg-indigo-500/40"
      />
      <div className="flex min-w-0 flex-1" onPointerDownCapture={activate('pcb')}>
        <PcbToolRail />
        <div className="relative min-w-0 flex-1">
          <PcbView />
          {label('pcb')}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const theme = useEditor((s) => s.theme);
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const mode = useEditor((s) => s.mode);
  const split = useEditor((s) => s.split);
  const booted = useEditor((s) => s.booted);
  const startOpen = useEditor((s) => s.startOpen);
  const name = useEditor((s) => s.project.name);
  const dirty = useEditor((s) => !!s.file && s.project.updatedAt > s.file.savedAt);
  const svgRef = useRef<SVGSVGElement>(null);
  useShortcuts();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${name} · Schematics`;
  }, [name, dirty]);

  useEffect(() => {
    void bootWorkspace();
  }, []);

  // A project file dropped anywhere on the window opens.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (openDropped(e)) e.preventDefault();
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  useEffect(() => {
    ensureWebMcp().then((r) => useWebMcp.getState().set({ api: r.api, registered: r.registered, errors: r.errors }));
  }, []);

  if (!booted) return <div className="h-full" />;
  if (startOpen) {
    return (
      <>
        <StartScreen />
        <Toast />
        <TooltipLayer />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar svgRef={svgRef} />
      <div className="flex min-h-0 flex-1">
        {mode === 'pcb' ? <PcbLeftPanel /> : <LeftPanel />}
        {mode === 'pcb' && !split && <PcbToolRail />}
        <main className="relative min-w-0 flex-1">
          {split ? (
            <SplitView svgRef={svgRef} />
          ) : mode === 'schematic' ? (
            <>
              <SchematicCanvas svgRef={svgRef} />
              <SchematicToolbar />
            </>
          ) : (
            <PcbView />
          )}
          <FindBox />
        </main>
        <RightPanel />
      </div>
      {libraryOpen && mode === 'schematic' && (
        <>
          <LibraryResizer />
          <LibraryPanel />
        </>
      )}
      <StatusBar />
      <Toast />
      <TooltipLayer />
      <OrderDialog />
      <BlocksDialog />
      <PartsEditor />
      <SaveBlockDialog />
    </div>
  );
}
