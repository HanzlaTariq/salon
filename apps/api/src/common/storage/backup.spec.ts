import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { backupStorage } from './backup';
import { MemoryObjectStorage } from './object-storage';

describe('backupStorage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'salon-backup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies every object with the same relative path and a verifiable manifest', async () => {
    const s = new MemoryObjectStorage();
    await s.put('salons/a/one.webp', Buffer.from('first'), 'image/webp');
    await s.put('receipts/b/two.webp', Buffer.from('second file'), 'image/webp');
    const r = await backupStorage(s, dir);
    expect(r).toMatchObject({ files: 2, bytes: 16, truncated: false, failed: [] });
    expect((await readFile(join(dir, 'salons/a/one.webp'))).toString()).toBe('first');
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.find((f: { key: string }) => f.key === 'salons/a/one.webp').sha256).toBe(createHash('sha256').update('first').digest('hex'));
  });

  it('never writes outside the target folder', async () => {
    const s = new MemoryObjectStorage();
    await s.put('../escape.txt', Buffer.from('x'), 'text/plain');
    await s.put('/abs.txt', Buffer.from('x'), 'text/plain');
    const r = await backupStorage(s, dir);
    expect(r.files).toBe(0);
    expect(r.failed.sort()).toEqual(['../escape.txt', '/abs.txt']);
    expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false);
  });

  it('reports a failing object instead of aborting the whole backup', async () => {
    const s = new MemoryObjectStorage();
    await s.put('ok/1.webp', Buffer.from('1'), 'image/webp');
    await s.put('bad/2.webp', Buffer.from('2'), 'image/webp');
    const original = s.get.bind(s);
    s.get = async (k: string) => {
      if (k === 'bad/2.webp') throw new Error('boom');
      return original(k);
    };
    const r = await backupStorage(s, dir);
    expect(r.files).toBe(1);
    expect(r.failed).toEqual(['bad/2.webp']);
  });
});
