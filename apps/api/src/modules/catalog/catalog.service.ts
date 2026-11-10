import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { processUpload } from '../../common/uploads/process-upload';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { insertAudit } from '../audit/audit.types';
import { displayName } from '../salons/salon-views';
import { PROFILE_EDITABLE, SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { CatalogRepository } from './catalog.repository';
import {
  CATALOG_LIMITS, CategoryRecord, PlannedAssignment, ServiceRecord, StaffRecord, isCompleteOrdering, planPricing,
} from './catalog.types';
import {
  CreateCategoryDto, CreateServiceDto, CreateStaffDto, UpdateCategoryDto, UpdateServiceDto, UpdateStaffDto,
} from './dto/catalog.dto';

export const categoryView = (c: CategoryRecord) => ({
  id: c.id, name: c.name, description: c.description, isActive: c.isActive, displayOrder: c.displayOrder, imageFileId: c.imageFileId,
});

export const staffView = (s: StaffRecord) => ({ id: s.id, displayName: s.displayName, isOwner: s.isOwner, isActive: s.isActive });

export const serviceView = (s: ServiceRecord, staff: ReadonlyArray<PlannedAssignment>) => ({
  id: s.id, categoryId: s.categoryId, name: s.name, description: s.description, durationMinutes: s.durationMinutes,
  pricingMode: s.pricingMode, price: s.basePrice, imageFileId: s.imageFileId, isActive: s.isActive,
  staff: staff.map((a) => ({ staffId: a.staffId, price: a.price })),
});

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const locked = (status: string) =>
  new AppException('CONFLICT', `The catalogue cannot be changed while the salon is ${status.toLowerCase()}.`, 409);
const limitReached = (what: string, max: number) => new AppException('CONFLICT', `You can have at most ${max} ${what}.`, 409);
const blankToNull = (v: string | null | undefined): string | null | undefined => (typeof v === 'string' && v.trim() === '' ? null : v);

type Target = 'category' | 'service';

/**
 * Owner-side catalogue: categories, services (fixed or staff-based pricing), the minimal staff roster and
 * staff-service assignments. The salon id is ALWAYS derived from the verified session (owner_user_id), never
 * from the request. Every mutation runs in ONE transaction that first locks the salon row, so concurrent
 * edits of the same salon are serialised (limits, ordering and uniqueness stay consistent).
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: CatalogRepository,
    private readonly salons: SalonsRepository,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Runs `fn` inside the tenant transaction of the caller's own salon. Writes lock the salon and require an editable status. */
  private async scoped<T>(user: AuthenticatedUser, write: boolean, fn: (tx: Tx, salon: SalonRecord) => Promise<T>): Promise<T> {
    const found = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!found) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
    return this.tenant.withTenant(toTenantContext(user, found.id), async (tx: Tx) => {
      const salon = write ? await this.salons.lockById(tx, found.id) : await this.salons.findById(tx, found.id);
      if (!salon) throw new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
      if (write && !PROFILE_EDITABLE.includes(salon.status)) throw locked(salon.status);
      return fn(tx, salon);
    });
  }

  private audit(user: AuthenticatedUser, meta: ClientContext, salonId: string, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) {
    return {
      actorUserId: user.id, actorRole: user.role, action, targetType, targetId, salonId,
      ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: metadata ?? null,
    };
  }

  // ------------------------------------------------------------------ overview
  /** Everything the owner app needs in one call. */
  async getCatalog(user: AuthenticatedUser) {
    return this.scoped(user, false, async (tx, salon) => {
      const [cats, services, assigns, staff] = await Promise.all([
        this.repo.listCategories(tx, salon.id), this.repo.listServices(tx, salon.id),
        this.repo.listAssignments(tx, salon.id), this.repo.listStaff(tx, salon.id),
      ]);
      return {
        canEdit: PROFILE_EDITABLE.includes(salon.status),
        categories: cats.map((c) => ({
          ...categoryView(c),
          services: services.filter((s) => s.categoryId === c.id).map((s) => serviceView(s, assigns.filter((a) => a.serviceId === s.id))),
        })),
        staff: staff.map(staffView),
        limits: CATALOG_LIMITS,
      };
    });
  }

  // ------------------------------------------------------------------ categories
  async createCategory(user: AuthenticatedUser, dto: CreateCategoryDto, meta: ClientContext) {
    try {
      return await this.scoped(user, true, async (tx, salon) => {
        if ((await this.repo.countCategories(tx, salon.id)) >= CATALOG_LIMITS.categories) throw limitReached('categories', CATALOG_LIMITS.categories);
        const now = this.clock.now();
        const order = await this.repo.nextCategoryOrder(tx, salon.id);
        const c = await this.repo.insertCategory(tx, salon.id, {
          name: dto.name, description: blankToNull(dto.description) ?? null, isActive: dto.isActive ?? true, displayOrder: order,
        }, now);
        await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.category_created', 'service_category', c.id, { name: c.name }));
        return categoryView(c);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'You already have a category with this name.', 409);
      throw e;
    }
  }

  async updateCategory(user: AuthenticatedUser, id: string, dto: UpdateCategoryDto, meta: ClientContext) {
    try {
      return await this.scoped(user, true, async (tx, salon) => {
        const cur = await this.repo.findCategory(tx, salon.id, id);
        if (!cur) throw notFound('Category');
        const desc = blankToNull(dto.description);
        const next = await this.repo.updateCategory(tx, salon.id, id, {
          name: dto.name ?? cur.name, description: desc !== undefined ? desc : cur.description, isActive: dto.isActive ?? cur.isActive,
        }, this.clock.now());
        await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.category_updated', 'service_category', id, {
          fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined),
        }));
        return categoryView(next);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'You already have a category with this name.', 409);
      throw e;
    }
  }

  async deleteCategory(user: AuthenticatedUser, id: string, meta: ClientContext): Promise<void> {
    const out: { key: string | null } = { key: null };
    await this.scoped(user, true, async (tx, salon) => {
      const cur = await this.repo.findCategory(tx, salon.id, id);
      if (!cur) throw notFound('Category');
      if ((await this.repo.countServicesInCategory(tx, salon.id, id)) > 0) {
        throw new AppException('CONFLICT', 'This category still has services. Move or delete them first.', 409);
      }
      const now = this.clock.now();
      await this.repo.softDeleteCategory(tx, salon.id, id, now);
      if (cur.imageFileId) out.key = (await this.salons.softDeleteFile(tx, salon.id, cur.imageFileId, now))?.storageKey ?? null;
      await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.category_deleted', 'service_category', id, { name: cur.name }));
    });
    await this.removeQuietly(out.key ? [out.key] : []);
  }

  async reorderCategories(user: AuthenticatedUser, ids: string[], meta: ClientContext) {
    await this.scoped(user, true, async (tx, salon) => {
      const existing = await this.repo.listCategories(tx, salon.id);
      if (!isCompleteOrdering(ids, existing.map((c) => c.id))) {
        throw new AppException('VALIDATION_FAILED', 'Send every category id exactly once, in the order you want.', 400);
      }
      const now = this.clock.now();
      for (let i = 0; i < ids.length; i++) await this.repo.setCategoryOrder(tx, salon.id, ids[i], i, now);
      await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.categories_reordered', 'salon', salon.id));
    });
    return this.getCatalog(user);
  }

  // ------------------------------------------------------------------ services
  async createService(user: AuthenticatedUser, dto: CreateServiceDto, meta: ClientContext) {
    const plan = planPricing({ mode: 'FIXED', basePrice: null }, [], { pricing: dto.pricing, staff: dto.staff });
    if (!plan.ok) throw new AppException('VALIDATION_FAILED', plan.message, 400);
    try {
      return await this.scoped(user, true, async (tx, salon) => {
        if (!(await this.repo.findCategory(tx, salon.id, dto.categoryId))) throw notFound('Category');
        if ((await this.repo.countServices(tx, salon.id)) >= CATALOG_LIMITS.services) throw limitReached('services', CATALOG_LIMITS.services);
        await this.assertStaffExist(tx, salon.id, plan.assignments.map((a) => a.staffId));
        const now = this.clock.now();
        const s = await this.repo.insertService(tx, salon.id, {
          categoryId: dto.categoryId, name: dto.name, description: blankToNull(dto.description) ?? null, durationMinutes: dto.durationMinutes,
          mode: plan.mode, basePrice: plan.basePrice, isActive: dto.isActive ?? true,
        }, now);
        for (const a of plan.assignments) await this.repo.insertAssignment(tx, salon.id, s.id, a.staffId, plan.mode, a.price);
        await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.service_created', 'service', s.id, {
          name: s.name, pricingMode: s.pricingMode, staffCount: plan.assignments.length,
        }));
        return serviceView(s, plan.assignments);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'A service with this name already exists in this category.', 409);
      throw e;
    }
  }

  async updateService(user: AuthenticatedUser, id: string, dto: UpdateServiceDto, meta: ClientContext) {
    try {
      return await this.scoped(user, true, async (tx, salon) => {
        const cur = await this.repo.findService(tx, salon.id, id);
        if (!cur) throw notFound('Service');
        if (dto.categoryId && dto.categoryId !== cur.categoryId && !(await this.repo.findCategory(tx, salon.id, dto.categoryId))) {
          throw notFound('Category');
        }
        const existing = await this.repo.listAssignmentsOf(tx, salon.id, id);
        const plan = planPricing({ mode: cur.pricingMode, basePrice: cur.basePrice }, existing, { pricing: dto.pricing, staff: dto.staff });
        if (!plan.ok) throw new AppException('VALIDATION_FAILED', plan.message, 400);
        if (plan.rewriteAssignments) await this.assertStaffExist(tx, salon.id, plan.assignments.map((a) => a.staffId));

        const desc = blankToNull(dto.description);
        // The pricing mode is part of the assignments' composite foreign key: clear them, change the service, re-insert.
        if (plan.rewriteAssignments) await this.repo.deleteAssignmentsOf(tx, salon.id, id);
        const next = await this.repo.updateService(tx, salon.id, id, {
          categoryId: dto.categoryId ?? cur.categoryId, name: dto.name ?? cur.name, description: desc !== undefined ? desc : cur.description,
          durationMinutes: dto.durationMinutes ?? cur.durationMinutes, mode: plan.mode, basePrice: plan.basePrice, isActive: dto.isActive ?? cur.isActive,
        }, this.clock.now());
        if (plan.rewriteAssignments) {
          for (const a of plan.assignments) await this.repo.insertAssignment(tx, salon.id, id, a.staffId, plan.mode, a.price);
        }
        await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.service_updated', 'service', id, {
          fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined),
          ...(plan.modeChanged ? { pricingModeFrom: cur.pricingMode, pricingModeTo: plan.mode } : {}),
        }));
        return serviceView(next, plan.assignments);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'A service with this name already exists in this category.', 409);
      throw e;
    }
  }

  async deleteService(user: AuthenticatedUser, id: string, meta: ClientContext): Promise<void> {
    const out: { key: string | null } = { key: null };
    await this.scoped(user, true, async (tx, salon) => {
      const cur = await this.repo.findService(tx, salon.id, id);
      if (!cur) throw notFound('Service');
      const now = this.clock.now();
      await this.repo.deleteAssignmentsOf(tx, salon.id, id);
      await this.repo.softDeleteService(tx, salon.id, id, now);
      if (cur.imageFileId) out.key = (await this.salons.softDeleteFile(tx, salon.id, cur.imageFileId, now))?.storageKey ?? null;
      await insertAudit(tx, this.audit(user, meta, salon.id, 'catalog.service_deleted', 'service', id, { name: cur.name }));
    });
    await this.removeQuietly(out.key ? [out.key] : []);
  }

  // ------------------------------------------------------------------ staff roster (minimal; Phase 5 extends it)
  async createStaff(user: AuthenticatedUser, dto: CreateStaffDto, meta: ClientContext) {
    const self = dto.self === true;
    if (!self && !dto.displayName) throw new AppException('VALIDATION_FAILED', 'displayName is required.', 400);
    const name = (dto.displayName ?? user.fullName).trim().slice(0, 80);
    try {
      return await this.scoped(user, true, async (tx, salon) => {
        if ((await this.repo.countStaff(tx, salon.id)) >= CATALOG_LIMITS.staff) throw limitReached('staff members', CATALOG_LIMITS.staff);
        const s = await this.repo.insertStaff(tx, salon.id, { userId: self ? user.id : null, displayName: name, isOwner: self }, this.clock.now());
        await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.created', 'staff_profile', s.id, { isOwner: self }));
        return staffView(s);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'You are already on your staff list.', 409);
      throw e;
    }
  }

  async updateStaff(user: AuthenticatedUser, id: string, dto: UpdateStaffDto, meta: ClientContext) {
    return this.scoped(user, true, async (tx, salon) => {
      const cur = await this.repo.findStaff(tx, salon.id, id);
      if (!cur) throw notFound('Staff member');
      const next = await this.repo.updateStaff(tx, salon.id, id, { displayName: dto.displayName ?? cur.displayName, isActive: dto.isActive ?? cur.isActive }, this.clock.now());
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.updated', 'staff_profile', id, {
        fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined),
      }));
      return staffView(next);
    });
  }

  async deleteStaff(user: AuthenticatedUser, id: string, meta: ClientContext): Promise<void> {
    await this.scoped(user, true, async (tx, salon) => {
      const cur = await this.repo.findStaff(tx, salon.id, id);
      if (!cur) throw notFound('Staff member');
      await this.repo.deleteAssignmentsOfStaff(tx, salon.id, id);
      await this.repo.softDeleteStaff(tx, salon.id, id, this.clock.now());
      await insertAudit(tx, this.audit(user, meta, salon.id, 'staff.deleted', 'staff_profile', id, { isOwner: cur.isOwner }));
    });
  }

  // ------------------------------------------------------------------ images (category / service picture)
  async setImage(user: AuthenticatedUser, target: Target, id: string, file: { buffer: Buffer; originalname?: string } | undefined, meta: ClientContext) {
    if (!file || !file.buffer || file.buffer.length === 0) throw new AppException('VALIDATION_FAILED', 'A file is required (multipart field "file").', 400);
    // Cheap pre-check so nothing is processed or uploaded for an unknown id.
    const salonId = await this.scoped(user, false, async (tx, salon) => {
      if (!(await this.find(tx, target, salon.id, id))) throw notFound(target === 'category' ? 'Category' : 'Service');
      return salon.id;
    });
    const processed = await processUpload(file.buffer, { allowPdf: false, maxBytes: this.env.UPLOAD_MAX_BYTES });
    const fileId = randomUUID();
    const key = `salons/${salonId}/${fileId}.${processed.ext}`; // server-generated; user input never reaches the key
    try {
      await this.storage.put(key, processed.body, processed.contentType);
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
    const out: { oldKey: string | null } = { oldKey: null };
    try {
      await this.scoped(user, true, async (tx, salon) => {
        const cur = await this.find(tx, target, salon.id, id);
        if (!cur) throw notFound(target === 'category' ? 'Category' : 'Service');
        const now = this.clock.now();
        await this.salons.insertFile(tx, {
          id: fileId, salonId: salon.id, kind: 'PHOTO', docType: 'CATALOG', storageKey: key, contentType: processed.contentType,
          sizeBytes: processed.sizeBytes, sha256: processed.sha256, originalName: displayName(file.originalname), uploadedBy: user.id,
        });
        await this.attach(tx, target, salon.id, id, fileId, now);
        if (cur.imageFileId) out.oldKey = (await this.salons.softDeleteFile(tx, salon.id, cur.imageFileId, now))?.storageKey ?? null;
        await insertAudit(tx, this.audit(user, meta, salon.id, `catalog.${target}_image_set`, target === 'category' ? 'service_category' : 'service', id, { sizeBytes: processed.sizeBytes }));
      });
    } catch (e) {
      await this.removeQuietly([key]); // never leave an orphan object behind
      throw e;
    }
    await this.removeQuietly(out.oldKey ? [out.oldKey] : []);
    return { imageFileId: fileId };
  }

  async removeImage(user: AuthenticatedUser, target: Target, id: string, meta: ClientContext): Promise<void> {
    const out: { key: string | null } = { key: null };
    await this.scoped(user, true, async (tx, salon) => {
      const cur = await this.find(tx, target, salon.id, id);
      if (!cur) throw notFound(target === 'category' ? 'Category' : 'Service');
      if (!cur.imageFileId) return;
      const now = this.clock.now();
      await this.attach(tx, target, salon.id, id, null, now);
      out.key = (await this.salons.softDeleteFile(tx, salon.id, cur.imageFileId, now))?.storageKey ?? null;
      await insertAudit(tx, this.audit(user, meta, salon.id, `catalog.${target}_image_removed`, target === 'category' ? 'service_category' : 'service', id));
    });
    await this.removeQuietly(out.key ? [out.key] : []);
  }

  /** Short-lived signed URL for a catalogue image of the caller's own salon (owner app thumbnails). */
  async imageUrl(user: AuthenticatedUser, target: Target, id: string) {
    const key = await this.scoped(user, false, async (tx, salon) => {
      const cur = await this.find(tx, target, salon.id, id);
      if (!cur || !cur.imageFileId) throw new AppException('NOT_FOUND', 'No image.', 404);
      const f = await this.salons.findFile(tx, salon.id, cur.imageFileId);
      if (!f || f.docType !== 'CATALOG') throw new AppException('NOT_FOUND', 'No image.', 404);
      return f.storageKey;
    });
    try {
      return { url: await this.storage.signedUrl(key, this.env.SIGNED_URL_TTL_SEC), expiresInSec: this.env.SIGNED_URL_TTL_SEC };
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
  }

  // ------------------------------------------------------------------ helpers
  private find(tx: Tx, target: Target, salonId: string, id: string): Promise<{ imageFileId: string | null } | null> {
    return target === 'category' ? this.repo.findCategory(tx, salonId, id) : this.repo.findService(tx, salonId, id);
  }

  private attach(tx: Tx, target: Target, salonId: string, id: string, fileId: string | null, now: Date): Promise<void> {
    return target === 'category' ? this.repo.setCategoryImage(tx, salonId, id, fileId, now) : this.repo.setServiceImage(tx, salonId, id, fileId, now);
  }

  /** Every staff id must belong to this salon (the composite foreign key is the second wall). */
  private async assertStaffExist(tx: Tx, salonId: string, staffIds: string[]): Promise<void> {
    if (staffIds.length === 0) return;
    const have = new Set((await this.repo.listStaff(tx, salonId)).map((s) => s.id));
    if (!staffIds.every((id) => have.has(id))) throw new AppException('NOT_FOUND', 'One or more staff members were not found.', 404);
  }

  private async removeQuietly(keys: string[]): Promise<void> {
    for (const k of keys) {
      try {
        await this.storage.remove(k);
      } catch {
        this.logger.warn('Failed to delete a storage object (orphan left for cleanup)');
      }
    }
  }
}
