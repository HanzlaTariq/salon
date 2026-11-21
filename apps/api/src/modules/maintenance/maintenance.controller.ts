import { Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/errors/app-exception';
import { secretMatches } from '../../common/util/secret';
import { ENV, Env } from '../../config/env';
import { MaintenanceService } from './maintenance.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;

/**
 * For a cron service on hosting without a long-running process. Disabled (404) unless MAINTENANCE_CRON_SECRET is set. The secret is
 * compared in constant time. The endpoint takes no input and only runs the same idempotent round as the built-in loop; it returns
 * counts only (no keys, no ids).
 */
@ApiTags('internal')
@Controller('internal/maintenance')
export class MaintenanceCronController {
  constructor(private readonly svc: MaintenanceService, @Inject(ENV) private readonly env: Env) {}

  @Public()
  @Post('run')
  @HttpCode(200)
  @Throttle({ default: { limit: () => 6 * factor(), ttl: () => 60_000 } })
  async run(@Headers('x-cron-secret') secret?: string) {
    if (!this.env.MAINTENANCE_CRON_SECRET) throw new AppException('NOT_FOUND', 'Not found.', 404);
    if (!secretMatches(this.env.MAINTENANCE_CRON_SECRET, secret)) throw new AppException('UNAUTHENTICATED', 'Invalid secret.', 401);
    return { data: await this.svc.run() };
  }
}
