import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, CircleCheck, ExternalLink, ShoppingCart, X } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { safeFileName } from '../../lib/actions';
import { ORDER_QUANTITIES, orderSummary, startJlcpcbOrder, type OrderOptions } from '../../lib/pcb/order';
import { checklistReady, type CheckItem } from '../../lib/pcb/jlcpcb';
import { CheckRow } from './Checklist';
import { Button, cx } from '../ui';

const money = (n: number) => `$${n.toFixed(2)}`;
const names = (list: { designator: string }[] | string[]) => list.map((c) => (typeof c === 'string' ? c : c.designator)).join(', ');

/** "Order from JLCPCB": checks the board, downloads the upload files and opens the quote page. */
export function OrderDialog() {
  const open = useEditor((s) => s.orderOpen);
  if (!open) return null;
  return <OrderSheet />;
}

function OrderSheet() {
  const project = useEditor((s) => s.project);
  const close = () => useEditor.getState().setOrderOpen(false);
  const [opts, setOpts] = useState<OrderOptions>({ quantity: 5, assembly: true, handSolderThroughHole: false });
  const [sent, setSent] = useState<string[] | null>(null);
  const summary = useMemo(() => orderSummary(project, opts), [project, opts]);
  const base = safeFileName(project.name);
  const patch = (p: Partial<OrderOptions>) => {
    setOpts((o) => ({ ...o, ...p }));
    setSent(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { bom } = summary;
  const steps = [
    <>
      Drop <File name={`${base}-gerbers.zip`} /> on <b>Add gerber file</b>.
    </>,
    <>
      Check <b>Layers 2</b>, <b>{summary.width} × {summary.height} mm</b> (read from the Gerbers), <b>PCB Qty {opts.quantity}</b>, thickness <b>1.6 mm</b> and{' '}
      <b>Via Covering: Tented</b>
      {summary.viasInPads && <> (or Epoxy Filled &amp; Capped, at extra cost, so solder can't wick into the thermal vias)</>}. Leave the rest at JLCPCB's defaults.
    </>,
    ...(opts.assembly
      ? [
          <>
            Switch on <b>PCB Assembly</b>: {summary.bottomSide ? <b>Standard, both sides</b> : <b>Economic, top side</b>}, quantity <b>{opts.quantity}</b>, then <b>Next</b>.
          </>,
          <>
            Upload <File name={`${base}-BOM.csv`} /> and <File name={`${base}-CPL.csv`} />, then <b>Process BOM &amp; CPL</b>. Parts are matched by their LCSC numbers.
          </>,
          ...(summary.checkOrientation.length
            ? [
                <>
                  In the placement preview, check that pin 1 or the polarity of <b>{names(summary.checkOrientation)}</b> matches the silkscreen, and rotate a part there if it
                  doesn't.
                </>,
              ]
            : []),
        ]
      : []),
    <>
      <b>Save to Cart</b> and check out.
    </>,
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Order from JLCPCB" className="flex max-h-full w-[540px] max-w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShoppingCart className="h-4 w-4 text-indigo-500" /> Order from JLCPCB
          </div>
          <button aria-label="Close" onClick={close} className="rounded p-1 text-muted hover:text-[var(--text)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4 text-[13px]">
          {summary.partCount === 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5">
              <CircleAlert className="mt-px h-4 w-4 shrink-0 text-rose-500" />
              <div className="font-medium">{summary.errors[0]}</div>
            </div>
          ) : (
            <ChecklistSummary items={summary.checklist} />
          )}

          {summary.partCount > 0 && (
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-muted">Board</span>
              <span>
                {summary.width} × {summary.height} mm · 2 layers · FR-4 1.6 mm
              </span>
              <span className="text-muted">Parts</span>
              <span>
                {summary.partCount} placed{summary.throughHole.length > 0 && <> · through-hole: {names(summary.throughHole)}</>}
              </span>
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
            <label className="flex items-center justify-between gap-3">
              <span>Boards</span>
              <select
                value={opts.quantity}
                onChange={(e) => patch({ quantity: Number(e.target.value) })}
                className="h-7 rounded-md border border-line bg-panel px-2 text-xs"
              >
                {ORDER_QUANTITIES.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={opts.assembly} onChange={(e) => patch({ assembly: e.target.checked })} />
              <span>Assemble the parts (JLCPCB PCBA)</span>
            </label>
            {opts.assembly && summary.throughHole.length > 0 && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={opts.handSolderThroughHole} onChange={(e) => patch({ handSolderThroughHole: e.target.checked })} />
                <span>
                  I'll solder the through-hole parts myself ({names(summary.throughHole)})
                  <span className="block text-xs text-muted">JLCPCB solders through-hole parts by hand for an extra charge.</span>
                </span>
              </label>
            )}
            {opts.assembly && (
              <div className="border-t border-line pt-2 text-xs">
                <div>
                  Parts ≈ <b>{money(bom.partsCost)}</b> for {opts.quantity} boards
                  {bom.setupFee > 0 && (
                    <>
                      {' '}
                      + <b>{money(bom.setupFee)}</b> setup fee ({bom.byClass.extended} extended part{bom.byClass.extended === 1 ? '' : 's'})
                    </>
                  )}
                </div>
                <div className="text-muted">
                  {bom.uniqueParts} unique parts: {bom.byClass.basic} basic, {bom.byClass.preferred} preferred, {bom.byClass.extended} extended
                  {bom.byClass.unassigned > 0 && <>, {bom.byClass.unassigned} without an LCSC part (left out)</>}. JLCPCB adds the board, assembly and shipping cost
                  in its quote.
                </div>
                {bom.lowStock.length > 0 && (
                  <div className="mt-1 flex items-center gap-1 text-amber-600 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5" /> Low stock: {bom.lowStock.map((l) => l.designators.join(', ')).join('; ')}
                  </div>
                )}
              </div>
            )}
          </div>

          <Button
            variant="primary"
            className="h-9 w-full"
            disabled={!summary.ready}
            onClick={() => setSent(startJlcpcbOrder(project, opts))}
          >
            <ExternalLink className="h-4 w-4" /> {sent ? 'Download again & reopen JLCPCB' : 'Download files & open JLCPCB'}
          </Button>
          {sent && <div className="text-center text-xs text-emerald-600 dark:text-emerald-400">Downloaded {sent.join(', ')}. Finish the order in the JLCPCB tab:</div>}

          <ol className={cx('space-y-1.5 text-xs', !sent && 'text-muted')}>
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-500/15 text-[10px] font-semibold text-indigo-600 dark:text-indigo-300">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          {opts.assembly && opts.handSolderThroughHole && summary.throughHole.length > 0 && (
            <p className="text-xs text-muted">When the boards arrive, solder {names(summary.throughHole)} yourself.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The JLCPCB checklist in short: failures first, then what to look at, the rest folded away. */
function ChecklistSummary({ items }: { items: CheckItem[] }) {
  const ready = checklistReady(items);
  const failed = items.filter((i) => i.status === 'fail');
  const warned = items.filter((i) => i.status === 'warn');
  const rest = items.filter((i) => i.status === 'pass' || i.status === 'info');
  return (
    <div className={cx('rounded-lg border p-2.5', ready ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10')}>
      <div className="flex items-center gap-2 font-medium">
        {ready ? <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" /> : <CircleAlert className="h-4 w-4 shrink-0 text-rose-500" />}
        {ready ? 'Meets JLCPCB’s requirements' : 'Fix these before ordering'}
        <span className="ml-auto text-xs font-normal text-muted">
          {rest.length}/{items.length} checks fine
        </span>
      </div>
      {(failed.length > 0 || warned.length > 0) && <ul className="mt-1 text-xs">{[...failed, ...warned].map((i) => <CheckRow key={i.id} item={i} />)}</ul>}
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted">All {items.length} checks</summary>
        <ul className="mt-1">{rest.map((i) => <CheckRow key={i.id} item={i} />)}</ul>
      </details>
    </div>
  );
}

function File({ name }: { name: string }) {
  return <code className="rounded bg-black/5 px-1 py-px font-mono text-[11px] dark:bg-white/10">{name}</code>;
}
