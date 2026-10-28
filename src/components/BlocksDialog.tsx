import { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Download, Trash2, Upload, X } from 'lucide-react';
import { useEditor } from '../store/editor';
import { BLOCKS, insertBlock, type CircuitBlock } from '../lib/blocks';
import { fitView } from '../lib/editing';
import { freeGroupName, groupItems } from '../lib/grouping';
import { blockNets, deleteUserBlock, exportUserBlocks, importUserBlocks, insertUserBlock, loadUserBlocks, saveUserBlock, type UserBlock } from '../lib/userBlocks';
import { PASSIVES } from '../shared/passives';
import { Button, ClassBadge, cx, inputClass } from './ui';

/** Circuit block picker: choose a built-in or saved block, set its nets and values, insert it. */
export function BlocksDialog() {
  const open = useEditor((s) => s.blocksOpen);
  if (!open) return null;
  return <BlocksSheet />;
}

function Sheet({ title, onClose, width, children }: { title: string; onClose: () => void; width: string; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className={cx('flex max-h-full max-w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/40', width)}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Blocks className="h-4 w-4 text-indigo-500" /> {title}
          </div>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 text-muted hover:text-[var(--text)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function BlocksSheet() {
  const close = () => useEditor.getState().setBlocksOpen(false);
  const [mine, setMine] = useState<UserBlock[]>(loadUserBlocks);
  const [id, setId] = useState(BLOCKS[0].id);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Frame the inserted parts as a group named after the block. */
  const [frame, setFrame] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const builtIn = BLOCKS.find((b) => b.id === id);
  const saved = mine.find((b) => b.id === id);
  const params = values[id] ?? {};
  const setParam = (key: string, value: string) => setValues((v) => ({ ...v, [id]: { ...params, [key]: value } }));
  const title = builtIn?.title ?? saved?.title ?? '';

  const done = (ids: string[], message: string) => {
    const s = useEditor.getState();
    s.setSelection(ids);
    fitView(ids);
    s.notify(message);
    close();
  };
  const insert = async () => {
    setBusy(true);
    setError(null);
    try {
      if (builtIn) {
        const r = await insertBlock(builtIn.id, params, undefined, frame ? builtIn.title : undefined);
        done(r.group ? [r.group.id] : r.ids, `Inserted ${builtIn.title}: ${Object.values(r.parts).join(', ')} · drag it into place`);
      } else if (saved) {
        const ids = insertUserBlock(saved, params);
        const s = useEditor.getState();
        const mark = s.past[s.past.length - 1];
        const g = frame ? groupItems(ids, freeGroupName(saved.title)) : undefined;
        if (g && mark) s.squashHistory(mark);
        done(g ? [g.id] : ids, `Inserted ${saved.title} · drag it into place`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = (b: UserBlock) => {
    if (!confirm(`Delete the block "${b.title}"?`)) return;
    deleteUserBlock(b.id);
    setMine(loadUserBlocks());
    setId(BLOCKS[0].id);
  };
  const pick = (next: string) => {
    setId(next);
    setError(null);
  };

  const item = (key: string, label: string) => (
    <li key={key}>
      <button
        role="option"
        aria-selected={key === id}
        onClick={() => pick(key)}
        className={cx('w-full truncate rounded-md px-2.5 py-1.5 text-left', key === id ? 'bg-indigo-500/12 font-medium' : 'hover:bg-black/5 dark:hover:bg-white/5')}
      >
        {label}
      </button>
    </li>
  );

  return (
    <Sheet title="Circuit blocks" onClose={close} width="h-[560px] w-[760px]">
      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 shrink-0 flex-col border-r border-line">
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5 text-[13px]" role="listbox" aria-label="Blocks">
            <li className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Built in</li>
            {BLOCKS.map((b) => item(b.id, b.title))}
            <li className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">My blocks</li>
            {mine.length === 0 && <li className="px-2.5 py-1 text-xs leading-relaxed text-muted">Select parts and choose Save as block (Edit menu or right-click).</li>}
            {mine.map((b) => item(b.id, b.title))}
          </ul>
          <div className="flex gap-1 border-t border-line p-1.5">
            <Button size="sm" variant="ghost" className="flex-1" onClick={() => fileInput.current?.click()} data-tip="Add blocks from an exported file">
              <Upload className="h-3.5 w-3.5" /> Import
            </Button>
            <Button size="sm" variant="ghost" className="flex-1" disabled={mine.length === 0} onClick={exportUserBlocks} data-tip="Download my blocks as a file">
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                importUserBlocks(f)
                  .then((n) => {
                    setMine(loadUserBlocks());
                    useEditor.getState().notify(`Imported ${n} block${n === 1 ? '' : 's'}`);
                  })
                  .catch((err) => setError((err as Error).message));
              }}
            />
          </div>
        </div>
        <form
          className="flex min-w-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void insert();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[13px]">
            {builtIn && <BuiltInDetails block={builtIn} params={params} setParam={setParam} />}
            {saved && <SavedDetails block={saved} params={params} setParam={setParam} onDelete={() => remove(saved)} />}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-4 py-3">
            <div className={cx('min-w-0 flex-1 text-xs', error ? 'text-rose-500' : 'text-muted')}>
              {error ?? 'Goes to the right of the drawing, selected, as one undo step; drag it into place.'}
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted" data-tip={`A named frame around the parts, which moves as one; rename it on the canvas`}>
              <input type="checkbox" checked={frame} onChange={(e) => setFrame(e.target.checked)} />
              Frame as “{title}”
            </label>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Inserting…' : 'Insert block'}
            </Button>
          </div>
        </form>
      </div>
    </Sheet>
  );
}

function ParamFields({ fields, params, setParam }: { fields: { key: string; label: string; default: string }[]; params: Record<string, string>; setParam: (k: string, v: string) => void }) {
  if (fields.length === 0) return null;
  return (
    <div className="grid grid-cols-[minmax(110px,auto)_1fr] items-center gap-x-3 gap-y-1.5">
      {fields.map((p) => (
        <label key={p.key} className="contents">
          <span className="text-xs text-muted">{p.label}</span>
          <input aria-label={p.label} className={cx(inputClass, 'font-mono')} value={params[p.key] ?? p.default} spellCheck={false} onChange={(e) => setParam(p.key, e.target.value)} />
        </label>
      ))}
    </div>
  );
}

function BuiltInDetails({ block, params, setParam }: { block: CircuitBlock; params: Record<string, string>; setParam: (k: string, v: string) => void }) {
  return (
    <>
      <div>
        <div className="font-semibold">{block.title}</div>
        <p className="mt-1 leading-relaxed text-muted">{block.description}</p>
      </div>
      <ParamFields fields={block.params} params={params} setParam={setParam} />
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
    </>
  );
}

function SavedDetails({ block, params, setParam, onDelete }: { block: UserBlock; params: Record<string, string>; setParam: (k: string, v: string) => void; onDelete: () => void }) {
  const nets = useMemo(() => blockNets(block), [block]);
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold">{block.title}</div>
          <p className="mt-1 leading-relaxed text-muted">{block.description || `Saved ${new Date(block.savedAt).toLocaleDateString()}.`}</p>
        </div>
        <Button size="sm" variant="ghost" type="button" onClick={onDelete} data-tip="Delete this block">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {nets.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Nets</div>
          <ParamFields fields={nets.map((n) => ({ key: n, label: n, default: n }))} params={params} setParam={setParam} />
        </div>
      )}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Parts · {block.components.length}</div>
        <div className="divide-y divide-[var(--line)] rounded-lg border border-line">
          {block.components.map((c) => (
            <div key={c.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
              <span className="w-10 shrink-0 font-medium">{c.designator}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{c.value}</span>
              {c.lcsc && <span className="font-mono text-muted">{c.lcsc}</span>}
              <ClassBadge value={c.partClass} compact />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Names the selection and saves it as one of the user's blocks. */
export function SaveBlockDialog() {
  const open = useEditor((s) => s.saveBlockOpen);
  if (!open) return null;
  return <SaveBlockSheet />;
}

function SaveBlockSheet() {
  const close = () => useEditor.getState().setSaveBlockOpen(false);
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = useMemo(() => new Set(selection), [selection]);
  const parts = project.components.filter((c) => ids.has(c.id));
  const nets = blockNets({ ports: project.ports.filter((p) => ids.has(p.id)) });
  const save = () => {
    try {
      const b = saveUserBlock(title, description, ids, project);
      useEditor.getState().notify(`Saved "${b.title}" · insert it from Circuit blocks (B)`);
      close();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Sheet title="Save as block" onClose={close} width="w-[440px]">
      <form
        className="space-y-3 p-4 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="block space-y-1">
          <span className="text-xs text-muted">Name</span>
          <input autoFocus className={inputClass} value={title} placeholder="e.g. RS-485 transceiver" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Description (optional)</span>
          <textarea className={cx(inputClass, 'h-16 resize-none py-1.5')} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <p className="text-xs text-muted">
          {parts.length} part{parts.length === 1 ? '' : 's'} ({parts.map((c) => c.designator).join(', ') || 'none selected'})
          {nets.length > 0 && <> · nets {nets.join(', ')}, renameable when inserted</>}. Saved in this browser; use Export to share.
        </p>
        {error && <p className="text-xs text-rose-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={parts.length === 0}>
            Save block
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
