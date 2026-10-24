/** Small in-memory LRU cache with per-entry TTL that also de-duplicates in-flight loads. */
export class TtlCache<V> {
  private entries = new Map<string, { value: Promise<V>; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = load();
    this.entries.set(key, { value, expires: now + this.ttlMs });
    // Failed loads must not be cached.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }
}
