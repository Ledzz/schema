import { memo } from 'react';
import type { SymbolShape, SymbolUnit } from '../../lib/easyeda/symbol';
import { dirToWorld, toWorld, transformBox, unitOf } from '../../lib/schematic/geometry';
import type { SymbolDef } from '../../lib/easyeda/symbol';
import { blockBox, blockPins } from '../../lib/schematic/sheets';
import type { Component, NetPort, SheetBlock, Vec } from '../../lib/schematic/types';

const STROKE = 1;

function Shape({ s, stroke, fill }: { s: SymbolShape; stroke: string; fill: string }) {
  switch (s.kind) {
    case 'rect':
      return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} fill={fill} stroke={stroke} strokeWidth={STROKE} />;
    case 'ellipse':
      return <ellipse cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} fill="none" stroke={stroke} strokeWidth={STROKE} />;
    case 'poly': {
      const pts = s.points.join(' ');
      return s.closed ? (
        <polygon points={pts} fill="none" stroke={stroke} strokeWidth={STROKE} strokeLinejoin="round" />
      ) : (
        <polyline points={pts} fill="none" stroke={stroke} strokeWidth={STROKE} strokeLinejoin="round" strokeLinecap="round" />
      );
    }
    case 'path':
      return <path d={s.d} fill="none" stroke={stroke} strokeWidth={STROKE} />;
    case 'text':
      return (
        <text x={s.x} y={s.y} fontSize={s.size} fill="var(--sym-text)" className="canvas-text">
          {s.text}
        </text>
      );
  }
}

/** Symbol body and pin lines in symbol-local coordinates. */
export const SymbolBody = memo(function SymbolBody({ unit, stroke, fill }: { unit: SymbolUnit; stroke: string; fill: string }) {
  return (
    <>
      {unit.shapes.map((s, i) => (
        <Shape key={i} s={s} stroke={stroke} fill={fill} />
      ))}
      {unit.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={p.y} x2={p.x + p.dir[0] * p.length} y2={p.y + p.dir[1] * p.length} stroke="var(--pin)" strokeWidth={STROKE} strokeLinecap="round" />
      ))}
    </>
  );
});

interface TextSpec {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  vertical: boolean;
  size: number;
  fill: string;
  baseline: 'central' | 'auto' | 'hanging';
}

/** Pin names/numbers placed in world space so they stay readable at any rotation. */
function pinTexts(c: Component, unit: SymbolUnit): TextSpec[] {
  const out: TextSpec[] = [];
  for (const pin of unit.pins) {
    const at = toWorld(c, [pin.x, pin.y]);
    const d = dirToWorld(c, pin.dir);
    const vertical = Math.abs(d[1]) > Math.abs(d[0]);
    const inner: Vec = [at[0] + d[0] * pin.length, at[1] + d[1] * pin.length];
    if (pin.showName && pin.name && pin.name !== pin.number) {
      const pos: Vec = [inner[0] + d[0] * 2, inner[1] + d[1] * 2];
      const forward = vertical ? d[1] < 0 : d[0] > 0;
      out.push({ x: pos[0], y: pos[1], text: pin.name, anchor: forward ? 'start' : 'end', vertical, size: 5.5, fill: 'var(--sym-text)', baseline: 'central' });
    }
    if (pin.showNumber && pin.number) {
      const mid: Vec = [at[0] + (d[0] * pin.length) / 2, at[1] + (d[1] * pin.length) / 2];
      out.push({
        x: vertical ? mid[0] - 1 : mid[0],
        y: vertical ? mid[1] : mid[1] - 1,
        text: pin.number,
        anchor: 'middle',
        vertical,
        size: 4.5,
        fill: 'var(--pin-text)',
        baseline: 'auto',
      });
    }
  }
  return out;
}

function SvgText({ t }: { t: TextSpec }) {
  return (
    <text
      x={t.x}
      y={t.y}
      fontSize={t.size}
      fill={t.fill}
      textAnchor={t.anchor}
      dominantBaseline={t.baseline}
      transform={t.vertical ? `rotate(-90 ${t.x} ${t.y})` : undefined}
      className="canvas-text"
    >
      {t.text}
    </text>
  );
}

