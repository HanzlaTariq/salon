import { Logger } from '@nestjs/common';
import { ThrottlerModuleOptions, ThrottlerStorageService } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const logger = new Logger('RateLimit');

/**
 * Builds the throttler configuration. With REDIS_URL set, counters are shared through Redis
 * (required in production by env validation). Without it (development/tests), the default
 * in-memory store is used, which is correct for a single instance.
 */
export function buildThrottlerOptions(env: Env): ThrottlerModuleOptions {
  const throttlers = [{ ttl: env.RATE_LIMIT_TTL_MS, limit: env.RATE_LIMIT_MAX }];
  if (!env.REDIS_URL) return { throttlers };

  const redis = new Redis(env.REDIS_URL, {
    // Fail fast: a slow Redis must not stall every request; the fallback takes over instead.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    lazyConnect: false,
  });
  redis.on('error', (error: Error) => {
    logger.warn(`Redis connection error (${error.name})`);
  });

  return {
    throttlers,
    storage: new RedisThrottlerStorage(redis, new ThrottlerStorageService()),
  };
}
