import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { backupStorage } from '../common/storage/backup';
import { ObjectStorage } from '../common/storage/object-storage';

/**
 * Downloads every file of the private Supabase bucket into a folder (with manifest.json of SHA-256 hashes).
 *   BACKUP_DIR=./storage-backup npm run storage:backup
 * Encrypt the folder afterwards: infra/backup/backup.sh and backup.ps1 do this for you (docs/BACKUP.md).
 */
async function main(): Promise<void> {
  const dir = process.env.BACKUP_DIR;
  if (!dir) throw new Error('BACKUP_DIR is required (an empty or new folder).');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const r = await backupStorage(app.get(ObjectStorage), dir);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...r, failed: r.failed.length }, null, 2));
    if (r.failed.length > 0 || r.truncated) process.exitCode = 2;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
