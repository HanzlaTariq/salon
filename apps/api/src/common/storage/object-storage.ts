import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../../config/env';

/**
 * Private object storage used ONLY by the backend. Clients never receive a storage credential,
 * a bucket name or a permanent URL: they get a short-lived signed URL from the API after the API
 * has authorised the request.
 */
export interface StoredObject {
  key: string;
  /** null when the storage API did not report it (such objects are never treated as old enough to delete). */
  createdAt: Date | null;
  sizeBytes: number | null;
}

export abstract class ObjectStorage {
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Phase 15: every object under `prefix` (recursive), at most `maxObjects`. Used only by maintenance and backup jobs. */
  abstract list(prefix: string, opts: { maxObjects: number }): Promise<{ objects: StoredObject[]; truncated: boolean }>;
  /** Phase 15: raw bytes of one object (backup job only; never exposed through an endpoint). */
  abstract get(key: string): Promise<Buffer>;
  /** Deleting a missing object is not an error. */
  abstract remove(key: string): Promise<void>;
  abstract signedUrl(key: string, ttlSec: number, opts?: { downloadName?: string }): Promise<string>;
}

/** Test/local-development driver. Refused in production by parseEnv. */
@Injectable()
export class MemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; createdAt?: Date }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.objects.has(key)) throw new Error('object already exists');
    this.objects.set(key, { body, contentType, createdAt: new Date() });
  }

  async list(prefix: string, opts: { maxObjects: number }): Promise<{ objects: StoredObject[]; truncated: boolean }> {
    const all = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, createdAt: o.createdAt ?? null, sizeBytes: o.body.length }));
    return { objects: all.slice(0, opts.maxObjects), truncated: all.length > opts.maxObjects };
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error('object not found');
    return o.body;
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async signedUrl(key: string, ttlSec: number, opts?: { downloadName?: string }): Promise<string> {
    if (!this.objects.has(key)) throw new Error('object not found');
    const dl = opts?.downloadName ? `&download=${encodeURIComponent(opts.downloadName)}` : '';
    return `memory://private/${key}?ttl=${ttlSec}${dl}`;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Supabase Storage over its REST API with the service_role key (backend only). The bucket MUST be
 * private. supabase-js is deliberately not used (project rule: Supabase is managed storage/DB only).
 * Keys are server-generated (`salons/<uuid>/<uuid>.<ext>`), never derived from user input.
 */
@Injectable()
export class SupabaseObjectStorage extends ObjectStorage {
  private readonly logger = new Logger('ObjectStorage');
  private readonly base: string;
  private readonly bucket: string;
  private readonly key: string;

  constructor(@Inject(ENV) env: Env) {
    super();
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase storage is not configured');
    this.base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1`;
    this.bucket = env.SUPABASE_STORAGE_BUCKET;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  private path(objectKey: string): string {
    return objectKey.split('/').map(encodeURIComponent).join('/');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }

  private async call(method: string, url: string, init: { headers?: Record<string, string>; body?: Uint8Array | string }): Promise<Response> {
    try {
      return await fetch(url, { method, ...init, headers: this.headers(init.headers), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // Never log the URL query (signed tokens) or headers (service key).
      this.logger.error(`Storage request failed (${method}): ${(err as Error).name}`);
      throw new Error('Storage unavailable');
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.call('POST', `${this.base}/object/${this.bucket}/${this.path(key)}`, {
      headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': 'private, max-age=3600' },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      this.logger.error(`Storage upload rejected: HTTP ${res.status}`);
      throw new Error('Storage upload failed');
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.call('GET', `${this.base}/object/authenticated/${this.bucket}/${this.path(key)}`, {});
    if (!res.ok) {
      this.logger.error(`Storage download rejected: HTTP ${res.status}`);
      throw new Error('Storage download failed');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Supabase lists ONE folder level per call (folders come back with `id: null`), so this walks the tree. The walk is capped
   * (`maxObjects`, and a folder budget) so a huge or malformed bucket can never keep the job running for ever.
   */
  async list(prefix: string, opts: { maxObjects: number }): Promise<{ objects: StoredObject[]; truncated: boolean }> {
    const objects: StoredObject[] = [];
    const queue: string[] = [prefix.replace(/\/+$/, '')];
    let folders = 0;
    let truncated = false;
    const PAGE = 100;
    while (queue.length > 0) {
      const folder = queue.shift()!;
      if ((folders += 1) > 5000) { truncated = true; break; }
      for (let offset = 0; ; offset += PAGE) {
        const res = await this.call('POST', `${this.base}/object/list/${this.bucket}`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: folder, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        if (!res.ok) {
          this.logger.error(`Storage list rejected: HTTP ${res.status}`);
          throw new Error('Storage list failed');
        }
        const rows = (await res.json().catch(() => null)) as Array<{ name?: string; id?: string | null; created_at?: string; metadata?: { size?: number } | null }> | null;
        if (!Array.isArray(rows)) throw new Error('Storage list failed');
        for (const r of rows) {
          if (typeof r.name !== 'string' || r.name.length === 0) continue;
          const key = folder ? `${folder}/${r.name}` : r.name;
          if (r.id === null || r.id === undefined) {
            queue.push(key); // folder
          } else {
            if (objects.length >= opts.maxObjects) { truncated = true; break; }
            const created = r.created_at ? new Date(r.created_at) : null;
            objects.push({ key, createdAt: created && !Number.isNaN(created.getTime()) ? created : null, sizeBytes: typeof r.metadata?.size === 'number' ? r.metadata.size : null });
          }
        }
        if (truncated || rows.length < PAGE) break;
      }
      if (truncated) break;
    }
    return { objects, truncated };
  }

  async remove(key: string): Promise<void> {
    const res = await this.call('DELETE', `${this.base}/object/${this.bucket}/${this.path(key)}`, {});
    if (!res.ok && res.status !== 404) {
      this.logger.error(`Storage delete rejected: HTTP ${res.status}`);
      throw new Error('Storage delete failed');
    }
  }

  async signedUrl(key: string, ttlSec: number, opts?: { downloadName?: string }): Promise<string> {
    const res = await this.call('POST', `${this.base}/object/sign/${this.bucket}/${this.path(key)}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: ttlSec }),
    });
    if (!res.ok) {
      this.logger.error(`Storage sign rejected: HTTP ${res.status}`);
      throw new Error('Storage sign failed');
    }
    const json = (await res.json().catch(() => null)) as { signedURL?: string } | null;
    if (!json?.signedURL || !json.signedURL.startsWith('/')) throw new Error('Storage sign failed');
    const url = `${this.base}${json.signedURL}`;
    return opts?.downloadName ? `${url}&download=${encodeURIComponent(opts.downloadName)}` : url;
  }
}
