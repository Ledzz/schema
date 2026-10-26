import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CircuitBoard, RefreshCcw } from 'lucide-react';
import { SHAPE_TOOLS, useEditor } from '../../store/editor';
import type { Vec } from '../../lib/schematic/types';
import { buildBoard, pcbConnectivity, type BoardModel, type PcbConnectivity } from '../../lib/pcb/board';
import { pointInPolygon, pointSegDist, type WorldPad } from '../../lib/pcb/geometry';
import { areasToSvgPath, pointInArea } from '../../lib/pcb/pour';
import { designatorLabel, labelBox, labelComponent, labelId, labelStrokes, logoAreas, logoBox, pinLabels, silkTextBox, strokeFor, textItemStrokes, textStroke } from '../../lib/pcb/silk';
import type { Box } from '../../lib/pcb/geometry';
import { boardSvgPath, rectOutline } from '../../lib/pcb/outline';
import { addText, addVia, finishDraft, finishShape, movableIds, movePlacements, placeMountingHole, posture, snapMm, syncPcb, trackWidthFor } from '../../lib/pcb/actions';
import { fitPcbView, zoomPcbBy } from '../../lib/pcb/view';
import { copperLayers, emptyPcb, isInner, LAYER_NAMES, type CopperLayer, type Pcb } from '../../lib/pcb/types';
import { Kbd } from '../ui';

const LAYER_COLOR: Record<CopperLayer, string> = { top: 'var(--pcb-top)', inner1: 'var(--pcb-inner1)', inner2: 'var(--pcb-inner2)', bottom: 'var(--pcb-bottom)' };
const pts = (p: Vec[]) => p.map((q) => `${q[0]},${q[1]}`).join(' ');

type Hit = { kind: 'part' | 'track' | 'via' | 'pour' | 'hole' | 'keepout' | 'cutout' | 'label' | 'text' | 'logo'; id: string } | null;
const inBox = (p: Vec, b: Box) => p[0] >= b.x1 && p[0] <= b.x2 && p[1] >= b.y1 && p[1] <= b.y2;
const KEEPOUT_COLOR = '#ef4444';

function padAt(board: BoardModel, p: Vec, layer?: CopperLayer): WorldPad | null {
  for (const pad of board.pads) {
    if (layer && !pad.layers.includes(layer)) continue;
    if (pointInPolygon(p, pad.outline)) return pad;
  }
  return null;
}

