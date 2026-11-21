import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MaintenanceService } from '../modules/maintenance/maintenance.service';

/**
 * Runs the retention purge and the storage reconciliation once and prints the counts.
 *   npm run maintenance:run
 * Deleting orphaned files needs MAINTENANCE_DELETE_ORPHANS=true in the environment (default: report only).
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await app.get(MaintenanceService).run();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