export const ComponentGraphic = memo(function ComponentGraphic({
  component: c,
  symbol,
  selected,
  ghost,
  highlightPins,
}: {
  component: Component;
  symbol: SymbolDef;
  selected?: boolean;
  ghost?: boolean;
  highlightPins?: Set<string>;
}) {
  const unit = unitOf(symbol, c.unit);
  const stroke = selected ? 'var(--select)' : 'var(--sym-stroke)';
  const box = transformBox(c, unit.bbox);
  const twoPin = unit.pins.length <= 3;
  const tall = box.y2 - box.y1 > (box.x2 - box.x1) * 1.3;
  const labels: TextSpec[] = [];
  if (twoPin && tall) {
    const cy = (box.y1 + box.y2) / 2;
    labels.push({ x: box.x2 + 3, y: cy - 2, text: c.designator, anchor: 'start', vertical: false, size: 7, fill: 'var(--sym-text)', baseline: 'auto' });
    labels.push({ x: box.x2 + 3, y: cy + 2, text: c.value, anchor: 'start', vertical: false, size: 6, fill: 'var(--muted)', baseline: 'hanging' });
  } else {
    const x = twoPin ? (box.x1 + box.x2) / 2 : box.x1;
    const anchor = twoPin ? 'middle' : 'start';
    labels.push({ x, y: box.y1 - 3, text: c.designator, anchor, vertical: false, size: 7, fill: 'var(--sym-text)', baseline: 'auto' });
    labels.push({ x, y: box.y2 + 3, text: c.value, anchor, vertical: false, size: 6, fill: 'var(--muted)', baseline: 'hanging' });
  }
  return (
    <g opacity={ghost ? 0.6 : 1}>
      {selected && (
        <rect x={box.x1 - 3} y={box.y1 - 3} width={box.x2 - box.x1 + 6} height={box.y2 - box.y1 + 6} rx={2} fill="var(--select)" fillOpacity={0.08} stroke="var(--select)" strokeWidth={0.6} strokeDasharray="2 2" />
      )}
      <g transform={`translate(${c.x} ${c.y}) rotate(${-c.rotation}) scale(${c.mirror ? -1 : 1} 1)`}>
        <SymbolBody unit={unit} stroke={stroke} fill="var(--sym-fill)" />
        {highlightPins &&
          unit.pins
            .filter((p) => highlightPins.has(p.id))
            .map((p) => <line key={p.id} x1={p.x} y1={p.y} x2={p.x + p.dir[0] * p.length} y2={p.y + p.dir[1] * p.length} stroke="var(--highlight)" strokeWidth={2} />)}
      </g>
      {pinTexts(c, unit).map((t, i) => (
        <SvgText key={i} t={t} />
      ))}
      {labels.map((t, i) => (
        <SvgText key={`l${i}`} t={t} />
      ))}
    </g>
  );
});

