import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  it('returns the cached value until the TTL ends, then loads again', async () => {
    let now = 1_000;
    const cache = new TtlCache<number>(100, 10, () => now);
    let loads = 0;
    const load = async () => (loads += 1);
    expect(await cache.getOrLoad('a', load)).toBe(1);
    expect(await cache.getOrLoad('a', load)).toBe(1);
    now += 99;
    expect(await cache.getOrLoad('a', load)).toBe(1);
    now += 2;
    expect(await cache.getOrLoad('a', load)).toBe(2);
    expect(loads).toBe(2);
  });

  it('shares one load between simultaneous callers (single flight)', async () => {
    const cache = new TtlCache<string>(1_000, 10);
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = async () => {
      loads += 1;
      await gate;
      return 'v';
    };
    const all = Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    release();
    expect(await all).toEqual(['v', 'v', 'v']);
    expect(loads).toBe(1);
  });

  it('does not cache a failed load and lets the next caller retry', async () => {
    const cache = new TtlCache<string>(1_000, 10);
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.getOrLoad('k', load)).rejects.toThrow('boom');
    expect(await cache.getOrLoad('k', load)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('keeps at most maxEntries and drops the least recently used first', async () => {
    const cache = new TtlCache<number>(10_000, 2);
    await cache.getOrLoad('a', async () => 1);
    await cache.getOrLoad('b', async () => 2);
    await cache.getOrLoad('a', async () => 99); // touch a: b is now the oldest
    await cache.getOrLoad('c', async () => 3);
    expect(cache.size).toBe(2);
    let reloaded = false;
    await cache.getOrLoad('b', async () => ((reloaded = true), 22));
    expect(reloaded).toBe(true);
  });

  it('rejects nonsense settings', () => {
    expect(() => new TtlCache(0, 5)).toThrow();
    expect(() => new TtlCache(5, 0)).toThrow();
  });
});