export function PcbCanvas() {
  const project = useEditor((s) => s.project);
  const view = useEditor((s) => s.pcbView);
  const tool = useEditor((s) => s.pcbTool);
  const activeLayer = useEditor((s) => s.activeLayer);
  const selection = useEditor((s) => s.pcbSelection);
  const draft = useEditor((s) => s.routeDraft);
  const shapeDraft = useEditor((s) => s.shapeDraft);
  const highlightNet = useEditor((s) => s.pcbHighlightNet);
  const showPours = useEditor((s) => s.showPours);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pointer, setPointer] = useState<Vec>([0, 0]);
  const [box, setBox] = useState<{ a: Vec; b: Vec } | null>(null);
  const [hoverPad, setHoverPad] = useState<WorldPad | null>(null);
  const interaction = useRef<
    { mode: 'none' } | { mode: 'pan'; start: Vec; view: { x: number; y: number } } | { mode: 'drag'; start: Vec; ids: Set<string>; delta: Vec } | { mode: 'box'; start: Vec } | { mode: 'shape'; start: Vec }
  >({ mode: 'none' });
  const spaceDown = useRef(false);

  const pcb: Pcb = useMemo(() => project.pcb ?? emptyPcb(), [project.pcb]);
  const model = useMemo(() => {
    const board = buildBoard(project, pcb);
    return { board, conn: pcbConnectivity(board, pcb) };
  }, [project.components, project.wires, project.ports, project.symbols, pcb]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(() => new Set(selection), [selection]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(([e]) => {
      const s = { width: e.contentRect.width, height: e.contentRect.height };
      useEditor.getState().setPcbCanvasSize(s);
      if (first && s.width > 0) {
        first = false;
        fitPcbView(s);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > 0) {
        const v = useEditor.getState().pcbView;
        useEditor.getState().setPcbView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
        return;
      }
      zoomPcbBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), [e.clientX - rect.left, e.clientY - rect.top]);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const down = (e: KeyboardEvent) => e.code === 'Space' && (spaceDown.current = true);
    const up = (e: KeyboardEvent) => e.code === 'Space' && (spaceDown.current = false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toWorld = (clientX: number, clientY: number): Vec => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = useEditor.getState().pcbView;
    return [(clientX - rect.left - v.x) / v.zoom, (clientY - rect.top - v.y) / v.zoom];
  };
  const snap = (p: Vec): Vec => [snapMm(p[0]), snapMm(p[1])];

  const hitTest = (p: Vec): Hit => {
    const tol = 4 / view.zoom;
    for (const v of pcb.vias) if (Math.hypot(v.x - p[0], v.y - p[1]) <= v.diameter / 2 + tol) return { kind: 'via', id: v.id };
    const tracks = [...pcb.tracks].sort((a) => (a.layer === activeLayer ? -1 : 1));
    for (const t of tracks) for (let i = 1; i < t.points.length; i++) if (pointSegDist(p, t.points[i - 1], t.points[i]) <= t.width / 2 + tol) return { kind: 'track', id: t.id };
    const holes = pcb.holes ?? [];
    for (const h of holes) if (Math.hypot(h.x - p[0], h.y - p[1]) <= h.diameter / 2 + tol) return { kind: 'hole', id: h.id };
    // Silkscreen on the active side first.
    const front = <T extends { side: CopperLayer }>(list: T[]) => [...list].sort((a) => (a.side === activeLayer ? -1 : 1));
    for (const t of front(pcb.texts ?? [])) if (inBox(p, silkTextBox(t))) return { kind: 'text', id: t.id };
    for (const part of [...model.board.parts].sort((a) => (a.placement.side === activeLayer ? -1 : 1))) {
      const l = designatorLabel(part);
      if (part.fp && !l.hidden && inBox(p, labelBox(l))) return { kind: 'label', id: labelId(part.component.id) };
    }
    const parts = [...model.board.parts].sort((a) => (a.placement.side === activeLayer ? -1 : 1));
    for (const part of parts) if (p[0] >= part.box.x1 && p[0] <= part.box.x2 && p[1] >= part.box.y1 && p[1] <= part.box.y2) return { kind: 'part', id: part.component.id };
    for (const l of front(pcb.logos ?? [])) if (inBox(p, logoBox(l))) return { kind: 'logo', id: l.id };
    for (const k of pcb.keepouts ?? []) if (pointInPolygon(p, k.outline)) return { kind: 'keepout', id: k.id };
    for (const c of pcb.board.cutouts ?? []) if (pointInPolygon(p, c.outline)) return { kind: 'cutout', id: c.id };
    for (const h of holes) if (Math.hypot(h.x - p[0], h.y - p[1]) <= h.keepout / 2) return { kind: 'hole', id: h.id };
    if (useEditor.getState().showPours) {
      const zones = (pcb.pours ?? []).filter((z) => z.outline && z.outline.length >= 3).sort((a) => (a.layer === activeLayer ? -1 : 1));
      for (const z of zones) if (pointInPolygon(p, z.outline!)) return { kind: 'pour', id: z.id };
      const fills = [...model.board.fills].sort((a) => (a.pour.layer === activeLayer ? -1 : 1));
      for (const f of fills) if (f.areas.some((a) => pointInArea(p, a))) return { kind: 'pour', id: f.pour.id };
    }
    return null;
  };

  /** Where the route under construction ends for a pointer position (snaps onto same-net pads). */
  const routeTarget = (p: Vec): { at: Vec; finish: boolean } => {
    const d = useEditor.getState().routeDraft;
    if (!d) return { at: snap(p), finish: false };
    const pad = padAt(model.board, p, d.layer);
    if (pad && (pad.net === d.net || !d.net) && !(pad.center[0] === d.points[0][0] && pad.center[1] === d.points[0][1] && d.points.length === 1)) return { at: pad.center, finish: true };
    for (const v of pcb.vias) if (Math.hypot(v.x - p[0], v.y - p[1]) <= v.diameter / 2 && (model.conn.itemNet.get(v.id) ?? v.net) === d.net) return { at: [v.x, v.y], finish: true };
    return { at: snap(p), finish: false };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    svgRef.current?.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      interaction.current = { mode: 'pan', start: [e.clientX, e.clientY], view: { x: s.pcbView.x, y: s.pcbView.y } };
      return;
    }
    if (e.button !== 0) return;
    if (s.pcbTool === 'select') {
      const hit = hitTest(w);
      if (!hit) {
        if (!e.shiftKey) s.setPcbSelection([]);
        s.setPcbHighlightNet(null);
        interaction.current = { mode: 'box', start: w };
        setBox({ a: w, b: w });
        return;
      }
      if (e.shiftKey) {
        s.setPcbSelection(selected.has(hit.id) ? selection.filter((x) => x !== hit.id) : [...selection, hit.id]);
        return;
      }
      const zoneSelected = hit.kind === 'pour' && selected.has(hit.id) && pcb.pours?.some((z) => z.id === hit.id && z.outline);
      if (hit.kind === 'pour' && !zoneSelected) {
        // Clicking a pour selects it; dragging from it still box-selects (a selected zone drags).
        s.setPcbSelection([hit.id]);
        interaction.current = { mode: 'box', start: w };
        setBox({ a: w, b: w });
        return;
      }
      if (!selected.has(hit.id)) s.setPcbSelection([hit.id]);
      const ids = movableIds(pcb, selected.has(hit.id) ? selection : [hit.id]);
      if (ids.has(hit.id)) {
        s.beginTransient();
        interaction.current = { mode: 'drag', start: snap(w), ids, delta: [0, 0] };
      }
      return;
    }
    if (SHAPE_TOOLS.includes(s.pcbTool)) {
      const at = snap(w);
      const corners = s.shapeDraft;
      if (!corners) {
        interaction.current = { mode: 'shape', start: at };
        setBox({ a: at, b: at });
      } else if (corners.length >= 3 && Math.hypot(at[0] - corners[0][0], at[1] - corners[0][1]) <= 6 / s.pcbView.zoom) finishShape(corners);
      else if (e.detail >= 2) finishShape(corners);
      else s.setShapeDraft([...corners, at]);
      return;
    }
    if (s.pcbTool === 'hole') {
      placeMountingHole(snap(w));
      return;
    }
    if (s.pcbTool === 'text') {
      const t = addText('TEXT', snap(w));
      s.setPcbTool('select');
      s.setPcbSelection([t.id]);
      return;
    }
    if (s.pcbTool === 'via') {
      const pad = padAt(model.board, w);
      addVia(snap(w), pad?.net ?? null);
      return;
    }
    // route
    const d = s.routeDraft;
    if (!d) {
      const pad = padAt(model.board, w);
      const via = pcb.vias.find((v) => Math.hypot(v.x - w[0], v.y - w[1]) <= v.diameter / 2);
      const track = !pad && !via ? pcb.tracks.find((t) => t.points.some((_, i) => i > 0 && pointSegDist(w, t.points[i - 1], t.points[i]) <= t.width / 2)) : undefined;
      if (!pad && !via && !track) return s.notify('Start a track on a pad, via or track');
      const net = pad?.net ?? (via ? (model.conn.itemNet.get(via.id) ?? via.net) : track ? (model.conn.itemNet.get(track.id) ?? track.net) : null);
      let layer = s.activeLayer;
      if (pad && !pad.layers.includes(layer)) layer = pad.layers[0];
      if (track) layer = track.layer;
      if (layer !== s.activeLayer) s.setActiveLayer(layer);
      const start: Vec = pad ? pad.center : via ? [via.x, via.y] : snap(w);
      s.setRouteDraft({ net, layer, width: trackWidthFor(net, pcb), points: [start] });
      return;
    }
    const target = routeTarget(w);
    const last = d.points[d.points.length - 1];
    if (target.at[0] === last[0] && target.at[1] === last[1]) {
      if (e.detail >= 2) finishDraft();
      return;
    }
    const next = { ...d, points: [...d.points, ...posture(last, target.at)] };
    s.setRouteDraft(next);
    if (target.finish) finishDraft();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    const w = toWorld(e.clientX, e.clientY);
    setPointer(w);
    s.setPcbCursor(snap(w));
    setHoverPad(padAt(model.board, w));
    const it = interaction.current;
    if (it.mode === 'pan') s.setPcbView({ ...s.pcbView, x: it.view.x + e.clientX - it.start[0], y: it.view.y + e.clientY - it.start[1] });
    else if (it.mode === 'drag') {
      const p = snap(w);
      const delta: Vec = [p[0] - it.start[0], p[1] - it.start[1]];
      if (delta[0] !== it.delta[0] || delta[1] !== it.delta[1]) {
        it.delta = delta;
        // Designators at their default spot get an explicit position before they can move.
        const labels = new Set([...it.ids].map(labelComponent).filter((c): c is string => !!c));
        s.updateTransient((base) => ({ ...base, pcb: movePlacements(pinLabels(base.pcb ?? emptyPcb(), model.board, labels), it.ids, delta[0], delta[1]) }));
      }
    } else if (it.mode === 'box') setBox({ a: it.start, b: w });
    else if (it.mode === 'shape') setBox({ a: it.start, b: snap(w) });
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    const it = interaction.current;
    interaction.current = { mode: 'none' };
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (it.mode === 'drag') s.endTransient();
    if (it.mode === 'shape') {
      setBox(null);
      const b = snap(toWorld(e.clientX, e.clientY));
      // A drag draws a rectangle; a click starts a polygon at that corner.
      if (Math.abs(b[0] - it.start[0]) >= 0.5 && Math.abs(b[1] - it.start[1]) >= 0.5) finishShape(rectOutline(it.start[0], it.start[1], b[0], b[1]));
      else s.setShapeDraft([it.start]);
      return;
    }
    if (it.mode === 'box') {
      setBox(null);
      const w = toWorld(e.clientX, e.clientY);
      const [x1, x2] = [Math.min(it.start[0], w[0]), Math.max(it.start[0], w[0])];
      const [y1, y2] = [Math.min(it.start[1], w[1]), Math.max(it.start[1], w[1])];
      if ((x2 - x1) * s.pcbView.zoom < 4 && (y2 - y1) * s.pcbView.zoom < 4) return;
      const ids = [
        ...model.board.parts.filter((p) => p.box.x1 <= x2 && p.box.x2 >= x1 && p.box.y1 <= y2 && p.box.y2 >= y1).map((p) => p.component.id),
        ...pcb.tracks.filter((t) => t.points.some((q) => q[0] >= x1 && q[0] <= x2 && q[1] >= y1 && q[1] <= y2)).map((t) => t.id),
        ...pcb.vias.filter((v) => v.x >= x1 && v.x <= x2 && v.y >= y1 && v.y <= y2).map((v) => v.id),
        ...(pcb.holes ?? []).filter((h) => h.x >= x1 && h.x <= x2 && h.y >= y1 && h.y <= y2).map((h) => h.id),
        ...[...(pcb.texts ?? []), ...(pcb.logos ?? [])].filter((t) => t.x >= x1 && t.x <= x2 && t.y >= y1 && t.y <= y2).map((t) => t.id),
        // Areas only when the box encloses them, so selecting parts doesn't pick up a large keepout.
        ...[...(pcb.keepouts ?? []), ...(pcb.board.cutouts ?? []), ...(pcb.pours ?? []).filter((z) => z.outline)]
          .filter((a) => a.outline!.every((q) => q[0] >= x1 && q[0] <= x2 && q[1] >= y1 && q[1] <= y2))
          .map((a) => a.id),
      ];
      s.setPcbSelection(e.shiftKey ? [...new Set([...selection, ...ids])] : ids);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const s = useEditor.getState();
    if (s.routeDraft) finishDraft();
    else if (s.shapeDraft) {
      if (s.shapeDraft.length >= 3) finishShape(s.shapeDraft);
      else s.setShapeDraft(null);
    } else if (s.pcbTool !== 'select') s.setPcbTool('select');
  };

  const preview: Vec[] | null = draft ? [...draft.points, ...posture(draft.points[draft.points.length - 1], routeTarget(pointer).at)] : null;
  const crosshair = tool !== 'select' ? snap(pointer) : null;
  const empty = pcb.placements.length === 0;
  const issuesShown = useEditor((s) => s.pcbLeftTab === 'drc');

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ background: 'var(--pcb-bg)' }}>
      <svg
        ref={svgRef}
        role="application"
        aria-label="PCB canvas"
        className="absolute inset-0 h-full w-full touch-none select-none"
        style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverPad(null)}
        onContextMenu={onContextMenu}
        onDoubleClick={() => {
          const s = useEditor.getState();
          if (s.routeDraft) finishDraft();
          else if (s.shapeDraft && s.shapeDraft.length >= 3) finishShape(s.shapeDraft);
        }}
      >
        <defs>
          <pattern id="pcb-grid" width={view.zoom} height={view.zoom} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={0.6} cy={0.6} r={0.6} fill="var(--grid-dot)" />
          </pattern>
          <pattern id="pcb-keepout-hatch" width={0.6} height={0.6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={0.6} stroke={KEEPOUT_COLOR} strokeWidth={0.08} />
          </pattern>
          <pattern id="pcb-grid-5" width={view.zoom * 5} height={view.zoom * 5} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={0.9} cy={0.9} r={0.9} fill="var(--grid-major)" />
          </pattern>
        </defs>
        {view.zoom >= 6 && <rect width="100%" height="100%" fill="url(#pcb-grid)" />}
        <rect width="100%" height="100%" fill="url(#pcb-grid-5)" />

        <g data-layer="world" transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <path d={boardSvgPath(pcb)} fillRule="evenodd" fill="var(--pcb-board)" stroke="var(--pcb-edge)" strokeWidth={0.1} />
          <BoardLayers board={model.board} conn={model.conn} pcb={pcb} activeLayer={activeLayer} selected={selected} highlightNet={highlightNet} showPours={showPours} />
          <Mechanical pcb={pcb} activeLayer={activeLayer} selected={selected} zoom={view.zoom} showPours={showPours} />
          {/* ratsnest */}
          <g stroke="var(--pcb-ratsnest)" strokeWidth={1 / view.zoom} opacity={0.85}>
            {model.conn.airwires.map((a, i) => (
              <line key={i} x1={a.a[0]} y1={a.a[1]} x2={a.b[0]} y2={a.b[1]} strokeDasharray={highlightNet === a.net ? undefined : `${3 / view.zoom} ${2 / view.zoom}`} stroke={highlightNet === a.net ? 'var(--highlight)' : undefined} />
            ))}
          </g>
          {issuesShown && <DrcMarkers zoom={view.zoom} />}
          {shapeDraft && (
            <g fill="none" stroke="var(--select)" strokeWidth={1.5 / view.zoom}>
              <polyline points={pts([...shapeDraft, snap(pointer)])} strokeDasharray={`${4 / view.zoom} ${3 / view.zoom}`} />
              {shapeDraft.map((q, i) => (
                <circle key={i} cx={q[0]} cy={q[1]} r={(i === 0 ? 4 : 2.5) / view.zoom} fill={i === 0 ? 'var(--select)' : 'none'} />
              ))}
            </g>
          )}
          {preview && draft && (
            <polyline points={pts(preview)} fill="none" stroke={LAYER_COLOR[draft.layer]} strokeWidth={draft.width} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
          )}
          {hoverPad && (
            <polygon points={pts(hoverPad.outline)} fill="none" stroke="var(--select)" strokeWidth={1.5 / view.zoom} />
          )}
          {crosshair && (
            <g stroke="var(--select)" strokeWidth={1 / view.zoom}>
              <line x1={crosshair[0] - 8 / view.zoom} y1={crosshair[1]} x2={crosshair[0] + 8 / view.zoom} y2={crosshair[1]} />
              <line x1={crosshair[0]} y1={crosshair[1] - 8 / view.zoom} x2={crosshair[0]} y2={crosshair[1] + 8 / view.zoom} />
            </g>
          )}
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
            />
          )}
        </g>
      </svg>

      {hoverPad && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-line bg-panel px-2 py-1 text-[11px] shadow-lg">
          {hoverPad.designator}.{hoverPad.number} · {hoverPad.net ?? 'no net'} · {hoverPad.layers.join('+')}
        </div>
      )}
      {draft && (
        <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-panel/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
          <span className="h-2 w-2 rounded-full" style={{ background: LAYER_COLOR[draft.layer] }} />
          Routing <span className="font-semibold">{draft.net ?? 'no net'}</span> on {LAYER_NAMES[draft.layer]} · {draft.width} mm
          <span className="text-muted">
            · <Kbd>V</Kbd> via · <Kbd>⌫</Kbd> undo corner · <Kbd>Esc</Kbd> finish
          </span>
        </div>
      )}
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="max-w-sm rounded-xl border border-dashed border-line bg-panel/85 p-6 text-center backdrop-blur">
            <CircuitBoard className="mx-auto mb-3 h-6 w-6 text-indigo-400" />
            <div className="text-sm font-semibold">No parts on the board yet</div>
            <p className="mt-1 text-xs text-muted">Pull the schematic's parts and their JLCPCB footprints onto the PCB.</p>
            <button
              onClick={() => syncPcb().then((r) => useEditor.getState().notify(`Added ${r.added.length} parts${r.missing.length ? `; no footprint for ${r.missing.join(', ')}` : ''}`))}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-[13px] font-medium text-white hover:bg-indigo-500"
            >
              <RefreshCcw className="h-4 w-4" /> Update from schematic
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const BoardLayers = memo(function BoardLayers({
  board,
  conn,
  pcb,
  activeLayer,
  selected,
  highlightNet,
  showPours,
}: {
  board: BoardModel;
  conn: PcbConnectivity;
  pcb: Pcb;
  activeLayer: CopperLayer;
  selected: Set<string>;
  highlightNet: string | null;
  showPours: boolean;
}) {
  // Every copper layer from the bottom up, the active one on top of the rest.
  const order: CopperLayer[] = [...copperLayers(pcb).reverse().filter((l) => l !== activeLayer), activeLayer];
  const netOfTrack = (id: string, fallback: string | null) => conn.itemNet.get(id) ?? fallback;
  return (
    <>
      {order.map((layer) => {
        const dim = layer !== activeLayer;
        return (
          <g key={layer} opacity={dim ? (isInner(layer) ? 0.3 : 0.45) : 0.92}>
            {showPours &&
              board.fills
                .filter((f) => f.pour.layer === layer)
                .map((f) => (
                  <path
                    key={f.pour.id}
                    d={areasToSvgPath(f.areas)}
                    fillRule="evenodd"
                    fill={selected.has(f.pour.id) || (highlightNet && f.pour.net === highlightNet) ? 'var(--highlight)' : LAYER_COLOR[layer]}
                    opacity={selected.has(f.pour.id) ? 0.5 : 0.4}
                  />
                ))}
            {pcb.tracks
              .filter((t) => t.layer === layer)
              .map((t) => {
                const hi = selected.has(t.id) || (!!highlightNet && netOfTrack(t.id, t.net) === highlightNet);
                return (
                  <polyline key={t.id} points={pts(t.points)} fill="none" stroke={hi ? 'var(--highlight)' : LAYER_COLOR[layer]} strokeWidth={t.width} strokeLinecap="round" strokeLinejoin="round" />
                );
              })}
            {board.pads
              .filter((p) => p.pad.layer !== 'through' && p.layers.includes(layer))
              .map((p) => (
                <polygon key={`${p.componentId}:${p.index}`} points={pts(p.outline)} fill={highlightNet && p.net === highlightNet ? 'var(--highlight)' : LAYER_COLOR[layer]} />
              ))}
          </g>
        );
      })}
      {board.pads
        .filter((p) => p.pad.layer === 'through')
        .map((p) => (
          <g key={`${p.componentId}:${p.index}`}>
            <polygon points={pts(p.outline)} fill={highlightNet && p.net === highlightNet ? 'var(--highlight)' : 'var(--pcb-tht)'} />
            {p.hole && <Hole hole={p.hole} />}
          </g>
        ))}
      {pcb.vias.map((v) => (
        <g key={v.id}>
          <circle cx={v.x} cy={v.y} r={v.diameter / 2} fill={selected.has(v.id) || (highlightNet && (conn.itemNet.get(v.id) ?? v.net) === highlightNet) ? 'var(--highlight)' : 'var(--pcb-tht)'} />
          <circle cx={v.x} cy={v.y} r={v.drill / 2} fill="var(--pcb-hole)" />
        </g>
      ))}
      {/* silkscreen and parts */}
      {board.parts.map((part) => {
        const side = part.placement.side;
        const dim = side !== activeLayer;
        const silk = side === 'top' ? 'var(--pcb-silk-top)' : 'var(--pcb-silk-bottom)';
        return (
          <g key={part.component.id} opacity={dim ? 0.5 : 1}>
            {part.graphics.map((g, i) =>
              g.layer === 'outline' ? null : g.filled ? (
                <polygon key={i} points={pts(g.points)} fill={silk} />
              ) : (
                <polyline key={i} points={pts(g.points)} fill="none" stroke={silk} strokeWidth={g.width} strokeLinecap="round" strokeLinejoin="round" />
              ),
            )}
            <Label part={part} color={silk} selected={selected.has(labelId(part.component.id))} />
            {!part.fp && (
              <g>
                <rect x={part.box.x1} y={part.box.y1} width={part.box.x2 - part.box.x1} height={part.box.y2 - part.box.y1} fill="none" stroke="var(--unconnected)" strokeWidth={0.1} strokeDasharray="0.3 0.2" />
              </g>
            )}
            {selected.has(part.component.id) && (
              <rect
                x={part.box.x1 - 0.2}
                y={part.box.y1 - 0.2}
                width={part.box.x2 - part.box.x1 + 0.4}
                height={part.box.y2 - part.box.y1 + 0.4}
                fill="var(--select)"
                fillOpacity={0.12}
                stroke="var(--select)"
                strokeWidth={0.08}
                strokeDasharray="0.25 0.15"
              />
            )}
          </g>
        );
      })}
      {(['bottom', 'top'] as CopperLayer[]).map((side) => {
        const silk = side === 'top' ? 'var(--pcb-silk-top)' : 'var(--pcb-silk-bottom)';
        return (
          <g key={side} opacity={side === activeLayer ? 1 : 0.5}>
            {(pcb.logos ?? [])
              .filter((l) => l.side === side)
              .map((l) => (
                <g key={l.id}>
                  <path d={areasToSvgPath(logoAreas(l))} fillRule="evenodd" fill={silk} />
                  {selected.has(l.id) && <SelectBox box={logoBox(l)} />}
                </g>
              ))}
            {(pcb.texts ?? [])
              .filter((t) => t.side === side)
              .map((t) => (
                <g key={t.id}>
                  {textItemStrokes(t).map((st, i) => (
                    <polyline key={i} points={pts(st)} fill="none" stroke={silk} strokeWidth={textStroke(t)} strokeLinecap="round" strokeLinejoin="round" />
                  ))}
                  {selected.has(t.id) && <SelectBox box={silkTextBox(t)} />}
                </g>
              ))}
          </g>
        );
      })}
    </>
  );
});

