import { useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, CircleCheck, Info, ShoppingCart } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { boardModel, throughHoleParts } from '../../lib/pcb/actions';
import { checklistReady, jlcpcbChecklist, type CheckItem, type CheckStatus } from '../../lib/pcb/jlcpcb';
import { zoomPcbTo } from '../../lib/pcb/view';
import { cx } from '../ui';

export function StatusIcon({ status, className }: { status: CheckStatus; className?: string }) {
  const c = cx('h-3.5 w-3.5 shrink-0', className);
  if (status === 'pass') return <CircleCheck className={cx(c, 'text-emerald-500')} aria-label="passes" />;
  if (status === 'fail') return <CircleAlert className={cx(c, 'text-rose-500')} aria-label="fails" />;
  if (status === 'warn') return <AlertTriangle className={cx(c, 'text-amber-500')} aria-label="warning" />;
  return <Info className={cx(c, 'text-sky-500')} aria-label="note" />;
}

/** One checklist line; clicking it shows the spot on the board when there is one. */
export function CheckRow({ item }: { item: CheckItem }) {
  const show = () => {
    if (item.at) zoomPcbTo(item.at);
    if (item.refs?.length) useEditor.getState().setPcbSelection(item.refs);
  };
  return (
    <li>
      <button onClick={show} disabled={!item.at && !item.refs?.length} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left enabled:hover:bg-black/5 dark:enabled:hover:bg-white/5">
        <StatusIcon status={item.status} className="mt-px" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{item.title}</span>
          <span className="block break-words text-[11px]">{item.value}</span>
          <span className="block text-[10px] text-muted">JLCPCB: {item.limit}</span>
          {item.detail && item.status !== 'pass' && <span className="mt-0.5 block text-[11px] text-muted">{item.detail}</span>}
        </span>
      </button>
    </li>
  );
}

/** The JLCPCB tab of the PCB panel: the whole checklist, grouped. */
export function JlcpcbChecklistPanel() {
  const project = useEditor((s) => s.project);
  const [assembly, setAssembly] = useState(true);
  const [handSolder, setHandSolder] = useState(false);
  const items = useMemo(() => {
    const skip = handSolder ? new Set(throughHoleParts(boardModel(project).board).map((c) => c.id)) : undefined;
    return jlcpcbChecklist(project, { assembly, skip });
  }, [project, assembly, handSolder]);
  const groups = [...new Set(items.map((i) => i.group))];
  const failed = items.filter((i) => i.status === 'fail').length;
  const warned = items.filter((i) => i.status === 'warn').length;
  if (!project.pcb?.placements.length) return <p className="px-3 py-2 text-muted">Bring the parts onto the board first.</p>;
  return (
    <div className="space-y-2 p-2">
      <div className={cx('rounded-lg border p-2.5', checklistReady(items) ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10')}>
        <div className="flex items-center gap-2 font-medium">
          <StatusIcon status={checklistReady(items) ? 'pass' : 'fail'} />
          {checklistReady(items) ? 'Meets JLCPCB’s requirements' : `${failed} problem${failed > 1 ? 's' : ''} JLCPCB can’t make`}
        </div>
        <p className="mt-0.5 text-[11px] text-muted">
          {items.length - failed - warned} of {items.length} checks fine{warned > 0 && `, ${warned} to look at`}. Standard 2-layer FR-4, 1.6 mm, against jlcpcb.com/capabilities.
        </p>
      </div>
      <div className="flex flex-col gap-1 px-1 text-[11px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={assembly} onChange={(e) => setAssembly(e.target.checked)} /> Include assembly checks
        </label>
        {assembly && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={handSolder} onChange={(e) => setHandSolder(e.target.checked)} /> I solder through-hole parts myself
          </label>
        )}
      </div>
      {groups.map((g) => (
        <section key={g}>
          <h3 className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{g}</h3>
          <ul>
            {items
              .filter((i) => i.group === g)
              .map((i) => (
                <CheckRow key={i.id} item={i} />
              ))}
          </ul>
        </section>
      ))}
      <button
        onClick={() => useEditor.getState().setOrderOpen(true)}
        className="mt-1 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 font-medium text-white hover:bg-indigo-500"
      >
        <ShoppingCart className="h-3.5 w-3.5" /> Order from JLCPCB
      </button>
    </div>
  );
}
