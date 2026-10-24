import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { PASSIVES, parsePassiveValue, type PassiveKind } from '../../shared/passives';
import type { PartSummary } from '../../shared/parts';
import { fetchMatch, type PassiveMatch } from '../../lib/passives';
import { ClassBadge, cx, formatPrice, formatStock } from '../ui';

export function usePassiveMatch(kind: PassiveKind, value: string, size: string) {
  const [state, setState] = useState<{ loading: boolean; match: PassiveMatch | null; error: string | null }>({ loading: true, match: null, error: null });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchMatch(kind, value, size)
      .then((match) => live && setState({ loading: false, match, error: match.error ?? null }))
      .catch((err) => live && setState({ loading: false, match: null, error: (err as Error).message }));
    return () => {
      live = false;
    };
  }, [kind, value, size]);
  return state;
}

interface Props {
  kind: PassiveKind;
  value: string;
  size: string;
  lcsc?: string;
  onChange: (patch: { value?: string; size?: string }) => void;
  onPick: (part: PartSummary) => void;
  /** Horizontal toolbar layout (placement bar) instead of a stacked panel. */
  inline?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
}

export function PassiveEditor({ kind, value, size, lcsc, onChange, onPick, inline, autoFocus, onDone }: Props) {
  const spec = PASSIVES[kind];
  const [text, setText] = useState(value);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { loading, match, error } = usePassiveMatch(kind, value, size);
  const parsed = parsePassiveValue(kind, text);
  const invalid = text.trim() !== '' && !parsed;

  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [autoFocus]);

  const commitText = () => {
    if (!invalid && text.trim() && text !== value) onChange({ value: text });
  };
  const chosen = match?.candidates.find((p) => p.lcsc === lcsc) ?? (lcsc ? null : match?.candidates[0]);

  const valueInput = (
    <div className="relative">
      <input
        ref={inputRef}
        value={text}
        list={`passive-values-${kind}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            commitText();
            onDone?.();
          } else if (e.key === 'Escape') {
            setText(value);
            onDone?.();
          }
        }}
        placeholder={spec.placeholder}
        aria-label={`${spec.label} value`}
        aria-invalid={invalid}
        spellCheck={false}
        className={cx(
          'h-7 rounded-md border bg-panel-2 px-2 font-mono text-xs outline-none focus:ring-2',
          inline ? 'w-28' : 'w-full',
          invalid ? 'border-rose-500 focus:ring-rose-500/20' : 'border-line focus:border-indigo-500 focus:ring-indigo-500/20',
        )}
      />
      <datalist id={`passive-values-${kind}`}>
        {spec.quickValues.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </div>
  );

  const sizes = (
    <div className={cx('flex gap-0.5 rounded-md border border-line bg-panel-2 p-0.5', inline ? 'flex-nowrap' : 'flex-wrap')} role="group" aria-label="Size">
      {spec.sizes.map((s) => (
        <button
          key={s.label}
          onClick={() => onChange({ size: s.label })}
          aria-pressed={size === s.label}
          className={cx('h-6 rounded px-1.5 font-mono text-[11px]', size === s.label ? 'bg-indigo-500 text-white' : 'text-muted hover:text-[var(--text)]')}
        >
          {s.label}
        </button>
      ))}
    </div>
  );

  const status = loading ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted">
      <Loader2 className="h-3 w-3 animate-spin" /> Matching…
    </span>
  ) : error ? (
    <span className="text-[11px] text-rose-500">{error}</span>
  ) : chosen ? (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px]">
      <ClassBadge value={chosen.partClass} />
      <span className="font-mono text-muted">{chosen.lcsc}</span>
      {!inline && <span className="truncate">{chosen.mpn}</span>}
      <span className="tabular text-muted">{formatStock(chosen.stock)}</span>
    </span>
  ) : (
    <span className="text-[11px] text-amber-500">No in-stock JLCPCB part for {value} {size}</span>
  );

  if (inline) {
    return (
      <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
        <span className="text-xs font-semibold">{spec.label}</span>
        {valueInput}
        {sizes}
        {status}
      </div>
    );
  }

  const candidates = match?.candidates ?? [];
  return (
    <div className="space-y-2 text-xs" onPointerDown={(e) => e.stopPropagation()}>
      <div className="space-y-1">
        <div className="text-[11px] text-muted">Value</div>
        {valueInput}
        <div className="flex flex-wrap gap-1">
          {spec.quickValues.slice(0, 10).map((v) => (
            <button
              key={v}
              onClick={() => onChange({ value: v })}
              className={cx('rounded border px-1.5 py-px font-mono text-[10px]', v === value ? 'border-indigo-500 bg-indigo-500/10' : 'border-line hover:border-indigo-400')}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-muted">Size</div>
        {sizes}
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-muted">JLCPCB part</div>
        <div className="min-h-5">{status}</div>
        {candidates.length > 1 && (
          <>
            <button onClick={() => setShowAll((s) => !s)} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-[var(--text)]">
              <ChevronDown className={cx('h-3 w-3 transition-transform', showAll && 'rotate-180')} /> {candidates.length} options
            </button>
            {showAll && (
              <ul className="max-h-48 divide-y divide-[var(--line)] overflow-auto rounded-md border border-line">
                {candidates.map((p) => (
                  <li key={p.lcsc}>
                    <button onClick={() => onPick(p)} className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left hover:bg-black/5 dark:hover:bg-white/5">
                      <ClassBadge value={p.partClass} compact />
                      <span className="w-16 shrink-0 font-mono text-[10px] text-muted">{p.lcsc}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px]" title={p.description}>
                        {p.mpn}
                      </span>
                      <span className="tabular shrink-0 text-[10px] text-muted">{formatStock(p.stock)}</span>
                      <span className="tabular w-12 shrink-0 text-right text-[10px]">{formatPrice(p.prices[0]?.price)}</span>
                      {chosen?.lcsc === p.lcsc && <Check className="h-3 w-3 shrink-0 text-emerald-500" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