function SelectBox({ box }: { box: Box }) {
  return (
    <rect
      x={box.x1 - 0.15}
      y={box.y1 - 0.15}
      width={box.x2 - box.x1 + 0.3}
      height={box.y2 - box.y1 + 0.3}
      fill="var(--select)"
      fillOpacity={0.12}
      stroke="var(--select)"
      strokeWidth={0.06}
      strokeDasharray="0.25 0.15"
    />
  );
}

function Label({ part, color, selected }: { part: BoardModel['parts'][number]; color: string; selected: boolean }) {
  const label = designatorLabel(part);
  if (!part.fp || label.hidden) return null;
  return (
    <g>
      {labelStrokes(label).map((st, i) => (
        <polyline key={i} points={pts(st)} fill="none" stroke={color} strokeWidth={strokeFor(label.size)} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {selected && <SelectBox box={labelBox(label)} />}
    </g>
  );
}

/** Mounting holes, keepout areas, cutout outlines and pour zone borders. */
const Mechanical = memo(function Mechanical({ pcb, activeLayer, selected, zoom, showPours }: { pcb: Pcb; activeLayer: CopperLayer; selected: Set<string>; zoom: number; showPours: boolean }) {
  const line = 1.5 / zoom;
  const dash = `${4 / zoom} ${3 / zoom}`;
  return (
    <g>
      {showPours &&
        (pcb.pours ?? [])
          .filter((z) => z.outline && z.outline.length >= 3)
          .map((z) => (
            <polygon
              key={z.id}
              points={pts(z.outline!)}
              fill="none"
              stroke={selected.has(z.id) ? 'var(--select)' : LAYER_COLOR[z.layer]}
              strokeWidth={line}
              strokeDasharray={dash}
              opacity={z.layer === activeLayer || selected.has(z.id) ? 1 : 0.45}
            />
          ))}
      {(pcb.keepouts ?? []).map((k) => (
        <polygon
          key={k.id}
          points={pts(k.outline)}
          fill="url(#pcb-keepout-hatch)"
          stroke={selected.has(k.id) ? 'var(--select)' : KEEPOUT_COLOR}
          strokeWidth={line}
          strokeDasharray={dash}
          opacity={k.layers.includes(activeLayer) ? 0.9 : 0.4}
        />
      ))}
      {(pcb.board.cutouts ?? [])
        .filter((c) => selected.has(c.id))
        .map((c) => (
          <polygon key={c.id} points={pts(c.outline)} fill="var(--select)" fillOpacity={0.12} stroke="var(--select)" strokeWidth={line} />
        ))}
      {(pcb.holes ?? []).map((h) => (
        <g key={h.id}>
          <circle cx={h.x} cy={h.y} r={h.keepout / 2} fill="none" stroke={selected.has(h.id) ? 'var(--select)' : KEEPOUT_COLOR} strokeWidth={line} strokeDasharray={dash} opacity={0.8} />
          <circle cx={h.x} cy={h.y} r={h.diameter / 2} fill="var(--pcb-hole)" stroke={selected.has(h.id) ? 'var(--select)' : 'var(--pcb-edge)'} strokeWidth={0.1} />
        </g>
      ))}
    </g>
  );
});

function Hole({ hole }: { hole: { center: Vec; w: number; h: number; rotation: number } }) {
  const d = Math.min(hole.w, hole.h);
  if (Math.abs(hole.w - hole.h) < 1e-6) return <circle cx={hole.center[0]} cy={hole.center[1]} r={d / 2} fill="var(--pcb-hole)" />;
  const half = (Math.max(hole.w, hole.h) - d) / 2;
  const r = (hole.rotation * Math.PI) / 180;
  const [ax, ay] = hole.w >= hole.h ? [half, 0] : [0, half];
  const dx = ax * Math.cos(r) + ay * Math.sin(r);
  const dy = -ax * Math.sin(r) + ay * Math.cos(r);
  return <line x1={hole.center[0] - dx} y1={hole.center[1] - dy} x2={hole.center[0] + dx} y2={hole.center[1] + dy} stroke="var(--pcb-hole)" strokeWidth={d} strokeLinecap="round" />;
}

function DrcMarkers({ zoom }: { zoom: number }) {
  const issues = useEditor((s) => s.pcbIssues);
  return (
    <g>
      {issues
        .filter((i) => i.at)
        .map((i, k) => (
          <circle key={k} cx={i.at![0]} cy={i.at![1]} r={6 / zoom} fill="none" stroke={i.severity === 'error' ? 'var(--unconnected)' : '#f59e0b'} strokeWidth={1.5 / zoom} />
        ))}
    </g>
  );
}
