import { useEffect, useMemo, useState } from 'react';
import { Box, Cpu, Plus, Trash2, X } from 'lucide-react';
import { useEditor, type PartsEditorState } from '../../store/editor';
import {
  deleteLibraryItem,
  deletePart,
  partWarnings,
  placingForPart,
  saveFootprint,
  savePart,
  saveSymbol,
  setFootprint,
  setSymbol,
  userFootprints,
  userKey,
  userSymbols,
} from '../../lib/library';
import { footprintGeom } from '../../lib/pcb/board';
import { symbolFor } from '../../lib/schematic/symbols';
import type { CustomPart } from '../../lib/schematic/types';
import { Button, Field, cx, inputClass } from '../ui';
import { FootprintEditor, FootprintPicture } from './FootprintEditor';
import { SymbolPreview } from './Previews';
import { SymbolEditor } from './SymbolEditor';

const st = () => useEditor.getState();
const TABS = [
  { tab: 'part', label: 'Parts' },
  { tab: 'symbol', label: 'Symbols' },
  { tab: 'footprint', label: 'Footprints' },
] as const;

/** Symbols, footprints and parts made in the project, with their editors. */
export function PartsEditor() {
  const state = useEditor((s) => s.partsEditor);
  if (!state) return null;
  return <PartsEditorSheet state={state} />;
}

