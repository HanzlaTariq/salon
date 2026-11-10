import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { ENV, Env } from '../../config/env';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { CatalogRepository } from './catalog.repository';
import { priceRange } from './catalog.types';

/** Signing is one storage call per image; cap it so a huge menu cannot fan out unboundedly (cache/CDN: Phase 15). */
const MAX_SIGNED_IMAGES = 60;

/**
 * Customer-facing catalogue of an APPROVED salon. Visibility is enforced twice: by the SQL filters and by the
 * RLS policies `public_read_approved` (they only match inside TenantDb.withPublicRead). Only ACTIVE categories,
 * services and staff are shown, and a service appears only while at least one active staff member performs it.
 */
@Injectable()
export class PublicCatalogService {
  private readonly logger = new Logger(PublicCatalogService.name);

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: CatalogRepository,
    private readonly salons: SalonsRepository,
    private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async catalog(salonId: string) {
    const { cats, services, assigns } = await this.tenant.withPublicRead(async (tx: Tx) => {
      const s = await this.salons.findById(tx, salonId);
      if (!s || s.status !== 'APPROVED') throw new AppException('NOT_FOUND', 'Salon not found.', 404);
      const [cats, services, assigns] = await Promise.all([
        this.repo.publicCategories(tx, salonId), this.repo.publicServices(tx, salonId), this.repo.publicAssignments(tx, salonId),
      ]);
      return { cats, services, assigns };
    });

    const visible = services
      .map((s) => ({ s, staff: assigns.filter((a) => a.serviceId === s.id) }))
      .filter((x) => x.staff.length > 0);

    const keys = [...new Set([...cats.map((c) => c.imageKey), ...visible.map((x) => x.s.imageKey)].filter((k): k is string => !!k))].slice(0, MAX_SIGNED_IMAGES);
    const urls = new Map<string, string>();
    await Promise.all(keys.map(async (k) => {
      try {
        urls.set(k, await this.storage.signedUrl(k, this.env.SIGNED_URL_TTL_SEC));
      } catch {
        this.logger.warn('Could not sign a catalogue image URL');
      }
    }));
    const url = (k: string | null) => (k ? urls.get(k) ?? null : null);

    return {
      categories: cats
        .map((c) => ({
          id: c.id, name: c.name, description: c.description, imageUrl: url(c.imageKey),
          services: visible.filter((x) => x.s.categoryId === c.id).map(({ s, staff }) => {
            const range = priceRange(s.pricingMode, s.basePrice, staff.map((a) => a.price));
            return {
              id: s.id, name: s.name, description: s.description, durationMinutes: s.durationMinutes, pricingMode: s.pricingMode,
              priceFrom: range?.from ?? null, priceTo: range?.to ?? null, imageUrl: url(s.imageKey),
              // Customers always see the exact price of each staff member (the salon-wide price for FIXED services).
              staff: staff.map((a) => ({ id: a.staffId, name: a.staffName, price: s.pricingMode === 'FIXED' ? s.basePrice : a.price })),
            };
          }),
        }))
        .filter((c) => c.services.length > 0),
      imageUrlTtlSec: this.env.SIGNED_URL_TTL_SEC,
    };
  }
}
