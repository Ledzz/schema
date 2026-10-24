import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { useEditor } from '../../store/editor';
import { assignPassive, pickPart } from '../../lib/passives';
import { componentBox } from '../../lib/schematic/geometry';
import { symbolFor } from '../../lib/schematic/symbols';
import { PASSIVES } from '../../shared/passives';
import { PassiveEditor } from './PassiveEditor';

/** Generic passives that an edit of `id` applies to: the selection if it is all the same kind. */
export function passiveTargets(id: string): string[] {
  const { project, selection } = useEditor.getState();
  const c = project.components.find((x) => x.id === id);
  if (!c?.generic) return [];
  const same = project.components.filter((x) => selection.includes(x.id) && x.generic?.kind === c.generic!.kind).map((x) => x.id);
  return same.includes(id) ? same : [id];
}

/** Floating value/size editor next to a passive on the canvas. */
export function QuickEdit() {
  const id = useEditor((s) => s.quickEditId);
  const project = useEditor((s) => s.project);
  const view = useEditor((s) => s.view);
  const canvas = useEditor((s) => s.canvasSize);
  const ref = useRef<HTMLDivElement>(null);
  const c = project.components.find((x) => x.id === id);
  const close = () => useEditor.getState().setQuickEdit(null);

  useEffect(() => {
    if (!id) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [id]);

  const targets = useMemo(() => (id ? passiveTargets(id) : []), [id]);
  if (!c?.generic) return null;
  const box = componentBox(c, symbolFor(project, c.symbolKey));
  const width = 288;
  const left = Math.min(Math.max(8, box.x2 * view.zoom + view.x + 12), canvas.width - width - 8);
  const top = Math.min(Math.max(8, box.y1 * view.zoom + view.y - 8), canvas.height - 330);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit ${c.designator}`}
      className="absolute z-20 rounded-xl border border-line bg-panel p-3 shadow-2xl shadow-black/30"
      style={{ left, top, width }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">
          {targets.length > 1 ? `${targets.length} ${PASSIVES[c.generic.kind].label.toLowerCase()}s` : `${c.designator} · ${PASSIVES[c.generic.kind].label}`}
        </div>
        <button aria-label="Close" onClick={close} className="rounded p-0.5 text-muted hover:text-[var(--text)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <PassiveEditor
        kind={c.generic.kind}
        value={c.value}
        size={c.generic.size}
        lcsc={c.lcsc}
        autoFocus
        onChange={(patch) => assignPassive(targets, patch)}
        onPick={(part) => pickPart(targets, part)}
        onDone={close}
      />
    </div>
  );
}
