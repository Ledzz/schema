import { useEffect, useMemo, useState } from 'react';
import { Bot, Box, ExternalLink, FlipHorizontal2, PenTool, Play, Plus, Replace, RotateCcw, Sparkles, Trash2, Waypoints } from 'lucide-react';
import { AssistantPanel } from './AssistantPanel';
import { useEditor } from '../../store/editor';
import { useWebMcp } from '../../store/webmcp';
import { connectivity, findNoFeeAlternative, nameNet, renameNet } from '../../lib/actions';
import { alignSelection, deleteSelection, fitView, mirrorSelection, rotateSelection } from '../../lib/editing';
import { ALIGN_ACTIONS } from '../align';
import { addDecoupling, planDecoupling, supplyPins, type PlannedCap } from '../../lib/decoupling';
import { editFootprintOf, editSymbolOf, setFootprint } from '../../lib/library';
import { fitGroup, partsInGroup, removeGroup, selectGroupContents, updateGroup } from '../../lib/grouping';
import { worldPins } from '../../lib/schematic/geometry';
import { GROUP_COLORS, GROUP_COLOR_NAMES } from '../../lib/schematic/groups';
import { symbolFor } from '../../lib/schematic/symbols';
import type { Component, NetPort, Rotation, SchematicGroup } from '../../lib/schematic/types';
import { TOOLS, runTool, type ToolDefinition } from '../../lib/webmcp';
import { CLASS_HINT, ClassBadge, Field, IconButton, Tabs, cx, formatPrice, formatStock, inputClass } from '../ui';
import { PassiveEditor } from '../passives/PassiveEditor';
import { PcbInspector } from '../pcb/PcbPanels';
import { assignPassive, pickPart } from '../../lib/passives';
import { PASSIVES } from '../../shared/passives';

export function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const setTab = useEditor((s) => s.setRightTab);
  const mode = useEditor((s) => s.mode);
  const status = useWebMcp((s) => s.status);
  return (
    <aside className="flex min-h-0 w-80 flex-col border-l border-line bg-panel" aria-label="Inspector">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'properties', label: 'Properties' },
          {
            value: 'assistant',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" /> Assistant
              </span>
            ),
          },
          {
            value: 'agent',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Bot className="h-3.5 w-3.5" /> Agent
                <span className={cx('h-1.5 w-1.5 rounded-full', status?.api ? 'bg-emerald-500' : 'bg-zinc-400')} />
              </span>
            ),
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">{tab === 'assistant' ? <AssistantPanel /> : tab === 'agent' ? <AgentPanel /> : mode === 'pcb' ? <PcbInspector /> : <Inspector />}</div>
    </aside>
  );
}

function Inspector() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  if (selection.length === 0) return <ProjectSummary />;
  if (selection.length > 1) {
    const selected = project.components.filter((c) => selection.includes(c.id));
    const alignable = selected.length + project.ports.filter((p) => selection.includes(p.id)).length;
    const kind = selected[0]?.generic?.kind;
    const samePassives = kind && selected.length === selection.length && selected.every((c) => c.generic?.kind === kind);
    return (
      <div className="space-y-3 p-3 text-xs">
        <div className="font-semibold">
          {samePassives ? `${selected.length} ${PASSIVES[kind].label.toLowerCase()}s` : `${selection.length} items selected`}
        </div>
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Align">
          {ALIGN_ACTIONS.map((a) => (
            <IconButton key={a.mode} label={a.label} className="h-7 w-7" disabled={alignable < a.min} onClick={() => alignSelection(a.mode)}>
              {a.icon}
            </IconButton>
          ))}
        </div>
        {samePassives && (
          <PassiveEditor
            kind={kind}
            value={selected[0].value}
            size={selected[0].generic!.size}
            lcsc={selected[0].lcsc}
            onChange={(patch) => assignPassive(selection, patch)}
            onPick={(part) => pickPart(selection, part)}
          />
        )}
        <SelectionActions />
      </div>
    );
  }
  const id = selection[0];
  const component = project.components.find((c) => c.id === id);
  if (component) return <ComponentInspector key={id} c={component} />;
  const port = project.ports.find((p) => p.id === id);
  if (port) return <PortInspector key={id} p={port} />;
  const wire = project.wires.find((w) => w.id === id);
  if (wire) return <WireInspector id={id} />;
  const group = project.groups?.find((g) => g.id === id);
  if (group) return <GroupInspector key={id} g={group} />;
  return null;
}

