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
import { MailService } from '../auth/mail/mail.service';
import { CreateSalonDto, SetOpeningHoursDto, UpdateSalonDto, UploadFileDto } from './dto/salon.dto';
import { validateWeek, weekFromRows } from './opening-hours';
import { displayName, fileView, ownerSalonView } from './salon-views';
import {
  DOCUMENT_TYPES, FileDocType, MULTI_SLOT_LIMITS, OWNER_EDITABLE, PHOTO_TYPES, PROFILE_EDITABLE, SalonRecord, computeMissing, isComplete, isMultiSlot,
} from './salon.types';
import { SalonProfile, SalonsRepository, Tx } from './salons.repository';

const profileOf = (s: SalonRecord): SalonProfile => ({
  name: s.name, salonType: s.salonType, city: s.city, area: s.area, addressLine: s.addressLine, phone: s.phone,
  contactEmail: s.contactEmail, description: s.description, latitude: s.latitude, longitude: s.longitude,
});

const notFound = () => new AppException('NOT_FOUND', 'You have not registered a salon yet.', 404);
const locked = (status: string) =>
  new AppException('CONFLICT', `This salon cannot be changed while it is ${status.toLowerCase()}.`, 409);

@Injectable()
export class OwnerSalonsService {
  private readonly logger = new Logger(OwnerSalonsService.name);

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: SalonsRepository,
    private readonly storage: ObjectStorage,
    private readonly mail: MailService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The salon id ALWAYS comes from the database (owner_user_id = verified user), never from the request. */
  private async salonIdOf(user: AuthenticatedUser): Promise<string> {
    const s = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.repo.findByOwner(tx, user.id));
    if (!s) throw notFound();
    return s.id;
  }

  async create(user: AuthenticatedUser, dto: CreateSalonDto, meta: ClientContext) {
    const hasLat = dto.latitude !== undefined;
    if (hasLat !== (dto.longitude !== undefined)) {
      throw new AppException('VALIDATION_FAILED', 'Provide both latitude and longitude, or neither.', 400);
    }
    const conflict = () => new AppException('CONFLICT', 'You have already registered a salon.', 409);
    try {
      await this.tenant.withTenant(toTenantContext(user), async (tx: Tx) => {
        if (await this.repo.findByOwner(tx, user.id)) throw conflict();
        const s = await this.repo.insert(tx, user.id, {
          name: dto.name, salonType: dto.salonType, city: dto.city, area: dto.area, addressLine: dto.addressLine,
          phone: dto.phone, contactEmail: dto.contactEmail ?? null, description: dto.description ?? null,
          latitude: dto.latitude ?? null, longitude: dto.longitude ?? null,
        });
        await insertAudit(tx, {
          actorUserId: user.id, actorRole: user.role, action: 'salon.created', targetType: 'salon', targetId: s.id,
          salonId: s.id, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict();
      throw e;
    }
    return this.getMine(user);
  }

  async getMine(user: AuthenticatedUser) {
    const salonId = await this.salonIdOf(user);
    return this.tenant.withTenant(toTenantContext(user, salonId), async (tx: Tx) => {
      const s = await this.repo.findById(tx, salonId);
      if (!s) throw notFound();
      const [files, req, apps] = await Promise.all([this.repo.listFiles(tx, salonId), this.repo.getRequirements(tx), this.repo.listApplications(tx, salonId)]);
      const missing = computeMissing(req, files);
      const canEdit = OWNER_EDITABLE.includes(s.status);
      const latest = apps[0] ?? null;
      return {
        salon: ownerSalonView(s),
        files: files.map(fileView),
        requirements: { ...req, missing },
        canEdit,
        /** Phase 4: profile, opening hours and salon photos stay editable while the salon is live (APPROVED). */
        canEditProfile: PROFILE_EDITABLE.includes(s.status),
        canSubmit: canEdit && isComplete(missing),
        latestApplication: latest && {
          submissionNo: latest.submissionNo, status: latest.status, submittedAt: latest.submittedAt,
          reviewedAt: latest.reviewedAt, decisionReason: latest.status === 'REJECTED' ? latest.decisionReason : null,
        },
      };
    });
  }

  async update(user: AuthenticatedUser, dto: UpdateSalonDto, meta: ClientContext) {
    const salonId = await this.salonIdOf(user);
    await this.tenant.withTenant(toTenantContext(user, salonId), async (tx: Tx) => {
      const cur = await this.repo.lockById(tx, salonId);
      if (!cur) throw notFound();
      if (!PROFILE_EDITABLE.includes(cur.status)) throw locked(cur.status);
      const next: SalonProfile = {
        name: dto.name ?? cur.name, salonType: dto.salonType ?? cur.salonType, city: dto.city ?? cur.city,
        area: dto.area ?? cur.area, addressLine: dto.addressLine ?? cur.addressLine, phone: dto.phone ?? cur.phone,
        contactEmail: dto.contactEmail !== undefined ? (dto.contactEmail ?? null) : cur.contactEmail,
        description: dto.description !== undefined ? (dto.description ?? null) : cur.description,
        latitude: dto.latitude !== undefined ? (dto.latitude ?? null) : cur.latitude,
        longitude: dto.longitude !== undefined ? (dto.longitude ?? null) : cur.longitude,
      };
      if ((next.latitude === null) !== (next.longitude === null)) {
        throw new AppException('VALIDATION_FAILED', 'Provide both latitude and longitude, or neither.', 400);
      }
      const changed = (Object.keys(next) as Array<keyof SalonProfile>).filter((k) => next[k] !== profileOf(cur)[k]);
      await this.repo.updateProfile(tx, salonId, next, this.clock.now());
      await insertAudit(tx, {
        actorUserId: user.id, actorRole: user.role, action: 'salon.updated', targetType: 'salon', targetId: salonId,
        salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: { fields: changed },
      });
    });
    return this.getMine(user);
  }

  async uploadFile(user: AuthenticatedUser, file: { buffer: Buffer; originalname?: string } | undefined, dto: UploadFileDto, meta: ClientContext) {
    if (!file || !file.buffer || file.buffer.length === 0) throw new AppException('VALIDATION_FAILED', 'A file is required (multipart field "file").', 400);
    const typeOk = dto.kind === 'DOCUMENT' ? (DOCUMENT_TYPES as readonly string[]).includes(dto.docType) : (PHOTO_TYPES as readonly string[]).includes(dto.docType);
    if (!typeOk) throw new AppException('VALIDATION_FAILED', `docType ${dto.docType} is not valid for kind ${dto.kind}.`, 400);

    const salonId = await this.salonIdOf(user);
    const processed = await processUpload(file.buffer, { allowPdf: dto.kind === 'DOCUMENT', maxBytes: this.env.UPLOAD_MAX_BYTES });
    const fileId = randomUUID();
    const key = `salons/${salonId}/${fileId}.${processed.ext}`; // server-generated; user input never reaches the key

    try {
      await this.storage.put(key, processed.body, processed.contentType);
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }

    let replacedKeys: string[] = [];
    try {
      const row = await this.tenant.withTenant(toTenantContext(user, salonId), async (tx: Tx) => {
        const cur = await this.repo.lockById(tx, salonId); // serialises uploads/submit for this salon
        if (!cur) throw notFound();
        // Documents are review evidence (DRAFT/REJECTED only); photos stay editable on a live salon.
        if (!(dto.kind === 'DOCUMENT' ? OWNER_EDITABLE : PROFILE_EDITABLE).includes(cur.status)) throw locked(cur.status);
        const docType = dto.docType;
        if (isMultiSlot(docType)) {
          if ((await this.repo.countActive(tx, salonId, docType)) >= (MULTI_SLOT_LIMITS[docType] as number)) {
            throw new AppException('CONFLICT', `You can upload at most ${MULTI_SLOT_LIMITS[docType]} files of this type. Delete one first.`, 409);
          }
        } else {
          replacedKeys = await this.repo.softDeleteSlot(tx, salonId, docType, this.clock.now());
        }
        const created = await this.repo.insertFile(tx, {
          id: fileId, salonId, kind: dto.kind, docType, storageKey: key, contentType: processed.contentType,
          sizeBytes: processed.sizeBytes, sha256: processed.sha256, originalName: displayName(file.originalname), uploadedBy: user.id,
        });
        await insertAudit(tx, {
          actorUserId: user.id, actorRole: user.role, action: 'salon.file_uploaded', targetType: 'salon_file', targetId: fileId,
          salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
          metadata: { kind: dto.kind, docType, contentType: processed.contentType, sizeBytes: processed.sizeBytes, replaced: replacedKeys.length },
        });
        return created;
      });
      await this.removeQuietly(replacedKeys);
      return { data: fileView(row) };
    } catch (e) {
      await this.removeQuietly([key]); // never leave an orphan object behind
      if (isUniqueViolation(e)) throw new AppException('CONFLICT', 'A file for this slot already exists. Try again.', 409);
      throw e;
    }
  }

  async deleteFile(user: AuthenticatedUser, fileId: string, meta: ClientContext): Promise<void> {
    const salonId = await this.salonIdOf(user);
    const removed = await this.tenant.withTenant(toTenantContext(user, salonId), async (tx: Tx) => {
      const cur = await this.repo.lockById(tx, salonId);
      if (!cur) throw notFound();
      const existing = await this.repo.findFile(tx, salonId, fileId);
      // Catalogue images belong to a category/service and are removed through the catalogue endpoints.
      if (!existing || existing.docType === 'CATALOG') throw new AppException('NOT_FOUND', 'File not found.', 404);
      if (!(existing.kind === 'DOCUMENT' ? OWNER_EDITABLE : PROFILE_EDITABLE).includes(cur.status)) throw locked(cur.status);
      const f = await this.repo.softDeleteFile(tx, salonId, fileId, this.clock.now());
      if (!f) throw new AppException('NOT_FOUND', 'File not found.', 404);
      await insertAudit(tx, {
        actorUserId: user.id, actorRole: user.role, action: 'salon.file_deleted', targetType: 'salon_file', targetId: fileId,
        salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata: { docType: f.docType },
      });
      return f;
    });
    await this.removeQuietly([removed.storageKey]);
  }

  async fileUrl(user: AuthenticatedUser, fileId: string) {
    const salonId = await this.salonIdOf(user);
    const f = await this.tenant.withTenant(toTenantContext(user, salonId), (tx: Tx) => this.repo.findFile(tx, salonId, fileId));
    if (!f) throw new AppException('NOT_FOUND', 'File not found.', 404);
    return this.sign(f.storageKey, f.contentType, f.docType);
  }

  /** Always seven days. `configured` is false until the owner has saved hours at least once. */
  async getOpeningHours(user: AuthenticatedUser) {
    const salonId = await this.salonIdOf(user);
    const rows = await this.tenant.withTenant(toTenantContext(user, salonId), (tx: Tx) => this.repo.listHours(tx, salonId));
    return { configured: rows.length > 0, days: weekFromRows(rows) };
  }

  async setOpeningHours(user: AuthenticatedUser, dto: SetOpeningHoursDto, meta: ClientContext) {
    const v = validateWeek(dto.days);
    if (!v.ok) throw new AppException('VALIDATION_FAILED', v.message, 400);
    const salonId = await this.salonIdOf(user);
    await this.tenant.withTenant(toTenantContext(user, salonId), async (tx: Tx) => {
      const cur = await this.repo.lockById(tx, salonId);
      if (!cur) throw notFound();
      if (!PROFILE_EDITABLE.includes(cur.status)) throw locked(cur.status);
      await this.repo.replaceHours(tx, salonId, v.rows, this.clock.now());
      await insertAudit(tx, {
        actorUserId: user.id, actorRole: user.role, action: 'salon.hours_updated', targetType: 'salon', targetId: salonId,
        salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    });
    return this.getOpeningHours(user);
  }

  async submit(user: AuthenticatedUser, meta: ClientContext) {
    const salonId = await this.salonIdOf(user);
    const submitted = await this.tenant.withTenant(toTenantContext(user, salonId), async (tx: Tx) => {
      const cur = await this.repo.lockById(tx, salonId);
      if (!cur) throw notFound();
      if (!OWNER_EDITABLE.includes(cur.status)) throw locked(cur.status);
      const [files, req] = await Promise.all([this.repo.listFiles(tx, salonId), this.repo.getRequirements(tx)]);
      const missing = computeMissing(req, files);
      if (!isComplete(missing)) {
        throw new AppException('VALIDATION_FAILED', 'Upload the required documents and photos before submitting.', 400, { missing });
      }
      const now = this.clock.now();
      const app = await this.repo.insertApplication(tx, salonId, now, { profile: profileOf(cur), fileIds: files.map((f) => f.id) });
      const s = await this.repo.markSubmitted(tx, salonId, now);
      await insertAudit(tx, {
        actorUserId: user.id, actorRole: user.role, action: 'salon.submitted', targetType: 'salon', targetId: salonId,
        salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
        metadata: { submissionNo: app.submissionNo, resubmission: cur.status === 'REJECTED' },
      });
      return s;
    });
    void this.notifyAdmins(submitted);
    return this.getMine(user);
  }

  private async notifyAdmins(s: SalonRecord): Promise<void> {
    try {
      for (const a of await this.repo.listActiveSuperAdmins()) await this.mail.sendSalonSubmittedToAdmin(a.email, a.fullName, s.name, s.city);
    } catch (err) {
      this.logger.error({ err }, 'Failed to notify administrators');
    }
  }

  private async sign(key: string, contentType: string, docType: FileDocType) {
    try {
      const url = await this.storage.signedUrl(key, this.env.SIGNED_URL_TTL_SEC, contentType === 'application/pdf' ? { downloadName: `${docType.toLowerCase()}.pdf` } : undefined);
      return { url, expiresInSec: this.env.SIGNED_URL_TTL_SEC };
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
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
