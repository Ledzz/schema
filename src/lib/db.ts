/*
 * The app's IndexedDB: the project library (every project opened in this browser, autosaved
 * as it is edited) and the assistant's chats. One tiny promise wrapper over the two stores;
 * where IndexedDB is missing (tests, the CLI, some private windows) the same calls work on an
 * in-memory map so nothing else has to care.
 */

const DB_NAME = 'schematics';
const DB_VERSION = 1;

/** `projects` holds what the start screen lists, `docs` the projects themselves (by the same id). */
export type StoreName = 'projects' | 'docs' | 'chats';

/** Fields the stores are indexed on; `projectId` finds a project's chats. */
const INDEXES: Record<StoreName, string[]> = { projects: [], docs: [], chats: ['projectId'] };

type Row = { id: string };

const memory: Record<StoreName, Map<string, Row>> = { projects: new Map(), docs: new Map(), chats: new Map() };

const hasIndexedDb = () => typeof indexedDB !== 'undefined';

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.keys(INDEXES) as StoreName[]) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'id' });
        for (const index of INDEXES[name]) store.createIndex(index, index);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database closes this connection; the next call reopens it.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error('Could not open the browser database'));
    };
    req.onblocked = () => reject(new Error('The browser database is open in another tab with an older version'));
  });
  return opening;
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Browser database request failed'));
  });

async function withStore<T>(name: StoreName, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const result = await request(fn(tx.objectStore(name)));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Browser database transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Browser database transaction aborted'));
  });
  return result;
}

/** One row by id, or undefined. */
export async function dbGet<T extends Row>(store: StoreName, id: string): Promise<T | undefined> {
  if (!hasIndexedDb()) return memory[store].get(id) as T | undefined;
  return (await withStore(store, 'readonly', (s) => s.get(id))) as T | undefined;
}

/** Adds or replaces a row. */
export async function dbPut<T extends Row>(store: StoreName, row: T): Promise<void> {
  if (!hasIndexedDb()) {
    memory[store].set(row.id, row);
    return;
  }
  await withStore(store, 'readwrite', (s) => s.put(row));
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memory[store].delete(id);
    return;
  }
  await withStore(store, 'readwrite', (s) => s.delete(id));
}

/** Every row of a store, or the rows whose `index` field equals `value`. */
export async function dbAll<T extends Row>(store: StoreName, index?: string, value?: string): Promise<T[]> {
  if (!hasIndexedDb()) {
    const rows = [...memory[store].values()] as T[];
    return index ? rows.filter((r) => (r as unknown as Record<string, unknown>)[index] === value) : rows;
  }
  return (await withStore(store, 'readonly', (s) => (index ? s.index(index).getAll(value) : s.getAll()))) as T[];
}

/** Forgets everything (tests). */
export function dbClearMemory() {
  for (const m of Object.values(memory)) m.clear();
}
