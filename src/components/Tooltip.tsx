import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/*
 * Instant tooltips. Any element with `data-tip` shows it the moment the pointer is over it, or
 * when it gets keyboard focus, instead of the browser's delayed native `title`. `data-tip-key`
 * adds a shortcut chip; `data-tip-side` picks the side (default: right of vertical toolbars,
 * below everything else). One layer, mounted once, serves the whole app.
 */

type Side = 'right' | 'bottom' | 'top' | 'left';

interface Tip {
  text: string;
  shortcut?: string;
  rect: DOMRect;
  side: Side;
}

const GAP = 6;
const MARGIN = 8;

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const current = useRef<Element | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = (el: Element | null) => {
      if (el === current.current) return;
      current.current = el;
      const text = el?.getAttribute('data-tip');
      if (!el || !text) return setTip(null);
      const side = (el.getAttribute('data-tip-side') as Side | null) ?? (el.closest('[aria-orientation="vertical"]') ? 'right' : 'bottom');
      setTip({ text, shortcut: el.getAttribute('data-tip-key') ?? undefined, rect: el.getBoundingClientRect(), side });
    };
    const tipOf = (t: EventTarget | null) => (t instanceof Element ? t.closest('[data-tip]') : null);
    const over = (e: PointerEvent) => e.pointerType !== 'touch' && show(tipOf(e.target));
    const out = (e: PointerEvent) => !e.relatedTarget && show(null);
    // A tooltip whose element went away (a toolbar re-rendered) must not linger.
    const move = () => current.current && !current.current.isConnected && show(null);
    const focus = (e: FocusEvent) => {
      const el = tipOf(e.target);
      if (el?.matches(':focus-visible')) show(el);
    };
    const hide = () => show(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('resize', hide);
    };
  }, []);

  // Place it next to its element once its size is known: flip at the window edge, then clamp.
  useLayoutEffect(() => {
    const el = box.current;
    if (!tip || !el) return;
    const { rect } = tip;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let side = tip.side;
    if (side === 'bottom' && rect.bottom + GAP + h > window.innerHeight - MARGIN) side = 'top';
    else if (side === 'top' && rect.top - GAP - h < MARGIN) side = 'bottom';
    else if (side === 'right' && rect.right + GAP + w > window.innerWidth - MARGIN) side = 'left';
    else if (side === 'left' && rect.left - GAP - w < MARGIN) side = 'right';
    let x = side === 'right' ? rect.right + GAP : side === 'left' ? rect.left - GAP - w : rect.left + rect.width / 2 - w / 2;
    let y = side === 'bottom' ? rect.bottom + GAP : side === 'top' ? rect.top - GAP - h : rect.top + rect.height / 2 - h / 2;
    x = Math.max(MARGIN, Math.min(x, window.innerWidth - MARGIN - w));
    y = Math.max(MARGIN, Math.min(y, window.innerHeight - MARGIN - h));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      style={{ visibility: 'hidden' }}
      className="pointer-events-none fixed left-0 top-0 z-[100] flex max-w-[280px] items-center gap-1.5 rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
    >
      <span>{tip.text}</span>
      {tip.shortcut && <kbd className="shrink-0 rounded border border-white/25 px-1 font-mono text-[10px] leading-4 text-white/75 dark:border-black/20 dark:text-zinc-600">{tip.shortcut}</kbd>}
    </div>,
    document.body,
  );
}
