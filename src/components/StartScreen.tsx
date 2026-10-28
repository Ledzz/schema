/*
 * The start screen: the projects this browser has, most recent first with a sketch of each,
 * plus new, open and (in dev) the designs/ folder. It is what the app shows before anything
 * is open, and the logo or File → Recent projects brings it back.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, FilePlus, FolderOpen, HardDrive, Sparkles, X } from 'lucide-react';
import { useEditor } from '../store/editor';
import { openDesign } from '../lib/designs';
import { listProjects, openFile, openProject, removeProject, startNewProject, type ProjectEntry, type ProjectPreview } from '../lib/projects';
import { Kbd, cx } from './ui';

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, now - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

export function StartScreen() {
  const current = useEditor((s) => s.project);
  const [entries, setEntries] = useState<ProjectEntry[] | null>(null);
  const [designs, setDesigns] = useState<string[]>([]);
  const s = useEditor.getState;
  const refresh = () => listProjects().then(setEntries, () => setEntries([]));

  useEffect(() => {
    void refresh();
    if (import.meta.env.DEV) fetch('/api/dev/designs').then((r) => (r.ok ? r.json() : [])).then(setDesigns, () => setDesigns([]));
  }, []);

  // Something is open behind the start screen once a project has content or is in the library.
  const canClose = current.components.length + current.wires.length > 0 || (entries?.some((e) => e.id === current.id) ?? false);
  useEffect(() => {
    if (!canClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && s().setStartOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canClose, s]);

  const remove = async (e: ProjectEntry) => {
    if (!confirm(`Remove "${e.name}" from this browser?${e.fileName ? ` The file ${e.fileName} stays on disk.` : ' This cannot be undone.'}`)) return;
    await removeProject(e.id);
    void refresh();
  };

  return (
    <div role="dialog" aria-label="Start" className="flex h-full flex-col overflow-auto bg-app">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h4l2-5 4 10 2-5h6" />
            </svg>
          </div>
          <div>
            <div className="text-lg font-semibold tracking-tight">Schematics</div>
            <div className="text-xs text-muted">Schematics and PCBs for JLCPCB, with an assistant that knows the parts</div>
          </div>
          {canClose && (
            <button onClick={() => s().setStartOpen(false)} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs hover:bg-black/5 dark:hover:bg-white/5">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to {current.name}
              <Kbd>Esc</Kbd>
            </button>
          )}
        </header>

        <div className="grid gap-8 md:grid-cols-[220px_1fr]">
          <aside className="space-y-4">
            <div className="space-y-1.5">
              <Action icon={<FilePlus className="h-4 w-4" />} title="New project" detail="An empty schematic" onClick={() => startNewProject()} />
              <Action icon={<FolderOpen className="h-4 w-4" />} title="Open file…" detail="A project saved as JSON" onClick={() => void openFile()} />
              <Action
                icon={<Sparkles className="h-4 w-4 text-indigo-500" />}
                title="Describe what to build"
                detail="The assistant designs it"
                onClick={() => {
                  startNewProject();
                  s().setRightTab('assistant');
                }}
              />
            </div>
            {designs.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Designs folder</div>
                <ul className="space-y-0.5 text-xs">
                  {designs.map((name) => (
                    <li key={name}>
                      <button onClick={() => void openDesign(name, { askIfNewer: true })} className="w-full truncate rounded-md px-2 py-1 text-left font-mono hover:bg-black/5 dark:hover:bg-white/5">
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 px-2 text-[11px] leading-relaxed text-muted">Files in designs/ stay in step with the page (dev only).</p>
              </div>
            )}
            <p className="px-1 text-[11px] leading-relaxed text-muted">
              Projects are kept in this browser as you work. Save to a file to keep one elsewhere, or drop a project file anywhere on the window to open it.
            </p>
          </aside>

          <section>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Recent projects</div>
            {entries === null && <p className="text-xs text-muted">Loading…</p>}
            {entries?.length === 0 && <p className="rounded-lg border border-dashed border-line p-6 text-center text-xs text-muted">Nothing yet. Start a new project or open a file.</p>}
            {entries && entries.length > 0 && (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {entries.map((e) => (
                  <li key={e.id} className="group relative">
                    <button
                      onClick={() => void openProject(e.id)}
                      className={cx(
                        'flex w-full flex-col overflow-hidden rounded-xl border bg-panel text-left shadow-sm transition-colors hover:border-indigo-500/50',
                        e.id === current.id && canClose ? 'border-indigo-500/60' : 'border-line',
                      )}
                    >
                      <div className="h-28 w-full border-b border-line" style={{ background: 'var(--canvas-bg)' }}>
                        <Thumbnail preview={e.preview} />
                      </div>
                      <div className="space-y-0.5 px-3 py-2">
                        <div className="truncate text-sm font-medium">{e.name}</div>
                        <div className="truncate text-[11px] text-muted">
                          {e.parts} part{e.parts === 1 ? '' : 's'}
                          {e.sheets > 1 && ` · ${e.sheets} sheets`}
                          {e.hasPcb && ' · PCB'}
                          {' · '}
                          {ago(e.updatedAt)}
                        </div>
                        {(e.fileName || e.source) && (
                          <div className="flex items-center gap-1 truncate font-mono text-[10px] text-muted">
                            <HardDrive className="h-3 w-3 shrink-0" /> {e.source ? `designs/${e.source}` : e.fileName}
                          </div>
                        )}
                      </div>
                    </button>
                    <button
                      aria-label={`Remove ${e.name}`}
                      data-tip="Remove from this browser"
                      onClick={() => void remove(e)}
                      className="absolute right-1.5 top-1.5 rounded-md bg-panel/90 p-1 text-muted opacity-0 shadow-sm hover:text-rose-500 group-hover:opacity-100 focus:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Action({ icon, title, detail, onClick }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-left hover:border-indigo-500/50 hover:bg-indigo-500/5">
      <span className="text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-[11px] text-muted">{detail}</span>
      </span>
    </button>
  );
}

/** A sketch of a project's busiest sheet: part outlines and wires, scaled to fit. */
export function Thumbnail({ preview }: { preview: ProjectPreview | null }) {
  if (!preview) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted">
        <FilePlus className="h-5 w-5 opacity-40" />
      </div>
    );
  }
  const b = preview.bounds;
  const pad = Math.max(20, (b.x2 - b.x1) * 0.06);
  return (
    <svg viewBox={`${b.x1 - pad} ${b.y1 - pad} ${b.x2 - b.x1 + pad * 2} ${b.y2 - b.y1 + pad * 2}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-hidden>
      {preview.wires.map((pts, i) => (
        <polyline key={i} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--wire)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.9} />
      ))}
      {preview.boxes.map((box, i) => (
        <rect key={i} x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="var(--sym-fill)" stroke="var(--sym-stroke)" strokeWidth={1} vectorEffect="non-scaling-stroke" rx={1} />
      ))}
    </svg>
  );
}
