import { Global, Module } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { ErrorReporter, NullErrorReporter, SentryReporter } from './error-reporter';

@Global()
@Module({
  providers: [
    {
      provide: ErrorReporter,
      inject: [ENV],
      useFactory: (env: Env): ErrorReporter =>
        env.SENTRY_DSN && env.NODE_ENV !== 'test'
          ? new SentryReporter({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, release: env.APP_RELEASE })
          : new NullErrorReporter(),
    },
  ],
  exports: [ErrorReporter],
})
export class MonitoringModule {}
