import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Minimal in-memory stand-in for the Redis commands used by RedisThrottlerStorage.
 * It mirrors the real semantics we rely on: INCR, PEXPIRE ... NX, PTTL (-2 missing, -1 no TTL), SET PX.
 */
class FakeRedis {
  private values = new Map<string, number | string>();
  private expiresAt = new Map<string, number>();
  constructor(private readonly now: () => number) {}

  private alive(key: string): boolean {
    const exp = this.expiresAt.get(key);
    if (exp !== undefined && exp <= this.now()) {
      this.values.delete(key);
      this.expiresAt.delete(key);
    }
    return this.values.has(key);
  }

  incr(key: string): number {
    const next = (this.alive(key) ? Number(this.values.get(key)) : 0) + 1;
    this.values.set(key, next);
    return next;
  }

  pexpireNx(key: string, ms: number): number {
    if (!this.alive(key) || this.expiresAt.has(key)) return 0;
    this.expiresAt.set(key, this.now() + ms);
    return 1;
  }

  pttl(key: string): number {
    if (!this.alive(key)) return -2;
    const exp = this.expiresAt.get(key);
    return exp === undefined ? -1 : Math.max(exp - this.now(), 0);
  }

  set(key: string, value: string, _px: 'PX', ms: number): 'OK' {
    this.values.set(key, value);
    this.expiresAt.set(key, this.now() + ms);
    return 'OK';
  }

  multi() {
    const ops: Array<() => unknown> = [];
    const chain = {
      incr: (k: string) => (ops.push(() => this.incr(k)), chain),
      pexpire: (k: string, ms: number, _mode: 'NX') => (ops.push(() => this.pexpireNx(k, ms)), chain),
      pttl: (k: string) => (ops.push(() => this.pttl(k)), chain),
      exec: async () => ops.map((op) => [null, op()]),
    };
    return chain;
  }
}

function setup(opts: { redisDown?: boolean } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const fake = new FakeRedis(now);
  const redis = opts.redisDown
    ? ({
        multi: () => {
          const down = {
            incr: () => down,
            pexpire: () => down,
            pttl: () => down,
            exec: async () => {
              throw new Error('ECONNREFUSED');
            },
          };
          return down;
        },
        set: async () => { throw new Error('ECONNREFUSED'); },
      } as unknown as Redis)
    : (fake as unknown as Redis);
  const fallbackCalls: string[] = [];
  const fallback: ThrottlerStorage = {
    increment: async (key) => {
      fallbackCalls.push(key);
      return { totalHits: 99, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 };
    },
  };
  return { storage: new RedisThrottlerStorage(redis, fallback), advance: (ms: number) => (t += ms), fallbackCalls };
}

describe('RedisThrottlerStorage', () => {
  it('counts hits and keeps the window fixed from the first hit (NX)', async () => {
    const { storage, advance } = setup();
    const a = await storage.increment('k', 60_000, 5, 0, 'default');
    expect(a.totalHits).toBe(1);
    expect(a.timeToExpire).toBe(60_000);

    advance(20_000);
    const b = await storage.increment('k', 60_000, 5, 0, 'default');
    expect(b.totalHits).toBe(2);
    expect(b.timeToExpire).toBe(40_000); // window did not slide forward
  });

  it('starts a new window after the TTL expires', async () => {
    const { storage, advance } = setup();
    await storage.increment('k', 1_000, 5, 0, 'default');
    advance(1_001);
    const again = await storage.increment('k', 1_000, 5, 0, 'default');
    expect(again.totalHits).toBe(1);
  });

  it('isolates counters per key', async () => {
    const { storage } = setup();
    await storage.increment('ip-a', 60_000, 5, 0, 'default');
    const other = await storage.increment('ip-b', 60_000, 5, 0, 'default');
    expect(other.totalHits).toBe(1);
  });

  it('blocks when over the limit and a block duration is set', async () => {
    const { storage, advance } = setup();
    for (let i = 0; i < 3; i++) await storage.increment('k', 60_000, 2, 30_000, 'default');
    const over = await storage.increment('k', 60_000, 2, 30_000, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBe(30_000);

    // Block (30s) and counting window (60s) both have to expire before the client is allowed again.
    advance(60_001);
    const after = await storage.increment('k', 60_000, 2, 30_000, 'default');
    expect(after.isBlocked).toBe(false);
    expect(after.totalHits).toBe(1);
  });

  it('falls back to the in-memory store when Redis is unreachable (availability over strictness)', async () => {
    const { storage, fallbackCalls } = setup({ redisDown: true });
    const result = await storage.increment('10.0.0.1', 60_000, 5, 0, 'default');
    expect(fallbackCalls).toEqual(['10.0.0.1']);
    expect(result.totalHits).toBe(99);
  });
});
