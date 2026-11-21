import { Module } from '@nestjs/common';
import { MaintenanceCronController } from './maintenance.controller';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { MaintenanceService } from './maintenance.service';

@Module({
  controllers: [MaintenanceCronController],
  providers: [MaintenanceService, MaintenanceScheduler],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
