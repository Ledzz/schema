import { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Box, CircleOff, Copy, Cpu, Loader2, Plus, Split, Tag } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { fetchSearch } from '../../lib/api';
import { placeQuickItem, quickSuggestions, searchesLibrary, type QuickItem, type Suggestion } from '../../lib/quickadd';
import { loadUserBlocks } from '../../lib/userBlocks';
import { PART_CLASS_LABEL, splitPackageQuery } from '../../shared/parts';
import { GroundIcon, PASSIVE_TOOLS, PowerIcon } from '../Chrome';
import { cx, formatStock } from '../ui';

/** What was typed last time, offered again so a second "100n" is one keystroke. */
let lastQuery = '';

const RANK = { basic: 0, preferred: 1, extended: 2 } as const;

function Icon({ item }: { item: QuickItem }) {
  switch (item.kind) {
    case 'passive':
      return <>{PASSIVE_TOOLS.find((t) => t.kind === item.passive)?.icon}</>;
    case 'power':
      return <PowerIcon />;
    case 'ground':
      return <GroundIcon />;
    case 'label':
      return <Tag className="h-4 w-4" />;
    case 'hier':
      return <Split className="h-4 w-4" />;
    case 'noconnect':
      return <CircleOff className="h-4 w-4" />;
    case 'same':
      return <Copy className="h-4 w-4" />;
    case 'custom':
      return <Box className="h-4 w-4" />;
    case 'block':
    case 'userBlock':
      return <Blocks className="h-4 w-4" />;
    case 'library':
      return <Cpu className="h-4 w-4" />;
  }
}

/**
 * The quick add box at the cursor: type a value, rail, net, block or part and press Enter to place
 * the highlighted suggestion there (or to name the pin under the cursor).
 */
export function QuickAdd() {
  const state = useEditor((s) => s.quickAdd);
  if (!state) return null;
  return <QuickAddBox key={`${state.at.join(',')}|${state.pin}`} />;
}

function QuickAddBox() {
  const state = useEditor((s) => s.quickAdd)!;
  const view = useEditor((s) => s.view);
  const canvas = useEditor((s) => s.canvasSize);
  const project = useEditor((s) => s.project);
  const [query, setQuery] = useState(lastQuery);
  const [active, setActive] = useState(0);
  const [library, setLibrary] = useState<{ query: string; items: Suggestion[]; loading: boolean; error?: string }>({ query: '', items: [], loading: false });
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => useEditor.getState().setQuickAdd(null);

  useEffect(() => {
    input.current?.select();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  const local = useMemo(() => quickSuggestions(query, project, { onPin: !!state.pin, userBlocks: loadUserBlocks() }), [query, project, state.pin]);

  // JLCPCB keyword search, a moment after typing stops; Basic and Preferred parts first.
  useEffect(() => {
    const q = query.trim();
    if (!searchesLibrary(q, local)) {
      setLibrary({ query: q, items: [], loading: false });
      return;
    }
    setLibrary((l) => ({ ...l, query: q, loading: true, error: undefined }));
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { keyword, packages } = splitPackageQuery(q);
        const r = await fetchSearch({ q: keyword, packages, types: [], inStock: true, sort: 'relevance', page: 1, pageSize: 12 }, abort.signal);
        const parts = [...r.parts].sort((a, b) => RANK[a.partClass] - RANK[b.partClass]).slice(0, 6);
        const items = parts.map(
          (part): Suggestion => ({
            item: { kind: 'library', part },
            title: part.mpn,
            detail: `${part.package} · ${part.lcsc} · ${PART_CLASS_LABEL[part.partClass]} · ${formatStock(part.stock)} in stock`,
          }),
        );
        setLibrary({ query: q, items, loading: false });
      } catch (err) {
        if (!abort.signal.aborted) setLibrary({ query: q, items: [], loading: false, error: (err as Error).message });
      }
    }, 250);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, local]);

  const shownLibrary = library.query === query.trim() ? library.items : [];
  const suggestions = [...local, ...shownLibrary];
  const current = Math.min(active, Math.max(0, suggestions.length - 1));

  const place = async (s: Suggestion | undefined) => {
    if (!s || busy) return;
    setBusy(true);
    lastQuery = query;
    try {
      const ids = await placeQuickItem(s.item, state.at, state.pin);
      useEditor.getState().setSelection(ids);
      close();
    } catch (err) {
      useEditor.getState().notify((err as Error).message, 'error');
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggestions.length;
      if (n) setActive((current + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void place(suggestions[current]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const width = 340;
  const sx = state.at[0] * view.zoom + view.x;
  const sy = state.at[1] * view.zoom + view.y;
  const left = Math.min(Math.max(8, sx + 10), canvas.width - width - 8);
  const top = Math.min(Math.max(8, sy + 10), Math.max(8, canvas.height - 360));

  return (
    <div ref={ref} role="dialog" aria-label="Quick add" className="absolute z-30 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/30" style={{ left, top, width }}>
      <div className="flex items-center gap-2 border-b border-line px-3">
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" /> : <Plus className="h-4 w-4 shrink-0 text-muted" />}
        <input
          ref={input}
          aria-label="Quick add"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={state.pin ? 'Net, rail, GND or nc for this pin…' : '10k 0603, 100n, +3V3, SDA, AMS1117…'}
          spellCheck={false}
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
        />
      </div>
      {state.pinLabel && <div className="border-b border-line bg-panel-2 px-3 py-1 text-[11px] text-muted">On {state.pinLabel}: a name labels this pin, a rail or GND flags it</div>}
      <div role="listbox" aria-label="Suggestions" className="max-h-72 overflow-y-auto py-1">
        {suggestions.map((s, i) => (
          <button
            key={`${s.item.kind}-${i}-${s.title}`}
            role="option"
            aria-selected={i === current}
            onPointerEnter={() => setActive(i)}
            onClick={() => void place(s)}
            className={cx('flex w-full items-center gap-2.5 px-3 py-1.5 text-left', i === current ? 'bg-indigo-500/12' : '')}
          >
            <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', i === current ? 'text-indigo-500' : 'text-muted')}>
              <Icon item={s.item} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{s.title}</span>
              <span className="block truncate text-[11px] text-muted">{s.detail}</span>
            </span>
            {i === current && <kbd className="rounded border border-line bg-panel-2 px-1 py-px font-mono text-[10px] text-muted">↵</kbd>}
          </button>
        ))}
        {library.loading && library.query === query.trim() && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching JLCPCB…
          </div>
        )}
        {library.error && <div className="px-3 py-1.5 text-[11px] text-rose-500">JLCPCB search failed: {library.error}</div>}
        {!suggestions.length && !library.loading && <div className="px-3 py-2 text-[11px] text-muted">Nothing matches. Try a value (10k, 100n), a rail (+3V3), a net name or a part number.</div>}
      </div>
    </div>
  );
}
