/*
 * Runs one of the PCB TASKS off the main thread. In the browser the work goes to a Web Worker
 * (started on first use), so the editor keeps drawing and responding while a board routes;
 * where there is no Worker (the command line, tests) the task simply runs here. Stopping the
 * assistant cancels whatever the worker is doing.
 */
import { TASKS, type TaskName, type Tasks } from './tasks';

type Result<K extends TaskName> = ReturnType<Tasks[K]>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  task: TaskName;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

const hasWorker = () => typeof Worker !== 'undefined' && typeof window !== 'undefined';

function startWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };
  // The worker itself failing (not a task throwing): fail what it was doing and start afresh next time.
  w.onerror = (e) => {
    failAll(new Error(`The PCB worker failed: ${e.message || 'unknown error'}`));
    w.terminate();
    if (worker === w) worker = null;
  };
  return w;
}

function failAll(err: Error) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

/** Runs a task, in the worker when there is one, and resolves with its result. */
export function offload<K extends TaskName>(task: K, ...args: Parameters<Tasks[K]>): Promise<Result<K>> {
  if (!hasWorker()) {
    try {
      return Promise.resolve((TASKS[task] as (...a: unknown[]) => Result<K>)(...args));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  worker ??= startWorker();
  const id = nextId++;
  return new Promise<Result<K>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, task });
    worker!.postMessage({ id, task, args });
  });
}

/** Whether something is running in the worker right now. */
export const offloading = () => pending.size > 0;

/** Stops the worker mid-task; everything pending fails with `reason`. The next task starts a new worker. */
export function cancelOffloaded(reason = 'Stopped') {
  if (!worker) return;
  worker.terminate();
  worker = null;
  failAll(new Error(reason));
}
