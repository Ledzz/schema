import { useEffect, useRef, useState } from 'react';
import { Box, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { BoardViewer, type LoadStatus, type View3d } from '../../lib/pcb/viewer3d';
import { cx } from '../ui';

const VIEWS: { id: View3d; label: string }[] = [
  { id: 'angle', label: 'Angle' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
];

/** 3D view of the board with EasyEDA's part models (loaded on demand: three.js is large). */
export default function Board3D() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<BoardViewer | null>(null);
  const pcb = useEditor((s) => s.project.pcb);
  const components = useEditor((s) => s.project.components);
  const [status, setStatus] = useState<LoadStatus | null>(null);
  const [parts, setParts] = useState(true);

  useEffect(() => {
    const v = new BoardViewer(host.current!);
    viewer.current = v;
    return () => {
      v.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    // Rebuild a moment after edits settle (dragging a part changes the project every frame).
    const t = setTimeout(() => viewer.current?.setProject(useEditor.getState().project, setStatus), 150);
    return () => clearTimeout(t);
  }, [pcb, components]);

  const loading = status && status.loaded < status.total;
  return (
    <div className="relative h-full w-full bg-[var(--pcb-bg)]">
      <div ref={host} className="absolute inset-0" />
      <div className="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-line bg-panel/90 p-1 text-xs shadow-sm backdrop-blur">
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => viewer.current?.setView(v.id)} className="rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
            {v.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--line)]" />
        <button
          onClick={() => {
            setParts(!parts);
            viewer.current?.setPartsVisible(!parts);
          }}
          className={cx('inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10', !parts && 'text-muted')}
          title="Show or hide the parts"
        >
          {parts ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />} Parts
        </button>
        <button onClick={() => useEditor.getState().setPcb3d(false)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10" title="Back to the 2D editor (3)">
          <Box className="h-3.5 w-3.5" /> 2D
        </button>
      </div>
      {status && (loading || status.missing.length > 0 || status.total === 0) && (
        <div className="absolute bottom-3 left-3 max-w-[60%] rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 text-xs text-muted shadow-sm backdrop-blur">
          {status.total === 0 ? (
            'The board is empty: update it from the schematic first.'
          ) : loading ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading 3D models {status.loaded}/{status.total}
            </span>
          ) : (
            <>No 3D model for {status.missing.join(', ')}: shown as blocks.</>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 text-[11px] text-muted">Drag to orbit · right-drag to pan · scroll to zoom</div>
    </div>
  );
}
