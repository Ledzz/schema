import { useCallback, useEffect, useRef, useState } from 'react';
import type { Vec } from '../../lib/schematic/types';

type Box = { x1: number; y1: number; x2: number; y2: number };
type ViewBox = [number, number, number, number];

const fitted = (b: Box, pad: number): ViewBox => [b.x1 - pad, b.y1 - pad, b.x2 - b.x1 + pad * 2, b.y2 - b.y1 + pad * 2];

/**
 * Pan and zoom for the symbol and footprint editors: an SVG viewBox fitted to a box, zoomed with
 * the wheel around the pointer and panned by dragging (middle button, or empty space).
 */
export function useEditorView(fit: () => Box, pad: number) {
  const ref = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewBox>(() => fitted(fit(), pad));
  const panning = useRef<{ client: Vec; view: ViewBox } | null>(null);

  const toWorld = useCallback((e: { clientX: number; clientY: number }): Vec => {
    const svg = ref.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }, []);

  /** World units per screen pixel, for hit tolerances and stroke widths. */
  const perPixel = () => {
    const svg = ref.current;
    if (!svg || !svg.clientWidth) return view[2] / 600;
    return Math.max(view[2] / svg.clientWidth, view[3] / svg.clientHeight);
  };

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.002)));
      const [px, py] = toWorld(e);
      setView(([x, y, w, h]) => [px - (px - x) * f, py - (py - y) * f, w * f, h * f]);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [toWorld]);

  return {
    ref,
    viewBox: view.join(' '),
    toWorld,
    perPixel,
    refit: () => setView(fitted(fit(), pad)),
    startPan: (e: { clientX: number; clientY: number }) => (panning.current = { client: [e.clientX, e.clientY], view }),
    /** Pans while a pan is going on; returns whether one is. */
    movePan: (e: { clientX: number; clientY: number }) => {
      const p = panning.current;
      if (!p) return false;
      const k = perPixel();
      setView([p.view[0] - (e.clientX - p.client[0]) * k, p.view[1] - (e.clientY - p.client[1]) * k, p.view[2], p.view[3]]);
      return true;
    },
    endPan: () => {
      const was = !!panning.current;
      panning.current = null;
      return was;
    },
  };
}
