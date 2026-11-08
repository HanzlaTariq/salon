import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { LoggerModule } from 'nestjs-pino';
import { TenancyModule } from './common/tenancy/tenancy.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AppConfigModule } from './config/config.module';
import { ENV, Env, parseEnv } from './config/env';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './prisma/prisma.module';

const env = parseEnv();

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        // Correlate logs with the requestId returned to clients in error responses.
        genReqId: (req, res) => {
          const incoming = req.headers['x-request-id'];
          const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        // Never log credentials or tokens.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
        transport:
          env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      },
    }),
    ThrottlerModule.forRoot([{ ttl: env.RATE_LIMIT_TTL_MS, limit: env.RATE_LIMIT_MAX }]),
    PrismaModule,
    TenancyModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

export type { Env };
export { ENV };
