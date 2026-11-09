import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { ENV, Env } from '../../config/env';
import { SalonRecord, SalonType } from './salon.types';
import { SalonsRepository, Tx } from './salons.repository';

/** Only fields meant for customers. No owner identity, no e-mail, no review fields. */
const publicView = (s: SalonRecord) => ({
  id: s.id, name: s.name, salonType: s.salonType, city: s.city, area: s.area, addressLine: s.addressLine, phone: s.phone,
  description: s.description, latitude: s.latitude, longitude: s.longitude,
});

/**
 * Public visibility rule: a salon is reachable here ONLY while APPROVED. Enforced twice: by the SQL
 * filter and by the RLS policy `public_read_approved` (which needs `app.public_read`, set by withPublicRead).
 * Search, nearby (PostGIS), ratings and prices arrive in Phase 7.
 */
@Injectable()
export class PublicSalonsService {
  private readonly logger = new Logger(PublicSalonsService.name);

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: SalonsRepository,
    private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(f: { q?: string; city?: string; area?: string; type?: SalonType; page: number; pageSize: number }) {
    const r = await this.tenant.withPublicRead((tx: Tx) =>
      this.repo.publicList(tx, { q: f.q, city: f.city, area: f.area, type: f.type, limit: f.pageSize, offset: (f.page - 1) * f.pageSize }),
    );
    return { items: r.items.map(publicView), total: r.total, page: f.page, pageSize: f.pageSize };
  }

  async detail(id: string) {
    const { salon, photos } = await this.tenant.withPublicRead(async (tx: Tx) => {
      const s = await this.repo.findById(tx, id);
      if (!s || s.status !== 'APPROVED') throw new AppException('NOT_FOUND', 'Salon not found.', 404);
      return { salon: s, photos: await this.repo.listPublicPhotos(tx, id) };
    });
    const signed = await Promise.all(
      photos.map(async (p) => {
        try {
          return { id: p.id, isCover: p.docType === 'COVER', url: await this.storage.signedUrl(p.storageKey, this.env.SIGNED_URL_TTL_SEC) };
        } catch {
          this.logger.warn('Could not sign a public photo URL');
          return null;
        }
      }),
    );
    return { ...publicView(salon), photos: signed.filter((x): x is NonNullable<typeof x> => x !== null), photoUrlTtlSec: this.env.SIGNED_URL_TTL_SEC };
  }
}
