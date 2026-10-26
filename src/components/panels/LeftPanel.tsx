import { useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, CircleCheck, Download, RefreshCcw, Sparkles } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { connectivity, downloadText, findNoFeeAlternative, refreshStock, safeFileName } from '../../lib/actions';
import { fitView } from '../../lib/editing';
import { bomToJlcpcbCsv, buildBom } from '../../lib/schematic/bom';
import { CLASS_STYLES, ClassBadge, Tabs, cx, formatPrice, formatStock } from '../ui';
import { EXTENDED_SETUP_FEE, PART_CLASSES, PART_CLASS_LABEL } from '../../shared/parts';

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab);
  const setTab = useEditor((s) => s.setLeftTab);
  const project = useEditor((s) => s.project);
  const conn = useMemo(() => connectivity(project), [project]);
  const issues = conn.issues.length;
  return (
    <aside className="flex min-h-0 w-64 flex-col border-r border-line bg-panel" aria-label="Project">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'project', label: 'Project' },
          { value: 'bom', label: 'BOM' },
          {
            value: 'check',
            label: (
              <span className="inline-flex items-center gap-1">
                Check
                {issues > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-600 dark:text-amber-300">{issues}</span>}
              </span>
            ),
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'project' && <ProjectTree conn={conn} />}
        {tab === 'bom' && <BomView />}
        {tab === 'check' && <CheckView conn={conn} />}
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</div>;
}

function ProjectTree({ conn }: { conn: ReturnType<typeof connectivity> }) {
  const components = useEditor((s) => s.project.components);
  const selection = useEditor((s) => s.selection);
  const highlightNet = useEditor((s) => s.highlightNet);
  const sorted = useMemo(
    () => [...components].sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true })),
    [components],
  );
  return (
    <div className="pb-3 text-xs">
      <SectionTitle>Components · {components.length}</SectionTitle>
      {sorted.length === 0 && <p className="px-3 text-muted">Nothing placed yet.</p>}
      {sorted.map((c) => (
        <button
          key={c.id}
          onClick={() => {
            useEditor.getState().setSelection([c.id]);
            fitView([c.id]);
          }}
          className={cx('flex w-full items-center gap-2 px-3 py-1 text-left', selection.includes(c.id) ? 'bg-indigo-500/12' : 'hover:bg-black/5 dark:hover:bg-white/5')}
        >
          <span className={cx('h-2 w-2 shrink-0 rounded-full', c.partClass ? CLASS_STYLES[c.partClass].dot : 'bg-zinc-400')} />
          <span className="w-10 shrink-0 font-medium">{c.designator}</span>
          <span className="truncate text-muted">{c.value}</span>
          {c.lcsc && <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{c.lcsc}</span>}
        </button>
      ))}
      <SectionTitle>Nets · {conn.nets.length}</SectionTitle>
      {conn.nets.map((n) => (
        <button
          key={n.name}
          onClick={() => useEditor.getState().setHighlightNet(highlightNet === n.name ? null : n.name)}
          className={cx('flex w-full items-center justify-between px-3 py-1 text-left', highlightNet === n.name ? 'bg-pink-500/12' : 'hover:bg-black/5 dark:hover:bg-white/5')}
          title={n.members.map((m) => `${m.designator}.${m.pinNumber}`).join(' ')}
        >
          <span className={cx('truncate', n.auto && 'text-muted')}>{n.name}</span>
          <span className="text-[10px] text-muted">{n.members.length} pins</span>
        </button>
      ))}
    </div>
  );
}

