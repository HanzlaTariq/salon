import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/errors/app-exception';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process is up. No dependencies touched. */
  @Get()
  live() {
    return { data: { status: 'ok' } };
  }

  /** Readiness: database reachable. Details are logged, never returned. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { data: { status: 'ready' } };
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'Service not ready.', 503);
    }
  }
}
