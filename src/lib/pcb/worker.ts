/*
 * The PCB worker: runs one of the TASKS on a project sent from the page and posts the result
 * back, so routing and checking a board never freeze the editor. Loaded by offload.ts.
 */
import { TASKS, type TaskName } from './tasks';

interface Request {
  id: number;
  task: TaskName;
  args: unknown[];
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, task, args } = e.data;
  try {
    const fn = TASKS[task] as (...a: unknown[]) => unknown;
    if (!fn) throw new Error(`Unknown task "${task}"`);
    self.postMessage({ id, result: fn(...args) });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
