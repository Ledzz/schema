import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { addSheet, deleteSheet, renameSheet } from '../../lib/actions';
import { openSheet } from '../../lib/editing';
import { itemsOnSheet, sheetsOf } from '../../lib/schematic/sheets';
import { cx } from '../ui';

/** Tabs for the schematic's sheets along the bottom of the canvas. */
export function SheetTabs() {
  const project = useEditor((s) => s.project);
  const current = useEditor((s) => s.currentSheet);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const sheets = sheetsOf(project);
  const s = useEditor.getState;
  const run = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      s().notify((err as Error).message, 'error');
    }
  };
  const show = (id: string) => {
    if (id !== current) openSheet(id);
  };
  const commitName = (id: string) => {
    setEditing(null);
    const sheet = sheets.find((x) => x.id === id);
    if (sheet && name.trim() && name.trim() !== sheet.name) run(() => renameSheet(id, name));
  };
  return (
    <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-24px)] items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-panel/95 p-0.5 text-xs shadow-sm backdrop-blur" role="tablist" aria-label="Sheets">
      {sheets.map((sheet) => {
        const active = sheet.id === current;
        if (editing === sheet.id) {
          return (
            <input
              key={sheet.id}
              autoFocus
              aria-label="Sheet name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => commitName(sheet.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName(sheet.id);
                if (e.key === 'Escape') setEditing(null);
              }}
              className="h-6 w-28 rounded-md border border-indigo-500 bg-panel px-1.5 outline-none"
            />
          );
        }
        return (
          <div key={sheet.id} className={cx('group flex h-6 items-center rounded-md', active ? 'bg-indigo-500/12 font-medium text-[var(--text)]' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5')}>
            <button
              role="tab"
              aria-selected={active}
              onClick={() => show(sheet.id)}
              onDoubleClick={() => {
                setName(sheet.name);
                setEditing(sheet.id);
              }}
              data-tip="Double-click to rename"
              data-tip-side="top"
              className="h-6 whitespace-nowrap px-2"
            >
              {sheet.name}
            </button>
            {active && sheets.length > 1 && (
              <button
                aria-label={`Delete ${sheet.name}`}
                data-tip="Delete this sheet"
                data-tip-side="top"
                onClick={() => {
                  const count = itemsOnSheet(project, sheet.id).length;
                  if (count && !confirm(`Delete ${sheet.name} and the ${count} item${count === 1 ? '' : 's'} on it?`)) return;
                  run(() => {
                    deleteSheet(sheet.id);
                    openSheet(s().currentSheet);
                  });
                }}
                className="mr-0.5 rounded p-0.5 text-muted opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
      <button aria-label="Add a sheet" data-tip="Add a sheet" data-tip-side="top" onClick={() => run(() => addSheet())} className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-black/5 dark:hover:bg-white/5">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
