import { useMemo, useState } from 'react';
import { Cpu, Search, Waypoints, X } from 'lucide-react';
import { useEditor } from '../store/editor';
import { connectivity } from '../lib/actions';
import { fitView } from '../lib/editing';
import { findItems, type FindResult } from '../lib/find';
import { fitPcbView } from '../lib/pcb/view';
import { cx } from './ui';

/** ⌘F: find a part or net and jump to it, in whichever editor is open. */
export function FindBox() {
  const open = useEditor((s) => s.findOpen);
  if (!open) return null;
  return <FindPanel />;
}

function FindPanel() {
  const project = useEditor((s) => s.project);
  const mode = useEditor((s) => s.mode);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const conn = useMemo(() => connectivity(project), [project]);
  const results = useMemo(() => findItems(project, conn, query), [project, conn, query]);
  const close = () => useEditor.getState().setFindOpen(false);

  const go = (r: FindResult) => {
    const s = useEditor.getState();
    if (mode === 'pcb') {
      if (r.kind === 'part') {
        s.setPcbSelection(r.ids);
        fitPcbView(undefined, r.ids);
      } else s.setPcbHighlightNet(r.net ?? null);
    } else if (r.kind === 'part') {
      s.setSelection(r.ids);
      fitView(r.ids);
    } else {
      s.setHighlightNet(r.net ?? null);
      const net = conn.nets.find((n) => n.name === r.net);
      const parts = project.components.filter((c) => net?.members.some((m) => m.componentId === c.id)).map((c) => c.id);
      fitView([...r.ids, ...parts]);
    }
    close();
  };

  return (
    <div className={cx('absolute left-1/2 z-30 w-[420px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-xl border border-line bg-panel shadow-xl shadow-black/20', mode === 'pcb' ? 'top-3' : 'top-16')}>
      <div className="flex items-center gap-2 px-3">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input
          autoFocus
          aria-label="Find a part or net"
          placeholder="Find a part or net — R12, 10k, STM32, C25804, SDA…"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            else if (e.key === 'Enter' && results[active]) go(results[active]);
            else return;
            e.preventDefault();
          }}
          // Results keep the focus here (mouse down is cancelled on them), so leaving means done.
          onBlur={() => setTimeout(close, 120)}
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
        <button aria-label="Close" onClick={close} className="rounded p-1 text-muted hover:text-[var(--text)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      {query.trim() && (
        <ul role="listbox" aria-label="Matches" className="max-h-80 overflow-y-auto border-t border-line p-1">
          {results.length === 0 && <li className="px-2.5 py-2 text-xs text-muted">Nothing matches “{query.trim()}”.</li>}
          {results.map((r, i) => (
            <li key={`${r.kind}:${r.label}`}>
              <button
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r)}
                onMouseEnter={() => setActive(i)}
                className={cx('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs', i === active && 'bg-indigo-500/10')}
              >
                {r.kind === 'part' ? <Cpu className="h-3.5 w-3.5 shrink-0 text-muted" /> : <Waypoints className="h-3.5 w-3.5 shrink-0 text-pink-500" />}
                <span className="shrink-0 font-medium">{r.label}</span>
                <span className="truncate text-muted">{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
