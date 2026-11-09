import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { PERMISSIONS, roleHasPermissions } from '../../common/auth/permissions';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { AuditEntry, insertAudit } from '../audit/audit.types';
import { MailService } from '../auth/mail/mail.service';
import { fileView, ownerSalonView } from './salon-views';
import { SalonRecord, SalonStatus } from './salon.types';
import { SalonsRepository, Tx } from './salons.repository';

const notFound = () => new AppException('NOT_FOUND', 'Salon not found.', 404);
const wrongState = (status: string, action: string) =>
  new AppException('CONFLICT', `A salon that is ${status.toLowerCase()} cannot be ${action}.`, 409);

@Injectable()
export class AdminSalonsService {
  private readonly logger = new Logger(AdminSalonsService.name);

  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: SalonsRepository,
    private readonly storage: ObjectStorage,
    private readonly mail: MailService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(actor: AuthenticatedUser, f: { status?: Exclude<SalonStatus, 'DRAFT'>; q?: string; city?: string; page: number; pageSize: number }) {
    const r = await this.tenant.withTenant(toTenantContext(actor), (tx: Tx) =>
      this.repo.adminList(tx, { status: f.status, q: f.q, city: f.city, limit: f.pageSize, offset: (f.page - 1) * f.pageSize }),
    );
    return {
      items: r.items.map((s) => ({ ...ownerSalonView(s), ownerName: s.ownerName, ownerEmail: s.ownerEmail })),
      total: r.total, page: f.page, pageSize: f.pageSize,
    };
  }

  async stats(actor: AuthenticatedUser) {
    const c = await this.tenant.withTenant(toTenantContext(actor), (tx: Tx) => this.repo.statusCounts(tx));
    const get = (k: string) => c[k] ?? 0;
    return { pending: get('PENDING'), approved: get('APPROVED'), rejected: get('REJECTED'), suspended: get('SUSPENDED') };
  }

  async detail(actor: AuthenticatedUser, id: string) {
    return this.tenant.withTenant(toTenantContext(actor), async (tx: Tx) => {
      const s = await this.repo.findById(tx, id);
      if (!s || s.status === 'DRAFT') throw notFound(); // drafts are private to the owner
      const [owner, files, applications] = await Promise.all([this.repo.adminOwner(tx, s.ownerUserId), this.repo.listFiles(tx, id), this.repo.listApplications(tx, id)]);
      return {
        salon: { ...ownerSalonView(s), approvedBy: s.approvedBy },
        owner,
        files: files.map(fileView),
        applications: applications.map((a) => ({
          id: a.id, submissionNo: a.submissionNo, status: a.status, submittedAt: a.submittedAt, reviewedAt: a.reviewedAt,
          reviewedBy: a.reviewedBy, decisionReason: a.decisionReason,
        })),
        canViewDocuments: roleHasPermissions(actor.role, [PERMISSIONS.SALONS_DOCUMENTS_READ]),
      };
    });
  }

