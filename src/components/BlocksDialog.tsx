import { useEffect, useState } from 'react';
import { Blocks, X } from 'lucide-react';
import { useEditor } from '../store/editor';
import { BLOCKS, insertBlock, type CircuitBlock } from '../lib/blocks';
import { fitView } from '../lib/editing';
import { PASSIVES } from '../shared/passives';
import { Button, ClassBadge, cx, inputClass } from './ui';

/** Circuit block picker: choose a block, set its nets and values, insert it. */
export function BlocksDialog() {
  const open = useEditor((s) => s.blocksOpen);
  if (!open) return null;
  return <BlocksSheet />;
}

function BlocksSheet() {
  const close = () => useEditor.getState().setBlocksOpen(false);
  const [id, setId] = useState(BLOCKS[0].id);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const block = BLOCKS.find((b) => b.id === id)!;
  const params = values[id] ?? {};

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const insert = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await insertBlock(block.id, params);
      const s = useEditor.getState();
      s.setSelection(r.ids);
      fitView(r.ids);
      s.notify(`Inserted ${block.title}: ${Object.values(r.parts).join(', ')} · drag it into place`);
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Circuit blocks" className="flex h-[560px] max-h-full w-[760px] max-w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Blocks className="h-4 w-4 text-indigo-500" /> Circuit blocks
          </div>
          <button aria-label="Close" onClick={close} className="rounded p-1 text-muted hover:text-[var(--text)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ul className="w-56 shrink-0 overflow-y-auto border-r border-line p-1.5 text-[13px]" role="listbox" aria-label="Blocks">
            {BLOCKS.map((b) => (
              <li key={b.id}>
                <button
                  role="option"
                  aria-selected={b.id === id}
                  onClick={() => {
                    setId(b.id);
                    setError(null);
                  }}
                  className={cx('w-full rounded-md px-2.5 py-1.5 text-left', b.id === id ? 'bg-indigo-500/12 font-medium' : 'hover:bg-black/5 dark:hover:bg-white/5')}
                >
                  {b.title}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex min-w-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void insert();
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[13px]">
              <div>
                <div className="font-semibold">{block.title}</div>
                <p className="mt-1 leading-relaxed text-muted">{block.description}</p>
              </div>
              <div className="grid grid-cols-[minmax(110px,auto)_1fr] items-center gap-x-3 gap-y-1.5">
                {block.params.map((p) => (
                  <label key={p.key} className="contents">
                    <span className="text-xs text-muted">{p.label}</span>
                    <input
                      aria-label={p.label}
                      className={cx(inputClass, 'font-mono')}
                      value={params[p.key] ?? p.default}
                      spellCheck={false}
                      onChange={(e) => setValues((v) => ({ ...v, [id]: { ...params, [p.key]: e.target.value } }))}
                    />
                  </label>
                ))}
              </div>
              <PartList block={block} />
            </div>
            <div className="flex items-center gap-3 border-t border-line px-4 py-3">
              <div className={cx('min-w-0 flex-1 text-xs', error ? 'text-rose-500' : 'text-muted')}>
                {error ?? 'Goes to the right of the drawing, selected, as one undo step; drag it into place.'}
              </div>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Inserting…' : 'Insert block'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function PartList({ block }: { block: CircuitBlock }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Parts · {block.parts.length}</div>
      <div className="divide-y divide-[var(--line)] rounded-lg border border-line">
        {block.parts.map((p) => (
          <div key={p.ref} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">{p.role}</span>
            {p.passive ? (
              <span className="text-muted" data-tip="Matched to the cheapest in-stock JLCPCB part when inserted">
                {PASSIVES[p.passive.kind].label} {p.passive.value.replace(/\{\w+\}/, '…')} · {p.passive.size ?? '0603'}
              </span>
            ) : (
              <>
                <span className="font-mono text-muted">{p.lcsc}</span>
                <ClassBadge value={p.partClass} compact />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
