import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MousePointerClick, Search } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { addPort, commitAttach, endByKey, placeComponent, planAttach } from '../../lib/actions';
import { finishWireDraft, fitView, openSheet, wireDraftTo, zoomBy } from '../../lib/editing';
import { normBox, samePoint, snapVec } from '../../lib/schematic/geometry';
import { connectionNear, hitTest, itemsInBox, wireGrabAt } from '../../lib/schematic/hit';
import { analyze } from '../../lib/schematic/netlist';
import { dragWire, moveItems, type WireGrab } from '../../lib/schematic/ops';
import { onSheet, sheetsOf, sheetView } from '../../lib/schematic/sheets';
import { portRotationFor } from '../../lib/schematic/route';
import { resolverFor } from '../../lib/schematic/symbols';
import type { Component, NetPort, PortKind, Vec } from '../../lib/schematic/types';
import { BlockGraphic, ComponentGraphic, PortGraphic } from './graphics';
import { SheetTabs } from './SheetTabs';
import { cx, inputClass, Kbd } from '../ui';
import { QuickEdit } from '../passives/QuickEdit';
import { QuickAdd } from './QuickAdd';
import { ContextMenu, schematicMenu, type ContextMenuState } from './ContextMenu';
import { PassiveEditor } from '../passives/PassiveEditor';
import { pickPlacingPart, updatePlacingPassive } from '../../lib/passives';

type Interaction =
  | { mode: 'none' }
  | { mode: 'pan'; start: Vec; view: { x: number; y: number } }
  | { mode: 'drag'; start: Vec; ids: Set<string>; delta: Vec }
  | { mode: 'box'; start: Vec }
  /** A wire started by pressing on a pin in the select tool; releasing elsewhere places its next point. */
  | { mode: 'wire'; start: Vec }
  /** Pressed on a no-connect marker on a pin: a click selects the marker, a drag draws a wire. */
  | { mode: 'press-pin'; start: Vec; at: Vec; portId: string }
  /** Dragging a segment, corner or end of one wire. */
  | { mode: 'wire-edit'; wireId: string; grab: WireGrab; start: Vec; from: Vec; delta: Vec };

type NamedPort = Exclude<PortKind, 'noconnect'>;
const isNamedPortTool = (tool: string): tool is NamedPort => tool === 'label' || tool === 'power' || tool === 'ground' || tool === 'hier';

function nextLabelName(name: string): string {
  const m = /^(.*?)(\d+)$/.exec(name);
  return m ? `${m[1]}${Number(m[2]) + 1}` : name;
}

