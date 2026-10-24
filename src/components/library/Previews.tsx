import { memo, useMemo } from 'react';
import { parseFootprint } from '../../lib/easyeda/footprint';
import { parseSymbol, type SymbolDef } from '../../lib/easyeda/symbol';
import type { Component } from '../../lib/schematic/types';
import { ComponentGraphic } from '../canvas/graphics';

export const SymbolPreview = memo(function SymbolPreview({
  dataStr,
  symbol: given,
  title,
  prefix,
  className,
}: {
  dataStr?: string;
  symbol?: SymbolDef;
  title?: string;
  prefix?: string;
  className?: string;
}) {
  const symbol = useMemo(() => given ?? (dataStr ? parseSymbol(dataStr, title) : null), [given, dataStr, title]);
  if (!symbol) return <Empty text="No symbol in the EasyEDA library" />;
  const unit = symbol.units[0];
  const pad = 14;
  const b = unit.bbox;
  const component: Component = {
    id: 'preview',
    symbolKey: 'preview',
    unit: 0,
    designator: `${prefix || symbol.prefix}?`,
    value: title ?? symbol.title,
    x: 0,
    y: 0,
    rotation: 0,
    mirror: false,
    attrs: {},
  };
  const vb = `${b.x1 - pad} ${b.y1 - pad} ${b.x2 - b.x1 + pad * 2} ${b.y2 - b.y1 + pad * 2}`;
  return (
    <svg viewBox={vb} className={className ?? 'h-full w-full'} preserveAspectRatio="xMidYMid meet">
      <ComponentGraphic component={component} symbol={symbol} />
      {symbol.units.length > 1 && (
        <text x={b.x2 + pad - 2} y={b.y1 - pad + 6} fontSize={5} textAnchor="end" fill="var(--muted)" className="canvas-text">
          unit 1 of {symbol.units.length}
        </text>
      )}
    </svg>
  );
});

export const FootprintPreview = memo(function FootprintPreview({ dataStr, className }: { dataStr?: string; className?: string }) {
  const fp = useMemo(() => (dataStr ? parseFootprint(dataStr) : null), [dataStr]);
  if (!fp || (fp.pads.length === 0 && fp.shapes.length === 0)) return <Empty text="No footprint in the EasyEDA library" />;
  const pad = Math.max(fp.bbox.x2 - fp.bbox.x1, fp.bbox.y2 - fp.bbox.y1) * 0.08 + 10;
  const vb = `${fp.bbox.x1 - pad} ${fp.bbox.y1 - pad} ${fp.bbox.x2 - fp.bbox.x1 + pad * 2} ${fp.bbox.y2 - fp.bbox.y1 + pad * 2}`;
  const fontSize = Math.max(6, Math.min(...fp.pads.map((p) => Math.min(p.w, p.h)).filter((v) => v > 0), 40) * 0.55);
  return (
    <svg viewBox={vb} className={className ?? 'h-full w-full'} preserveAspectRatio="xMidYMid meet" style={{ background: '#0d1016' }}>
      {fp.shapes
        .filter((s) => s.layer === 'outline')
        .map((s, i) => (
          <path key={`o${i}`} d={s.d} fill="none" stroke="#475569" strokeWidth={Math.max(s.width, 2)} strokeLinecap="round" />
        ))}
      {fp.pads.map((p, i) => {
        const fill = p.throughHole ? '#d4a24c' : '#c0392b';
        const shape =
          p.shape === 'polygon' && p.points.length >= 6 ? (
            <polygon points={p.points.join(' ')} fill={fill} transform={`translate(${p.x} ${p.y})`} />
          ) : (
            <rect
              x={p.x - p.w / 2}
              y={p.y - p.h / 2}
              width={p.w}
              height={p.h}
              rx={p.shape === 'oval' || p.shape === 'ellipse' ? Math.min(p.w, p.h) / 2 : p.radius ? (Math.min(p.w, p.h) * p.radius) / 100 : 0}
              fill={fill}
              transform={p.rotation ? `rotate(${-p.rotation} ${p.x} ${p.y})` : undefined}
            />
          );
        return (
          <g key={i}>
            {shape}
            {p.hole && (
              <rect
                x={p.x - p.hole.w / 2}
                y={p.y - p.hole.h / 2}
                width={p.hole.w}
                height={p.hole.h}
                rx={Math.min(p.hole.w, p.hole.h) / 2}
                fill="#0d1016"
                transform={p.rotation ? `rotate(${-p.rotation} ${p.x} ${p.y})` : undefined}
              />
            )}
            <text x={p.x} y={p.y} fontSize={fontSize} textAnchor="middle" dominantBaseline="central" fill="#fff" fillOpacity={0.85} className="canvas-text">
              {p.number}
            </text>
          </g>
        );
      })}
      {fp.shapes
        .filter((s) => s.layer === 'silk')
        .map((s, i) => (
          <path key={`s${i}`} d={s.d} fill={s.fill ? '#f8fafc' : 'none'} stroke="#f8fafc" strokeWidth={Math.max(s.width, 4)} strokeLinecap="round" strokeLinejoin="round" />
        ))}
    </svg>
  );
});

function Empty({ text }: { text: string }) {
  return <div className="flex h-full w-full items-center justify-center p-4 text-center text-xs text-muted">{text}</div>;
}
