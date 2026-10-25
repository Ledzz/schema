import { Suspense, lazy, useEffect, useRef } from 'react';
import { useEditor } from './store/editor';
import { useWebMcp } from './store/webmcp';
import { ensureWebMcp } from './lib/webmcp';
import { openFromUrl } from './lib/designs';
import { useShortcuts } from './hooks/useShortcuts';
import { SchematicCanvas } from './components/canvas/SchematicCanvas';
import { LibraryPanel } from './components/library/LibraryPanel';
import { LeftPanel } from './components/panels/LeftPanel';
import { RightPanel } from './components/panels/RightPanel';
import { StatusBar, Toast, ToolRail, TopBar } from './components/Chrome';
import { PcbCanvas } from './components/pcb/PcbCanvas';
import { OrderDialog } from './components/pcb/OrderDialog';
import { PcbLeftPanel, PcbToolRail } from './components/pcb/PcbPanels';

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

export default function App() {
  const theme = useEditor((s) => s.theme);
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const mode = useEditor((s) => s.mode);
  const pcb3d = useEditor((s) => s.pcb3d);
  const svgRef = useRef<SVGSVGElement>(null);
  useShortcuts();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    openFromUrl();
  }, []);

  useEffect(() => {
    ensureWebMcp().then((r) => useWebMcp.getState().set({ api: r.api, registered: r.registered, errors: r.errors }));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar svgRef={svgRef} />
      <div className="flex min-h-0 flex-1">
        {mode === 'pcb' ? <PcbLeftPanel /> : <LeftPanel />}
        {mode === 'pcb' ? <PcbToolRail /> : <ToolRail />}
        <main className="min-w-0 flex-1">
          {mode === 'schematic' ? (
            <SchematicCanvas svgRef={svgRef} />
          ) : pcb3d ? (
            <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted">Loading 3D view…</div>}>
              <Board3D />
            </Suspense>
          ) : (
            <PcbCanvas />
          )}
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
      <OrderDialog />
    </div>
  );
}
