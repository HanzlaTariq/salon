import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { PublicUrlSigner } from '../../common/storage/public-url-signer';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { ENV, Env } from '../../config/env';
import { DiscoveryRepository } from '../discovery/discovery.repository';
import { ListingPolicy } from '../listing/listing';
import { Tx } from '../salons/salons.repository';
import { ReviewsRepository } from './reviews.repository';
import { REVIEW_LIMITS } from './reviews.types';

/**
 * Phase 14: a customer's favourite salons. Private to the customer (the database has no policy for anyone else). Only listed salons can
 * be added; a favourite whose salon is later suspended or unlisted simply stops being shown (it is kept, and returns if the salon returns).
 */
@Injectable()
export class FavouritesService {
  private readonly logger = new Logger(FavouritesService.name);

  constructor(
    private readonly tenant: TenantDb, private readonly repo: ReviewsRepository, private readonly discovery: DiscoveryRepository,
    private readonly listing: ListingPolicy, private readonly signer: PublicUrlSigner, @Inject(ENV) private readonly env: Env,
  ) {}

  async list(u: AuthenticatedUser) {
    const rows = await this.tenant.withCustomer(u.id, async (tx: Tx) => {
      const p = await this.listing.params(tx);
      return this.repo.favourites(tx, u.id, p.trialDays, p.today, REVIEW_LIMITS.favouritesMax);
    });
    const items = await Promise.all(rows.map(async (r) => {
      let coverUrl: string | null = null;
      if (r.coverKey) {
        try {
          coverUrl = await this.signer.sign(r.coverKey);
        } catch {
          this.logger.warn('Could not sign a cover photo URL');
        }
      }
      return { salonId: r.salonId, name: r.name, city: r.city, area: r.area, salonType: r.salonType, rating: r.ratingAvg, ratingCount: r.ratingCount, coverUrl, addedAt: r.createdAt };
    }));
    return { items, total: items.length, max: REVIEW_LIMITS.favouritesMax, imageUrlTtlSec: this.signer.guaranteedTtlSec };
  }

  /** Idempotent: adding a salon that is already a favourite succeeds and changes nothing. */
  async add(u: AuthenticatedUser, salonId: string): Promise<{ salonId: string; favourite: true }> {
    try {
      await this.tenant.withCustomer(u.id, async (tx: Tx) => {
        const p = await this.listing.params(tx);
        if (!(await this.discovery.salonListed(tx, salonId, p.trialDays, p.today))) throw new AppException('NOT_FOUND', 'Salon not found.', 404);
        await this.repo.addFavourite(tx, u.id, salonId);
      });
    } catch (e) {
      if (sqlState(e) === '23514') throw new AppException('CONFLICT', `You can have at most ${REVIEW_LIMITS.favouritesMax} favourite salons.`, 409, { reason: 'LIMIT' });
      throw e;
    }
    return { salonId, favourite: true };
  }

  /** Idempotent: removing something that is not a favourite succeeds. */
  async remove(u: AuthenticatedUser, salonId: string): Promise<void> {
    await this.tenant.withCustomer(u.id, (tx: Tx) => this.repo.removeFavourite(tx, u.id, salonId));
  }
}
