import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HourRow } from './opening-hours';
import {
  ApplicationRecord, FileDocType, FileKind, Requirements, SalonFileRecord, SalonRecord, SalonStatus, SalonType, parseRequirements,
} from './salon.types';

/** Transaction handle from TenantDb.withTenant / withPublicRead (Prisma tx or the test adapter). */
export interface Tx {
  $queryRaw<T = unknown>(q: TemplateStringsArray, ...v: unknown[]): Promise<T>;
  $executeRaw(q: TemplateStringsArray, ...v: unknown[]): Promise<number>;
}

type Row = Record<string, any>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const salon = (r: Row): SalonRecord => ({
  id: r.id, ownerUserId: r.owner_user_id, name: r.name, salonType: r.salon_type, city: r.city, area: r.area,
  addressLine: r.address_line, phone: r.phone, contactEmail: r.contact_email, description: r.description,
  latitude: num(r.latitude), longitude: num(r.longitude), status: r.status, submittedAt: r.submitted_at,
  approvedAt: r.approved_at, approvedBy: r.approved_by, rejectionReason: r.rejection_reason,
  suspendedReason: r.suspended_reason, createdAt: r.created_at, updatedAt: r.updated_at,
});

const file = (r: Row): SalonFileRecord => ({
  id: r.id, salonId: r.salon_id, kind: r.kind, docType: r.doc_type, storageKey: r.storage_key,
  contentType: r.content_type, sizeBytes: r.size_bytes, originalName: r.original_name, uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
});

const application = (r: Row): ApplicationRecord => ({
  id: r.id, salonId: r.salon_id, submissionNo: r.submission_no, status: r.status, submittedAt: r.submitted_at,
  reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, decisionReason: r.decision_reason,
});

export interface SalonProfile {
  name: string; salonType: SalonType; city: string; area: string; addressLine: string; phone: string;
  contactEmail: string | null; description: string | null; latitude: number | null; longitude: number | null;
}

export interface AdminSalonRow extends SalonRecord { ownerName: string; ownerEmail: string }

/** Escapes LIKE wildcards so user input is matched literally. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * All SQL for Phase 3. Every method takes the transaction opened by TenantDb so Row-Level Security
 * applies; parameters are bound (never concatenated) and carry explicit casts.
 */