export function SchematicCanvas({ svgRef }: { svgRef: React.RefObject<SVGSVGElement | null> }) {
  const whole = useEditor((s) => s.project);
  const currentSheet = useEditor((s) => s.currentSheet);
  // Everything drawn and edited here is on one sheet; nets come from the whole project.
  const project = useMemo(() => sheetView(whole, currentSheet), [whole, currentSheet]);
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const placing = useEditor((s) => s.placing);
  const portTemplate = useEditor((s) => s.portTemplate);
  const placementRotation = useEditor((s) => s.placementRotation);
  const placementMirror = useEditor((s) => s.placementMirror);
  const highlightNet = useEditor((s) => s.highlightNet);
  const wireDraft = useEditor((s) => s.wireDraft);
  const wireFlip = useEditor((s) => s.wireFlip);
  const canvasSize = useEditor((s) => s.canvasSize);

  const containerRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction>({ mode: 'none' });
  const spaceDown = useRef(false);
  const [pointer, setPointer] = useState<Vec>([0, 0]);
  const [inside, setInside] = useState(false);
  const [box, setBox] = useState<{ a: Vec; b: Vec } | null>(null);
  const [hover, setHover] = useState<{ text: string; at: Vec } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const symbols = useMemo(() => resolverFor(whole), [whole.symbols]); // eslint-disable-line react-hooks/exhaustive-deps
  const conn = useMemo(
    () => analyze(whole, symbols),
    [whole.components, whole.wires, whole.ports, whole.sheets, whole.blocks, symbols], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const sheetName = useMemo(() => new Map(sheetsOf(whole).map((sh) => [sh.id, sh.name])), [whole.sheets]); // eslint-disable-line react-hooks/exhaustive-deps
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
      // Fit the drawing once the real canvas size is known, or what cross-probing asked to show.
      if (first && entry.contentRect.width > 0) {
        first = false;
        const frame = useEditor.getState().pendingFrame;
        if (frame?.editor === 'schematic') useEditor.getState().setPendingFrame(null);
        fitView(frame?.editor === 'schematic' ? frame.ids : undefined);
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
    // The pin's tooltip describes the drawing before this click; the next move brings it back.
    setHover(null);
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      interaction.current = { mode: 'pan', start: [e.clientX, e.clientY], view: { x: s.view.x, y: s.view.y } };
      return;
    }
    if (e.button !== 0) return;

    switch (s.tool) {
      case 'select': {
        const id = hitTest(project, symbols, w, tolerance());
        const mod = e.shiftKey || e.metaKey || e.ctrlKey;
        // Pressing on a pin end (not on a label or flag sitting there) starts a wire.
        const port = project.ports.find((p) => p.id === id);
        const near = !mod && (!port || port.kind === 'noconnect') ? connectionNear(project, symbols, w, tolerance()) : null;
        if ((near?.kind === 'pin' || near?.kind === 'block') && port) {
          interaction.current = { mode: 'press-pin', start: [e.clientX, e.clientY], at: near.at, portId: port.id };
          return;
        }
        if (near?.kind === 'pin' || near?.kind === 'block') {
          s.setSelection([]);
          s.startWire(near.at);
          interaction.current = { mode: 'wire', start: [e.clientX, e.clientY] };
          return;
        }
        if (id) {
          if (mod) {
            s.setSelection(selected.has(id) ? selection.filter((x) => x !== id) : [...selection, id]);
            return;
          }
          // A wire on its own: drag the segment, corner or end under the pointer.
          const wireHit = project.wires.some((x) => x.id === id) && (!selected.has(id) || selection.length === 1) ? wireGrabAt(project, w, tolerance()) : null;
          if (wireHit?.wireId === id) {
            s.setSelection([id]);
            s.beginTransient();
            const wire = project.wires.find((x) => x.id === id)!;
            const from = 'vertex' in wireHit.grab ? wire.points[wireHit.grab.vertex] : snapVec(w);
            interaction.current = { mode: 'wire-edit', wireId: id, grab: wireHit.grab, start: snapVec(w), from, delta: [0, 0] };
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
      case 'wire':
        wireClick(w, e.detail >= 2);
        return;
      case 'place': {
        if (!s.placing) return;
        placeComponent(s.placing, snapVec(w), s.placementRotation, s.placementMirror);
        return;
      }
      case 'label':
      case 'power':
      case 'ground':
      case 'hier':
      case 'noconnect': {
        const t = s.portTemplate;
        const kind = s.tool;
        if (kind === 'noconnect') {
          addPort(kind, '', cursorPoint(w), t.rotation);
          return;
        }
        const name = t.name.trim();
        if (!name) {
          s.notify(`Type a name for the ${kind === 'label' ? 'label' : 'flag'} first`, 'error');
          return;
        }
        const hit = connectionNear(project, symbols, w, tolerance());
        const pin = (hit?.kind === 'pin' || hit?.kind === 'block') && hit.ref ? endByKey(hit.ref, project) : null;
        if (pin) {
          // On a pin: a short stub leading away from the part or block, the label or flag at its end.
          const plan = planAttach(project, pin, kind, name);
          if (plan) commitAttach(plan);
          else addPort(kind, name, pin.at, portRotationFor(kind, [-pin.dir[0], -pin.dir[1]]));
        } else addPort(kind, name, cursorPoint(w), t.rotation);
        if (kind === 'label') s.setPortTemplate({ name: nextLabelName(name) });
        return;
      }
    }
  };

  /** A click with the wire tool: start, add a corner, or finish on a pin, wire or label. */
  const wireClick = (w: Vec, double: boolean) => {
    const s = useEditor.getState();
    const hit = connectionNear(project, symbols, w, tolerance());
    const p = hit?.at ?? snapVec(w);
    const draft = s.wireDraft;
    if (!draft) {
      s.setWireDraft([p]);
      return;
    }
    const last = draft[draft.length - 1];
    if (samePoint(last, p)) {
      if (double) finishWireDraft();
      return;
    }
    s.setWireDraft(wireDraftTo(draft, p, project, s.wireFlip).points);
    if (hit && !samePoint(hit.at, draft[0])) finishWireDraft();
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
        s.updateTransient((base) => onSheet(base, s.currentSheet, (v) => moveItems(v, it.ids, delta[0], delta[1], symbols)));
      }
      return;
    }
    if (it.mode === 'box') {
      setBox({ a: it.start, b: w });
      return;
    }
    if (it.mode === 'wire-edit') {
      const base = s.transientBase;
      if (!base) return;
      // A dragged end snaps to pins and other wiring (not to its own wire).
      const here = sheetView(base, s.currentSheet);
      const others = { ...here, wires: here.wires.filter((x) => x.id !== it.wireId) };
      const end = 'vertex' in it.grab && (it.grab.vertex === 0 || it.grab.vertex === base.wires.find((x) => x.id === it.wireId)!.points.length - 1);
      const to = end ? (connectionNear(others, symbols, w, tolerance())?.at ?? snapVec(w)) : snapVec(w);
      const delta: Vec = 'vertex' in it.grab ? [to[0] - it.from[0], to[1] - it.from[1]] : [to[0] - it.start[0], to[1] - it.start[1]];
      if (delta[0] !== it.delta[0] || delta[1] !== it.delta[1]) {
        it.delta = delta;
        s.updateTransient((b) => onSheet(b, s.currentSheet, (v) => dragWire(v, it.wireId, it.grab, delta, symbols)));
      }
      return;
    }
    if (it.mode === 'press-pin' && Math.hypot(e.clientX - it.start[0], e.clientY - it.start[1]) >= 5) {
      s.setSelection([]);
      s.startWire(it.at);
      interaction.current = { mode: 'wire', start: it.start };
    }
    const hit = connectionNear(project, symbols, w, tolerance());
    if (hit?.kind === 'pin' && hit.ref) {
      const net = conn.pinNet.get(hit.ref);
      setHover({ text: `${hit.label}${net ? ` · ${net}` : ' · unconnected'}`, at: hit.at });
    } else if (hit?.kind === 'port' && hit.label) {
      setHover({ text: `Net ${hit.label}`, at: hit.at });
    } else if (hit?.kind === 'block' && hit.label) {
      setHover({ text: hit.label, at: hit.at });
    } else setHover(null);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = useEditor.getState();
    const it = interaction.current;
    interaction.current = { mode: 'none' };
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (it.mode === 'drag' || it.mode === 'wire-edit') s.endTransient();
    if (it.mode === 'wire' && Math.hypot(e.clientX - it.start[0], e.clientY - it.start[1]) >= 5) wireClick(toWorld(e.clientX, e.clientY), false);
    if (it.mode === 'press-pin') s.setSelection([it.portId]);
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
    else {
      const rect = svgRef.current!.getBoundingClientRect();
      const m = schematicMenu(toWorld(e.clientX, e.clientY), tolerance());
      if (m.items.length) setMenu({ ...m, at: [e.clientX - rect.left, e.clientY - rect.top] });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = useEditor.getState();
    if (s.tool === 'wire') return finishWireDraft();
    if (s.tool !== 'select') return;
    const id = hitTest(project, symbols, toWorld(e.clientX, e.clientY), tolerance());
    if (id && project.components.find((c) => c.id === id)?.generic) s.setQuickEdit(id);
    // On a block: open its sheet.
    const block = project.blocks?.find((b) => b.id === id);
    if (block) return openSheet(block.child);
    // On a wire or label: highlight its net, or stop highlighting it.
    const net = id ? conn.itemNet.get(id) : undefined;
    if (net) s.setHighlightNet(s.highlightNet === net ? null : net);
  };

  // Ghost previews.
  const near = useMemo(() => (inside ? connectionNear(project, symbols, pointer, 6 / view.zoom) : null), [inside, project, symbols, pointer, view.zoom]);
  const snapped = tool === 'select' || tool === 'place' ? snapVec(pointer) : (near?.at ?? snapVec(pointer));
  const ghostComponent: Component | null =
    tool === 'place' && placing && inside
      ? { ...placing.template, id: 'ghost', x: snapped[0], y: snapped[1], rotation: placementRotation, mirror: placementMirror, designator: `${placing.prefix}?` }
      : null;
  // Over a pin, show where the stub and the label or flag will go.
  const nearPin = near?.kind === 'pin' || near?.kind === 'block' ? near.ref : undefined;
  const attachPreview = useMemo(() => {
    if (!isNamedPortTool(tool) || !nearPin || !portTemplate.name.trim()) return null;
    const pin = endByKey(nearPin, project);
    return pin ? planAttach(project, pin, tool, portTemplate.name.trim()) : null;
  }, [tool, nearPin, portTemplate.name, project]);
  const ghostPort: NetPort | null =
    (tool === 'label' || tool === 'power' || tool === 'ground' || tool === 'noconnect') && inside
      ? (attachPreview?.port ?? { id: 'ghost', kind: tool, name: tool === 'noconnect' ? '' : portTemplate.name, x: snapped[0], y: snapped[1], rotation: portTemplate.rotation })
      : null;
  const draftPreview = useMemo(
    () => (wireDraft ? wireDraftTo(wireDraft, snapped, project, wireFlip) : null),
    [wireDraft, snapped[0], snapped[1], project, wireFlip], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const gridStep = 10 * view.zoom;
  const showMinor = gridStep >= 7;
  const majorStep = (gridStep >= 7 ? 50 : 100) * view.zoom;
  const wireHover = useMemo(() => (tool === 'select' && inside && near?.kind !== 'pin' ? wireGrabAt(project, pointer, 6 / view.zoom) : null), [tool, inside, near, project, pointer, view.zoom]);
  const wireCursor = wireHover ? ('vertex' in wireHover.grab ? 'move' : wireHover.horizontal ? 'ns-resize' : 'ew-resize') : 'default';
  const cursor = tool === 'select' ? (interaction.current.mode === 'pan' ? 'grabbing' : near?.kind === 'pin' ? 'crosshair' : wireCursor) : 'crosshair';
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
          {(project.blocks ?? []).map((b) => (
            <BlockGraphic key={b.id} block={b} name={sheetName.get(b.child) ?? 'Sheet'} selected={selected.has(b.id)} />
          ))}
          {project.ports.map((p) => (
            <PortGraphic key={p.id} port={p} selected={selected.has(p.id)} highlight={!!highlightNet && conn.itemNet.get(p.id) === highlightNet} />
          ))}
          {conn.junctions
            .filter((j) => j.sheet === currentSheet)
            .map(({ at: j }) => (
              <circle key={j.join(',')} cx={j[0]} cy={j[1]} r={1.8} fill="var(--junction)" />
            ))}
          <g data-ephemeral="">
            {conn.unconnected.filter((u) => project.components.some((c) => c.id === u.componentId)).map((u) => (
              <circle key={`${u.componentId}:${u.pinId}`} cx={u.at[0]} cy={u.at[1]} r={1.3} fill="none" stroke="var(--unconnected)" strokeWidth={0.5} opacity={0.8} />
            ))}
            {draftPreview && (
              <polyline
                points={draftPreview.points.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke={draftPreview.routed ? 'var(--select)' : 'var(--wire)'}
                strokeWidth={1.2}
                strokeDasharray="3 2"
              />
            )}
            {attachPreview && (
              <polyline points={attachPreview.points.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--wire)" strokeWidth={1.2} strokeDasharray="3 2" opacity={0.7} />
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
      <QuickEdit />
      <QuickAdd />
      <SheetTabs />
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {isNamedPortTool(tool) && <PortNameBar kind={tool} />}
      {tool === 'place' && placing?.template.generic && (
        <div className="absolute left-1/2 top-16 z-10 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-panel/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
          <PassiveEditor
            inline
            kind={placing.template.generic.kind}
            value={placing.template.value}
            size={placing.template.generic.size}
            lcsc={placing.template.lcsc}
            onChange={updatePlacingPassive}
            onPick={pickPlacingPart}
          />
          <span className="whitespace-nowrap text-muted">
            click to place · <Kbd>R</Kbd> rotate · <Kbd>Esc</Kbd> done
          </span>
        </div>
      )}
      {tool === 'place' && placing && !placing.template.generic && (
        <div className="pointer-events-none absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-panel/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
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

const PORT_TITLES: Record<NamedPort, string> = { label: 'Net label', power: 'Power flag', ground: 'Ground flag', hier: 'Hierarchical port' };
const COMMON_NAMES: Record<NamedPort, string[]> = { label: [], power: ['+3V3', '+5V', '+12V', 'VBUS', 'VCC'], ground: ['GND', 'AGND', 'PGND'], hier: [] };

/** Name of the label or flag being placed, with the project's names of that kind as suggestions. */
function PortNameBar({ kind }: { kind: NamedPort }) {
  const name = useEditor((s) => s.portTemplate.name);
  const ports = useEditor((s) => s.project.ports);
  const suggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of ports) if (p.kind === kind && p.name.trim()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const used = [...counts].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return [...new Set([...used, ...COMMON_NAMES[kind]])];
  }, [ports, kind]);
  const set = (n: string) => useEditor.getState().setPortTemplate({ name: n });
  return (
    <div className="absolute left-1/2 top-16 z-10 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <span className="whitespace-nowrap font-medium">{PORT_TITLES[kind]}</span>
      <input
        id="port-name"
        aria-label={`${PORT_TITLES[kind]} name`}
        list="port-name-suggestions"
        spellCheck={false}
        autoComplete="off"
        className={cx(inputClass, 'h-7 w-32 font-mono')}
        value={name}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
        onBlur={() => {
          const s = useEditor.getState();
          if (!name.trim()) set(s.portNames[kind] ?? suggestions[0] ?? (kind === 'label' ? 'NET1' : kind === 'power' ? 'VCC' : 'GND'));
        }}
      />
      <datalist id="port-name-suggestions">
        {suggestions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {kind !== 'label' &&
        suggestions.slice(0, 6).map((n) => (
          <button
            key={n}
            onClick={() => set(n)}
            className={cx('h-7 rounded-md border px-2 font-mono', n === name ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500' : 'border-line hover:bg-black/5 dark:hover:bg-white/5')}
          >
            {n}
          </button>
        ))}
      <span className="whitespace-nowrap text-muted">
        click a pin or wire · <Kbd>Tab</Kbd> rename · <Kbd>R</Kbd> rotate · <Kbd>Esc</Kbd> done
      </span>
    </div>
  );
}
