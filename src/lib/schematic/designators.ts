import type { Component } from './types';

export function splitDesignator(d: string): { prefix: string; n: number | null } {
  const m = /^([A-Za-z_]+)(\d+)$/.exec(d);
  return m ? { prefix: m[1], n: Number(m[2]) } : { prefix: d.replace(/[\d?]+$/, ''), n: null };
}

/** Smallest unused number for a designator prefix. */
export function nextDesignator(prefix: string, components: Pick<Component, 'designator'>[]): string {
  const used = new Set<number>();
  for (const c of components) {
    const { prefix: p, n } = splitDesignator(c.designator);
    if (p === prefix && n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${prefix}${n}`;
}

/** Renumbers every designator by position: top-to-bottom, then left-to-right. */
export function annotate(components: Component[]): Map<string, string> {
  const result = new Map<string, string>();
  const byPrefix = new Map<string, Component[]>();
  for (const c of components) {
    const { prefix } = splitDesignator(c.designator);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), c]);
  }
  for (const [prefix, list] of byPrefix) {
    list
      .slice()
      .sort((a, b) => Math.round(a.y / 50) - Math.round(b.y / 50) || a.x - b.x)
      .forEach((c, i) => result.set(c.id, `${prefix}${i + 1}`));
  }
  return result;
}
