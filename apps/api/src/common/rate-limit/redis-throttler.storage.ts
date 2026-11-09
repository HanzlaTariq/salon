import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Shared rate-limit counters across API instances (risk R5).
 *
 * Counters are kept in Redis so that N API instances share one budget per client.
 * If Redis is unreachable, requests fall back to the local in-memory store instead of
 * failing: availability wins over a temporarily multiplied limit, and the fallback is logged.
 *
 * Commands use a single MULTI round trip. PEXPIRE ... NX sets the window only on the first hit,
 * so the window does not slide forever for a steady client.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(
    private readonly redis: Redis,
    private readonly fallback: ThrottlerStorage,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const blockKey = `${key}:blocked`;
    try {
      const results = await this.redis
        .multi()
        .incr(key)
        .pexpire(key, ttl, 'NX')
        .pttl(key)
        .pttl(blockKey)
        .exec();

      if (!results) throw new Error('Redis transaction aborted');
      for (const [err] of results) if (err) throw err;

      const totalHits = Number(results[0][1]);
      const timeToExpire = Math.max(Number(results[2][1]), 0);
      let blockTtl = Number(results[3][1]);

      if (blockTtl <= 0 && blockDuration > 0 && totalHits > limit) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
        blockTtl = blockDuration;
      }

      return {
        totalHits,
        timeToExpire,
        isBlocked: blockTtl > 0,
        timeToBlockExpire: Math.max(blockTtl, 0),
      };
    } catch (error) {
      // Never log the key (it contains the client IP); the error class is enough for operators.
      this.logger.warn(`Redis rate-limit store unavailable (${(error as Error).name}); using in-memory fallback`);
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
