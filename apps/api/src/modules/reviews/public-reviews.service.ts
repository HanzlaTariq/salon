import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { DiscoveryRepository } from '../discovery/discovery.repository';
import { ListingPolicy } from '../listing/listing';
import { Tx } from '../salons/salons.repository';
import { PublicReviewsQuery } from './dto/reviews.dto';
import { ReviewsRepository } from './reviews.repository';
import { REVIEW_LIMITS, summarise } from './reviews.types';
import { publicView } from './reviews.views';

/**
 * Phase 14: public reviews of a salon. Runs through withPublicRead, so the database only ever returns PUBLISHED reviews of APPROVED
 * salons; `salon_is_listed()` (the same rule as discovery) decides whether the salon is visible at all.
 */
@Injectable()
export class PublicReviewsService {
  constructor(
    private readonly tenant: TenantDb, private readonly repo: ReviewsRepository, private readonly discovery: DiscoveryRepository,
    private readonly listing: ListingPolicy, private readonly clock: Clock,
  ) {}

  async list(salonId: string, q: PublicReviewsQuery) {
    const pageSize = q.pageSize ?? REVIEW_LIMITS.defaultPageSize;
    const page = q.page ?? 1;
    const sort = q.sort ?? 'recent';
    const data = await this.tenant.withPublicRead(async (tx: Tx) => {
      const p = await this.listing.params(tx);
      if (!(await this.discovery.salonListed(tx, salonId, p.trialDays, p.today))) throw new AppException('NOT_FOUND', 'Salon not found.', 404);
      const [stats, staff, list] = await Promise.all([
        this.repo.salonStats(tx, salonId), this.repo.staffStats(tx, salonId), this.repo.listPublished(tx, salonId, sort, pageSize, (page - 1) * pageSize),
      ]);
      return { stats, staff, list };
    });
    return {
      summary: summarise(data.stats.stars),
      /** Per staff member, only people with at least one rating. */
      staff: data.staff.map((s) => ({ staffId: s.staffId, name: s.name, ...summarise(s.stars) })),
      items: data.list.items.map(publicView),
      page, pageSize, total: data.list.total, hasMore: (page - 1) * pageSize + data.list.items.length < data.list.total, sort,
    };
  }
}
