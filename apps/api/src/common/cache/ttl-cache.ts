/**
 * Small in-process cache with a time-to-live, a size cap and "single flight": if ten requests ask for the same missing key at the
 * same moment, the loader runs ONCE and all ten share the result (no thundering herd on the storage API or the database).
 *
 * Rules for using it (Phase 15, docs/PHASE15.md):
 *   - only data that is the same for EVERY caller (public images, platform-wide figures). Never cache anything that depends on
 *     who is asking: a per-user cache is a data leak waiting for a missing key part;
 *   - a failed load is never cached (the next request tries again);
 *   - the cache lives in one process: with several instances each keeps its own copy, which is fine for short TTLs.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(ttlMs > 0) || !(maxEntries > 0)) throw new Error('ttlMs and maxEntries must be positive');
  }

  get size(): number {
    return this.entries.size;
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    const t = this.now();
    if (hit && hit.expiresAt > t) {
      // refresh recency (Map keeps insertion order, so re-inserting makes this the newest entry)
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    if (hit) this.entries.delete(key);

    const running = this.inflight.get(key);
    if (running) return running;

    const p = load()
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private store(key: string, value: V): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    // drop expired first, then the oldest, until we are under the cap
    if (this.entries.size > this.maxEntries) {
      const t = this.now();
      for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
