import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MousePointerClick, Search } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { addPort, placeComponent } from '../../lib/actions';
import { finishWireDraft, fitView, zoomBy } from '../../lib/editing';
import { normBox, samePoint, snapVec } from '../../lib/schematic/geometry';
import { connectionNear, hitTest, itemsInBox } from '../../lib/schematic/hit';
import { analyze } from '../../lib/schematic/netlist';
import { moveItems } from '../../lib/schematic/ops';
import { elbow, simplify } from '../../lib/schematic/route';
import { resolverFor } from '../../lib/schematic/symbols';
import type { Component, NetPort, Vec } from '../../lib/schematic/types';
import { ComponentGraphic, PortGraphic } from './graphics';
import { Kbd } from '../ui';

type Interaction =
  | { mode: 'none' }
  | { mode: 'pan'; start: Vec; view: { x: number; y: number } }
  | { mode: 'drag'; start: Vec; ids: Set<string>; delta: Vec }
  | { mode: 'box'; start: Vec };

function nextLabelName(name: string): string {
  const m = /^(.*?)(\d+)$/.exec(name);
  return m ? `${m[1]}${Number(m[2]) + 1}` : name;
}

export function SchematicCanvas({ svgRef }: { svgRef: React.RefObject<SVGSVGElement | null> }) {
  const project = useEditor((s) => s.project);
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const placing = useEditor((s) => s.placing);
  const portTemplate = useEditor((s) => s.portTemplate);
  const placementRotation = useEditor((s) => s.placementRotation);
  const placementMirror = useEditor((s) => s.placementMirror);
  const highlightNet = useEditor((s) => s.highlightNet);
  const wireDraft = useEditor((s) => s.wireDraft);
  const canvasSize = useEditor((s) => s.canvasSize);

  const containerRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction>({ mode: 'none' });
  const spaceDown = useRef(false);
  const [pointer, setPointer] = useState<Vec>([0, 0]);
  const [inside, setInside] = useState(false);
  const [box, setBox] = useState<{ a: Vec; b: Vec } | null>(null);
  const [hover, setHover] = useState<{ text: string; at: Vec } | null>(null);

  const symbols = useMemo(() => resolverFor(project), [project.symbols]); // eslint-disable-line react-hooks/exhaustive-deps
  const conn = useMemo(
    () => analyze(project, symbols),
    [project.components, project.wires, project.ports, symbols], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const selected = useMemo(() => new Set(selection), [selection]);
  const highlightPins = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!highlightNet) return map;
    for (const [key, net] of conn.pinNet) {
      if (net !== highlightNet) continue;
      const [cid, pid] = key.split(':');
      if (!map.has(cid)) map.set(cid, new Set());
      map.get(cid)!.add(pid);
    }
    return map;
  }, [conn, highlightNet]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(([entry]) => {
      useEditor.getState().setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      // Fit the drawing once the real canvas size is known.
      if (first && entry.contentRect.width > 0) {
        first = false;
        fitView();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive wheel listener so we can prevent page zoom/scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const at: Vec = [e.clientX - rect.left, e.clientY - rect.top];
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > 0) {
        const v = useEditor.getState().view;
        useEditor.getState().setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
        return;
      }
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), at);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [svgRef]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) spaceDown.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toWorld = (clientX: number, clientY: number): Vec => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = useEditor.getState().view;
    return [(clientX - rect.left - v.x) / v.zoom, (clientY - rect.top - v.y) / v.zoom];
  };
  const tolerance = () => 6 / useEditor.getState().view.zoom;
  const cursorPoint = (w: Vec): Vec => connectionNear(project, symbols, w, tolerance())?.at ?? snapVec(w);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    svgRef.current?.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      interaction.current = { mode: 'pan', start: [e.clientX, e.clientY], view: { x: s.view.x, y: s.view.y } };
      return;
    }
    if (e.button !== 0) return;

    switch (s.tool) {
      case 'select': {
        const id = hitTest(project, symbols, w, tolerance());
        if (id) {
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            s.setSelection(selected.has(id) ? selection.filter((x) => x !== id) : [...selection, id]);
            return;
          }
          const ids = selected.has(id) ? new Set(selection) : new Set([id]);
          if (!selected.has(id)) s.setSelection([id]);
          s.beginTransient();
          interaction.current = { mode: 'drag', start: snapVec(w), ids, delta: [0, 0] };
        } else {
          if (!e.shiftKey) s.setSelection([]);
          s.setHighlightNet(null);
          interaction.current = { mode: 'box', start: w };
          setBox({ a: w, b: w });
        }
        return;
      }
      case 'wire': {
        const hit = connectionNear(project, symbols, w, tolerance());
        const p = hit?.at ?? snapVec(w);
        const draft = s.wireDraft;
        if (!draft) {
          s.setWireDraft([p]);
          return;
        }
        const last = draft[draft.length - 1];
        if (samePoint(last, p)) {
          if (e.detail >= 2) finishWireDraft();
          return;
        }
        const next = simplify([...draft, ...elbow(last, p).slice(1)]);
        s.setWireDraft(next);
        if (hit && !samePoint(hit.at, draft[0])) finishWireDraft();
        return;
      }
      case 'place': {
        if (!s.placing) return;
        placeComponent(s.placing, snapVec(w), s.placementRotation, s.placementMirror);
        return;
      }
      case 'label':
      case 'power':
      case 'ground':
      case 'noconnect': {
        const t = s.portTemplate;
        addPort(s.tool, s.tool === 'noconnect' ? '' : t.name, cursorPoint(w), t.rotation);
        if (s.tool === 'label') s.setPortTemplate({ name: nextLabelName(t.name) });
        return;
      }
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    const w = toWorld(e.clientX, e.clientY);
    setPointer(w);
    s.setCursor(snapVec(w));
    const it = interaction.current;
    if (it.mode === 'pan') {
      s.setView({ ...s.view, x: it.view.x + e.clientX - it.start[0], y: it.view.y + e.clientY - it.start[1] });
      return;
    }
    if (it.mode === 'drag') {
      const p = snapVec(w);
      const delta: Vec = [p[0] - it.start[0], p[1] - it.start[1]];
      if (delta[0] !== it.delta[0] || delta[1] !== it.delta[1]) {
        it.delta = delta;
        s.updateTransient((base) => moveItems(base, it.ids, delta[0], delta[1], symbols));
      }
      return;
    }
    if (it.mode === 'box') {
      setBox({ a: it.start, b: w });
      return;
    }
    const hit = connectionNear(project, symbols, w, tolerance());
    if (hit?.kind === 'pin' && hit.ref) {
      const net = conn.pinNet.get(hit.ref);
      setHover({ text: `${hit.label}${net ? ` · ${net}` : ' · unconnected'}`, at: hit.at });
    } else if (hit?.kind === 'port' && hit.label) {
      setHover({ text: `Net ${hit.label}`, at: hit.at });
    } else setHover(null);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    const it = interaction.current;
    interaction.current = { mode: 'none' };
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (it.mode === 'drag') s.endTransient();
    if (it.mode === 'box') {
      const w = toWorld(e.clientX, e.clientY);
      setBox(null);
      if (Math.hypot(w[0] - it.start[0], w[1] - it.start[1]) * s.view.zoom < 4) return;
      const ids = itemsInBox(project, symbols, normBox(it.start, w));
      s.setSelection(e.shiftKey ? [...new Set([...selection, ...ids])] : ids);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const s = useEditor.getState();
    if (s.wireDraft) finishWireDraft();
    else if (s.tool !== 'select') s.setTool('select');
  };

  const onDoubleClick = () => {
    if (useEditor.getState().tool === 'wire') finishWireDraft();
  };

  // Ghost previews.
  const snapped = tool === 'select' || tool === 'place' ? snapVec(pointer) : cursorPoint(pointer);
  const ghostComponent: Component | null =
    tool === 'place' && placing && inside
      ? { ...placing.template, id: 'ghost', x: snapped[0], y: snapped[1], rotation: placementRotation, mirror: placementMirror, designator: `${placing.prefix}?` }
      : null;
  const ghostPort: NetPort | null =
    (tool === 'label' || tool === 'power' || tool === 'ground' || tool === 'noconnect') && inside
      ? { id: 'ghost', kind: tool, name: tool === 'noconnect' ? '' : portTemplate.name, x: snapped[0], y: snapped[1], rotation: portTemplate.rotation }
      : null;
  const draftPreview: Vec[] | null = wireDraft ? simplify([...wireDraft, ...elbow(wireDraft[wireDraft.length - 1], snapped).slice(1)]) : null;

  const gridStep = 10 * view.zoom;
  const showMinor = gridStep >= 7;
  const majorStep = (gridStep >= 7 ? 50 : 100) * view.zoom;
  const cursor = tool === 'select' ? (interaction.current.mode === 'pan' ? 'grabbing' : 'default') : 'crosshair';
  const empty = project.components.length === 0 && project.wires.length === 0 && project.ports.length === 0;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ background: 'var(--canvas-bg)' }}>
      <svg
        ref={svgRef}
        role="application"
        aria-label="Schematic canvas"
        width={canvasSize.width}
        height={canvasSize.height}
        className="absolute inset-0 h-full w-full touch-none select-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerEnter={() => setInside(true)}
        onPointerLeave={() => {
          setInside(false);
          setHover(null);
        }}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
      >
        <defs>
          <pattern id="grid-minor" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={0.75} cy={0.75} r={0.75} fill="var(--grid-dot)" />
          </pattern>
          <pattern id="grid-major" width={majorStep} height={majorStep} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={1} fill="var(--grid-major)" />
          </pattern>
        </defs>
        {showMinor && <rect width="100%" height="100%" fill="url(#grid-minor)" />}
        <rect width="100%" height="100%" fill="url(#grid-major)" />

        <g data-layer="world" transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {project.wires.map((w) => {
            const isSel = selected.has(w.id);
            const isHi = !!highlightNet && conn.itemNet.get(w.id) === highlightNet;
            return (
              <polyline
                key={w.id}
                points={w.points.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke={isSel ? 'var(--select)' : isHi ? 'var(--highlight)' : 'var(--wire)'}
                strokeWidth={isSel || isHi ? 1.8 : 1.2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}
          {project.components.map((c) => (
            <ComponentGraphic key={c.id} component={c} symbol={symbols(c.symbolKey)} selected={selected.has(c.id)} highlightPins={highlightPins.get(c.id)} />
          ))}
          {project.ports.map((p) => (
            <PortGraphic key={p.id} port={p} selected={selected.has(p.id)} highlight={!!highlightNet && conn.itemNet.get(p.id) === highlightNet} />
          ))}
          {conn.junctions.map((j) => (
            <circle key={j.join(',')} cx={j[0]} cy={j[1]} r={1.8} fill="var(--junction)" />
          ))}
          <g data-ephemeral="">
            {conn.unconnected.map((u) => (
              <circle key={`${u.componentId}:${u.pinId}`} cx={u.at[0]} cy={u.at[1]} r={1.3} fill="none" stroke="var(--unconnected)" strokeWidth={0.5} opacity={0.8} />
            ))}
            {draftPreview && (
              <polyline points={draftPreview.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--wire)" strokeWidth={1.2} strokeDasharray="3 2" />
            )}
            {ghostComponent && <ComponentGraphic component={ghostComponent} symbol={symbols(ghostComponent.symbolKey)} ghost />}
            {ghostPort && <PortGraphic port={ghostPort} ghost />}
            {(tool === 'wire' || ghostPort) && inside && (
              <g stroke="var(--select)" strokeWidth={0.6} opacity={0.9}>
                <line x1={snapped[0] - 4} y1={snapped[1]} x2={snapped[0] + 4} y2={snapped[1]} />
                <line x1={snapped[0]} y1={snapped[1] - 4} x2={snapped[0]} y2={snapped[1] + 4} />
              </g>
            )}
            {hover && <circle cx={hover.at[0]} cy={hover.at[1]} r={2.5} fill="none" stroke="var(--select)" strokeWidth={0.8} />}
            {box && (
              <rect
                x={Math.min(box.a[0], box.b[0])}
                y={Math.min(box.a[1], box.b[1])}
                width={Math.abs(box.b[0] - box.a[0])}
                height={Math.abs(box.b[1] - box.a[1])}
                fill="var(--select)"
                fillOpacity={0.08}
                stroke="var(--select)"
                strokeWidth={1 / view.zoom}
                strokeDasharray={`${4 / view.zoom} ${3 / view.zoom}`}
              />
            )}
          </g>
        </g>
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-line bg-panel px-2 py-1 text-[11px] shadow-lg"
          style={{ left: hover.at[0] * view.zoom + view.x + 12, top: hover.at[1] * view.zoom + view.y + 12 }}
        >
          {hover.text}
        </div>
      )}

      {empty && tool !== 'place' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-md rounded-xl border border-dashed border-line bg-panel/80 p-6 text-center backdrop-blur">
            <Search className="mx-auto mb-3 h-6 w-6 text-indigo-400" />
            <div className="text-sm font-semibold">Start with a part</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Search the JLCPCB library below — filter by <span className="font-semibold text-emerald-500">Basic</span>,{' '}
              <span className="font-semibold text-sky-500">Preferred</span> or <span className="font-semibold text-amber-500">Extended</span> — then
              double-click a result to place it.
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span>
                <Kbd>/</Kbd> search
              </span>
              <span>
                <Kbd>W</Kbd> wire
              </span>
              <span>
                <Kbd>N</Kbd> net label
              </span>
              <span>
                <Kbd>P</Kbd>/<Kbd>G</Kbd> power/ground
              </span>
              <span>
                <Kbd>R</Kbd> rotate
              </span>
            </div>
          </div>
        </div>
      )}
      {tool === 'place' && placing && (
        <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-panel/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
          <MousePointerClick className="h-3.5 w-3.5 text-indigo-400" />
          Click to place <span className="font-semibold">{placing.template.value}</span>
          <span className="text-muted">
            · <Kbd>R</Kbd> rotate · <Kbd>X</Kbd> mirror · <Kbd>Esc</Kbd> done
          </span>
        </div>
      )}
    </div>
  );
}
