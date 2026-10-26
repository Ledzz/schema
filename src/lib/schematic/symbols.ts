import { genericSymbol, parseSymbol, type SymbolDef } from '../easyeda/symbol';
import type { Project, StoredSymbol } from './types';

const parsed = new Map<string, { source: StoredSymbol; def: SymbolDef }>();

export function resolveSymbol(stored: StoredSymbol | undefined): SymbolDef {
  if (!stored) return genericSymbol('?', 2);
  if (stored.def) return stored.def;
  if (stored.source === 'generic' || !stored.dataStr) return genericSymbol(stored.title, stored.pinCount ?? 2);
  return parseSymbol(stored.dataStr, stored.title);
}

/** Parsed symbol for a key, memoized on the stored object identity. */
export function symbolFor(project: Pick<Project, 'symbols'>, key: string): SymbolDef {
  const stored = project.symbols[key];
  const hit = parsed.get(key);
  if (hit && hit.source === stored) return hit.def;
  const def = resolveSymbol(stored);
  if (stored) parsed.set(key, { source: stored, def });
  return def;
}

export type SymbolResolver = (key: string) => SymbolDef;

export const resolverFor = (project: Pick<Project, 'symbols'>): SymbolResolver => (key) => symbolFor(project, key);
