import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { MaintenanceService } from './maintenance.service';

const FIRST_RUN_DELAY_MS = 2 * 60_000;
const EVERY_MS = 6 * 3_600_000;

/**
 * Runs the maintenance job inside the API process every 6 hours when MAINTENANCE_WORKER_ENABLED=true (never in tests).
 * On serverless hosting (no long-running process) turn it off and call POST /internal/maintenance/run from a cron service.
 */
@Injectable()
export class MaintenanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Maintenance');
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly svc: MaintenanceService, @Inject(ENV) private readonly env: Env) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test' || !this.env.MAINTENANCE_WORKER_ENABLED) return;
    const run = () => {
      this.svc.run().catch((e) => this.logger.error(`maintenance failed: ${e instanceof Error ? e.message : 'unknown'}`));
    };
    this.first = setTimeout(run, FIRST_RUN_DELAY_MS);
    this.first.unref();
    this.timer = setInterval(run, EVERY_MS);
    this.timer.unref();
    this.logger.log('maintenance worker started (every 6 h)');
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }
}
