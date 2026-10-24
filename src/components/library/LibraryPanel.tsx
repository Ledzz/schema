import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  PackageSearch,
  Plus,
  RefreshCcw,
  Replace,
  Search,
  X,
} from 'lucide-react';
import { useEditor } from '../../store/editor';
import { fetchPartDetail } from '../../lib/api';
import { beginPlacePart, designatorPrefix, replacePart } from '../../lib/actions';
import { registerLibrarySearch } from '../../lib/libraryFocus';
import { LIBRARY_ATTRIBUTION, PART_CLASSES, PART_CLASS_LABEL, priceAt, type PartClass, type PartDetail, type PartSummary, type SortKey } from '../../shared/parts';
import { CLASS_HINT, CLASS_STYLES, ClassBadge, Kbd, cx, formatCount, formatPrice, formatStock } from '../ui';
import { FootprintPreview, SymbolPreview } from './Previews';
import { useLibrarySearch } from './useLibrarySearch';

const SORT_LABELS: Record<SortKey, string> = {
  relevance: 'Relevance',
  stock: 'Stock: high → low',
  price: 'Price: low → high',
  mpn: 'MFR part: A → Z',
};

export function LibraryPanel() {
  const libraryRequest = useEditor((s) => s.libraryRequest);
  const selection = useEditor((s) => s.selection);
  const components = useEditor((s) => s.project.components);
  const height = useEditor((s) => s.libraryHeight);
  const lib = useLibrarySearch();
  const { filters, update } = lib;
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerLibrarySearch(inputRef.current);
    return () => registerLibrarySearch(null);
  }, []);

  useEffect(() => {
    if (!libraryRequest) return;
    update({ q: libraryRequest.q, category: undefined, subcategory: undefined, packages: [], ...(libraryRequest.types ? { types: libraryRequest.types } : {}) });
    setReplaceId(libraryRequest.replaceId ?? null);
    inputRef.current?.focus();
  }, [libraryRequest, update]);

  // Replace target: explicit request, otherwise the single selected component.
  const selectedComponent = selection.length === 1 ? components.find((c) => c.id === selection[0]) : undefined;
  const replaceTarget = components.find((c) => c.id === replaceId) ?? selectedComponent;

  const selectedPart = lib.parts.find((p) => p.lcsc === selectedCode) ?? null;
  useEffect(() => {
    if (lib.parts.length && !lib.parts.some((p) => p.lcsc === selectedCode)) setSelectedCode(lib.parts[0].lcsc);
  }, [lib.parts, selectedCode]);

  const toggleType = (t: PartClass) => {
    const set = new Set(filters.types);
    if (set.has(t)) set.delete(t);
    else set.add(t);
    update({ types: PART_CLASSES.filter((c) => set.has(c)) });
  };
  const noFee = filters.types.length === 2 && filters.types.includes('basic') && filters.types.includes('preferred');

  const move = (delta: number) => {
    const idx = lib.parts.findIndex((p) => p.lcsc === selectedCode);
    const next = lib.parts[Math.min(lib.parts.length - 1, Math.max(0, idx + delta))];
    if (!next) return;
    setSelectedCode(next.lcsc);
    tableRef.current?.querySelector(`[data-lcsc="${next.lcsc}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && selectedCode) {
      e.preventDefault();
      if (/^C\d+$/i.test(filters.q.trim()) && !lib.parts.length) beginPlacePart(filters.q.trim());
      else beginPlacePart(selectedCode);
    } else if (e.key === 'Escape') {
      (e.target as HTMLElement).blur();
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" style={{ height }} aria-label="Parts library">
      {/* Search header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2" onKeyDown={onKeyDown}>
        <div className="relative min-w-72 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            value={filters.q}
            onChange={(e) => update({ q: e.target.value, category: undefined, subcategory: undefined, packages: [] })}
            placeholder="Search 7M+ JLCPCB parts — 10k 0603, AMS1117, USB-C, C25804…"
            className="h-9 w-full rounded-lg border border-line bg-panel-2 pl-8 pr-16 text-[13px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            spellCheck={false}
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {lib.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
            {filters.q ? (
              <button aria-label="Clear search" onClick={() => update({ q: '' })} className="rounded p-0.5 text-muted hover:text-[var(--text)]">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-0.5" role="group" aria-label="JLCPCB part type">
          {PART_CLASSES.map((t) => {
            const on = filters.types.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                title={CLASS_HINT[t]}
                aria-pressed={on}
                className={cx(
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                  on ? cx('ring-1 ring-inset', CLASS_STYLES[t].chip) : 'text-muted hover:text-[var(--text)]',
                )}
              >
                <span className={cx('h-2 w-2 rounded-full', CLASS_STYLES[t].dot)} />
                {PART_CLASS_LABEL[t]}
                {lib.facets && <span className="tabular text-[11px] opacity-70">{formatCount(lib.facets.classCounts[t])}</span>}
              </button>
            );
          })}
          <div className="mx-0.5 h-4 w-px bg-[var(--line)]" />
          <button
            onClick={() => update({ types: noFee ? [] : ['basic', 'preferred'] })}
            aria-pressed={noFee}
            title="Basic + Preferred: no extended-part setup fee"
            className={cx('h-7 rounded-md px-2 text-xs font-medium', noFee ? 'bg-indigo-500/15 text-indigo-500 dark:text-indigo-300' : 'text-muted hover:text-[var(--text)]')}
          >
            No setup fee
          </button>
        </div>

        <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 text-xs">
          <input type="checkbox" checked={filters.inStock} onChange={(e) => update({ inStock: e.target.checked })} className="accent-indigo-500" />
          In stock
        </label>

        <label className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2 text-xs">
          <ArrowDownWideNarrow className="h-3.5 w-3.5 text-muted" />
          <select value={filters.sort} onChange={(e) => update({ sort: e.target.value as SortKey })} className="bg-transparent text-xs outline-none" aria-label="Sort results">
            {Object.entries(SORT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[208px_minmax(0,1fr)_320px]">
        <Facets lib={lib} />
        <div className="flex min-h-0 flex-col border-x border-line">
          <div ref={tableRef} className="min-h-0 flex-1 overflow-auto" onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) lib.loadMore();
          }}>
            <ResultsTable parts={lib.parts} selected={selectedCode} onSelect={setSelectedCode} onPlace={beginPlacePart} />
            {lib.error && (
              <div className="flex items-center gap-2 p-4 text-xs text-rose-500">
                {lib.error}
                <button onClick={lib.retry} className="inline-flex items-center gap-1 underline">
                  <RefreshCcw className="h-3 w-3" /> Retry
                </button>
              </div>
            )}
            {!lib.loading && !lib.error && lib.parts.length === 0 && (
              <div className="flex flex-col items-center gap-2 p-8 text-center text-xs text-muted">
                <PackageSearch className="h-6 w-6" />
                No parts match. Try fewer words, another part type, or turn off "In stock".
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px] text-muted">
            <span className="tabular">
              {lib.parts.length.toLocaleString()} of {lib.total.toLocaleString()} parts
              {lib.impliedPackages.length > 0 && (
                <>
                  {' '}
                  · package <span className="text-[var(--text)]">{lib.impliedPackages.join(', ')}</span> (from search)
                </>
              )}
              {filters.category && (
                <>
                  {' '}
                  in <span className="text-[var(--text)]">{filters.subcategory ?? filters.category}</span>
                </>
              )}
            </span>
            {lib.hasMore && (
              <button onClick={lib.loadMore} className="hover:text-[var(--text)]">
                Load more
              </button>
            )}
          </div>
        </div>
        <PartDetailPane part={selectedPart} replaceTarget={replaceTarget ? { id: replaceTarget.id, designator: replaceTarget.designator } : null} onReplaced={() => setReplaceId(null)} />
      </div>
    </section>
  );
}

function Facets({ lib }: { lib: ReturnType<typeof useLibrarySearch> }) {
  const { filters, update, facets } = lib;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <aside className="min-h-0 overflow-auto px-2 py-2 text-xs">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Category</div>
      <button
        onClick={() => update({ category: undefined, subcategory: undefined })}
        className={cx('flex w-full items-center justify-between rounded-md px-2 py-1 text-left', !filters.category ? 'bg-indigo-500/10 font-medium' : 'hover:bg-black/5 dark:hover:bg-white/5')}
      >
        All categories
        {facets && <span className="tabular text-muted">{formatCount(facets.total)}</span>}
      </button>
      {facets?.categories.map((c) => {
        const expanded = open === c.name || filters.category === c.name;
        return (
          <div key={c.name}>
            <div className={cx('flex items-center rounded-md', filters.category === c.name && !filters.subcategory ? 'bg-indigo-500/10 font-medium' : 'hover:bg-black/5 dark:hover:bg-white/5')}>
              <button aria-label={expanded ? 'Collapse' : 'Expand'} onClick={() => setOpen(expanded && open === c.name ? null : c.name)} className="p-1 text-muted">
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <button onClick={() => update({ category: c.name, subcategory: undefined })} className="flex min-w-0 flex-1 items-center justify-between py-1 pr-2 text-left">
                <span className="truncate">{c.name}</span>
                <span className="tabular text-muted">{formatCount(c.count)}</span>
              </button>
            </div>
            {expanded &&
              c.children.map((s) => (
                <button
                  key={s.name}
                  onClick={() => update({ category: c.name, subcategory: s.name })}
                  className={cx(
                    'flex w-full items-center justify-between rounded-md py-1 pl-6 pr-2 text-left',
                    filters.subcategory === s.name ? 'bg-indigo-500/10 font-medium' : 'text-muted hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/5',
                  )}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="tabular">{formatCount(s.count)}</span>
                </button>
              ))}
          </div>
        );
      })}
      {facets && facets.packages.length > 0 && (
        <>
          <div className="mt-3 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Package</div>
          <div className="flex flex-wrap gap-1 px-1">
            {facets.packages.slice(0, 30).map((p) => {
              const implied = lib.impliedPackages.includes(p.name);
              const on = filters.packages.includes(p.name) || implied;
              return (
                <button
                  key={p.name}
                  disabled={implied}
                  onClick={() => update({ packages: on ? filters.packages.filter((x) => x !== p.name) : [...filters.packages, p.name] })}
                  className={cx('rounded-md border px-1.5 py-0.5 text-[11px]', on ? 'border-indigo-500 bg-indigo-500/10' : 'border-line hover:border-indigo-400')}
                  title={implied ? 'Taken from your search text' : `${p.count.toLocaleString()} parts`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}

function ResultsTable({
  parts,
  selected,
  onSelect,
  onPlace,
}: {
  parts: PartSummary[];
  selected: string | null;
  onSelect: (code: string) => void;
  onPlace: (code: string) => void;
}) {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <colgroup>
        <col className="w-[92px]" />
        <col className="w-[84px]" />
        <col className="w-[22%]" />
        <col className="w-[12%]" />
        <col />
        <col className="w-[72px]" />
        <col className="w-[70px]" />
        <col className="w-[40px]" />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] text-muted shadow-[0_1px_0_var(--line)]">
        <tr>
          <th className="px-3 py-1.5 font-medium">Type</th>
          <th className="px-2 py-1.5 font-medium">LCSC</th>
          <th className="px-2 py-1.5 font-medium">MFR Part</th>
          <th className="px-2 py-1.5 font-medium">Package</th>
          <th className="px-2 py-1.5 font-medium">Description</th>
          <th className="px-2 py-1.5 text-right font-medium">Stock</th>
          <th className="px-2 py-1.5 text-right font-medium">Price</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {parts.map((p) => (
          <tr
            key={p.lcsc}
            data-lcsc={p.lcsc}
            onClick={() => onSelect(p.lcsc)}
            onDoubleClick={() => onPlace(p.lcsc)}
            className={cx('group cursor-default border-b border-line/60', selected === p.lcsc ? 'bg-indigo-500/12' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]')}
          >
            <td className="px-3 py-1.5">
              <ClassBadge value={p.partClass} />
            </td>
            <td className="px-2 py-1.5 font-mono text-[11px] text-muted">{p.lcsc}</td>
            <td className="truncate px-2 py-1.5 font-medium" title={`${p.mpn} · ${p.manufacturer}`}>
              {p.mpn}
              <span className="ml-1.5 font-normal text-muted">{p.manufacturer}</span>
            </td>
            <td className="truncate px-2 py-1.5" title={p.package}>
              {p.package}
            </td>
            <td className="truncate px-2 py-1.5 text-muted" title={p.description}>
              {p.description}
            </td>
            <td className={cx('tabular px-2 py-1.5 text-right', p.stock === 0 && 'text-rose-500')}>{formatStock(p.stock)}</td>
            <td className="tabular px-2 py-1.5 text-right">{formatPrice(p.prices[0]?.price)}</td>
            <td className="px-1 py-1">
              <button
                aria-label={`Place ${p.mpn}`}
                title="Place on schematic"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlace(p.lcsc);
                }}
                className="invisible rounded-md p-1 text-indigo-500 hover:bg-indigo-500/15 group-hover:visible"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartDetailPane({
  part,
  replaceTarget,
  onReplaced,
}: {
  part: PartSummary | null;
  replaceTarget: { id: string; designator: string } | null;
  onReplaced: () => void;
}) {
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'symbol' | 'footprint' | 'photo'>('symbol');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!part) return;
    let live = true;
    setDetail(null);
    setLoading(true);
    fetchPartDetail(part.lcsc)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [part]);

  const priceRows = useMemo(() => part?.prices.slice(0, 6) ?? [], [part]);

  if (!part) return <aside className="flex items-center justify-center p-4 text-xs text-muted">Select a part to see details</aside>;

  const device = detail?.device;
  return (
    <aside className="flex min-h-0 flex-col overflow-auto">
      <div className="border-b border-line p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" title={part.mpn}>
              {part.mpn}
            </div>
            <div className="truncate text-[11px] text-muted">{part.manufacturer}</div>
          </div>
          <ClassBadge value={part.partClass} />
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(part.lcsc);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] hover:border-indigo-400"
            title="Copy LCSC part number"
          >
            {part.lcsc}
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 text-muted" />}
          </button>
          {part.datasheet && (
            <a href={part.datasheet} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] hover:border-indigo-400">
              <FileText className="h-3 w-3" /> Datasheet
            </a>
          )}
          <a href={part.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] hover:border-indigo-400">
            <ExternalLink className="h-3 w-3" /> JLCPCB
          </a>
        </div>
      </div>

      <div className="border-b border-line">
        <div className="flex gap-1 px-2 pt-1.5 text-[11px]">
          {(['symbol', 'footprint', 'photo'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx('rounded-md px-2 py-0.5 capitalize', tab === t ? 'bg-indigo-500/15 text-indigo-500 dark:text-indigo-300' : 'text-muted hover:text-[var(--text)]')}>
              {t}
            </button>
          ))}
        </div>
        <div className="h-44 p-2" style={{ background: tab === 'footprint' ? '#0d1016' : 'var(--canvas-bg)' }}>
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted" />
            </div>
          ) : tab === 'symbol' ? (
            <SymbolPreview dataStr={device?.symbol?.dataStr} title={device?.attributes['Value'] || part.mpn} prefix={designatorPrefix(device?.attributes['Designator'])} />
          ) : tab === 'footprint' ? (
            <FootprintPreview dataStr={device?.footprint?.dataStr} />
          ) : part.image || device?.image ? (
            <img src={part.image ?? device?.image ?? ''} alt={part.mpn} className="h-full w-full object-contain" referrerPolicy="no-referrer" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted">No photo</div>
          )}
        </div>
      </div>

      <div className="flex gap-2 border-b border-line p-3">
        <button onClick={() => beginPlacePart(part.lcsc)} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-indigo-600 text-[13px] font-medium text-white hover:bg-indigo-500">
          <Plus className="h-4 w-4" /> Place
        </button>
        {replaceTarget && (
          <button
            onClick={async () => {
              await replacePart(replaceTarget.id, part.lcsc);
              useEditor.getState().notify(`Replaced ${replaceTarget.designator} with ${part.mpn}`);
              onReplaced();
            }}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-3 text-[13px] hover:bg-black/5 dark:hover:bg-white/5"
            title={`Swap the part used by ${replaceTarget.designator}`}
          >
            <Replace className="h-4 w-4" /> Replace {replaceTarget.designator}
          </button>
        )}
      </div>

      <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1 border-b border-line p-3 text-[11px]">
        <dt className="text-muted">Package</dt>
        <dd className="truncate">{part.package || '—'}</dd>
        <dt className="text-muted">Footprint</dt>
        <dd className="truncate" title={device?.footprint?.title}>
          {device?.footprint?.title ?? (loading ? '…' : '—')}
        </dd>
        <dt className="text-muted">Stock</dt>
        <dd className={cx('tabular', part.stock === 0 && 'text-rose-500')}>{part.stock.toLocaleString()}</dd>
        <dt className="text-muted">Category</dt>
        <dd className="truncate">{[part.category, part.subcategory].filter(Boolean).join(' › ')}</dd>
        <dt className="text-muted">Assembly</dt>
        <dd className={CLASS_STYLES[part.partClass].text}>{CLASS_HINT[part.partClass].split(': ')[1]}</dd>
      </dl>

      {priceRows.length > 0 && (
        <div className="border-b border-line p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Price (USD)</div>
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            {priceRows.map((p) => (
              <div key={p.qty} className="rounded-md bg-panel-2 px-1.5 py-1">
                <div className="text-muted">{p.qty}+</div>
                <div className="tabular font-medium">{formatPrice(priceAt(part.prices, p.qty))}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {part.attributes.length > 0 && (
        <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 p-3 text-[11px]">
          {part.attributes.map((a) => (
            <div key={a.name} className="contents">
              <dt className="truncate text-muted" title={a.name}>
                {a.name}
              </dt>
              <dd className="truncate" title={a.value}>
                {a.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-auto px-3 pb-3 pt-1 text-[10px] leading-snug text-muted">{LIBRARY_ATTRIBUTION}</p>
    </aside>
  );
}
