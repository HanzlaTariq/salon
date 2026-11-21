import { Inject, Injectable } from '@nestjs/common';
import { TtlCache } from '../cache/ttl-cache';
import { ENV, Env } from '../../config/env';
import { ObjectStorage } from './object-storage';

/**
 * Signed URLs for PUBLIC images only (salon cover and photos, catalogue images). Every search card, catalogue page and favourites
 * list used to call the storage API once per image on every request (risk R26). The URL of an image is the same for every
 * viewer, so it is signed once and reused for half of its lifetime; a URL handed out is therefore always valid for at least
 * `guaranteedTtlSec` more seconds, and that is the number responses report as the image URL lifetime.
 *
 * NEVER use this for anything private (salon documents, payment receipts, personal data): those keep calling
 * `ObjectStorage.signedUrl` directly, one fresh short-lived URL per authorised request.
 */
@Injectable()
export class PublicUrlSigner {
  private readonly cache: TtlCache<string>;
  /** Seconds a returned URL is still guaranteed to work. */
  readonly guaranteedTtlSec: number;

  constructor(private readonly storage: ObjectStorage, @Inject(ENV) private readonly env: Env) {
    this.guaranteedTtlSec = Math.max(15, Math.floor(env.SIGNED_URL_TTL_SEC / 2));
    this.cache = new TtlCache<string>(this.guaranteedTtlSec * 1000, 2_000);
  }

  /** Throws when the object cannot be signed (callers already log and show the image as missing). */
  sign(key: string): Promise<string> {
    return this.cache.getOrLoad(key, () => this.storage.signedUrl(key, this.env.SIGNED_URL_TTL_SEC));
  }
}