function GroupInspector({ g }: { g: SchematicGroup }) {
  const project = useEditor((s) => s.project);
  const [name, setName] = useState(g.name);
  useEffect(() => setName(g.name), [g.name]);
  const parts = useMemo(() => partsInGroup(g), [g, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const next = name.trim();
    if (next && next !== g.name) updateGroup(g.id, { name: next });
    else setName(g.name);
  };
  const button = 'inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5';
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="text-sm font-semibold">Group</div>
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </Field>
      <Field label="Colour">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Group colour">
          {GROUP_COLOR_NAMES.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={(g.color ?? 'indigo') === c}
              aria-label={c}
              onClick={() => updateGroup(g.id, { color: c })}
              style={{ background: GROUP_COLORS[c] }}
              className={cx('h-5 w-5 rounded-full border-2', (g.color ?? 'indigo') === c ? 'border-[var(--text)]' : 'border-transparent')}
            />
          ))}
        </div>
      </Field>
      <p className="leading-relaxed text-muted">
        {parts.length === 0 ? 'Nothing inside yet: drag parts into the frame, or resize it by its corners.' : `${parts.length} part${parts.length === 1 ? '' : 's'} inside: ${parts.map((c) => c.designator).join(', ')}.`}{' '}
        Dragging the frame moves what is inside; deleting it leaves the parts.
      </p>
      <div className="flex gap-1.5">
        <button onClick={() => selectGroupContents(g.id)} className={button} disabled={parts.length === 0}>
          Select contents
        </button>
        <button onClick={() => fitGroup(g.id)} className={button} disabled={parts.length === 0}>
          Fit to contents
        </button>
      </div>
      <button onClick={() => removeGroup(g.id)} className={cx(button, 'w-full text-rose-500 hover:bg-rose-500/10')}>
        <Trash2 className="h-3.5 w-3.5" /> Delete frame
      </button>
    </div>
  );
}

function SelectionActions() {
  return (
    <div className="flex gap-1.5">
      <ActionButton onClick={rotateSelection} icon={<RotateCcw className="h-3.5 w-3.5" />} label="Rotate" />
      <ActionButton onClick={mirrorSelection} icon={<FlipHorizontal2 className="h-3.5 w-3.5" />} label="Mirror" />
      <ActionButton onClick={deleteSelection} icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete" danger />
    </div>
  );
}

function ActionButton({ onClick, icon, label, danger }: { onClick: () => void; icon: React.ReactNode; label: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-line text-xs',
        danger ? 'text-rose-500 hover:bg-rose-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ProjectSummary() {
  const project = useEditor((s) => s.project);
  const file = useEditor((s) => s.file);
  const sourceFile = useEditor((s) => s.sourceFile);
  const conn = useMemo(() => connectivity(project), [project]);
  const where = sourceFile ? `Synced with designs/${sourceFile}` : file ? (project.updatedAt > file.savedAt ? `Unsaved changes to ${file.name}` : `Saved to ${file.name}`) : 'Kept in this browser';
  return (
    <div className="space-y-3 p-3 text-xs">
      <div>
        <div className="text-sm font-semibold">{project.name}</div>
        <div className="text-muted">
          {where} · {new Date(project.updatedAt).toLocaleTimeString()}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          ['Parts', project.components.length],
          ['Nets', conn.nets.length],
          ['Wires', project.wires.length],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-panel-2 p-2">
            <div className="text-lg font-semibold tabular">{v}</div>
            <div className="text-[10px] text-muted">{k}</div>
          </div>
        ))}
      </div>
      <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 p-2.5 text-[11px] leading-relaxed text-muted">
        <div className="font-medium text-[var(--text)]">Tips</div>
        <p>Double-click a library result to place it; keep clicking to place more, Esc to stop.</p>
        <p>Drag from a pin end to draw a wire; ending on another pin routes it around parts. Labels and power flags with the same name join nets.</p>
        <p>Middle-drag or Space-drag pans; scroll zooms; F fits the view.</p>
      </div>
    </div>
  );
}

