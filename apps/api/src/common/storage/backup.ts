import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { ObjectStorage } from './object-storage';

export interface BackupResult {
  files: number;
  bytes: number;
  truncated: boolean;
  failed: string[];
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,300}$/;

/**
 * Copies every object of the private bucket into `dir` (same relative paths) and writes `manifest.json` with the SHA-256 of
 * each file, so a restore can be verified file by file. The database dump does NOT contain these files (receipts, documents,
 * photos): a backup that only has the dump is not a backup of the product. The folder must then be encrypted (see docs/BACKUP.md).
 */
export async function backupStorage(storage: ObjectStorage, dir: string, opts: { maxObjects?: number } = {}): Promise<BackupResult> {
  const root = resolve(dir);
  const listing = await storage.list('', { maxObjects: opts.maxObjects ?? 100_000 });
  const manifest: Array<{ key: string; sha256: string; bytes: number }> = [];
  const failed: string[] = [];
  let bytes = 0;
  for (const o of listing.objects) {
    // keys are server generated, but a backup tool must never trust a name enough to write outside its folder
    const target = resolve(join(root, o.key));
    if (!SAFE_KEY.test(o.key) || o.key.includes('..') || !target.startsWith(root + sep)) {
      failed.push(o.key);
      continue;
    }
    try {
      const body = await storage.get(o.key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      manifest.push({ key: o.key, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length });
      bytes += body.length;
    } catch {
      failed.push(o.key);
    }
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), truncated: listing.truncated, files: manifest }, null, 2));
  return { files: manifest.length, bytes, truncated: listing.truncated, failed };
}
