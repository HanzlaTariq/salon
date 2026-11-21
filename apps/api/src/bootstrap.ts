import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from '@nestjs/common';
import { routeTemplate } from './common/errors/all-exceptions.filter';
import { Env } from './config/env';

/** Every API answer is private and uncacheable unless a route sets its own header later (QR poster / landing page do). */
export function noStoreByDefault(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  next();
}

/** Logs a warning for requests slower than `thresholdMs` (0 = off): route template, status and duration only. */
export function slowRequestLogger(thresholdMs: number, logger: Pick<Logger, 'warn'> = new Logger('Http')) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (thresholdMs <= 0) return next();
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      if (ms >= thresholdMs) logger.warn({ event: 'http.slow', method: req.method, route: routeTemplate(req), status: res.statusCode, durationMs: ms, requestId: String(res.getHeader('x-request-id') ?? '') });
    });
    next();
  };
}

/**
 * Shared by main.ts and e2e tests so tests exercise the REAL security configuration.
 */
export function configureApp(app: INestApplication, env: Env): void {
  // `s/:code` is the address printed in every QR code (Phase 11), so it lives at the site root, not under the API prefix.
  app.setGlobalPrefix('api/v1', { exclude: ['s/:code'] });

  // Behind a load balancer req.ip is the proxy unless told how many hops to trust; rate limits,
  // lockout audit data and session IPs all depend on it.
  app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(cookieParser());
  app.use(noStoreByDefault);
  app.use(slowRequestLogger(env.SLOW_REQUEST_MS));

  // Slow-loris protection: a request must arrive completely within these limits.
  const server = app.getHttpServer();
  server.requestTimeout = env.REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(20_000, env.REQUEST_TIMEOUT_MS);

  app.use(
    helmet({
      // API only serves JSON; lock down everything.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  // Strict allowlist (parseEnv rejects '*'). Empty list => no cross-origin access.
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-CSRF-Token'],
    maxAge: 600,
  });

  // Reject unknown properties: blocks mass-assignment (client-sent role / price / salonId).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  if (env.ENABLE_SWAGGER && env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Salon Platform API').setVersion('0.1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  app.getHttpAdapter().getInstance().disable('x-powered-by');
}