function PartsEditorSheet({ state }: { state: PartsEditorState }) {
  const project = useEditor((s) => s.project);
  const close = () => st().setPartsEditor(null);
  const open = (next: Partial<PartsEditorState>) => st().setPartsEditor({ tab: state.tab, ...next });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items =
    state.tab === 'part'
      ? (project.parts ?? []).map((p) => ({ key: p.id, title: p.name, sub: p.value !== p.name ? p.value : (p.attrs['Manufacturer Part'] ?? '') }))
      : state.tab === 'symbol'
        ? userSymbols(project).map(([key, s]) => ({ key, title: s.title, sub: `${symbolFor(project, key).units.flatMap((u) => u.pins).length} pins` }))
        : userFootprints(project).map(([key, f]) => ({ key, title: f.title, sub: `${f.geom?.pads.length ?? 0} pads` }));
  const component = state.componentId ? project.components.find((c) => c.id === state.componentId) : undefined;
  // The editor starts afresh whenever another item (or a new one) is opened.
  const editorKey = `${state.tab}|${state.key ?? 'new'}|${state.draft?.name ?? ''}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Parts editor" className="flex h-[min(760px,100%)] w-[min(1180px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/40">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Cpu className="h-4 w-4 text-indigo-500" /> Parts editor
          </div>
          <div className="flex gap-0.5 rounded-lg bg-panel-2 p-0.5 text-xs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.tab}
                role="tab"
                aria-selected={state.tab === t.tab}
                onClick={() => st().setPartsEditor({ tab: t.tab })}
                className={cx('rounded-md px-2.5 py-1', state.tab === t.tab ? 'bg-panel font-medium shadow-sm' : 'text-muted hover:text-[var(--text)]')}
              >
                {t.label}
              </button>
            ))}
          </div>
          {component && <span className="text-xs text-muted">from {component.designator}</span>}
          <div className="flex-1" />
          <button aria-label="Close" onClick={close} className="rounded p-1 text-muted hover:text-[var(--text)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-52 shrink-0 flex-col border-r border-line">
            <div className="p-2">
              <Button size="sm" className="w-full" onClick={() => open({ key: undefined, draft: undefined, componentId: undefined })}>
                <Plus className="h-3.5 w-3.5" /> New {state.tab === 'part' ? 'part' : state.tab}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {items.length === 0 && <p className="px-1 py-2 text-[11px] text-muted">None in this project yet.</p>}
              {items.map((it) => (
                <button
                  key={it.key}
                  onClick={() => open({ key: it.key, draft: undefined, componentId: undefined })}
                  className={cx('block w-full rounded-md px-2 py-1.5 text-left', state.key === it.key ? 'bg-indigo-500/12' : 'hover:bg-black/5 dark:hover:bg-white/5')}
                >
                  <div className="truncate text-xs font-medium">{it.title}</div>
                  {it.sub && <div className="truncate text-[11px] text-muted">{it.sub}</div>}
                </button>
              ))}
            </div>
          </div>
          {state.tab === 'part' && <PartForm key={editorKey} id={state.key} />}
          {state.tab === 'symbol' && <SymbolTab key={editorKey} state={state} />}
          {state.tab === 'footprint' && <FootprintTab key={editorKey} state={state} />}
        </div>
      </div>
    </div>
  );
}

/** Offers to give the placed part it was opened from (and its look-alikes) what was just saved. */
function UseFor({ state, savedKey, kind }: { state: PartsEditorState; savedKey: string | null; kind: 'symbol' | 'footprint' }) {
  const project = useEditor((s) => s.project);
  const c = state.componentId ? project.components.find((x) => x.id === state.componentId) : undefined;
  if (!c || !savedKey) return null;
  const same = project.components.filter((x) => (kind === 'symbol' ? x.symbolKey === c.symbolKey : c.lcsc ? x.lcsc === c.lcsc : x.footprint === c.footprint && !!c.footprint));
  const apply = (ids: string[]) => {
    const joined = kind === 'symbol' ? setSymbol(ids, savedKey) : (setFootprint(ids, savedKey), []);
    const who = ids.length === 1 ? `${c.designator} now uses` : `${ids.length} parts now use`;
    if (joined.length) st().notify(`${who} it, but this joined ${joined.join('; ')}: check the wiring`, 'error');
    else st().notify(`${who} it${kind === 'footprint' ? '; update the PCB to see it' : ''}`);
  };
  const using = (kind === 'symbol' ? c.symbolKey : c.footprint) === savedKey;
  if (using && same.length <= 1) return <p className="text-[11px] text-muted">{c.designator} uses this {kind}.</p>;
  return (
    <div className="space-y-1.5">
      {!using && (
        <Button size="sm" className="w-full" onClick={() => apply([c.id])}>
          Use for {c.designator}
        </Button>
      )}
      {same.length > 1 && (
        <Button size="sm" className="w-full" onClick={() => apply(same.map((x) => x.id))}>
          Use for all {same.length} parts like {c.designator}
        </Button>
      )}
    </div>
  );
}

function SymbolTab({ state }: { state: PartsEditorState }) {
  const project = useEditor((s) => s.project);
  const stored = state.key ? project.symbols[state.key] : undefined;
  const [saved, setSaved] = useState<string | null>(stored ? state.key! : null);
  const initial = state.draft?.symbol ?? (state.key ? structuredClone(symbolFor(project, state.key)) : null);
  return (
    <SymbolEditor
      initialName={state.draft?.name ?? stored?.title ?? ''}
      initial={initial}
      onSave={(name, def) => {
        try {
          const key = state.key && stored?.title === name ? state.key : userKey(name);
          const replacing = !!project.symbols[key] && key !== state.key;
          if (replacing && !confirm(`Replace the symbol ${project.symbols[key].title}?`)) return;
          const { joined } = saveSymbol(name, def, key);
          setSaved(key);
          if (joined.length) st().notify(`Saved, but redrawing placed parts joined ${joined.join('; ')}: check their wiring`, 'error');
          else st().notify(`Saved symbol ${name}`);
          if (!state.componentId) st().setPartsEditor({ ...state, key, draft: undefined });
        } catch (err) {
          st().notify((err as Error).message, 'error');
        }
      }}
      footer={
        <>
          <UseFor state={state} savedKey={saved} kind="symbol" />
          {stored && <DeleteButton kind="symbol" itemKey={state.key!} />}
        </>
      }
    />
  );
}

function FootprintTab({ state }: { state: PartsEditorState }) {
  const project = useEditor((s) => s.project);
  const stored = state.key ? project.footprints?.[state.key] : undefined;
  const [saved, setSaved] = useState<string | null>(stored ? state.key! : null);
  const initial = state.draft?.footprint ?? (stored ? structuredClone(footprintGeom(stored)) : null);
  return (
    <FootprintEditor
      initialName={state.draft?.name ?? stored?.title ?? ''}
      initial={initial}
      onSave={(name, geom) => {
        try {
          const key = state.key && stored?.title === name ? state.key : userKey(name);
          const replacing = !!project.footprints?.[key] && key !== state.key;
          if (replacing && !confirm(`Replace the footprint ${project.footprints![key].title}?`)) return;
          saveFootprint(name, geom, key);
          setSaved(key);
          st().notify(`Saved footprint ${name}`);
          if (!state.componentId) st().setPartsEditor({ ...state, key, draft: undefined });
        } catch (err) {
          st().notify((err as Error).message, 'error');
        }
      }}
      footer={
        <>
          <UseFor state={state} savedKey={saved} kind="footprint" />
          {stored && <DeleteButton kind="footprint" itemKey={state.key!} />}
        </>
      }
    />
  );
}

function DeleteButton({ kind, itemKey }: { kind: 'symbol' | 'footprint'; itemKey: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="w-full text-rose-600 dark:text-rose-400"
      onClick={() => {
        try {
          deleteLibraryItem(kind, itemKey);
          st().setPartsEditor({ tab: kind });
        } catch (err) {
          st().notify((err as Error).message, 'error');
        }
      }}
    >
      <Trash2 className="h-3.5 w-3.5" /> Delete {kind}
    </Button>
  );
}

const FIELDS = [
  ['Description', 'Description'],
  ['Manufacturer', 'Manufacturer'],
  ['Manufacturer Part', 'MPN'],
  ['Datasheet', 'Datasheet'],
] as const;

function PartForm({ id }: { id?: string }) {
  const project = useEditor((s) => s.project);
  const existing = (project.parts ?? []).find((p) => p.id === id);
  const symbols = userSymbols(project);
  const footprints = userFootprints(project);
  const [part, setPart] = useState<Omit<CustomPart, 'id'> & { id?: string }>(
    () => existing ?? { name: '', symbolKey: symbols[0]?.[0] ?? '', footprintKey: footprints[0]?.[0] ?? null, prefix: '', value: '', attrs: {} },
  );
  const set = (patch: Partial<typeof part>) => setPart((p) => ({ ...p, ...patch }));
  const symbol = part.symbolKey && project.symbols[part.symbolKey] ? symbolFor(project, part.symbolKey) : null;
  const footprint = part.footprintKey ? footprintGeom(project.footprints?.[part.footprintKey]) : null;
  const warnings = useMemo(() => (symbol ? partWarnings(part, project) : []), [symbol, part, project]);

  const save = () => {
    try {
      const saved = savePart({ ...part, prefix: part.prefix || symbol?.prefix || 'U', value: part.value || part.name });
      st().setPartsEditor({ tab: 'part', key: saved.id });
      st().notify(`Saved part ${saved.name}`);
      return saved;
    } catch (err) {
      st().notify((err as Error).message, 'error');
      return null;
    }
  };

  if (!symbols.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Box className="h-8 w-8 text-muted" />
        <p className="max-w-sm text-xs text-muted">A part pairs a symbol with a footprint. Make a symbol first (from a pin list or by drawing it), then a footprint from its package.</p>
        <Button variant="primary" size="sm" onClick={() => st().setPartsEditor({ tab: 'symbol' })}>
          New symbol
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 w-96 shrink-0 space-y-2 overflow-y-auto border-r border-line p-4">
        <Field label="Name">
          <input aria-label="Part name" className={inputClass} value={part.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. TMP117" />
        </Field>
        <Field label="Symbol">
          <select aria-label="Symbol" className={inputClass} value={part.symbolKey} onChange={(e) => set({ symbolKey: e.target.value })}>
            {symbols.map(([key, s]) => (
              <option key={key} value={key}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Footprint">
          <select aria-label="Footprint" className={inputClass} value={part.footprintKey ?? ''} onChange={(e) => set({ footprintKey: e.target.value || null })}>
            <option value="">None yet</option>
            {footprints.map(([key, f]) => (
              <option key={key} value={key}>
                {f.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prefix">
          <input aria-label="Prefix" className={inputClass} value={part.prefix} placeholder={symbol?.prefix ?? 'U'} onChange={(e) => set({ prefix: e.target.value })} />
        </Field>
        <Field label="Value">
          <input aria-label="Value" className={inputClass} value={part.value} placeholder={part.name || 'Shown on the schematic'} onChange={(e) => set({ value: e.target.value })} />
        </Field>
        <Field label="LCSC">
          <input aria-label="LCSC number" className={inputClass} value={part.lcsc ?? ''} placeholder="C… when JLCPCB stocks it" onChange={(e) => set({ lcsc: e.target.value })} />
        </Field>
        {FIELDS.map(([key, label]) => (
          <Field key={key} label={label}>
            <input aria-label={label} className={inputClass} value={part.attrs[key] ?? ''} onChange={(e) => set({ attrs: { ...part.attrs, [key]: e.target.value } })} />
          </Field>
        ))}
        {warnings.length > 0 && (
          <ul className="space-y-1 rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <div className="flex gap-2 pt-2">
          <Button variant="primary" className="flex-1" disabled={!part.name.trim() || !part.symbolKey} onClick={save}>
            Save part
          </Button>
          <Button
            className="flex-1"
            disabled={!part.name.trim() || !part.symbolKey}
            onClick={() => {
              const saved = save();
              if (!saved) return;
              st().setPartsEditor(null);
              if (st().mode !== 'schematic') st().setMode('schematic');
              st().startPlacing(placingForPart(saved, st().project));
            }}
          >
            Save and place
          </Button>
        </div>
        {existing && (
          <Button size="sm" variant="ghost" className="w-full text-rose-600 dark:text-rose-400" onClick={() => (deletePart(existing.id), st().setPartsEditor({ tab: 'part' }))}>
            <Trash2 className="h-3.5 w-3.5" /> Delete part
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 grid-rows-2 gap-px bg-[var(--line)]">
          <div className="min-h-0 bg-[var(--canvas-bg)] p-3">{symbol && <SymbolPreview symbol={symbol} title={part.value || part.name} prefix={part.prefix || symbol.prefix} />}</div>
          <div className="min-h-0 bg-[var(--pcb-board)]">
            {footprint ? <FootprintPicture geom={footprint} className="h-full w-full" /> : <div className="flex h-full items-center justify-center text-xs text-white/60">No footprint</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