  /** Issues a short-lived signed URL. Viewing identity documents is itself audited. */
  async fileUrl(actor: AuthenticatedUser, salonId: string, fileId: string, meta: ClientContext) {
    const f = await this.tenant.withTenant(toTenantContext(actor), async (tx: Tx) => {
      const s = await this.repo.findById(tx, salonId);
      if (!s || s.status === 'DRAFT') throw notFound();
      const file = await this.repo.findFile(tx, salonId, fileId);
      if (!file) throw new AppException('NOT_FOUND', 'File not found.', 404);
      if (file.kind === 'DOCUMENT') {
        if (!roleHasPermissions(actor.role, [PERMISSIONS.SALONS_DOCUMENTS_READ])) {
          throw new AppException('FORBIDDEN', 'You do not have access to this resource.', 403);
        }
        await insertAudit(tx, { ...this.audit(actor, meta, 'salon.document_viewed', salonId), targetType: 'salon_file', targetId: fileId, metadata: { docType: file.docType } });
      }
      return file;
    });
    try {
      const url = await this.storage.signedUrl(f.storageKey, this.env.SIGNED_URL_TTL_SEC, f.contentType === 'application/pdf' ? { downloadName: `${f.docType.toLowerCase()}.pdf` } : undefined);
      return { url, expiresInSec: this.env.SIGNED_URL_TTL_SEC };
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
  }

  approve(actor: AuthenticatedUser, id: string, meta: ClientContext) {
    return this.transition(actor, id, meta, {
      from: 'PENDING', action: 'approved', audit: 'salon.approved',
      apply: async (tx, s, now) => {
        const r = await this.repo.approve(tx, id, actor.id, now);
        await this.repo.decideOpenApplication(tx, id, 'APPROVED', actor.id, null, now);
        return r;
      },
      notify: (owner, s) => this.mail.sendSalonApproved(owner.email, owner.fullName, s.name),
    });
  }

  reject(actor: AuthenticatedUser, id: string, reason: string, meta: ClientContext) {
    return this.transition(actor, id, meta, {
      from: 'PENDING', action: 'rejected', audit: 'salon.rejected', reason,
      apply: async (tx, s, now) => {
        const r = await this.repo.reject(tx, id, reason, now);
        await this.repo.decideOpenApplication(tx, id, 'REJECTED', actor.id, reason, now);
        return r;
      },
      notify: (owner, s) => this.mail.sendSalonRejected(owner.email, owner.fullName, s.name, reason),
    });
  }

  suspend(actor: AuthenticatedUser, id: string, reason: string, meta: ClientContext) {
    return this.transition(actor, id, meta, {
      from: 'APPROVED', action: 'suspended', audit: 'salon.suspended', reason,
      apply: (tx, s, now) => this.repo.suspend(tx, id, reason, now),
      notify: (owner, s) => this.mail.sendSalonSuspended(owner.email, owner.fullName, s.name, reason),
    });
  }

  reactivate(actor: AuthenticatedUser, id: string, meta: ClientContext) {
    return this.transition(actor, id, meta, {
      from: 'SUSPENDED', action: 'reactivated', audit: 'salon.reactivated',
      apply: (tx, s, now) => this.repo.reactivate(tx, id, now),
      notify: (owner, s) => this.mail.sendSalonReactivated(owner.email, owner.fullName, s.name),
    });
  }

  private audit(actor: AuthenticatedUser, meta: ClientContext, action: string, salonId: string): AuditEntry {
    return { actorUserId: actor.id, actorRole: actor.role, action, targetType: 'salon', targetId: salonId, salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId };
  }

  /** Row lock + legal-state check + change + audit record all commit in ONE transaction. */
  private async transition(
    actor: AuthenticatedUser, id: string, meta: ClientContext,
    t: {
      from: SalonStatus; action: string; audit: string; reason?: string;
      apply: (tx: Tx, s: SalonRecord, now: Date) => Promise<SalonRecord>;
      notify: (owner: { email: string; fullName: string }, s: SalonRecord) => Promise<void>;
    },
  ) {
    const updated = await this.tenant.withTenant(toTenantContext(actor), async (tx: Tx) => {
      const cur = await this.repo.lockById(tx, id);
      if (!cur || cur.status === 'DRAFT') throw notFound();
      if (cur.status !== t.from) throw wrongState(cur.status, t.action);
      const next = await t.apply(tx, cur, this.clock.now());
      await insertAudit(tx, { ...this.audit(actor, meta, t.audit, id), metadata: { from: cur.status, to: next.status, ...(t.reason ? { reason: t.reason } : {}) } });
      return next;
    });
    try {
      const owner = await this.repo.findUserContact(updated.ownerUserId);
      if (owner) await t.notify(owner, updated);
    } catch (err) {
      this.logger.error({ err }, 'Failed to notify salon owner');
    }
    return { salon: ownerSalonView(updated) };
  }
}