function BomView() {
  const components = useEditor((s) => s.project.components);
  const name = useEditor((s) => s.project.name);
  const [boards, setBoards] = useState(5);
  const [refreshing, setRefreshing] = useState(false);
  const bom = useMemo(() => buildBom(components, boards), [components, boards]);
  const extended = bom.lines.filter((l) => l.partClass === 'extended');

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="grid grid-cols-3 gap-1.5">
        {PART_CLASSES.map((c) => (
          <div key={c} className="rounded-lg border border-line bg-panel-2 p-2">
            <div className={cx('text-lg font-semibold tabular', CLASS_STYLES[c].text)}>{bom.byClass[c]}</div>
            <div className="text-[10px] text-muted">{PART_CLASS_LABEL[c]}</div>
          </div>
        ))}
      </div>
      <div className="space-y-1 rounded-lg border border-line bg-panel-2 p-2.5">
        <Row label="Unique parts" value={`${bom.uniqueParts} (${bom.totalParts} placed)`} />
        <Row label="Extended setup fee" value={<span className={bom.setupFee ? 'text-amber-500' : 'text-emerald-500'}>${bom.setupFee.toFixed(2)}</span>} />
        <Row
          label={
            <span className="inline-flex items-center gap-1">
              Parts for
              <input
                type="number"
                min={1}
                value={boards}
                onChange={(e) => setBoards(Math.max(1, Number(e.target.value) || 1))}
                className="h-5 w-12 rounded border border-line bg-panel px-1 text-xs"
                aria-label="Number of boards"
              />
              boards
            </span>
          }
          value={formatPrice(bom.partsCost)}
        />
        {bom.byClass.unassigned > 0 && <Row label="Without LCSC part" value={<span className="text-rose-500">{bom.byClass.unassigned}</span>} />}
      </div>

      {extended.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-300">
            <Sparkles className="h-3.5 w-3.5" /> Save ${(extended.length * EXTENDED_SETUP_FEE).toFixed(0)} in setup fees
          </div>
          <p className="mb-2 text-[11px] text-muted">These extended parts may have basic or preferred equivalents.</p>
          {extended.map((l) => {
            const c = components.find((x) => x.id === l.componentIds[0]);
            return (
              <button
                key={l.key}
                onClick={() => c && findNoFeeAlternative(c)}
                className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left hover:bg-amber-500/10"
                data-tip="Search basic / preferred alternatives"
              >
                <span className="truncate">
                  {l.designators.join(', ')} · {l.value}
                </span>
                <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-300">Find →</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={async () => {
            setRefreshing(true);
            try {
              const n = await refreshStock();
              useEditor.getState().notify(`Updated stock for ${n} parts`);
            } catch (err) {
              useEditor.getState().notify(`Stock refresh failed: ${(err as Error).message}`, 'error');
            } finally {
              setRefreshing(false);
            }
          }}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-line hover:bg-black/5 dark:hover:bg-white/5"
        >
          <RefreshCcw className={cx('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Stock
        </button>
        <button
          disabled={bom.lines.length === 0}
          onClick={() => downloadText(`${safeFileName(name)}-BOM-JLCPCB.csv`, bomToJlcpcbCsv(bom), 'text/csv')}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" /> JLCPCB CSV
        </button>
      </div>

      <div className="divide-y divide-[var(--line)] rounded-lg border border-line">
        {bom.lines.map((l) => (
          <div key={l.key} className="space-y-0.5 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{l.value}</span>
              <ClassBadge value={l.partClass} compact />
            </div>
            <div className="truncate text-[11px] text-muted">{l.designators.join(', ')}</div>
            <div className="flex justify-between text-[11px] text-muted">
              <span className="font-mono">{l.lcsc || 'no LCSC part'}</span>
              <span className={cx('tabular', l.stock !== null && l.stock < l.quantity * boards && 'text-rose-500')}>
                ×{l.quantity} · stock {formatStock(l.stock)}
              </span>
            </div>
          </div>
        ))}
        {bom.lines.length === 0 && <p className="p-3 text-muted">Place parts to build the BOM.</p>}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="tabular font-medium">{value}</span>
    </div>
  );
}

function CheckView({ conn }: { conn: ReturnType<typeof connectivity> }) {
  if (conn.issues.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-muted">
        <CircleCheck className="h-6 w-6 text-emerald-500" />
        No problems found.
      </div>
    );
  }
  return (
    <ul className="p-2 text-xs">
      {conn.issues.map((issue, i) => (
        <li key={i}>
          <button
            onClick={() => {
              if (issue.itemId) {
                useEditor.getState().setSelection([issue.itemId]);
                fitView([issue.itemId]);
              }
            }}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5"
          >
            {issue.severity === 'error' ? (
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-rose-500" />
            ) : (
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
            )}
            <span>{issue.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
