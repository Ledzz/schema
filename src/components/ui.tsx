import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { PART_CLASS_LABEL, type PartClass } from '../shared/parts';

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({ variant = 'outline', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-indigo-600 text-white hover:bg-indigo-500',
        variant === 'outline' && 'border border-line bg-panel hover:bg-black/5 dark:hover:bg-white/5',
        variant === 'ghost' && 'hover:bg-black/5 dark:hover:bg-white/8',
        variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-500',
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  shortcut,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; shortcut?: string; children: ReactNode }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        active ? 'bg-indigo-500/15 text-indigo-500 dark:text-indigo-300' : 'text-muted hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/8',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-panel-2 px-1 py-px font-mono text-[10px] leading-none text-muted">{children}</kbd>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cx('flex items-center gap-1 border-b border-line px-2', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px border-b-2 px-2 py-2 text-xs font-medium transition-colors',
            value === t.value ? 'border-indigo-500 text-[var(--text)]' : 'border-transparent text-muted hover:text-[var(--text)]',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const CLASS_STYLES: Record<PartClass, { dot: string; chip: string; text: string }> = {
  basic: { dot: 'bg-basic', chip: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300', text: 'text-emerald-600 dark:text-emerald-400' },
  preferred: { dot: 'bg-preferred', chip: 'bg-sky-500/12 text-sky-700 ring-sky-500/30 dark:text-sky-300', text: 'text-sky-600 dark:text-sky-400' },
  extended: { dot: 'bg-extended', chip: 'bg-amber-500/12 text-amber-700 ring-amber-500/30 dark:text-amber-300', text: 'text-amber-600 dark:text-amber-400' },
};

export const CLASS_HINT: Record<PartClass, string> = {
  basic: 'Basic part: always loaded on JLCPCB machines, no setup fee',
  preferred: 'Preferred (promotional) extended part: setup fee waived',
  extended: 'Extended part: $3 feeder setup fee per unique part',
};

export function ClassBadge({ value, compact }: { value: PartClass | null | undefined; compact?: boolean }) {
  if (!value) return <span className="text-muted">—</span>;
  const s = CLASS_STYLES[value];
  return (
    <span title={CLASS_HINT[value]} className={cx('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset', s.chip)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {compact ? PART_CLASS_LABEL[value][0] : PART_CLASS_LABEL[value]}
    </span>
  );
}

export interface MenuItem {
  label: string;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function MenuButton({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx('rounded-md px-2.5 py-1 text-[13px] transition-colors', open ? 'bg-black/5 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/8')}
      >
        {label}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-line bg-panel p-1 shadow-xl shadow-black/20">
          {items.map((item) => (
            <div key={item.label}>
              {item.separatorBefore && <div className="my-1 h-px bg-[var(--line)]" />}
              <button
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className="flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-indigo-500/10 disabled:opacity-40"
              >
                <span>{item.label}</span>
                {item.shortcut && <span className="font-mono text-[11px] text-muted">{item.shortcut}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[88px_1fr] items-center gap-2 text-xs">
      <span className="truncate text-muted">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'h-7 w-full min-w-0 rounded-md border border-line bg-panel-2 px-2 text-xs outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

export function formatStock(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString('en-US');
}

export function formatPrice(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString('en-US');
}