/** Net label, power / ground flag or no-connect marker, drawn around its anchor. */
export const PortGraphic = memo(function PortGraphic({ port, selected, highlight, ghost }: { port: NetPort; selected?: boolean; highlight?: boolean; ghost?: boolean }) {
  const color = selected
    ? 'var(--select)'
    : highlight
      ? 'var(--highlight)'
      : port.kind === 'label'
        ? 'var(--label)'
        : port.kind === 'hier'
          ? 'var(--hier)'
          : port.kind === 'noconnect'
            ? 'var(--unconnected)'
            : 'var(--power)';
  const { x, y, rotation: r } = port;
  if (port.kind === 'noconnect') {
    return (
      <g stroke={color} strokeWidth={1.2} opacity={ghost ? 0.6 : 1}>
        <line x1={x - 3} y1={y - 3} x2={x + 3} y2={y + 3} />
        <line x1={x - 3} y1={y + 3} x2={x + 3} y2={y - 3} />
      </g>
    );
  }
  if (port.kind === 'label' || port.kind === 'hier') {
    const vertical = r === 90 || r === 270;
    const reverse = r === 180 || r === 270;
    const width = Math.max(port.name.length * 4.2 + 4, 10);
    // A hierarchical port is pointed at both ends.
    const tip = port.kind === 'hier' ? 3 : 0;
    return (
      <g opacity={ghost ? 0.6 : 1}>
        <g transform={`translate(${x} ${y}) rotate(${vertical ? -90 : 0})`}>
          <path
            d={
              reverse
                ? `M0 0 L-3 -4.5 L${-width - 3} -4.5 L${-width - 3 - tip} 0 L${-width - 3} 4.5 L-3 4.5 Z`
                : `M0 0 L3 -4.5 L${width + 3} -4.5 L${width + 3 + tip} 0 L${width + 3} 4.5 L3 4.5 Z`
            }
            fill="var(--canvas-bg)"
            fillOpacity={0.85}
            stroke={color}
            strokeWidth={0.8}
          />
          <text x={reverse ? -width / 2 - 3 : width / 2 + 3} y={0.3} fontSize={6} fill={color} textAnchor="middle" dominantBaseline="central" className="canvas-text" fontWeight={600}>
            {port.name}
          </text>
        </g>
        <circle cx={x} cy={y} r={0.9} fill={color} />
      </g>
    );
  }
  // power (bar, points up by default) / ground (stacked bars, points down)
  const vertical = r === 90 || r === 270;
  return (
    <g opacity={ghost ? 0.6 : 1}>
      <g transform={`translate(${x} ${y}) rotate(${-r})`} stroke={color} strokeWidth={1.2} strokeLinecap="round" fill="none">
        {port.kind === 'power' ? (
          <>
            <line x1={0} y1={0} x2={0} y2={-8} />
            <line x1={-6} y1={-8} x2={6} y2={-8} />
          </>
        ) : (
          <>
            <line x1={0} y1={0} x2={0} y2={6} />
            <line x1={-7} y1={6} x2={7} y2={6} />
            <line x1={-4.5} y1={8.5} x2={4.5} y2={8.5} />
            <line x1={-2} y1={11} x2={2} y2={11} />
          </>
        )}
      </g>
      <PowerText port={port} color={color} vertical={vertical} />
    </g>
  );
});

function PowerText({ port, color, vertical }: { port: NetPort; color: string; vertical: boolean }) {
  const dist = port.kind === 'power' ? 11 : 15;
  const sign = port.kind === 'power' ? -1 : 1;
  let [tx, ty]: Vec = [0, sign * dist];
  // rotate the text anchor with the flag, keep glyphs upright
  const r = port.rotation;
  if (r === 90) [tx, ty] = [ty, -tx];
  else if (r === 180) [tx, ty] = [-tx, -ty];
  else if (r === 270) [tx, ty] = [-ty, tx];
  const anchor = vertical ? (tx < 0 ? 'end' : 'start') : 'middle';
  const baseline = vertical ? 'central' : ty < 0 ? 'auto' : 'hanging';
  return (
    <text x={port.x + tx} y={port.y + ty + (vertical ? 0 : ty < 0 ? 1 : -1)} fontSize={6} fill={color} textAnchor={anchor} dominantBaseline={baseline} className="canvas-text" fontWeight={600}>
      {port.name}
    </text>
  );
}

/** A hierarchical block: a box named after its sheet, with a pin per hierarchical port down the left. */
export const BlockGraphic = memo(function BlockGraphic({ block, name, selected }: { block: SheetBlock; name: string; selected?: boolean }) {
  const box = blockBox(block);
  const stroke = selected ? 'var(--select)' : 'var(--hier)';
  return (
    <g>
      <rect x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="var(--sym-fill)" stroke={stroke} strokeWidth={1.2} strokeDasharray="4 2" rx={1.5} />
      <text x={box.x1 + 4} y={box.y1 + 9} fontSize={7} fill={stroke} className="canvas-text" fontWeight={700}>
        {name}
      </text>
      {blockPins(block).map((p) => (
        <g key={p.name}>
          <line x1={p.at[0]} y1={p.at[1]} x2={p.at[0] + 5} y2={p.at[1]} stroke={stroke} strokeWidth={1} />
          <circle cx={p.at[0]} cy={p.at[1]} r={0.9} fill={stroke} />
          <text x={p.at[0] + 7} y={p.at[1] + 0.3} fontSize={5.5} fill="var(--pin-text)" dominantBaseline="central" className="canvas-text">
            {p.name}
          </text>
        </g>
      ))}
      {!block.pins.some(Boolean) && (
        <text x={box.x1 + 4} y={box.y1 + 22} fontSize={5} fill="var(--sym-text)" opacity={0.6} className="canvas-text">
          Add hierarchical ports on its sheet
        </text>
      )}
    </g>
  );
});
