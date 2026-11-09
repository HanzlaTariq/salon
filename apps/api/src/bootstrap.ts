import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Env } from './config/env';

/**
 * Shared by main.ts and e2e tests so tests exercise the REAL security configuration.
 */
export function configureApp(app: INestApplication, env: Env): void {
  app.setGlobalPrefix('api/v1');

  // Behind a load balancer req.ip is the proxy unless told how many hops to trust; rate limits,
  // lockout audit data and session IPs all depend on it.
  app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(cookieParser());

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
