import { Logger } from '@nestjs/common';
import { ErrorReporter } from './error-reporter';

/**
 * Last line of defence outside any request. An unhandled promise rejection is logged and reported (the process keeps running: one
 * background job failing must not take the API down). An uncaught exception leaves the process in an unknown state, so it is
 * reported, flushed and the process exits; the host restarts it.
 */
export function installProcessHandlers(reporter: ErrorReporter, logger: Pick<Logger, 'error'>, exit: (code: number) => void = process.exit): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ event: 'process.unhandledRejection', err: reason instanceof Error ? reason.message : 'non-error rejection' });
    reporter.capture(reason, { route: 'process:unhandledRejection' });
  });
  process.on('uncaughtException', (error) => {
    logger.error({ event: 'process.uncaughtException', err: error.message });
    reporter.capture(error, { route: 'process:uncaughtException' });
    void reporter.flush(2_000).finally(() => exit(1));
  });
}
