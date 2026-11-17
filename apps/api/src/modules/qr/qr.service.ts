import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { ENV, Env } from '../../config/env';
import { insertAudit } from '../audit/audit.types';
import { ListingPolicy } from '../listing/listing';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { LandingSalon, renderLanding, renderNotAvailable } from './landing';
import { renderPoster } from './poster';
import { QrRepository } from './qr.repository';
import { qrPng, qrSvg } from './qr.render';
import { POSTER_SIZES, POSTER_THEMES, PosterSize, PosterTheme, QR_LIMITS, QrImageFormat, fileSlug, normalizeCode, salonLink } from './qr.types';

const notFound = (what = 'Salon') => new AppException('NOT_FOUND', `${what} not found.`, 404);

/** The public view of a scanned code. Only what a customer needs to open the salon; the full profile comes from the existing public endpoints. */
const scanView = (code: string, s: SalonRecord) => ({ code, salonId: s.id, name: s.name, salonType: s.salonType, city: s.city, area: s.area });

/** Owner side: view, download and print the salon's QR code and poster. The salon is ALWAYS derived from the verified user. */
@Injectable()
export class OwnerQrService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly salons: SalonsRepository,
    private readonly repo: QrRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Finds (or, once, creates) the code of the caller's salon. Only an APPROVED salon has one. */
  private async resolve(user: AuthenticatedUser, meta?: ClientContext): Promise<{ salon: SalonRecord; code: string }> {
    const mine = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!mine) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.tenant.withTenant(toTenantContext(user, mine.id), async (tx: Tx) => {
          const s = await this.salons.findById(tx, mine.id);
          if (!s) throw notFound();
          if (s.status !== 'APPROVED') {
            throw new AppException(
              'CONFLICT',
              s.status === 'SUSPENDED'
                ? 'Your salon is suspended. Its QR code works again once it is reactivated.'
                : 'Your QR code and poster are created when your salon is approved.',
              409,
            );
          }
          let found = await this.repo.findBySalon(tx, s.id);
          if (!found) {
            await this.repo.createIfMissing(tx, s.id);
            found = await this.repo.findBySalon(tx, s.id);
            if (!found) throw new AppException('SERVICE_UNAVAILABLE', 'Could not create the salon link. Please try again.', 503);
            await insertAudit(tx, {
              actorUserId: user.id, actorRole: user.role, action: 'salon.qr_created', targetType: 'salon', targetId: s.id, salonId: s.id,
              ipAddress: meta?.ip, userAgent: meta?.userAgent, requestId: meta?.requestId,
            });
          }
          return { salon: s, code: found.code };
        });
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 3) continue; // astronomically rare code collision: the database picks another code
        throw e;
      }
    }
  }

  async info(user: AuthenticatedUser, meta: ClientContext) {
    const { salon, code } = await this.resolve(user, meta);
    return {
      code, link: salonLink(this.env.PUBLIC_LINK_BASE_URL, code), salonName: salon.name,
      posterSizes: POSTER_SIZES, posterThemes: POSTER_THEMES,
    };
  }

  async image(user: AuthenticatedUser, format: QrImageFormat, sizePx: number | undefined, meta: ClientContext) {
    const { salon, code } = await this.resolve(user, meta);
    const link = salonLink(this.env.PUBLIC_LINK_BASE_URL, code);
    const base = `${fileSlug(salon.name)}-qr`;
    if (format === 'svg') return { body: Buffer.from(await qrSvg(link), 'utf8'), contentType: 'image/svg+xml; charset=utf-8', filename: `${base}.svg` };
    return { body: await qrPng(link, sizePx ?? QR_LIMITS.defaultPx), contentType: 'image/png', filename: `${base}.png` };
  }

  async poster(user: AuthenticatedUser, size: PosterSize, theme: PosterTheme, meta: ClientContext) {
    const { salon, code } = await this.resolve(user, meta);
    const body = await renderPoster({
      salonName: salon.name, salonType: salon.salonType, city: salon.city, area: salon.area, addressLine: salon.addressLine, phone: salon.phone,
      link: salonLink(this.env.PUBLIC_LINK_BASE_URL, code), brandName: this.env.BRAND_NAME, size, theme,
    });
    return { body, contentType: 'application/pdf', filename: `${fileSlug(salon.name)}-poster-${size.toLowerCase()}.pdf` };
  }
}

/** Customer side: what a scanned code points at. No login. A code that is unknown, not approved, suspended or unlisted always looks the same (404). */
@Injectable()
export class PublicQrService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly salons: SalonsRepository,
    private readonly repo: QrRepository,
    private readonly listing: ListingPolicy,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async lookup(raw: string): Promise<{ code: string; salon: SalonRecord } | null> {
    const code = normalizeCode(raw);
    if (!code) return null;
    return this.tenant.withPublicRead(async (tx: Tx) => {
      const id = await this.repo.salonIdByCode(tx, code);
      if (!id) return null;
      const s = await this.salons.findById(tx, id);
      if (!s || s.status !== 'APPROVED') return null;
      const p = await this.listing.params(tx);
      return (await this.salons.isListed(tx, id, p.trialDays, p.today)) ? { code, salon: s } : null;
    });
  }

  /** JSON for the apps: the salon id (then the app loads the profile through the existing public endpoints). */
  async resolve(raw: string) {
    const r = await this.lookup(raw);
    if (!r) throw notFound();
    return scanView(r.code, r.salon);
  }

  /** HTML for a phone camera that opens the link in a browser. */
  async landing(raw: string): Promise<{ status: 200 | 404; html: string }> {
    const r = await this.lookup(raw);
    if (!r) return { status: 404, html: renderNotAvailable(this.env.BRAND_NAME) };
    const s: LandingSalon = r.salon;
    return {
      status: 200,
      html: renderLanding(s, { brandName: this.env.BRAND_NAME, code: r.code, androidUrl: this.env.APP_STORE_URL_ANDROID, iosUrl: this.env.APP_STORE_URL_IOS }),
    };
  }
}