@Injectable()
export class SalonsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ salons
  async findByOwner(tx: Tx, ownerId: string): Promise<SalonRecord | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM salons WHERE owner_user_id = ${ownerId}::uuid`;
    return r[0] ? salon(r[0]) : null;
  }

  async findById(tx: Tx, id: string): Promise<SalonRecord | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM salons WHERE id = ${id}::uuid`;
    return r[0] ? salon(r[0]) : null;
  }

  async lockById(tx: Tx, id: string): Promise<SalonRecord | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT * FROM salons WHERE id = ${id}::uuid FOR UPDATE`;
    return r[0] ? salon(r[0]) : null;
  }

  async insert(tx: Tx, ownerId: string, p: SalonProfile): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO salons (owner_user_id, name, salon_type, city, area, address_line, phone, contact_email, description, latitude, longitude)
      VALUES (${ownerId}::uuid, ${p.name}::varchar, ${p.salonType}::salon_type, ${p.city}::varchar, ${p.area}::varchar,
              ${p.addressLine}::varchar, ${p.phone}::varchar, ${p.contactEmail}::varchar, ${p.description}::varchar,
              ${p.latitude}::numeric, ${p.longitude}::numeric)
      RETURNING *`;
    return salon(r[0]);
  }

  async updateProfile(tx: Tx, id: string, p: SalonProfile, now: Date): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salons SET name = ${p.name}::varchar, salon_type = ${p.salonType}::salon_type, city = ${p.city}::varchar,
        area = ${p.area}::varchar, address_line = ${p.addressLine}::varchar, phone = ${p.phone}::varchar,
        contact_email = ${p.contactEmail}::varchar, description = ${p.description}::varchar,
        latitude = ${p.latitude}::numeric, longitude = ${p.longitude}::numeric, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING *`;
    return salon(r[0]);
  }

  async markSubmitted(tx: Tx, id: string, now: Date): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salons SET status = 'PENDING', submitted_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING *`;
    return salon(r[0]);
  }

  async approve(tx: Tx, id: string, adminId: string, now: Date): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salons SET status = 'APPROVED', approved_at = ${now}::timestamptz, approved_by = ${adminId}::uuid,
        rejection_reason = NULL, suspended_reason = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING *`;
    return salon(r[0]);
  }

  async reject(tx: Tx, id: string, reason: string, now: Date): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salons SET status = 'REJECTED', rejection_reason = ${reason}::varchar, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING *`;
    return salon(r[0]);
  }

  async suspend(tx: Tx, id: string, reason: string, now: Date): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salons SET status = 'SUSPENDED', suspended_reason = ${reason}::varchar, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING *`;
    return salon(r[0]);
  }

  async reactivate(tx: Tx, id: string, now: Date): Promise<SalonRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salons SET status = 'APPROVED', suspended_reason = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid RETURNING *`;
    return salon(r[0]);
  }

  // ------------------------------------------------------------------ files
  /** Application files only (documents, cover, gallery). Catalogue images (CATALOG) are managed by the catalogue module. */
  async listFiles(tx: Tx, salonId: string): Promise<SalonFileRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM salon_files WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL AND doc_type <> 'CATALOG' ORDER BY created_at, id`;
    return r.map(file);
  }

  async findFile(tx: Tx, salonId: string, fileId: string): Promise<SalonFileRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM salon_files WHERE id = ${fileId}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return r[0] ? file(r[0]) : null;
  }

  async countActive(tx: Tx, salonId: string, docType: FileDocType): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n FROM salon_files WHERE salon_id = ${salonId}::uuid AND doc_type = ${docType}::varchar AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  /** Frees a single-slot type (CNIC front, cover, ...) so a new upload replaces it. Returns the old storage keys. */
  async softDeleteSlot(tx: Tx, salonId: string, docType: FileDocType, now: Date): Promise<string[]> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salon_files SET deleted_at = ${now}::timestamptz
      WHERE salon_id = ${salonId}::uuid AND doc_type = ${docType}::varchar AND deleted_at IS NULL RETURNING storage_key`;
    return r.map((x) => x.storage_key as string);
  }

  async softDeleteFile(tx: Tx, salonId: string, fileId: string, now: Date): Promise<SalonFileRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE salon_files SET deleted_at = ${now}::timestamptz
      WHERE id = ${fileId}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL RETURNING *`;
    return r[0] ? file(r[0]) : null;
  }

  async insertFile(
    tx: Tx,
    f: { id: string; salonId: string; kind: FileKind; docType: FileDocType; storageKey: string; contentType: string;
         sizeBytes: number; sha256: string; originalName: string | null; uploadedBy: string },
  ): Promise<SalonFileRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO salon_files (id, salon_id, kind, doc_type, storage_key, content_type, size_bytes, sha256, original_name, uploaded_by)
      VALUES (${f.id}::uuid, ${f.salonId}::uuid, ${f.kind}::salon_file_kind, ${f.docType}::varchar, ${f.storageKey}::varchar,
              ${f.contentType}::varchar, ${f.sizeBytes}::int, ${f.sha256}::varchar, ${f.originalName}::varchar, ${f.uploadedBy}::uuid)
      RETURNING *`;
    return file(r[0]);
  }

  async listPublicPhotos(tx: Tx, salonId: string): Promise<SalonFileRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM salon_files WHERE salon_id = ${salonId}::uuid AND kind = 'PHOTO' AND doc_type IN ('COVER', 'GALLERY') AND deleted_at IS NULL
      ORDER BY (doc_type = 'COVER') DESC, created_at, id`;
    return r.map(file);
  }

  // ------------------------------------------------------------------ opening hours (Phase 4)
  async listHours(tx: Tx, salonId: string): Promise<HourRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT weekday, is_closed, opens_minute, closes_minute FROM salon_opening_hours WHERE salon_id = ${salonId}::uuid ORDER BY weekday`;
    return r.map((x) => ({ weekday: Number(x.weekday), isClosed: Boolean(x.is_closed), opensMinute: num(x.opens_minute), closesMinute: num(x.closes_minute) }));
  }

  /** Replaces the whole week atomically (the caller runs this inside one transaction with the salon row locked). */
  async replaceHours(tx: Tx, salonId: string, rows: HourRow[], now: Date): Promise<void> {
    await tx.$executeRaw`DELETE FROM salon_opening_hours WHERE salon_id = ${salonId}::uuid`;
    for (const r of rows) {
      await tx.$executeRaw`
        INSERT INTO salon_opening_hours (salon_id, weekday, is_closed, opens_minute, closes_minute, updated_at)
        VALUES (${salonId}::uuid, ${r.weekday}::smallint, ${r.isClosed}::boolean, ${r.opensMinute}::smallint, ${r.closesMinute}::smallint, ${now}::timestamptz)`;
    }
  }

  // ------------------------------------------------------------------ applications
  async insertApplication(tx: Tx, salonId: string, now: Date, snapshot: unknown): Promise<ApplicationRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO salon_applications (salon_id, submission_no, submitted_at, snapshot)
      VALUES (${salonId}::uuid,
              (SELECT COALESCE(MAX(submission_no), 0) + 1 FROM salon_applications WHERE salon_id = ${salonId}::uuid),
              ${now}::timestamptz, ${JSON.stringify(snapshot)}::jsonb)
      RETURNING *`;
    return application(r[0]);
  }

  async listApplications(tx: Tx, salonId: string): Promise<ApplicationRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM salon_applications WHERE salon_id = ${salonId}::uuid ORDER BY submission_no DESC`;
    return r.map(application);
  }

  async decideOpenApplication(tx: Tx, salonId: string, status: 'APPROVED' | 'REJECTED', reviewerId: string, reason: string | null, now: Date): Promise<number> {
    return tx.$executeRaw`
      UPDATE salon_applications SET status = ${status}::salon_application_status, reviewed_by = ${reviewerId}::uuid,
        reviewed_at = ${now}::timestamptz, decision_reason = ${reason}::varchar
      WHERE salon_id = ${salonId}::uuid AND status = 'SUBMITTED'`;
  }

  // ------------------------------------------------------------------ settings & users
  async getRequirements(tx: Tx): Promise<Requirements> {
    const r = await tx.$queryRaw<Row[]>`SELECT value FROM platform_settings WHERE key = 'salon_application'`;
    return parseRequirements(r[0]?.value);
  }

  async findUserContact(userId: string): Promise<{ email: string; fullName: string } | null> {
    const r = await this.prisma.$queryRaw<Row[]>`SELECT email, full_name FROM users WHERE id = ${userId}::uuid`;
    return r[0] ? { email: r[0].email, fullName: r[0].full_name } : null;
  }

  async listActiveSuperAdmins(): Promise<Array<{ email: string; fullName: string }>> {
    const r = await this.prisma.$queryRaw<Row[]>`SELECT email, full_name FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE'`;
    return r.map((x: Row) => ({ email: x.email, fullName: x.full_name }));
  }

  // ------------------------------------------------------------------ admin queries
  async adminList(tx: Tx, f: { status?: SalonStatus; q?: string; city?: string; limit: number; offset: number }): Promise<{ items: AdminSalonRow[]; total: number }> {
    const status = f.status ?? null;
    const q = f.q ? likePattern(f.q) : null;
    const city = f.city ?? null;
    const oldestFirst = f.status === 'PENDING';
    const rows = await tx.$queryRaw<Row[]>`
      SELECT s.*, u.full_name AS owner_name, u.email AS owner_email
      FROM salons s JOIN users u ON u.id = s.owner_user_id
      WHERE s.status <> 'DRAFT'
        AND (${status}::text IS NULL OR s.status::text = ${status}::text)
        AND (${q}::text IS NULL OR s.name ILIKE ${q}::text OR s.city ILIKE ${q}::text OR s.area ILIKE ${q}::text OR u.email ILIKE ${q}::text)
        AND (${city}::text IS NULL OR lower(s.city) = lower(${city}::text))
      ORDER BY CASE WHEN ${oldestFirst}::boolean THEN s.submitted_at END ASC NULLS LAST, s.created_at DESC, s.id
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    const count = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n FROM salons s JOIN users u ON u.id = s.owner_user_id
      WHERE s.status <> 'DRAFT'
        AND (${status}::text IS NULL OR s.status::text = ${status}::text)
        AND (${q}::text IS NULL OR s.name ILIKE ${q}::text OR s.city ILIKE ${q}::text OR s.area ILIKE ${q}::text OR u.email ILIKE ${q}::text)
        AND (${city}::text IS NULL OR lower(s.city) = lower(${city}::text))`;
    return { items: rows.map((r) => ({ ...salon(r), ownerName: r.owner_name, ownerEmail: r.owner_email })), total: Number(count[0].n) };
  }

  async adminOwner(tx: Tx, ownerId: string): Promise<{ id: string; fullName: string; email: string; phone: string | null } | null> {
    const r = await tx.$queryRaw<Row[]>`SELECT id, full_name, email, phone FROM users WHERE id = ${ownerId}::uuid`;
    return r[0] ? { id: r[0].id, fullName: r[0].full_name, email: r[0].email, phone: r[0].phone } : null;
  }

  async statusCounts(tx: Tx): Promise<Record<string, number>> {
    const r = await tx.$queryRaw<Row[]>`SELECT status::text AS status, count(*)::int AS n FROM salons WHERE status <> 'DRAFT' GROUP BY status`;
    return Object.fromEntries(r.map((x) => [x.status as string, Number(x.n)]));
  }

  // ------------------------------------------------------------------ public queries
  /** Phase 7 visibility rule (APPROVED + free trial or running subscription). Used by every public salon page. */
  async isListed(tx: Tx, id: string, trialDays: number, today: string): Promise<boolean> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT 1 AS ok FROM salons WHERE id = ${id}::uuid AND status = 'APPROVED' AND salon_is_listed(id, approved_at, ${trialDays}::int, ${today}::date)`;
    return r.length > 0;
  }

  async publicList(tx: Tx, f: { q?: string; city?: string; area?: string; type?: SalonType; limit: number; offset: number; trialDays: number; today: string }): Promise<{ items: SalonRecord[]; total: number }> {
    const q = f.q ? likePattern(f.q) : null;
    const city = f.city ?? null;
    const area = f.area ?? null;
    const type = f.type ?? null;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT * FROM salons
      WHERE status = 'APPROVED'
        AND salon_is_listed(id, approved_at, ${f.trialDays}::int, ${f.today}::date)
        AND (${q}::text IS NULL OR name ILIKE ${q}::text)
        AND (${city}::text IS NULL OR lower(city) = lower(${city}::text))
        AND (${area}::text IS NULL OR lower(area) = lower(${area}::text))
        AND (${type}::text IS NULL OR salon_type::text = ${type}::text)
      ORDER BY name, id LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    const count = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n FROM salons
      WHERE status = 'APPROVED'
        AND salon_is_listed(id, approved_at, ${f.trialDays}::int, ${f.today}::date)
        AND (${q}::text IS NULL OR name ILIKE ${q}::text)
        AND (${city}::text IS NULL OR lower(city) = lower(${city}::text))
        AND (${area}::text IS NULL OR lower(area) = lower(${area}::text))
        AND (${type}::text IS NULL OR salon_type::text = ${type}::text)`;
    return { items: rows.map(salon), total: Number(count[0].n) };
  }
}