function ComponentInspector({ c }: { c: Component }) {
  const project = useEditor((s) => s.project);
  const update = (patch: Partial<Component>) => useEditor.getState().updateComponent(c.id, patch);
  const symbol = symbolFor(project, c.symbolKey);
  const conn = useMemo(() => connectivity(project), [project]);
  const pins = worldPins(c, symbol);
  const [designator, setDesignator] = useState(c.designator);
  const [value, setValue] = useState(c.value);
  useEffect(() => setDesignator(c.designator), [c.designator]);
  useEffect(() => setValue(c.value), [c.value]);

  const attrs = Object.entries(c.attrs).filter(([k]) => !['Supplier', 'Supplier Part'].includes(k));
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{c.designator}</div>
          <div className="truncate text-muted">{c.attrs['Manufacturer Part'] ?? c.value}</div>
        </div>
        <ClassBadge value={c.partClass} />
      </div>

      <div className="space-y-1.5">
        <Field label="Designator">
          <input
            className={inputClass}
            value={designator}
            onChange={(e) => setDesignator(e.target.value)}
            onBlur={() => designator.trim() && designator !== c.designator && update({ designator: designator.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Field>
        {!c.generic && (
          <Field label="Value">
            <input
              className={inputClass}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => value !== c.value && update({ value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </Field>
        )}
        <Field label="Rotation">
          <select className={inputClass} value={c.rotation} onChange={(e) => update({ rotation: Number(e.target.value) as Rotation })}>
            {[0, 90, 180, 270].map((r) => (
              <option key={r} value={r}>
                {r}°
              </option>
            ))}
          </select>
        </Field>
        {symbol.units.length > 1 && (
          <Field label="Unit">
            <select className={inputClass} value={c.unit} onChange={(e) => update({ unit: Number(e.target.value) })}>
              {symbol.units.map((u, i) => (
                <option key={i} value={i}>
                  {String.fromCharCode(65 + i)} · {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {c.generic && (
        <div className="rounded-lg border border-line bg-panel-2 p-2.5">
          <PassiveEditor
            kind={c.generic.kind}
            value={c.value}
            size={c.generic.size}
            lcsc={c.lcsc}
            onChange={(patch) => assignPassive([c.id], patch)}
            onPick={(part) => pickPart([c.id], part)}
          />
        </div>
      )}
      <SelectionActions />

      {c.lcsc && (
        <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 p-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono">{c.lcsc}</span>
            <a href={`https://jlcpcb.com/parts/componentSearch?searchTxt=${c.lcsc}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-[var(--text)]">
              JLCPCB <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {c.partClass && <div className="text-[11px] text-muted">{CLASS_HINT[c.partClass]}</div>}
          <div className="flex justify-between text-[11px]">
            <span className="text-muted">Stock</span>
            <span className="tabular">{formatStock(c.stock)}</span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-muted">Unit price</span>
            <span className="tabular">{formatPrice(c.prices?.[0]?.price)}</span>
          </div>
        </div>
      )}
      <div className="flex gap-1.5">
        <button
          onClick={() => useEditor.getState().requestLibrary(c.attrs['Manufacturer Part'] ?? c.value, c.id)}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Replace className="h-3.5 w-3.5" /> Replace…
        </button>
        {c.partClass === 'extended' && (
          <button
            onClick={() => findNoFeeAlternative(c)}
            className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-amber-500/40 text-amber-600 hover:bg-amber-500/10 dark:text-amber-300"
            data-tip="Search basic / preferred parts like this one"
          >
            <Sparkles className="h-3.5 w-3.5" /> No-fee alt.
          </button>
        )}
      </div>
      <div className="flex gap-1.5">
        <button onClick={() => editSymbolOf(c)} className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5">
          <PenTool className="h-3.5 w-3.5" /> Symbol…
        </button>
        <button
          onClick={() => editFootprintOf(c).catch((err: Error) => useEditor.getState().notify(err.message, 'error'))}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Box className="h-3.5 w-3.5" /> Footprint…
        </button>
      </div>
      {c.footprint && (c.lcsc || c.generic) && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="truncate text-muted">Footprint made in this project</span>
          <button onClick={() => setFootprint([c.id], null)} className="shrink-0 text-indigo-500 hover:underline">
            Use the library’s
          </button>
        </div>
      )}

      {!c.generic && <DecouplingSection c={c} />}

      {attrs.length > 0 && (
        <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 text-[11px]">
          {attrs.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate text-muted">{k}</dt>
              <dd className="truncate" title={v}>
                {/^https?:\/\//.test(v) ? (
                  <a href={v} target="_blank" rel="noreferrer" className="text-indigo-500 hover:underline">
                    Open
                  </a>
                ) : (
                  v
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <details open={pins.length <= 24}>
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted">Pins · {pins.length}</summary>
        <div className="mt-1.5 divide-y divide-[var(--line)] rounded-lg border border-line">
          {pins.map((p) => {
            const net = conn.pinNet.get(`${c.id}:${p.pin.id}`);
            return (
              <button
                key={p.pin.id}
                onClick={() => net && useEditor.getState().setHighlightNet(net)}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="w-7 shrink-0 font-mono text-muted">{p.pin.number}</span>
                <span className="truncate">{p.pin.name !== p.pin.number ? p.pin.name : ''}</span>
                <span className={cx('ml-auto shrink-0 truncate', net ? '' : 'text-rose-500/80')}>{net ?? 'unconnected'}</span>
              </button>
            );
          })}
        </div>
      </details>
    </div>
  );
}

/** Adds the recipe's decoupling capacitors for an IC's supply pins. */
function DecouplingSection({ c }: { c: Component }) {
  const project = useEditor((s) => s.project);
  const pins = useMemo(() => supplyPins(c, project), [c, project]);
  const commonRail = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of project.ports) if (p.kind === 'power' && p.name.trim()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '+3V3';
  }, [project.ports]);
  const [rail, setRail] = useState<string | null>(null);
  const [bulk, setBulk] = useState(true);
  const [busy, setBusy] = useState(false);
  if (pins.length === 0) return null;
  const loose = pins.filter((p) => !p.rail);
  const chosenRail = rail ?? commonRail;
  let caps: PlannedCap[] = [];
  let skipped: string[] = [];
  let problem: string | null = null;
  try {
    ({ caps, skipped } = planDecoupling(c, { rail: chosenRail, bulk }, project));
    if (caps.length === 0) problem = 'The rails already have all the capacitors these pins call for';
  } catch (err) {
    problem = (err as Error).message;
  }
  const counts = new Map<string, number>();
  for (const cap of caps) counts.set(cap.value, (counts.get(cap.value) ?? 0) + 1);
  const add = async () => {
    setBusy(true);
    const s = useEditor.getState();
    try {
      const r = await addDecoupling(c.id, { rail: chosenRail, bulk });
      s.setSelection(r.ids);
      fitView(r.ids);
      s.notify(`Added ${r.caps.length} capacitors (${r.caps[0].designator}–${r.caps[r.caps.length - 1].designator}); place them next to their pins on the board`);
    } catch (err) {
      s.notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-2.5">
      <div className="flex items-center justify-between">
        <span className="font-medium">Decoupling</span>
        <span className="text-[11px] text-muted" data-tip={pins.map((p) => `${p.label}: ${p.rail ?? 'not connected'}`).join(' · ')}>
          {pins.length} supply pin{pins.length === 1 ? '' : 's'}
        </span>
      </div>
      {loose.length > 0 && (
        <Field label="Rail">
          <input className={inputClass} value={chosenRail} onChange={(e) => setRail(e.target.value)} spellCheck={false} />
        </Field>
      )}
      {loose.length > 0 && <p className="text-[11px] text-muted">Pin{loose.length === 1 ? '' : 's'} {loose.map((p) => p.label).join(', ')} will be connected to it.</p>}
      <label className="flex items-center gap-2 text-[11px]">
        <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} /> 10 µF bulk capacitor per rail
      </label>
      {skipped.length > 0 && <p className="text-[11px] text-muted">{skipped.join(' · ')}.</p>}
      <button
        onClick={() => void add()}
        disabled={busy || !!problem}
        data-tip={problem ?? '100 nF per supply pin, 1 µF + 10 nF on analog supplies, under the part with rail and GND flags'}
        className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 disabled:opacity-45 dark:hover:bg-white/5"
      >
        <Plus className="h-3.5 w-3.5" />
        {busy ? 'Adding…' : caps.length ? `Add ${[...counts].map(([v, n]) => `${n} × ${v}`).join(', ')}` : 'Nothing to add'}
      </button>
    </div>
  );
}

function PortInspector({ p }: { p: NetPort }) {
  const ports = useEditor((s) => s.project.ports);
  const [name, setName] = useState(p.name);
  const [onlyThis, setOnlyThis] = useState(false);
  useEffect(() => setName(p.name), [p.name]);
  const title = { label: 'Net label', power: 'Power flag', ground: 'Ground flag', noconnect: 'No-connect flag', hier: 'Hierarchical port' }[p.kind];
  const sameName = ports.filter((q) => q.kind !== 'noconnect' && q.name === p.name).length;
  const joins = name.trim() !== p.name && ports.some((q) => q.kind !== 'noconnect' && q.name === name.trim());
  const commit = () => {
    const next = name.trim();
    if (!next || next === p.name) return setName(p.name);
    if (onlyThis) useEditor.getState().updatePort(p.id, { name: next });
    else renameNet(p.name, next);
  };
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="text-sm font-semibold">{title}</div>
      {p.kind !== 'noconnect' && (
        <div className="space-y-1.5">
          <Field label="Net name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </Field>
          {sameName > 1 && (
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} />
              Rename only this {p.kind === 'label' ? 'label' : 'flag'} (not the other {sameName - 1} called {p.name})
            </label>
          )}
          {joins && <p className="text-[11px] text-amber-600 dark:text-amber-400">{name.trim()} already exists: this joins the two nets.</p>}
        </div>
      )}
      {p.kind !== 'noconnect' && (
        <button onClick={() => useEditor.getState().setHighlightNet(p.name)} className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5">
          <Waypoints className="h-3.5 w-3.5" /> Highlight net
        </button>
      )}
      <SelectionActions />
    </div>
  );
}

function WireInspector({ id }: { id: string }) {
  const project = useEditor((s) => s.project);
  const conn = useMemo(() => connectivity(project), [project]);
  const net = conn.itemNet.get(id);
  const auto = !net || conn.nets.find((n) => n.name === net)?.auto;
  const [name, setName] = useState(auto ? '' : (net ?? ''));
  useEffect(() => setName(auto ? '' : (net ?? '')), [net, auto]);
  const commit = () => {
    const next = name.trim();
    if (next && next !== net) nameNet(id, next);
  };
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="text-sm font-semibold">Wire</div>
      <Field label="Net">
        <input
          className={inputClass}
          value={name}
          placeholder={auto ? `${net ?? 'unconnected'} · type to name it` : undefined}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      {net && (
        <button onClick={() => useEditor.getState().setHighlightNet(net)} className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5">
          <Waypoints className="h-3.5 w-3.5" /> Highlight net
        </button>
      )}
      <SelectionActions />
    </div>
  );
}

function AgentPanel() {
  const status = useWebMcp((s) => s.status);
  const log = useEditor((s) => s.agentLog);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className={cx('rounded-lg border p-2.5', status?.api ? 'border-emerald-500/30 bg-emerald-500/8' : 'border-line bg-panel-2')}>
        <div className="flex items-center gap-1.5 font-medium">
          <span className={cx('h-2 w-2 rounded-full', status?.api ? 'bg-emerald-500' : 'bg-zinc-400')} />
          {status?.api ? `WebMCP active · ${status.registered.length} tools` : 'WebMCP not available in this browser'}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          {status?.api ? (
            <>
              Registered through <code className="font-mono">{status.api}</code>. Browser agents can search parts, place and wire them, and read the BOM.
            </>
          ) : (
            <>
              Tools are registered automatically when the page runs in a browser with WebMCP — e.g. Chrome with{' '}
              <code className="font-mono">chrome://flags/#enable-webmcp-testing</code>, or a WebMCP polyfill/extension. You can try every tool below meanwhile.
            </>
          )}
        </p>
        {status && status.errors.length > 0 && <p className="mt-1 text-[11px] text-rose-500">{status.errors.join('; ')}</p>}
      </div>

      <div>
        <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Tools · {TOOLS.length}</div>
        <div className="divide-y divide-[var(--line)] rounded-lg border border-line">
          {TOOLS.map((t) => (
            <ToolRow key={t.name} tool={t} open={open === t.name} onToggle={() => setOpen(open === t.name ? null : t.name)} />
          ))}
        </div>
      </div>

      <div>
        <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Activity</div>
        {log.length === 0 && <p className="text-muted">No agent calls yet.</p>}
        <ul className="space-y-1">
          {log.map((e) => (
            <li key={e.id} className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
              <div className="flex items-center justify-between">
                <span className={cx('font-mono font-medium', e.ok ? '' : 'text-rose-500')}>{e.tool}</span>
                <span className="text-[10px] text-muted">{new Date(e.at).toLocaleTimeString()}</span>
              </div>
              <div className="truncate text-[11px] text-muted" title={e.summary}>
                {e.summary}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function exampleInput(tool: ToolDefinition): string {
  const examples: Record<string, unknown> = {
    search_parts: { query: '10k 0603', part_types: ['basic'], limit: 5 },
    get_part_details: { lcsc: 'C6186' },
    place_part: { lcsc: 'C25804' },
    connect_pins: { from: 'R1.1', to: 'R2.2' },
    add_net_label: { pin: 'R1.1', name: 'EN' },
    add_power_flag: { pin: 'R1.2', net: 'GND' },
    mark_no_connect: { pin: 'U1.4' },
    update_component: { designator: 'R1', value: '4.7k' },
    replace_part: { designator: 'R1', lcsc: 'C23162' },
    delete_components: { designators: ['R1'] },
    get_bom: { boards: 5 },
    focus_components: { designators: ['R1'] },
    check_pin: { pin: 'R1.1' },
    new_schematic: { name: 'Untitled' },
    place_passive: { kind: 'resistor', value: '10k', size: '0603' },
    set_passive: { designators: ['R1'], value: '4k7', size: '0402' },
    pcb_set_board: { width: 40, height: 30 },
    pcb_move_part: { designator: 'R1', x: 10, y: 10, rotation: 90, side: 'top' },
    pcb_autoroute: {},
    pcb_clear_routing: { net: 'GND' },
    pcb_add_pour: { net: 'GND', layers: ['top', 'bottom'] },
    pcb_remove_pours: { net: 'GND' },
  };
  return JSON.stringify(examples[tool.name] ?? {}, null, 2);
}

function ToolRow({ tool, open, onToggle }: { tool: ToolDefinition; open: boolean; onToggle: () => void }) {
  const [input, setInput] = useState(() => exampleInput(tool));
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5">
        <span className="font-mono text-[11px]">{tool.name}</span>
        {tool.annotations?.readOnlyHint ? (
          <span className="rounded bg-emerald-500/12 px-1 text-[10px] text-emerald-600 dark:text-emerald-300">read</span>
        ) : (
          <span className="rounded bg-indigo-500/12 px-1 text-[10px] text-indigo-600 dark:text-indigo-300">edit</span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          <p className="text-[11px] leading-relaxed text-muted">{tool.description}</p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={Math.min(8, input.split('\n').length + 1)}
            spellCheck={false}
            className="w-full rounded-md border border-line bg-panel-2 p-1.5 font-mono text-[11px] outline-none focus:border-indigo-500"
            aria-label={`${tool.name} input`}
          />
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await runTool(tool, JSON.parse(input || '{}'));
                setResult(JSON.stringify(res, null, 2));
              } catch (err) {
                setResult(`Error: ${(err as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-indigo-600 px-2 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play className="h-3 w-3" /> Run
          </button>
          {result && <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-1.5 font-mono text-[10px] leading-snug">{result}</pre>}
        </div>
      )}
    </div>
  );
}
