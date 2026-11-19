import { Injectable } from '@nestjs/common';
import { AppointmentRecord, mapAppointment } from '../booking/booking.repository';
import { Tx } from '../salons/salons.repository';
import { SyncKind, SyncStatus } from './sync.types';

type Row = Record<string, any>;
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));

export interface LedgerRecord {
  operationId: string;
  kind: SyncKind;
  fingerprint: string;
  status: SyncStatus;
  resultCode: string | null;
  resultMessage: string | null;
  appointmentId: string | null;
  effectiveAt: Date;
}

export interface NewLedgerRow {
  salonId: string;
  userId: string;
  deviceId: string;
  operationId: string;
  kind: SyncKind;
  targetAppointmentId: string | null;
  refOperationId: string | null;
  fingerprint: string;
  clientCreatedAt: Date;
  effectiveAt: Date;
  status: SyncStatus;
  resultCode: string | null;
  resultMessage: string | null;
  appointmentId: string | null;
}

export interface NoteRecord {
  id: string;
  appointmentId: string;
  authorName: string;
  mine: boolean;
  body: string;
  createdAt: Date;
}

const ledger = (r: Row): LedgerRecord => ({
  operationId: r.operation_id, kind: r.kind, fingerprint: String(r.fingerprint).trim(), status: r.status, resultCode: r.result_code ?? null,
  resultMessage: r.result_message ?? null, appointmentId: r.appointment_id ?? null, effectiveAt: date(r.effective_at),
});

/**
 * All SQL for Phase 12. Same rules as the other repositories: every method takes the transaction opened by TenantDb (so Row-Level
 * Security applies), parameters are bound and carry explicit casts. The salon and the user always come from the verified session.
 */
@Injectable()
export class SyncRepository {
  // ------------------------------------------------------------------ the operation ledger
  async findOperation(tx: Tx, salonId: string, userId: string, operationId: string): Promise<LedgerRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT operation_id, kind, fingerprint, status, result_code, result_message, appointment_id, effective_at
      FROM sync_operations
      WHERE salon_id = ${salonId}::uuid AND user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid`;
    return r[0] ? ledger(r[0]) : null;
  }

  /** Throws a unique violation (23505) when this operation was already recorded: the caller's transaction then rolls back the change too. */
  async insertOperation(tx: Tx, o: NewLedgerRow): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO sync_operations (salon_id, user_id, device_id, operation_id, kind, target_appointment_id, ref_operation_id, fingerprint,
                                   client_created_at, effective_at, status, result_code, result_message, appointment_id)
      VALUES (${o.salonId}::uuid, ${o.userId}::uuid, ${o.deviceId}::uuid, ${o.operationId}::uuid, ${o.kind}::varchar, ${o.targetAppointmentId}::uuid,
              ${o.refOperationId}::uuid, ${o.fingerprint}::char(64), ${o.clientCreatedAt}::timestamptz, ${o.effectiveAt}::timestamptz,
              ${o.status}::varchar, ${o.resultCode}::varchar, ${o.resultMessage}::varchar, ${o.appointmentId}::uuid)`;
  }

  // ------------------------------------------------------------------ notes
  async countNotes(tx: Tx, appointmentId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM appointment_notes WHERE appointment_id = ${appointmentId}::uuid`;
    return Number(r[0]?.n ?? 0);
  }

  async insertNote(tx: Tx, n: { salonId: string; appointmentId: string; authorUserId: string; body: string }): Promise<string> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO appointment_notes (salon_id, appointment_id, author_user_id, body)
      VALUES (${n.salonId}::uuid, ${n.appointmentId}::uuid, ${n.authorUserId}::uuid, ${n.body}::varchar)
      RETURNING id`;
    return r[0].id as string;
  }

  /** Notes of the given appointments (RLS already limits staff to their own appointments). `since` = only notes written after it. */
  async notesFor(tx: Tx, salonId: string, appointmentIds: string[], viewerId: string, since: Date | null): Promise<NoteRecord[]> {
    if (appointmentIds.length === 0) return [];
    const r = await tx.$queryRaw<Row[]>`
      SELECT n.id, n.appointment_id, n.body, n.created_at, n.author_user_id, u.full_name
      FROM appointment_notes n JOIN users u ON u.id = n.author_user_id
      WHERE n.salon_id = ${salonId}::uuid AND n.appointment_id = ANY(${appointmentIds}::uuid[])
        AND (${since}::timestamptz IS NULL OR n.created_at > ${since}::timestamptz)
      ORDER BY n.created_at, n.id`;
    return r.map((x) => ({
      id: x.id, appointmentId: x.appointment_id, authorName: x.full_name, mine: x.author_user_id === viewerId, body: x.body, createdAt: date(x.created_at),
    }));
  }

  /** Appointments that got a note after `since` (their notes must reach the device even if the appointment itself did not change). */
  async appointmentIdsWithNotesSince(tx: Tx, salonId: string, since: Date): Promise<string[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT DISTINCT appointment_id FROM appointment_notes WHERE salon_id = ${salonId}::uuid AND created_at > ${since}::timestamptz`;
    return r.map((x) => x.appointment_id as string);
  }

  // ------------------------------------------------------------------ pull
  /** The database clock: the cursor the app stores. Taken BEFORE the reads, so nothing written during the pull is skipped next time. */
  async serverTime(tx: Tx): Promise<Date> {
    const r = await tx.$queryRaw<Row[]>`SELECT clock_timestamp() AS t`;
    return date(r[0].t);
  }

  /**
   * The appointments of the caller's window (staff: only THEIR OWN, owner: the whole salon), newest changes only when `since` is set.
   * Anything still IN_PROGRESS is always included, whatever day it started. Staff never get the phone number (`includePhone` false).
   * One extra row is read to tell the caller whether the cap truncated the answer.
   */
  async window(
    tx: Tx, salonId: string,
    f: { staffId: string | null; from: Date; to: Date; since: Date | null; extraIds: string[]; includePhone: boolean; limit: number },
  ): Promise<{ rows: AppointmentRecord[]; truncated: boolean }> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT a.*, COALESCE(u.full_name, a.walk_in_name) AS customer_name,
             CASE WHEN ${f.includePhone}::boolean THEN COALESCE(u.phone, a.walk_in_phone) END AS customer_phone
      FROM appointments a LEFT JOIN users u ON u.id = a.customer_user_id
      WHERE a.salon_id = ${salonId}::uuid
        AND (${f.staffId}::uuid IS NULL OR a.staff_id = ${f.staffId}::uuid)
        AND (
          (a.starts_at >= ${f.from}::timestamptz AND a.starts_at < ${f.to}::timestamptz)
          OR a.status = 'IN_PROGRESS'
          OR a.id = ANY(${f.extraIds}::uuid[])
        )
        AND (${f.since}::timestamptz IS NULL OR a.updated_at > ${f.since}::timestamptz OR a.id = ANY(${f.extraIds}::uuid[]))
      ORDER BY a.starts_at, a.id
      LIMIT ${f.limit + 1}::int`;
    const rows = r.slice(0, f.limit).map(mapAppointment);
    return { rows, truncated: r.length > f.limit };
  }
}
